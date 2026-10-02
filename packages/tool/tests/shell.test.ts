import assert from "node:assert/strict";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
import { openWorkspace, OutputCache, readOutputLog, runShell } from "../src/index.ts";
import { OutputLog } from "../src/output-cache.ts";
import { temporaryDirectory } from "./helpers.ts";

/** 将测试中的路径及脚本作为 PowerShell 单引号字面量传递，避免变量或命令展开。 */
function literal(value: string): string {
  return "'" + value.replaceAll("'", "''") + "'";
}

/** 等待测试子进程写入 PID，确认子进程已经启动后再验证取消行为。 */
async function waitForPid(path: string): Promise<number> {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    try {
      const text = await readFile(path, "utf8");
      if (/^\d+$/.test(text)) return Number(text);
    } catch (error) {
      if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") throw error;
    }
    await delay(50);
  }
  throw new Error("测试子进程未及时启动。");
}

test("真实 PowerShell 保留中文、工作目录和原生命令退出码", { skip: process.platform !== "win32" }, async (context) => {
  const workspace = await openWorkspace(await temporaryDirectory(context));
  const result = await runShell(workspace, {
    command: "[Console]::WriteLine('中文🙂'); [Console]::WriteLine((Get-Location).Path)",
  });
  assert.equal(result.status, "completed");
  assert.equal(result.exitCode, 0);
  assert.equal(result.truncated, false);
  assert.ok(result.output.includes("中文🙂"));
  assert.ok(result.output.includes(workspace.rootPath));
  const failure = await runShell(workspace, {
    command: `& ${literal(process.execPath)} -e ${literal("process.stderr.write('native error'); process.exit(7)")}`,
  });
  assert.equal(failure.exitCode, 7);
  assert.ok(failure.output.includes("native error"));
  const scriptError = await runShell(workspace, { command: "throw '测试失败'" });
  assert.equal(scriptError.exitCode, 1);
  assert.ok(scriptError.output.includes("测试失败"));
});

test("大量输出保留末尾并标记截断，不破坏 UTF-8 字符", { skip: process.platform !== "win32" }, async (context) => {
  const workspace = await openWorkspace(await temporaryDirectory(context));
  const result = await runShell(workspace, {
    command: `& ${literal(process.execPath)} -e ${literal("process.stdout.write('中文🙂'.repeat(20000) + 'END')")}`,
  });
  assert.equal(result.exitCode, 0);
  assert.equal(result.truncated, true);
  assert.ok(Buffer.byteLength(result.output, "utf8") <= 50 * 1024);
  assert.ok(result.output.endsWith("END"));
  assert.ok(!result.output.includes("\ufffd"));
});

test("超时和取消终止命令，取消同时终止仍在运行的子进程", { skip: process.platform !== "win32", timeout: 30000 }, async (context) => {
  const workspace = await openWorkspace(await temporaryDirectory(context));
  const timeout = await runShell(workspace, { command: "Start-Sleep -Seconds 60", timeoutSeconds: 1 });
  assert.equal(timeout.status, "timed_out");
  const pidFile = join(workspace.rootPath, "child.pid");
  const nodeScript = `require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setInterval(() => {}, 1000);`;
  const scriptPath = join(workspace.rootPath, "child.cjs");
  await writeFile(scriptPath, nodeScript, "utf8");
  const controller = new AbortController();
  const running = runShell(workspace, {
    command: `& ${literal(process.execPath)} ${literal(scriptPath)}`,
  }, controller.signal);
  // 注册后续清理，即使等待 PID 或断言失败也取消命令并等待退出。
  context.after(async () => { controller.abort(); await running; });
  const pid = await waitForPid(pidFile);
  controller.abort();
  const cancelled = await running;
  assert.equal(cancelled.status, "cancelled");
  assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
});

test("无效参数及预先取消不会启动命令", { skip: process.platform !== "win32" }, async (context) => {
  const workspace = await openWorkspace(await temporaryDirectory(context));
  await assert.rejects(runShell(workspace, { command: " " }), /不能为空/);
  await assert.rejects(runShell(workspace, { command: "exit", timeoutSeconds: 601 }), /1 到 600/);
  await assert.rejects(runShell(workspace, { command: "exit" }, AbortSignal.abort()), { name: "AbortError" });
});

