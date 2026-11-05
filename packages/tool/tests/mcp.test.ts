import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test, type TestContext } from "node:test";
import { McpManager, createToolSet, openWorkspace, OutputCache, readOutputLog } from "../src/index.ts";
import { loadMcpConfig } from "../src/mcp-config.ts";
import { mcpToolName } from "../src/mcp.ts";
import { MAX_OUTPUT_BYTES } from "../src/text.ts";
import { temporaryDirectory } from "./helpers.ts";
import { ImageStore } from "../../store/src/images.ts";
import { png } from "./image-fixture.ts";
// @ts-expect-error 独立子进程夹具共用于 HTTP 测试，不属于产品源码。
import { fixture } from "./mcp-fixture.mjs";

async function setup(context: TestContext) {
  const directory = await temporaryDirectory(context);
  const path = join(directory, "mcp.json");
  const manager = new McpManager(path);
  context.after(() => manager.close());
  const host = { threadId: "thread", outputs: new OutputCache(directory) };
  const workspace = await openWorkspace(directory);
  const save = (servers: Record<string, unknown>) => writeFile(path, JSON.stringify({ mcpServers: servers }), "utf8");
  return { path, manager, host, workspace, save };
}

test("MCP 直接、内嵌和资源链接图片完整传递，某张失败不丢实际结果也不重跑工具", async (context) => {
  const { manager, host, workspace, save } = await setup(context); const remote = await http(context);
  remote.service.setCapabilities({ tools: {}, resources: {} });
  const images = new ImageStore(workspace.rootPath); const mediaHost = { ...host, images };
  await save({ media: { url: remote.url } }); const snapshot = await manager.snapshot(mediaHost);
  const tools = createToolSet(workspace, mediaHost, { mode: "full-access" }, snapshot.tools);
  const output = await tools.execute("mcp__media__inspect", '{"kind":"pictures"}');
  assert.ok(Array.isArray(output)); assert.equal(output.length, 4);
  const text = output[0]!.type === "input_text" ? output[0]!.text : "";
  assert.match(text, /远端操作已经完成/); assert.match(text, /图片资源丢失/); assert.match(text, /不要.*重跑/);
  assert.match(text, /sideEffects/); assert.equal(JSON.parse(text).status, "ok");
  assert.equal(remote.service.calls.length, 1);
  assert.deepEqual(remote.service.resources, ["fixture://good.png", "fixture://missing.png"]);
  const hydrated = await images.hydrate([{ type: "function_call_output", call_id: "call", output }]);
  assert.equal(JSON.stringify(hydrated).split(png.toString("base64")).length - 1, 3);
  await snapshot.release();
});

