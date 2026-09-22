import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
import { openWorkspace, runShell } from "../src/index.ts";
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
