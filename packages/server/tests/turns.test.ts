import assert from "node:assert/strict";
import { EventEmitter, once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { PassThrough } from "node:stream";
import { test, type TestContext } from "node:test";
import type { RpcRequest, RpcResponse, ServerMessage } from "@tilot/protocol";
import { Store } from "@tilot/store";
import { serveStdio } from "../src/stdio.ts";

/** 启动本地模拟模型服务，先发送增量，再由测试决定何时发送终态。 */
async function mockModel(context: TestContext) {
  const pending: { response: ServerResponse; id: string }[] = [];
  const server = createServer((request, response) => {
    request.resume();
    const id = `response_${pending.length}`;
    pending.push({ response, id });
    response.writeHead(200, { "content-type": "text/event-stream" });
    const events = [
      { type: "response.created", response: { id, status: "in_progress", output: [] } },
      { type: "response.output_item.added", output_index: 0, item: { type: "reasoning", id: `${id}_reasoning`, status: "in_progress", summary: [], content: [] } },
      { type: "response.output_item.added", output_index: 1, item: { type: "message", id: `${id}_message`, role: "assistant", status: "in_progress", content: [] } },
      { type: "response.reasoning_text.delta", output_index: 0, item_id: `${id}_reasoning`, content_index: 0, delta: "思考" },
      { type: "response.output_text.delta", output_index: 1, item_id: `${id}_message`, content_index: 0, delta: "答" },
    ];
    for (const [sequence_number, event] of events.entries()) response.write(sse({ ...event, sequence_number }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  context.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  /** 为指定请求发送成功或失败终态，完整正文特意比增量长，以验证替换行为。 */
  function finish(index: number, failed = false): void {
    const { response, id } = pending[index]!;
    if (failed) {
      response.end(sse({ type: "response.failed", sequence_number: 5, response: { id, status: "failed", output: [], error: { message: "模拟模型失败" } } }));
      return;
    }
    const output = [
      { type: "reasoning", id: `${id}_reasoning`, status: "completed", summary: [], content: [{ type: "reasoning_text", text: "思考正文" }] },
      { type: "message", id: `${id}_message`, role: "assistant", status: "completed", content: [{ type: "output_text", text: "答案", annotations: [] }] },
    ];
    for (const [output_index, item] of output.entries()) response.write(sse({ type: "response.output_item.done", sequence_number: 5 + output_index, output_index, item }));
    response.end(sse({ type: "response.completed", sequence_number: 7, response: { id, status: "completed", output } }));
  }
  return { baseURL: `http://127.0.0.1:${address.port}`, finish };
}

/** 编码测试用 SSE 事件，正式模型传输仍由 OpenAI SDK 处理。 */
function sse(event: Record<string, unknown>): string {
  return `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
}

/** 创建完整服务连接及数据库，使用本地模拟模型地址和测试密钥。 */
function openSession(context: TestContext, baseURL: string) {
  const directory = mkdtempSync(join(tmpdir(), "tilot-turns-"));
  const store = new Store(directory);
  store.saveConfig({ ...store.getConfig(), baseURL });
  store.credentials.saveApiKey(baseURL, "local-test-only");
  const input = new PassThrough();
  const output = new PassThrough();
  const received: ServerMessage[] = [];
  const notifications = new EventEmitter();
  let buffer = "";
  output.setEncoding("utf8").on("data", (chunk: string) => {
    buffer += chunk;
    let end: number;
    while ((end = buffer.indexOf("\n")) !== -1) {
      received.push(JSON.parse(buffer.slice(0, end)) as ServerMessage);
      buffer = buffer.slice(end + 1);
      notifications.emit("message");
    }
  });
  const serving = serveStdio(store, input, output);
  // 出错断连测试会在后面断言拒绝，先挂接处理以免等待消息时出现未处理拒绝。
  void serving.catch(() => {});
  context.after(async () => {
    input.end();
    await serving.catch(() => {});
    input.destroy();
    output.destroy();
    store.close();
    assert.equal(dirname(directory), resolve(tmpdir()));
    rmSync(directory, { recursive: true, force: true });
  });
  /** 等待已收到或未来收到的消息，超时使测试失败而不是无限挂起。 */
  async function waitFor(predicate: (message: ServerMessage) => boolean): Promise<ServerMessage> {
    const signal = AbortSignal.timeout(3000);
    while (true) {
      const message = received.find(predicate);
      if (message) return message;
      await once(notifications, "message", { signal });
    }
  }
  /** 发送请求并只等待它的应答，期间允许交错收到模型推送事件。 */
  async function request(value: RpcRequest): Promise<RpcResponse> {
    input.write(JSON.stringify(value) + "\n");
    const message = await waitFor((message) => "success" in message && message.id === value.id);
    assert.ok("success" in message);
    return message;
  }
  /** 启动一个任务的轮次，并确认返回的是执行标识而非等待模型结束。 */
  async function start(threadId: string, id: string): Promise<string> {
    const result = await request({ id, method: "turn.start", params: { threadId, input: "输入", instructions: "测试策略" } });
    assert.ok(result.success && result.result && !Array.isArray(result.result) && "threadId" in result.result);
    return result.result.id;
  }
  return { store, input, output, serving, received, waitFor, request, start };
}

test("启动立即应答，并行任务事件有序且互不串流，完成内容替换预览", { timeout: 10000 }, async (context) => {
  const model = await mockModel(context);
  const session = openSession(context, model.baseURL);
  const thread = session.store.createThread("第一个任务");
  const first = await session.start(thread.id, "start-first");
  await session.waitFor((message) => "event" in message && message.event === "message.delta" && message.turnId === first);
  const duplicate = await session.request({ id: "duplicate", method: "turn.start", params: { threadId: thread.id, input: "重复", instructions: "" } });
  assert.equal(duplicate.success, false);
  const second = await session.start(session.store.createThread("第二个任务").id, "start-second");
  await session.waitFor((message) => "event" in message && message.event === "message.delta" && message.turnId === second);
  assert.equal((await session.request({ id: "config", method: "config.get", params: {} })).success, true);
  model.finish(1);
  await session.waitFor((message) => "event" in message && message.event === "turn.finished" && message.turn.id === second);
  assert.equal(session.store.getTurn(first)?.status, "running");
  model.finish(0);
  await session.waitFor((message) => "event" in message && message.event === "turn.finished" && message.turn.id === first);
  const events = session.received.filter((message) => "event" in message);
  assert.deepEqual(events.map((event) => event.seq), events.map((_event, index) => index + 1));
  const completed = events.flatMap((event) => event.event === "message.completed" && event.turnId === first ? [event.parts] : []);
  assert.deepEqual(completed, [[{ kind: "reasoning", text: "思考正文" }], [{ kind: "text", text: "答案" }]]);
  assert.equal(session.store.getTurn(first)?.status, "completed");
  assert.equal(JSON.stringify(events).includes("local-test-only"), false);
});

test("流中取消及时处理，输入关闭取消剩余请求并保存终态", { timeout: 10000 }, async (context) => {
  const model = await mockModel(context);
  const session = openSession(context, model.baseURL);
  const thread = session.store.createThread("取消");
  const turnId = await session.start(thread.id, "start");
  await session.waitFor((message) => "event" in message && message.event === "message.delta");
  assert.deepEqual(await session.request({ id: "cancel", method: "turn.interrupt", params: { turnId } }),
    { id: "cancel", success: true, result: { interrupted: true } });
  await session.waitFor((message) => "event" in message && message.event === "turn.finished" && message.turn.id === turnId);
  assert.equal(session.store.getTurn(turnId)?.status, "cancelled");
  assert.deepEqual(await session.request({ id: "cancel-again", method: "turn.interrupt", params: { turnId } }),
    { id: "cancel-again", success: true, result: { interrupted: false } });
  const second = await session.start(thread.id, "next");
  session.input.end();
  await session.serving;
  assert.equal(session.store.getTurn(second)?.status, "cancelled");
  assert.equal(session.store.history.listAttempts(second)[0]?.status, "cancelled");
});

test("缺少密钥不创建轮次，模型失败和输出断连均正确收尾", { timeout: 10000 }, async (context) => {
  const model = await mockModel(context);
  const session = openSession(context, model.baseURL);
  const thread = session.store.createThread("错误路径");
  session.store.credentials.deleteApiKey();
  const missing = await session.request({ id: "missing", method: "turn.start", params: { threadId: thread.id, input: "输入", instructions: "" } });
  assert.equal(missing.success, false);
  assert.deepEqual(session.store.listTurns(thread.id), []);
  session.store.credentials.saveApiKey(model.baseURL, "local-test-only");
  const failed = await session.start(thread.id, "failed");
  await session.waitFor((message) => "event" in message && message.event === "message.delta" && message.turnId === failed);
  model.finish(0, true);
  await session.waitFor((message) => "event" in message && message.event === "turn.finished" && message.turn.id === failed);
  assert.equal(session.store.getTurn(failed)?.status, "failed");
  assert.equal(session.received.some((message) => "event" in message && message.event === "message.completed"), false);
  const disconnected = await session.start(thread.id, "disconnect");
  await session.waitFor((message) => "event" in message && message.event === "message.delta" && message.turnId === disconnected);
  session.output.destroy(new Error("桌面连接断开"));
  await assert.rejects(session.serving, /桌面连接断开/);
  assert.equal(session.store.getTurn(disconnected)?.status, "cancelled");
});