async function http(context: TestContext, discovery?: { gate: Promise<void>; onList: () => void }) {
  const service = fixture();
  const headers: (string | undefined)[] = [];
  let drops = 0;
  let sessions = 0;
  let expired = false;
  let sessionCalls = 0;
  const called = Promise.withResolvers<void>();
  const server = createServer(async (request, response) => {
    if (request.method !== "POST") { response.writeHead(405).end(); return; }
    headers.push(request.headers.authorization);
    if (request.url === "/broken") { response.writeHead(403).end("denied test-private-token"); return; }
    let body = "";
    for await (const chunk of request) body += chunk;
    const input = JSON.parse(body);
    if (request.url === "/session") {
      if (input.method === "tools/call") sessionCalls++;
      if (input.method === "initialize") {
        sessions++;
        expired = false;
        response.setHeader("mcp-session-id", `session-${sessions}`);
      } else if (input.method !== "server/discover" && (expired || request.headers["mcp-session-id"] !== `session-${sessions}`)) {
        response.writeHead(404).end("Session expired");
        return;
      }
    }
    if (input.method === "tools/list" && discovery) { discovery.onList(); await discovery.gate; }
    if (input.method === "tools/call") called.resolve();
    if (input.method === "tools/call" && input.params.arguments?.kind === "drop") { drops++; response.destroy(); return; }
    const result = await service.handle(input);
    if (!result) { response.writeHead(202).end(); return; }
    if (request.url === "/sse") response.writeHead(200, { "content-type": "text/event-stream" }).end(`event: message\ndata: ${JSON.stringify(result)}\n\n`);
    else response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(result));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  context.after(async () => { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return { url: `http://127.0.0.1:${address.port}/mcp`, service, headers, called: called.promise, get drops() { return drops; },
    get sessions() { return sessions; }, get sessionCalls() { return sessionCalls; }, expire() { expired = true; } };
}

test("配置缺失、坏 JSON、局部错误、环境变量与禁用服务分别处理，不回显密钥", async (context) => {
  const { path, save } = await setup(context);
  assert.deepEqual(await loadMcpConfig(path), { servers: [], warnings: [] });
  await writeFile(path, '{"secret":"never-echo",', "utf8");
  const invalid = await loadMcpConfig(path);
  assert.equal(invalid.warnings.length, 1);
  assert.doesNotMatch(invalid.warnings.join(), /never-echo/);
  const previous = process.env.TILOT_TEST_MCP_TOKEN;
  process.env.TILOT_TEST_MCP_TOKEN = "test-private-token";
  context.after(() => { if (previous === undefined) delete process.env.TILOT_TEST_MCP_TOKEN; else process.env.TILOT_TEST_MCP_TOKEN = previous; });
  await save({ good: { url: "https://example.com/mcp", headers: { Authorization: "Bearer ${TILOT_TEST_MCP_TOKEN}" } },
    off: { enabled: false }, bad: { command: "node", cwd: "C:/" }, missing: { command: "node", env: { KEY: "${TILOT_MCP_UNSET_VARIABLE}" } } });
  const parsed = await loadMcpConfig(path);
  assert.equal(parsed.servers.length, 1);
  assert.equal(parsed.servers[0]!.headers.Authorization, "Bearer test-private-token");
  assert.equal(parsed.servers[0]!.timeoutMs, 120000);
  assert.equal(parsed.warnings.length, 2);
});

test("stdio 真实启动、固定主目录、连接复用、配置快照和停用后的回收", { timeout: 20000 }, async (context) => {
  const { manager, save, host } = await setup(context);
  const local = (version: string) => ({ command: process.execPath, args: [fileURLToPath(new URL("./mcp-fixture.mjs", import.meta.url))], env: { TILOT_MCP_VERSION: version } });
  await save({ local: local("1") });
  const first = await manager.snapshot(host);
  assert.deepEqual(first.warnings, []);
  const call = async (snapshot: typeof first) => JSON.parse(String((await snapshot.tools[0]!.execute({ value: "你好" }) as { output: string }).output));
  const a = await call(first);
  assert.equal(a.cwd.toLowerCase(), homedir().toLowerCase());
  assert.equal(a.version, "1");
  const same = await manager.snapshot(host);
  assert.equal((await call(same)).pid, a.pid);
  await save({ local: local("2") });
  const next = await manager.snapshot(host);
  assert.equal((await call(next)).version, "2");
  assert.equal((await call(first)).version, "1");
  await first.release(); await first.release(); await same.release();
  await assert.rejects(first.tools[0]!.execute({}));
  await save({});
  const disabled = await manager.snapshot(host);
  assert.equal(disabled.tools.length, 0);
  assert.equal((await call(next)).version, "2");
  await next.release(); await disabled.release();
  await assert.rejects(next.tools[0]!.execute({}));
});

test("HTTP Header、每轮工具发现及名称适配，坏服务不阻塞好服务且错误隐藏凭据", { timeout: 10000 }, async (context) => {
  const remote = await http(context);
  const { manager, save, host } = await setup(context);
  await save({ remote: { url: remote.url, headers: { Authorization: "Bearer test-private-token" } }, broken: { url: remote.url.replace("/mcp", "/broken"), headers: { Authorization: "Bearer test-private-token" } } });
  const first = await manager.snapshot(host);
  assert.equal(first.tools.length, 1);
  assert.equal(first.warnings.length, 1);
  assert.doesNotMatch(first.warnings[0]!, /test-private-token/);
  assert.equal(first.tools[0]!.definition.description, "检查 1");
  remote.service.setRevision("2");
  const next = await manager.snapshot(host);
  assert.equal(next.tools[0]!.definition.description, "检查 2");
  assert.equal(first.tools[0]!.definition.description, "检查 1");
  assert.ok(remote.headers.every((header) => header === "Bearer test-private-token"));
  const strange = mcpToolName("服务", "工具".repeat(80));
  assert.match(strange, /^[A-Za-z0-9_-]{1,64}$/);
  assert.notEqual(strange, mcpToolName("其他服务", "工具".repeat(80)));
  await first.release(); await next.release();
});

test("MCP 只读拒绝、逐次审批及拒绝不执行，完全访问跳过审批，业务失败保留输出", { timeout: 10000 }, async (context) => {
  const remote = await http(context);
  const { manager, save, host, workspace } = await setup(context);
  await save({ remote: { url: remote.url } });
  const snapshot = await manager.snapshot(host);
  let approvals = 0;
  let allowed = false;
  const approve = async () => { approvals++; return allowed; };
  const readonly = createToolSet(workspace, host, { mode: "read-only", approve }, snapshot.tools);
  const name = snapshot.tools[0]!.definition.name;
  assert.ok(!readonly.definitions.some((definition) => definition.name === name));
  assert.equal(JSON.parse(String(await readonly.execute(name, "{}"))).status, "error");
  const tools = createToolSet(workspace, host, { mode: "workspace-write", approve }, snapshot.tools);
  assert.equal(JSON.parse(String(await tools.execute(name, "{}", undefined, { executionId: "denied" }))).status, "error");
  assert.equal(remote.service.calls.length, 0);
  allowed = true;
  assert.equal(JSON.parse(String(await tools.execute(name, "{}", undefined, { executionId: "accepted" }))).status, "ok");
  const failure = JSON.parse(String(await tools.execute(name, '{"kind":"fail"}', undefined, { executionId: "failed" })));
  assert.equal(failure.status, "error");
  assert.equal(failure.data.output, "远端执行失败");
  assert.equal(approvals, 3);
  const full = createToolSet(workspace, host, { mode: "full-access", approve: async () => { throw new Error("不应审批"); } }, snapshot.tools);
  assert.deepEqual(full.definitions, tools.definitions);
  assert.equal(JSON.parse(String(await full.execute(name, "{}"))).status, "ok");
  await snapshot.release();
});

test("文本/JSON 去重、多模态提示、50 KiB 长行完整续读及任务隔离", { timeout: 10000 }, async (context) => {
  const remote = await http(context);
  const { manager, save, host, workspace } = await setup(context);
  await save({ remote: { url: remote.url } });
  const snapshot = await manager.snapshot(host);
  const tools = createToolSet(workspace, host, { mode: "full-access" }, snapshot.tools);
  const name = snapshot.tools[0]!.definition.name;
  const invoke = async (kind: string) => {
    const result = JSON.parse(String(await tools.execute(name, JSON.stringify({ kind }))));
    assert.equal(result.status, "ok", JSON.stringify(result));
    return result;
  };
  assert.equal((await invoke("structured")).data.output, '{"value":"中文"}');
  assert.match((await invoke("image")).data.output, /暂不支持.*image/);
  const long = (await invoke("long")).data;
  assert.ok(Buffer.byteLength(long.output) <= MAX_OUTPUT_BYTES);
  let text = long.output;
  let position: number | null = long.nextByteOffset;
  while (position !== null) {
    const page = await readOutputLog(host, { outputId: long.outputId, byteOffset: position });
    assert.ok("nextByteOffset" in page);
    text += page.content;
    position = page.nextByteOffset;
  }
  assert.equal(text, "长行🙂".repeat(18000));
  await assert.rejects(readOutputLog({ ...host, threadId: "other" }, { outputId: long.outputId }), /不能读取其他任务/);
  await snapshot.release();
});

test("取消与超时只结束当前调用、不关闭共享连接，断线调用不自动重试", { timeout: 10000 }, async (context) => {
  const remote = await http(context);
  const { manager, save, host } = await setup(context);
  await save({ remote: { url: remote.url, timeoutMs: 80 } });
  const first = await manager.snapshot(host);
  const other = await manager.snapshot({ ...host, threadId: "other" });
  const controller = new AbortController();
  const pending = first.tools[0]!.execute({ kind: "wait", delay: 200 }, controller.signal);
  await remote.called;
  controller.abort();
  await assert.rejects(pending, { name: "AbortError" });
  await remote.service.cancellation;
  assert.ok(await other.tools[0]!.execute({}));
  await assert.rejects(first.tools[0]!.execute({ kind: "wait", delay: 200 }), /timed out|timeout/i);
  assert.ok(await other.tools[0]!.execute({}));
  await assert.rejects(first.tools[0]!.execute({ kind: "drop" }));
  assert.equal(remote.drops, 1);
  await first.release(); await other.release();
});

test("缓存保存失败仍保留远端实际结果和预览，不重跑调用", { timeout: 10000 }, async (context) => {
  const remote = await http(context);
  const { manager, save, host, workspace } = await setup(context);
  await save({ remote: { url: remote.url } });
  const snapshot = await manager.snapshot(host);
  context.mock.method(host.outputs, "create", async () => { throw new Error("磁盘已满"); });
  const tools = createToolSet(workspace, host, { mode: "full-access" }, snapshot.tools);
  const result = JSON.parse(String(await tools.execute(snapshot.tools[0]!.definition.name, '{"kind":"long"}')));
  assert.equal(result.status, "ok");
  assert.ok(result.data.output.length > 0);
  assert.match(result.data.logError, /远端调用已经结束.*磁盘已满/);
  assert.equal(result.data.outputId, undefined);
  assert.equal(remote.service.calls.length, 1);
  await snapshot.release();
});

test("名称包含命名空间分隔符时不碰撞，普通名称保持不变", () => {
  assert.notEqual(mcpToolName("a__b", "c"), mcpToolName("a", "b__c"));
  assert.notEqual(mcpToolName("a_", "b"), mcpToolName("a", "_b"));
  assert.equal(mcpToolName("local", "inspect"), "mcp__local__inspect");
});

test("仅提供资源能力的合法服务不触发 SDK 调试输出污染宿主协议", { timeout: 10000 }, async (context) => {
  const remote = await http(context);
  remote.service.setCapabilities({ resources: {} });
  const { manager, save, host } = await setup(context);
  await save({ resources: { url: remote.url } });
  const debug: unknown[] = [];
  context.mock.method(console, "debug", (...args: unknown[]) => { debug.push(...args); });
  const snapshot = await manager.snapshot(host);
  assert.deepEqual(snapshot.tools, []);
  assert.deepEqual(snapshot.warnings, []);
  assert.deepEqual(debug, []);
  await snapshot.release();
});

test("Streamable HTTP 的 POST 流式响应可发现并调用工具", { timeout: 10000 }, async (context) => {
  const remote = await http(context);
  const { manager, save, host } = await setup(context);
  await save({ streaming: { url: remote.url.replace("/mcp", "/sse") } });
  const snapshot = await manager.snapshot(host);
  assert.deepEqual(snapshot.warnings, []);
  assert.equal(snapshot.tools.length, 1);
  const result = await snapshot.tools[0]!.execute({ value: "流式结果" }) as { output: string };
  assert.equal(JSON.parse(result.output).value, "流式结果");
  await snapshot.release();
});

test("发现工具期间停止一个对话，不取消另一对话的发现或关闭共享连接", { timeout: 10000 }, async (context) => {
  const gate = Promise.withResolvers<void>();
  const bothListed = Promise.withResolvers<void>();
  let lists = 0;
  const remote = await http(context, { gate: gate.promise, onList: () => { if (++lists === 2) bothListed.resolve(); } });
  context.after(() => gate.resolve());
  const { manager, save, host } = await setup(context);
  await save({ remote: { url: remote.url } });
  const controller = new AbortController();
  const first = manager.snapshot(host, controller.signal);
  const other = manager.snapshot({ ...host, threadId: "other" });
  await bothListed.promise;
  controller.abort();
  await assert.rejects(first, { name: "AbortError" });
  gate.resolve();
  const snapshot = await other;
  assert.deepEqual(snapshot.warnings, []);
  assert.ok(await snapshot.tools[0]!.execute({}));
  await snapshot.release();
});

test("发现或调用时 HTTP 会话过期，当前操作不重试，下一轮重新初始化后恢复", { timeout: 10000 }, async (context) => {
  for (const duringCall of [false, true]) {
    const remote = await http(context);
    const { manager, save, host } = await setup(context);
    await save({ remote: { url: remote.url.replace("/mcp", "/session") } });
    const first = await manager.snapshot(host);
    assert.equal(first.tools.length, 1);
    assert.equal(remote.sessions, 1);
    remote.expire();
    if (duringCall) {
      await assert.rejects(first.tools[0]!.execute({}), /Session expired|404/);
      assert.equal(remote.sessionCalls, 1);
    } else {
      const failed = await manager.snapshot(host);
      assert.equal(failed.tools.length, 0);
      assert.match(failed.warnings.join(), /Session expired|404/);
      await failed.release();
    }
    assert.equal(remote.sessions, 1);
    const next = await manager.snapshot(host);
    assert.deepEqual(next.warnings, []);
    assert.equal(remote.sessions, 2);
    assert.ok(await next.tools[0]!.execute({}));
    await first.release(); await next.release();
  }
});
