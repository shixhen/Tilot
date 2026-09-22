import { execFile, spawn } from "node:child_process";
import { mkdtemp, rm, rmdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { resolveWorkspacePath, type Workspace } from "./workspace.ts";

/** PowerShell 命令及运行时限；每次调用都从任务绑定的项目根目录开始。 */
export interface ShellInput {
  command: string;
  timeoutSeconds?: number;
}

/** 命令结束信息；output 合并标准输出和错误输出，截断时只保留末尾。 */
export interface ShellResult {
  status: "completed" | "cancelled" | "timed_out";
  exitCode: number | null;
  output: string;
  truncated: boolean;
}

/** 终止指定 Windows 进程及其子进程；失败时报告，不能把取消请求当成已停止。 */
async function stopProcessTree(pid: number, systemDirectory: string): Promise<void> {
  await promisify(execFile)(join(systemDirectory, "taskkill.exe"), ["/PID", String(pid), "/T", "/F"], {
    windowsHide: true,
    timeout: 10000,
  });
}

/** 从 UTF-8 输出尾部移除截断产生的不完整首字符，避免显示替换符。 */
function decodeTail(bytes: Buffer): string {
  let start = 0;
  while (start < bytes.length && (bytes[start]! & 0xc0) === 0x80) start++;
  return bytes.subarray(start).toString("utf8");
}

/** 在独立 Windows PowerShell 进程执行命令，限制输出，并在取消或超时时终止进程树。 */
export async function runShell(
  workspace: Workspace,
  input: ShellInput,
  signal?: AbortSignal,
): Promise<ShellResult> {
  const { command, timeoutSeconds = 300 } = input;
  if (typeof command !== "string" || command.trim() === "") throw new Error("command 不能为空。");
  if (!Number.isInteger(timeoutSeconds) || timeoutSeconds < 1 || timeoutSeconds > 600) {
    throw new Error("timeoutSeconds 必须是 1 到 600 的整数。");
  }
  if (process.platform !== "win32") throw new Error("shell 当前仅支持 Windows PowerShell。");
  const systemRoot = process.env.SystemRoot;
  if (!systemRoot) throw new Error("未找到 Windows 系统目录。");
  signal?.throwIfAborted();
  const cwd = await resolveWorkspacePath(workspace, "");
  const directory = await mkdtemp(join(tmpdir(), "tilot-shell-"));
  const script = join(directory, "command.ps1");
  try {
    // UTF-8 BOM 使 Windows PowerShell 5.1 正确读取中文；不加载个人配置，不修改机器执行策略。
    await writeFile(script, "\ufeff" + [
      "$ErrorActionPreference = 'Stop'",
      "$ProgressPreference = 'SilentlyContinue'",
      "[Console]::InputEncoding = [Console]::OutputEncoding = $OutputEncoding = [System.Text.UTF8Encoding]::new($false)",
      "$PSDefaultParameterValues['*:Encoding'] = 'utf8'",
      command,
      "if (-not $?) { if ($LASTEXITCODE) { exit $LASTEXITCODE }; exit 1 }",
    ].join("\r\n"), "utf8");
    signal?.throwIfAborted();
    const systemDirectory = join(systemRoot, "System32");
    const child = spawn(join(systemDirectory, "WindowsPowerShell", "v1.0", "powershell.exe"),
      ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", script],
      { cwd, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let output = Buffer.alloc(0);
    let truncated = false;
    let closed = false;
    let status: ShellResult["status"] = "completed";
    let stopping: Promise<void> | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let abort: (() => void) | undefined;

    /** 持续消费两个输出管道，只保存最后 50 KiB，避免大量输出阻塞子进程。 */
    function collect(chunk: string): void {
      const combined = Buffer.concat([output, Buffer.from(chunk, "utf8")]);
      truncated ||= combined.length > 50 * 1024;
      output = Buffer.from(combined.subarray(-50 * 1024));
    }
    child.stdout.setEncoding("utf8").on("data", collect);
    child.stderr.setEncoding("utf8").on("data", collect);
    try {
      const exitCode = await new Promise<number | null>((resolve, reject) => {
        child.once("error", reject);
        child.once("close", (code) => { closed = true; resolve(code); });

        /** 只发送一次终止请求；只有进程确实关闭后才返回取消或超时结果。 */
        function stop(reason: "cancelled" | "timed_out"): void {
          if (closed || stopping || child.pid === undefined) return;
          status = reason;
          stopping = stopProcessTree(child.pid, systemDirectory).catch(() => {
            if (!closed) throw new Error("终止命令进程树失败，无法确认所有进程已停止。");
          });
          void stopping.catch(reject);
        }
        abort = () => stop("cancelled");
        signal?.addEventListener("abort", abort, { once: true });
        timer = setTimeout(() => stop("timed_out"), timeoutSeconds * 1000);
        if (signal?.aborted) abort();
      });
      await stopping;
      return { status, exitCode, output: decodeTail(output), truncated };
    } finally {
      clearTimeout(timer);
      if (abort) signal?.removeEventListener("abort", abort);
      child.stdout.destroy();
      child.stderr.destroy();
    }
  } finally {
    await rm(script, { force: true });
    await rmdir(directory);
  }
}