test("执行中交付有节流的完整尾部快照，结束后可通过本地执行标识续读日志", { skip: process.platform !== "win32" }, async (context) => {
  const workspace = await openWorkspace(await temporaryDirectory(context));
  const host = { outputs: new OutputCache(await temporaryDirectory(context)), threadId: "thread" };
  const executionId = randomUUID();
  const updates: { at: number; output: string }[] = [];
  let completed = false;
  const result = await runShell(workspace, { command: [
    "[Console]::Write('中文🙂'); Start-Sleep -Milliseconds 250",
    "[Console]::Error.Write('错误片段'); Start-Sleep -Milliseconds 250",
    "[Console]::Write('结束'); Start-Sleep -Milliseconds 150",
  ].join("; ") }, undefined, host, { executionId, onUpdate(snapshot) {
    assert.equal(completed, false);
    updates.push({ at: performance.now(), output: snapshot.output });
  } });
  completed = true;
  assert.ok(updates.length >= 2);
  for (let index = 1; index < updates.length; index++) assert.ok(updates[index]!.at - updates[index - 1]!.at >= 95);
  assert.ok(updates.some((update) => update.output === "中文🙂错误片段"));
  assert.equal(result.output, "中文🙂错误片段结束");
  assert.equal(result.outputBytes, Buffer.byteLength(result.output));
  assert.equal(result.outputLines, 1);
  assert.ok(result.durationMs >= 650);
  assert.equal(result.outputId, executionId);
  assert.equal(result.artifactTruncated, false);
  assert.equal((await readOutputLog(host, { outputId: executionId })).content, result.output);
});

test("日志上限独立于命令尾部，保存失败保留退出码和副作用且不会重跑", { skip: process.platform !== "win32" }, async (context) => {
  const workspace = await openWorkspace(await temporaryDirectory(context));
  const data = await temporaryDirectory(context);
  const host = { outputs: new OutputCache(data, { artifactBytes: 1023, cacheBytes: 8192 }), threadId: "thread" };
  const capped = await runShell(workspace, { command: "[Console]::Write(('🙂' * 1000) + 'END')" }, undefined, host);
  assert.equal(capped.output, "🙂".repeat(1000) + "END");
  assert.equal(capped.truncated, false);
  assert.equal(capped.artifactTruncated, true);
  assert.equal((await readOutputLog(host, { outputId: capped.outputId! })).content, "🙂".repeat(255));
  for (const method of ["append", "finish"] as const) {
    const marker = `${method}.txt`;
    const failure = context.mock.method(OutputLog.prototype, method, async () => { throw new Error("测试磁盘写入失败"); });
    try {
      const result = await runShell(workspace, {
        command: `Add-Content -LiteralPath '${marker}' -Value '一次'; [Console]::Write('实际输出'); exit 7`,
      }, undefined, host);
      assert.equal(result.status, "completed");
      assert.equal(result.exitCode, 7);
      assert.equal(result.output, "实际输出");
      assert.equal(result.outputId, null);
      assert.match(result.logError!, /磁盘写入失败.*|日志保存失败/);
      assert.equal((await readFile(join(workspace.rootPath, marker), "utf8")).replace(/^\ufeff/, ""), "一次\r\n");
    } finally { failure.mock.restore(); }
  }
  assert.equal((await readdir(join(data, "outputs"))).length, 2);
});

test("慢日志写入提供背压，取消等待在途写入结束并保存已取得的输出", { skip: process.platform !== "win32", timeout: 15000 }, async (context) => {
  const workspace = await openWorkspace(await temporaryDirectory(context));
  const host = { outputs: new OutputCache(await temporaryDirectory(context)), threadId: "thread" };
  const controller = new AbortController();
  const append = OutputLog.prototype.append;
  let inFlight = 0;
  let peak = 0;
  let writes = 0;
  context.mock.method(OutputLog.prototype, "append", async function (this: OutputLog, text: string) {
    peak = Math.max(peak, ++inFlight);
    try {
      await delay(100);
      await append.call(this, text);
      if (++writes === 2) controller.abort();
    } finally { inFlight--; }
  });
  const script = join(workspace.rootPath, "slow.cjs");
  await writeFile(script, "setInterval(() => process.stdout.write('中文🙂'.repeat(8000)), 20);", "utf8");
  const running = runShell(workspace, { command: `& ${literal(process.execPath)} ${literal(script)}` }, controller.signal, host);
  context.after(async () => { controller.abort(); await running; });
  const result = await running;
  assert.equal(result.status, "cancelled");
  assert.equal(inFlight, 0);
  assert.equal(peak, 1);
  assert.ok(writes >= 2);
  assert.ok(result.outputBytes > 50 * 1024);
  assert.ok(!result.output.includes("\ufffd"));
  const saved = await readOutputLog(host, { outputId: result.outputId!, byteOffset: 0 });
  assert.ok(saved.content.length > 0);
  assert.equal(result.logError, undefined);
});

test("进度回调失败会停止真实子进程，再传播原始错误", { skip: process.platform !== "win32", timeout: 15000 }, async (context) => {
  const workspace = await openWorkspace(await temporaryDirectory(context));
  const pidFile = join(workspace.rootPath, "progress.pid");
  const script = join(workspace.rootPath, "progress.cjs");
  await writeFile(script, `require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); process.stdout.write('已启动'); setInterval(() => {}, 1000);`, "utf8");
  const controller = new AbortController();
  const running = runShell(workspace, { command: `& ${literal(process.execPath)} ${literal(script)}` }, controller.signal, undefined, {
    executionId: randomUUID(), onUpdate: async () => { throw new Error("进度通知失败"); },
  });
  const rejection = assert.rejects(running, /进度通知失败/);
  context.after(async () => { controller.abort(); await rejection; });
  const pid = await waitForPid(pidFile);
  await rejection;
  assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
});
