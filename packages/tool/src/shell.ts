import { execFile, spawn } from "node:child_process";
import { mkdtemp, rm, rmdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { OutputAccumulator, MAX_OUTPUT_LINES, type OutputSnapshot } from "./output-accumulator.ts";
import type { OutputArtifact, OutputLog } from "./output-cache.ts";
import { MAX_OUTPUT_BYTES } from "./text.ts";
import { validateKeys, type Tool, type ToolExecution, type ToolHost } from "./tool.ts";
import { resolveWorkspacePath, type Workspace } from "./workspace.ts";

const DEFAULT_TIMEOUT_SECONDS = 300;
const MAX_TIMEOUT_SECONDS = 600;
const UPDATE_INTERVAL_MS = 100;

export interface ShellInput { command: string; timeoutSeconds?: number }
/** 可记录的命令终态；日志失败不抹掉已知退出信息，也不重新执行命令。 */
export interface ShellResult extends OutputSnapshot {
  status: "completed" | "cancelled" | "timed_out";
  exitCode: number | null;
  durationMs: number;
  outputId: string | null;
  artifactTruncated: boolean;
  logError?: string;
}

async function stopProcessTree(pid: number, systemDirectory: string): Promise<void> {
  await promisify(execFile)(join(systemDirectory, "taskkill.exe"), ["/PID", String(pid), "/T", "/F"], { windowsHide: true, timeout: 10000 });
}

/** PowerShell 方言、输出与日志限制都与执行声明一起维护。 */
export function createShellTool(workspace: Workspace, host?: ToolHost): Tool {
  return {
    definition: {
      type: "function", name: "shell", strict: false,
      description: `在项目根目录执行独立 Windows PowerShell 5.1 命令，不是 Bash。输入输出用 UTF-8，不支持交互或后台服务。默认 ${DEFAULT_TIMEOUT_SECONDS} 秒，最多 ${MAX_TIMEOUT_SECONDS} 秒。输出只返回末尾 ${MAX_OUTPUT_LINES} 行或 ${MAX_OUTPUT_BYTES / 1024} KiB，partialLine 表示末尾预览的首行不完整。outputId 可用 read 续读当前任务日志；日志最多保存 10 MiB，保留 7 天，总缓存 256 MiB，artifactTruncated 表示缓存不完整，logError 表示保存失败。取消和超时返回已取得的输出与退出信息。修改文件前先读取；非零退出、日志失败或取消不表示没有副作用，不要自动重跑命令。`,
      parameters: { type: "object", additionalProperties: false, required: ["command"], properties: {
        command: { type: "string", description: "PowerShell 命令文本，从项目根目录开始，每次独立执行。" },
        timeoutSeconds: { type: "integer", minimum: 1, maximum: MAX_TIMEOUT_SECONDS, description: `运行时限，单位秒；默认 ${DEFAULT_TIMEOUT_SECONDS}。` },
      } },
    },
    async execute(args, signal, execution) {
      validateKeys(args, ["command", "timeoutSeconds"]);
      if (typeof args.command !== "string") throw new Error("command 必须是字符串。");
      if (args.timeoutSeconds !== undefined && typeof args.timeoutSeconds !== "number") throw new Error("timeoutSeconds 必须是数字。");
      return runShell(workspace, { command: args.command, ...(args.timeoutSeconds === undefined ? {} : { timeoutSeconds: args.timeoutSeconds }) }, signal, host, execution);
    },
  };
}

/** 合并 stdout/stderr 的到达顺序；暂停管道等待日志与进度，避免无界排队。 */
export async function runShell(workspace: Workspace, input: ShellInput, signal?: AbortSignal, host?: ToolHost, execution?: ToolExecution): Promise<ShellResult> {
  const { command, timeoutSeconds = DEFAULT_TIMEOUT_SECONDS } = input;
  if (typeof command !== "string" || command.trim() === "") throw new Error("command 不能为空。");
  if (!Number.isInteger(timeoutSeconds) || timeoutSeconds < 1 || timeoutSeconds > MAX_TIMEOUT_SECONDS) throw new Error(`timeoutSeconds 必须是 1 到 ${MAX_TIMEOUT_SECONDS} 的整数。`);
  if (process.platform !== "win32") throw new Error("shell 当前仅支持 Windows PowerShell。");
  const systemRoot = process.env.SystemRoot;
  if (!systemRoot) throw new Error("未找到 Windows 系统目录。");
  signal?.throwIfAborted();
  const cwd = await resolveWorkspacePath(workspace, "");
  const directory = await mkdtemp(join(tmpdir(), "tilot-shell-"));
  const script = join(directory, "command.ps1");
  let log: OutputLog | undefined;
  try {
    await writeFile(script, "\ufeff" + [
      "$ErrorActionPreference = 'Stop'", "$ProgressPreference = 'SilentlyContinue'",
      "[Console]::InputEncoding = [Console]::OutputEncoding = $OutputEncoding = [System.Text.UTF8Encoding]::new($false)",
      "$PSDefaultParameterValues['*:Encoding'] = 'utf8'", command,
      "if (-not $?) { if ($LASTEXITCODE) { exit $LASTEXITCODE }; exit 1 }",
    ].join("\r\n"), "utf8");
    if (host) {
      try { log = await host.outputs.create(host.threadId, execution?.executionId); }
      catch (error) { throw new Error(`无法创建输出日志，命令未执行：${message(error)}`); }
    }
    signal?.throwIfAborted();
    const systemDirectory = join(systemRoot, "System32");
    const child = spawn(join(systemDirectory, "WindowsPowerShell", "v1.0", "powershell.exe"),
      ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", script],
      { cwd, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    const started = performance.now();
    const output = new OutputAccumulator();
    const streams = [child.stdout, child.stderr];
    let closed = false;
    let status: ShellResult["status"] = "completed";
    let stopping: Promise<void> | undefined;
    let processing = Promise.resolve();
    let pending = 0;
    let logError: string | undefined;
    let updateError: unknown;
    let lastUpdate = -Infinity;
    let updateTimer: ReturnType<typeof setTimeout> | undefined;
    let updateQueued = false;
    let rejectExit!: (error: unknown) => void;

    const exit = new Promise<number | null>((resolve, reject) => {
      rejectExit = reject;
      child.once("error", reject);
      child.once("close", (code) => { closed = true; clearTimeout(updateTimer); resolve(code); });
    });
    // 提前挂接拒绝处理；输出消费仍会在 finally 等待，不能留下未处理的 Promise。
    void exit.catch(() => {});

    function stop(reason: "cancelled" | "timed_out"): void {
      if (closed || stopping || child.pid === undefined) return;
      status = reason;
      stopping = stopProcessTree(child.pid, systemDirectory).catch(() => {
        if (!closed) throw new Error("终止命令进程树失败，无法确认所有进程已停止。");
      });
      void stopping.catch(rejectExit);
    }

    /** 最多两路在途数据与一个进度任务；等待期间让操作系统管道提供背压。 */
    function enqueue(operation: () => Promise<void>): void {
      for (const stream of streams) stream.pause();
      pending++;
      processing = processing.then(async () => {
        try { await operation(); }
        catch (error) { updateError ??= error; stop("cancelled"); }
      }).then(() => {
        pending--;
        if (pending === 0) for (const stream of streams) stream.resume();
      });
    }

    function scheduleUpdate(): void {
      if (!execution?.onUpdate || updateError !== undefined || updateTimer !== undefined || updateQueued || closed) return;
      updateTimer = setTimeout(() => {
        updateTimer = undefined;
        if (closed || updateError !== undefined) return;
        updateQueued = true;
        enqueue(async () => {
          try {
            if (!closed) { lastUpdate = performance.now(); await execution.onUpdate!(output.snapshot()); }
          } finally { updateQueued = false; }
        });
      }, Math.max(0, UPDATE_INTERVAL_MS - (performance.now() - lastUpdate)));
    }

    for (const stream of streams) stream.setEncoding("utf8").on("data", (chunk: string) => {
      enqueue(async () => {
        output.append(chunk);
        if (log && logError === undefined) {
          try { await log.append(chunk); }
          catch (error) { logError = `日志保存失败，命令仍已执行，请勿据此重跑：${message(error)}`; }
        }
        scheduleUpdate();
      });
    });
    const abort = () => stop("cancelled");
    signal?.addEventListener("abort", abort, { once: true });
    const timeout = setTimeout(() => stop("timed_out"), timeoutSeconds * 1000);
    if (signal?.aborted) abort();
    try {
      const exitCode = await exit;
      await processing;
      await stopping;
      const durationMs = Math.round(performance.now() - started);
      let artifact: OutputArtifact | undefined;
      if (log) {
        try { if (logError === undefined) artifact = await log.finish(); else await log.discard(); }
        catch (error) { logError ??= `日志保存失败，命令仍已执行，请勿据此重跑：${message(error)}`; }
      }
      if (updateError !== undefined) throw updateError;
      return { status, exitCode, durationMs, ...output.snapshot(), outputId: artifact?.outputId ?? null,
        artifactTruncated: artifact?.artifactTruncated ?? false, ...(logError ? { logError } : {}) };
    } finally {
      clearTimeout(timeout); clearTimeout(updateTimer);
      signal?.removeEventListener("abort", abort);
      await processing;
      for (const stream of streams) stream.destroy();
    }
  } finally {
    try { await log?.discard(); }
    finally { await rm(script, { force: true }); await rmdir(directory); }
  }
}

function message(error: unknown): string { return error instanceof Error ? error.message : String(error); }
