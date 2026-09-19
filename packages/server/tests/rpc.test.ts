import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { PassThrough, Writable } from "node:stream";
import { test, type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import type { RpcResponse } from "@tilot/protocol";
import { Store } from "@tilot/store";
import { handleRpcLine } from "../src/rpc.ts";
import { serveStdio } from "../src/stdio.ts";
import { TurnManager } from "../src/turn-manager.ts";

/** 分配独立测试目录，删除前确认它属于系统临时目录。 */
function temporaryDirectory(context: TestContext): string {
  const directory = mkdtempSync(join(tmpdir(), "tilot-server-"));
  context.after(() => {
    assert.equal(dirname(directory), resolve(tmpdir()));
    rmSync(directory, { recursive: true, force: true });
  });
  return directory;
}

/** 启动真实 Node 服务并收集协议输出；输入按字节拆分，覆盖中文 UTF-8 跨块情况。 */
async function runServer(directory: string, lines: string[]): Promise<RpcResponse[]> {
  const entry = fileURLToPath(new URL("../src/main.ts", import.meta.url));
  const child = spawn(process.execPath, [entry, directory], { windowsHide: true, stdio: "pipe" });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8").on("data", (chunk: string) => { stdout += chunk; });
  child.stderr.setEncoding("utf8").on("data", (chunk: string) => { stderr += chunk; });
  const closed = new Promise<void>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code) => code === 0 ? resolve() : reject(new Error(`服务退出 ${code}: ${stderr}`)));
  });
  for (const byte of Buffer.from(lines.join("\r\n") + "\r\n", "utf8")) child.stdin.write(Buffer.from([byte]));
  child.stdin.end();
  await closed;
  assert.equal(stderr, "");
  return stdout.trim().split("\n").map((line) => JSON.parse(line) as RpcResponse);
}

test("真实服务按 UTF-8 行协议处理任务请求，坏请求不影响后续操作，退出后可重开", { timeout: 10000 }, async (context) => {
  const directory = temporaryDirectory(context);
  const first = await runServer(directory, [
    "not-json",
    JSON.stringify({ id: "create", method: "thread.create", params: { title: "中文\n任务" } }),
    JSON.stringify({ id: "list", method: "thread.list", params: {} }),
  ]);
  assert.equal(first.length, 3);
  assert.deepEqual(first[0], { id: null, success: false, error: { code: "invalid_request", message: "请求不是有效的 JSON。" } });
  const createdResponse = first[1]!;
  assert.ok(createdResponse.success);
  const created = createdResponse.result;
  assert.ok(created && !Array.isArray(created) && "title" in created);
  assert.equal(created.title, "中文\n任务");
  assert.equal(created.projectPath, null);
  const second = await runServer(directory, [
    JSON.stringify({ id: "rename", method: "thread.rename", params: { threadId: created.id, title: "新标题" } }),
    JSON.stringify({ id: "read", method: "thread.read", params: { threadId: created.id } }),
  ]);
  const readResponse = second[1]!;
  assert.ok(readResponse.success);
  assert.ok(readResponse.result && !Array.isArray(readResponse.result) && "title" in readResponse.result);
  assert.equal(readResponse.result.title, "新标题");
});

test("RPC 校验参数与项目目录，未知方法和无效操作不会创建任务", async (context) => {
  const directory = temporaryDirectory(context);
  const store = new Store(directory);
  const turns = new TurnManager(store, async () => {}, (error) => { throw error; });
  try {
    const samples = [
      { id: "unknown", method: "unknown", params: {} },
      { id: "type", method: "thread.create", params: { title: 12 } },
      { id: "path", method: "thread.create", params: { title: "无效目录", projectPath: "relative" } },
      { id: "limit", method: "thread.list", params: { limit: -1 } },
    ];
    for (const request of samples) {
      const result = await handleRpcLine(store, JSON.stringify(request), turns);
      assert.equal(result.id, request.id);
      assert.equal(result.success, false);
    }
    assert.deepEqual(store.listThreads(), []);
    const result = await handleRpcLine(store, JSON.stringify({ id: "valid", method: "thread.create", params: { title: "项目", projectPath: directory } }), turns);
    assert.equal(result.success, true);
    assert.equal(store.listThreads()[0]?.projectPath, realpathSync(directory));
    assert.deepEqual(await handleRpcLine(store, JSON.stringify({ id: "missing", method: "thread.read", params: { threadId: "missing" } }), turns),
      { id: "missing", success: true, result: null });
  } finally {
    store.close();
  }
});

test("输出连接失败结束服务循环，不吞掉传输错误", async (context) => {
  const store = new Store(temporaryDirectory(context));
  const input = new PassThrough();
  const output = new Writable({ write(_chunk, _encoding, callback) { callback(new Error("输出连接断开")); } });
  try {
    const serving = serveStdio(store, input, output);
    input.end(JSON.stringify({ id: "list", method: "thread.list", params: {} }) + "\n");
    await assert.rejects(serving, /输出连接断开/);
  } finally {
    input.destroy();
    output.destroy();
    store.close();
  }
});

test("配置与凭据 RPC 保存并恢复设置，地址切换隔离密钥，响应不回显密钥", { timeout: 10000 }, async (context) => {
  const directory = temporaryDirectory(context);
  const store = new Store(directory);
  const config = { ...store.getConfig(), baseURL: "https://example.test", model: "saved-model" };
  store.close();
  const key = "local-test-rpc-secret";
  const requests = [
    { id: "config", method: "config.set", params: { config: { ...config, apiKey: key } } },
    { id: "save", method: "credentials.set", params: { baseURL: config.baseURL, apiKey: key } },
    { id: "empty", method: "credentials.set", params: { baseURL: config.baseURL, apiKey: " " } },
    { id: "status", method: "credentials.status", params: {} },
    { id: "bad-budget", method: "config.set", params: { config: { ...config, contextBudgetTokens: 1 } } },
    { id: "bad-type", method: "config.set", params: { config: { ...config, maxStepsPerRun: "20" } } },
    { id: "read", method: "config.get", params: {} },
    { id: "change", method: "config.set", params: { config: { ...config, baseURL: "https://other.test" } } },
    { id: "other-status", method: "credentials.status", params: {} },
  ];
  const results = await runServer(directory, requests.map((request) => JSON.stringify(request)));
  assert.deepEqual(results[0], { id: "config", success: true, result: config });
  assert.deepEqual(results[1], { id: "save", success: true, result: null });
  assert.equal(results[2]?.success, false);
  assert.deepEqual(results[3], { id: "status", success: true, result: { configured: true } });
  assert.equal(results[4]?.success, false);
  assert.equal(results[5]?.success, false);
  assert.deepEqual(results[6], { id: "read", success: true, result: config });
  assert.deepEqual(results[8], { id: "other-status", success: true, result: { configured: false } });
  assert.equal(JSON.stringify(results).includes(key), false);
  const reopened = await runServer(directory, [
    JSON.stringify({ id: "restore", method: "config.set", params: { config } }),
    JSON.stringify({ id: "exists", method: "credentials.status", params: {} }),
    JSON.stringify({ id: "delete", method: "credentials.delete", params: {} }),
    JSON.stringify({ id: "deleted", method: "credentials.status", params: {} }),
  ]);
  assert.deepEqual(reopened[1], { id: "exists", success: true, result: { configured: true } });
  assert.deepEqual(reopened[3], { id: "deleted", success: true, result: { configured: false } });
});
