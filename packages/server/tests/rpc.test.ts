import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, rmSync, realpathSync, mkdirSync, writeFileSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { PassThrough, Writable } from "node:stream";
import { test, type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import type { RpcResponse, Thread } from "@tilot/protocol";
import { acquireServiceLock, Store } from "@tilot/store";
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

test("真实服务先取得排他锁再恢复遗留轮次，关闭后释放锁", { timeout: 10000 }, async (context) => {
  const directory = temporaryDirectory(context);
  const store = new Store(directory);
  const turn = store.startTurn(store.createThread("遗留任务").id, "原输入");
  const attempt = store.history.startAttempt(turn.id, store.listTurnInputs(turn.id)[0]!.id);
  const unlock = acquireServiceLock(directory);
  try {
    await assert.rejects(runServer(directory, ['{"id":"list","method":"thread.list","params":{}}']), /已有本地服务/);
    assert.equal(store.getTurn(turn.id)?.status, "running");
  } finally { unlock(); store.close(); }
  await runServer(directory, ['{"id":"list","method":"thread.list","params":{}}']);
  const reopened = new Store(directory);
  try {
    assert.equal(reopened.getTurn(turn.id)?.status, "interrupted");
    assert.equal(reopened.history.getAttempt(attempt.id)?.status, "interrupted");
    assert.equal(reopened.listTurnInputs(turn.id)[0]?.content, "原输入");
  } finally { reopened.close(); }
  acquireServiceLock(directory)();
});

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

// 选择目录仅是 UI 操作；创建时验证真实目录，已绑定路径在重命名和重开后保持固定。
test("项目任务解析目录链接并持久化，文件和失效目录不会创建任务", async (context) => {
  const directory = temporaryDirectory(context);
  const project = join(directory, "project");
  const alias = join(directory, "alias");
  mkdirSync(project);
  symlinkSync(project, alias, process.platform === "win32" ? "junction" : "dir");
  const file = join(directory, "file.txt");
  writeFileSync(file, "test", "utf8");
  const store = new Store(join(directory, "data"));
  const turns = new TurnManager(store, async () => {}, (error) => { throw error; });
  let threadId: string;
  try {
    for (const path of [file, join(directory, "missing")]) {
      const response = await handleRpcLine(store, JSON.stringify({ id: "invalid", method: "thread.create", params: { title: "无效项目", projectPath: path } }), turns);
      assert.equal(response.success, false);
    }
    assert.equal(store.listThreads().length, 0);
    const response = await handleRpcLine(store, JSON.stringify({ id: "valid", method: "thread.create", params: { title: "项目任务", projectPath: alias } }), turns);
    assert.equal(response.success, true);
    const thread = store.listThreads()[0]!;
    threadId = thread.id;
    assert.equal(thread.projectPath, realpathSync(project));
    await handleRpcLine(store, JSON.stringify({ id: "rename", method: "thread.rename", params: { threadId, title: "新名称", projectPath: directory } }), turns);
    assert.equal(store.getThread(threadId)?.projectPath, realpathSync(project));
  } finally { store.close(); }
  const reopened = new Store(join(directory, "data"));
  try { assert.equal(reopened.getThread(threadId!)?.projectPath, realpathSync(project)); }
  finally { reopened.close(); }
});

test("配置与凭据 RPC 保存并恢复多个服务，地址切换隔离密钥，删除服务同时删除密钥，响应不回显密钥", { timeout: 10000 }, async (context) => {
  const directory = temporaryDirectory(context);
  const store = new Store(directory);
  const original = store.getConfig();
  const provider = { ...original.providers[0]!, baseURL: "https://example.test/", models: [{ id: "saved-model", contextTokens: 65536 }] };
  const second = { id: "second", name: "second.test", baseURL: "https://second.test/", models: [{ id: "other-model", contextTokens: 65536 }] };
  const config = { ...original, model: "saved-model", providers: [provider, second] };
  store.close();
  const key = "local-test-rpc-secret";
  const requests = [
    { id: "config", method: "config.set", params: { config: { ...config, apiKey: key } } },
    { id: "save", method: "credentials.set", params: { providerId: "default", apiKey: key } },
    { id: "save-second", method: "credentials.set", params: { providerId: "second", apiKey: `${key}-2` } },
    { id: "empty", method: "credentials.set", params: { providerId: "default", apiKey: " " } },
    { id: "unknown", method: "credentials.set", params: { providerId: "missing", apiKey: key } },
    { id: "status", method: "credentials.status", params: {} },
    { id: "bad-budget", method: "config.set", params: { config: { ...config, providers: [{ ...provider, models: [{ id: "saved-model", contextTokens: 1 }] }, second] } } },
    { id: "bad-type", method: "config.set", params: { config: { ...config, maxStepsPerRun: "20" } } },
    { id: "read", method: "config.get", params: {} },
    { id: "change", method: "config.set", params: { config: { ...config, providers: [{ ...provider, baseURL: "https://other.test/" }, second] } } },
    { id: "changed-status", method: "credentials.status", params: {} },
    { id: "remove", method: "config.set", params: { config: { ...config, providers: [provider] } } },
    { id: "restore", method: "config.set", params: { config } },
    { id: "removed-status", method: "credentials.status", params: {} },
  ];
  const results = await runServer(directory, requests.map((request) => JSON.stringify(request)));
  assert.deepEqual(results[0], { id: "config", success: true, result: config });
  assert.deepEqual(results[1], { id: "save", success: true, result: null });
  assert.deepEqual(results[2], { id: "save-second", success: true, result: null });
  assert.equal(results[3]?.success, false);
  assert.equal(results[4]?.success, false);
  assert.deepEqual(results[5], { id: "status", success: true, result: { configured: ["default", "second"] } });
  assert.equal(results[6]?.success, false);
  assert.equal(results[7]?.success, false);
  assert.deepEqual(results[8], { id: "read", success: true, result: config });
  // 地址改了，旧密钥不会被用于新地址。
  assert.deepEqual(results[10], { id: "changed-status", success: true, result: { configured: ["second"] } });
  // 删除 second 服务后再加回来，它的密钥已经随之删除；default 恢复原地址后密钥重新可用。
  assert.deepEqual(results[13], { id: "removed-status", success: true, result: { configured: ["default"] } });
  assert.equal(JSON.stringify(results).includes(key), false);
});

test("模型列表使用填写或已保存的密钥加载，任务可单独切换模型和强度", async (context) => {
  // 本地服务模拟 GET /models，只接受 saved-key。
  const server = createServer((request, response) => {
    const ok = request.url === "/models" && request.headers.authorization === "Bearer saved-key";
    response.writeHead(ok ? 200 : 401, { "content-type": "application/json" });
    response.end(JSON.stringify(ok
      ? { object: "list", data: ["model-a", "model-b"].map((id) => ({ id, object: "model", created: 0, owned_by: "test" })) }
      : { error: { message: "密钥无效" } }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  context.after(() => server.close());
  const baseURL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const store = new Store(temporaryDirectory(context));
  try {
    const turns = new TurnManager(store, async () => {}, () => {});
    const call = (method: string, params: object) => handleRpcLine(store, JSON.stringify({ id: method, method, params }), turns);
    assert.deepEqual(await call("models.fetch", { providerId: "new", baseURL, apiKey: "saved-key" }), { id: "models.fetch", success: true, result: ["model-a", "model-b"] });
    assert.match(JSON.stringify(await call("models.fetch", { providerId: "new", baseURL, apiKey: " " })), /请填写 API Key/);
    assert.equal((await call("models.fetch", { providerId: "new", baseURL, apiKey: "wrong-key" })).success, false);
    const original = store.getConfig();
    const second = { id: "second", name: "second", baseURL, models: [{ id: "model-b", contextTokens: 131072 }] };
    store.saveConfig({ ...original, model: "model-a", providers: [{ ...original.providers[0]!, baseURL, models: [{ id: "model-a", contextTokens: 65536 }] }, second] });
    store.credentials.saveApiKey("default", baseURL, "saved-key");
    assert.equal((await call("models.fetch", { providerId: "default", baseURL, apiKey: "" })).success, true);
    assert.match(JSON.stringify(await call("models.fetch", { providerId: "second", baseURL, apiKey: "" })), /请填写 API Key/);

    const created = await call("thread.create", { title: "任务" });
    assert.ok(created.success);
    const thread = created.result as Thread;
    assert.equal(thread.model, "model-a");
    const updated = await call("thread.update", { threadId: thread.id, providerId: "second", model: "model-b", reasoningEffort: "low" });
    assert.deepEqual(updated, { id: "thread.update", success: true, result: { ...thread, providerId: "second", model: "model-b", reasoningEffort: "low" } });
    assert.equal((await call("thread.update", { threadId: thread.id, providerId: "default", model: "model-b", reasoningEffort: "low" })).success, false);
    assert.match(JSON.stringify(await call("thread.update", { threadId: thread.id, providerId: "default", model: "model-a", reasoningEffort: "extreme" })), /invalid_request/);
  } finally {
    store.close();
  }
});
