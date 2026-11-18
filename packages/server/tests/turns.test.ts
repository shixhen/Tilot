import assert from "node:assert/strict";
import { EventEmitter, once } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { PassThrough } from "node:stream";
import { test, type TestContext } from "node:test";
import type { ResponseUsage } from "openai/resources/responses/responses";
import type { Response as ModelResponse } from "openai/resources/responses/responses";
import type { RpcRequest, RpcResponse, ServerMessage } from "@tilot/protocol";
import { Store } from "@tilot/store";
import { serveStdio } from "../src/stdio.ts";
import { readPrompt } from "@tilot/context";
import { McpManager } from "@tilot/tool";
import { fileURLToPath } from "node:url";
import { emptyQuestionDraft, type QuestionGroup, type QuestionDelivery } from "@tilot/protocol";
import { type ImageRef, type ImageData, type Turn, type AttemptView } from "@tilot/protocol";
import { png } from "../../tool/tests/image-fixture.ts";
import { httpFixture } from "../../tool/tests/http-fixture.ts";

test("DeepSeek 首轮在工具调用后继续请求标题，保存后停止请求，手动标题优先", { timeout: 10000 }, async (context) => {
  const model = await mockModel(context);
  const fetch = globalThis.fetch;
  context.mock.method(globalThis, "fetch", (url: URL | Request | string, options?: RequestInit) => {
    const localURL = `${model.baseURL}/responses`;
    assert.ok([localURL, "https://api.deepseek.com/responses"].includes(String(url)));
    return fetch(localURL, options);
  });
  const session = openSession(context, "https://api.deepseek.com");
  async function createAndStart(id: string) {
    const created = await session.request({ id, method: "thread.create", params: { title: "首条消息", autoTitle: true } });
    assert.ok(created.success && created.result && !Array.isArray(created.result) && "title" in created.result);
    return { thread: created.result, turnId: await session.start(created.result.id, `${id}-start`) };
  }
  const waitStarted = (turnId: string, sequence: number) => session.waitFor((message) => "event" in message &&
    message.event === "attempt.updated" && message.turnId === turnId && message.attempt.sequence === sequence);
  const waitFinished = (turnId: string) => session.waitFor((message) => "event" in message && message.event === "turn.finished" && message.turn.id === turnId);

  const generated = await createAndStart("generated");
  await waitStarted(generated.turnId, 1);
  assert.deepEqual(model.requests[0]!.title, { enabled: true });
  const toolNames = (request: Record<string, unknown>) => (request.tools as { name: string }[]).map((tool) => tool.name);
  assert.ok(toolNames(model.requests[0]!).includes("find_files"));
  assert.ok(!toolNames(model.requests[0]!).includes("find"));
  assert.equal(session.store.getThread(generated.thread.id)?.title, "首条消息");
  writeFileSync(join(session.store.dataDirectory, "workspaces", generated.thread.id, "title-test.txt"), "", "utf8");
  const find = { name: "find_files", arguments: '{"pattern":"title-test.txt"}' };
  model.finish(0, false, [find]);
  await waitStarted(generated.turnId, 2);
  assert.deepEqual(model.requests[1]!.title, { enabled: true });
  assert.equal(session.store.getThread(generated.thread.id)?.title, "首条消息");
  assert.deepEqual(toolNames(model.requests[1]!), toolNames(model.requests[0]!));
  const replayed = model.requests[1]!.input as { type?: string; name?: string; call_id?: string; output?: string }[];
  const call = replayed.find((item) => item.type === "function_call");
  assert.equal(call?.name, "find_files");
  const result = replayed.find((item) => item.type === "function_call_output" && item.call_id === call?.call_id);
  assert.deepEqual(JSON.parse(result!.output!).data.files, ["title-test.txt"]);
  const shown = await session.waitFor((message) => "event" in message && message.event === "attempt.updated" &&
    message.turnId === generated.turnId && message.attempt.tools.some((tool) => tool.output !== null));
  assert.ok("event" in shown && shown.event === "attempt.updated");
  assert.equal(shown.attempt.tools[0]!.name, "find");
  model.finish(1, false, [find], undefined, "  自动\n标题  ");
  await session.waitFor((message) => "event" in message && message.event === "thread.title" && message.threadId === generated.thread.id);
  await waitStarted(generated.turnId, 3);
  assert.equal(model.requests[2]!.title, undefined);
  model.finish(2, false, [], undefined, "后续标题");
  await waitFinished(generated.turnId);
  const read = await session.request({ id: "read-title", method: "thread.read", params: { threadId: generated.thread.id } });
  assert.ok(read.success && read.result && !Array.isArray(read.result) && "title" in read.result);
  assert.equal(read.result.title, "自动 标题");

  const renamed = await createAndStart("renamed");
  await waitStarted(renamed.turnId, 1);
  assert.ok((await session.request({ id: "rename", method: "thread.rename", params: { threadId: renamed.thread.id, title: "我改的标题" } })).success);
  model.finish(3, false, [], undefined, "迟到的标题");
  await waitFinished(renamed.turnId);
  assert.equal(session.store.getThread(renamed.thread.id)?.title, "我改的标题");

  const fallback = await createAndStart("fallback");
  await waitStarted(fallback.turnId, 1);
  model.finish(4);
  await waitFinished(fallback.turnId);
  assert.equal(session.store.getThread(fallback.thread.id)?.title, "首条消息");
  const nextTurn = await session.start(fallback.thread.id, "fallback-next");
  await waitStarted(nextTurn, 1);
  assert.equal(model.requests[5]!.title, undefined);
  model.finish(5);
  await waitFinished(nextTurn);
  assert.equal(session.received.filter((message) => "event" in message && message.event === "thread.title").length, 1);

  const custom = openSession(context, model.baseURL);
  const customThread = custom.store.createThread("自定义服务", null, undefined, true);
  const customTurn = await custom.start(customThread.id, "custom");
  await custom.waitFor((message) => "event" in message && message.event === "message.delta" && message.turnId === customTurn);
  assert.equal(model.requests[6]!.title, undefined);
  assert.ok(toolNames(model.requests[6]!).includes("find"));
  assert.ok(!toolNames(model.requests[6]!).includes("find_files"));
  model.finish(6, false, [], undefined, "未请求的标题");
  await custom.waitFor((message) => "event" in message && message.event === "turn.finished" && message.turn.id === customTurn);
  assert.equal(custom.store.getThread(customThread.id)?.title, "自定义服务");

  const fast = session.store.createThread("快速模式", null, undefined, true);
  session.store.updateThreadModel(fast.id, fast.providerId, fast.model, "none");
  const fastTurn = await session.start(fast.id, "fast");
  await waitStarted(fastTurn, 1);
  assert.equal(model.requests[7]!.title, undefined);
  assert.ok(toolNames(model.requests[7]!).includes("find_files"));
  model.finish(7);
  await waitFinished(fastTurn);
  assert.equal(session.store.getThread(fast.id)?.title, "快速模式");
});

test("普通对话按需读取全局技能，后续请求刷新索引且坏文件每轮只提示一次", { timeout: 10000 }, async (context) => {
  const model = await mockModel(context);
  const session = openSession(context, model.baseURL);
  const path = join(session.globalSkillsDirectory, "guide", "SKILL.md");
  const invalidPath = join(session.globalSkillsDirectory, "invalid", "SKILL.md");
  mkdirSync(dirname(path), { recursive: true });
  mkdirSync(dirname(invalidPath), { recursive: true });
  const body = "仅通过工具读取的技能正文";
  writeFileSync(path, `---\nname: guide\ndescription: 初始技能描述\n---\n${body}`, "utf8");
  writeFileSync(invalidPath, "---\nname: invalid\n---\n缺少描述", "utf8");

  const thread = session.store.createThread("普通对话使用全局技能");
  const turnId = await session.start(thread.id, "start-global-skill");
  await session.waitFor((message) => "event" in message && message.event === "message.delta" && message.itemId === "response_0_message");
  const firstInstructions = String(model.requests[0]!.instructions);
  assert.match(firstInstructions, /初始技能描述/);
  assert.ok(firstInstructions.includes(JSON.stringify(path)));
  assert.ok(!firstInstructions.includes(body));
  assert.doesNotMatch(firstInstructions, /"name":"invalid"/);

  writeFileSync(path, `---\nname: guide\ndescription: 更新后的技能描述\n---\n${body}`, "utf8");
  model.finish(0, false, [{ name: "read", arguments: JSON.stringify({ path }) }]);
  await session.waitFor((message) => "event" in message && message.event === "message.delta" && message.itemId === "response_1_message");
  assert.match(String(model.requests[1]!.instructions), /更新后的技能描述/);
  const input = model.requests[1]!.input as { type?: string; output?: string }[];
  const result = JSON.parse(input.find((item) => item.type === "function_call_output")!.output!);
  assert.equal(result.status, "ok");
  assert.ok(result.data.content.includes(body));

  model.finish(1);
  await session.waitFor((message) => "event" in message && message.event === "turn.finished" && message.turn.id === turnId);
  assert.equal(session.store.getTurn(turnId)?.status, "completed");
  const notices = session.received.filter((message) => "event" in message && message.event === "turn.notice");
  assert.equal(notices.length, 1);
  assert.ok(notices[0]!.message.includes(invalidPath));
  assert.match(notices[0]!.message, /name 和 description/);
});

test("慢图片下载不会阻塞当前轮次的停止请求", { timeout: 10000 }, async (context) => {
  const model = await mockModel(context); const session = openSession(context, model.baseURL);
  const received = Promise.withResolvers<void>(); const release = Promise.withResolvers<void>();
  await httpFixture(context, (_request, response) => { received.resolve(); void release.promise.then(() => response.end(png)); });
  const thread = session.store.createThread("上传中停止"); const turnId = await session.start(thread.id, "start-slow");
  await session.waitFor((e) => "event" in e && e.event === "message.delta");
  const uploading = session.request({ id: "slow-image", method: "image.import", params: { url: "https://image.test/slow.png" } });
  await received.promise;
  await session.request({ id: "stop-slow", method: "turn.interrupt", params: { turnId } });
  await session.waitFor((e) => "event" in e && e.event === "turn.finished" && e.turn.id === turnId);
  assert.equal(session.store.getTurn(turnId)!.status, "cancelled");
  release.resolve(); assert.equal((await uploading).success, true);
});

test("启动与引导投递身份可跨重试和恢复核对，丢失确认也不会重复执行模型或工具", { timeout: 10000 }, async (context) => {
  const model = await mockModel(context); const session = openSession(context, model.baseURL);
  const thread = session.store.createThread("投递确认"); const image = await session.store.images.save(png, "图片.png");
  const params = { threadId: thread.id, input: "", images: [image], deliveryId: "stable-start" };
  const first = await session.request({ id: "first", method: "turn.start", params });
  assert.ok(first.success); const turnId = (first.result as Turn).id;
  const duplicate = await session.request({ id: "duplicate", method: "turn.start", params });
  assert.ok(duplicate.success); assert.equal((duplicate.result as Turn).id, turnId);
  await session.waitFor((e) => "event" in e && e.event === "message.delta" && e.itemId === "response_0_message");
  const steer = { turnId, input: "补充", images: [image], deliveryId: "stable-steer" };
  assert.equal((await session.request({ id: "steer", method: "turn.steer", params: steer })).success, true);
  assert.equal((await session.request({ id: "steer-again", method: "turn.steer", params: steer })).success, true);
  assert.equal(session.store.listTurnInputs(turnId).length, 2);
  model.finish(0); await session.waitFor((e) => "event" in e && e.event === "message.delta" && e.itemId === "response_1_message");
  model.finish(1); await session.waitFor((e) => "event" in e && e.event === "turn.finished" && e.turn.id === turnId);
  const receipts = await session.request({ id: "receipts", method: "input.receipts", params: { threadId: thread.id, deliveryIds: ["stable-start", "stable-steer", "not-sent"] } });
  assert.ok(receipts.success); assert.deepEqual(receipts.result, ["stable-start", "stable-steer"]);
  // 引导的应答丢失后，恢复队列尝试新开轮次，也只能得到原来的接收记录。
  const retry = await session.request({ id: "retry-as-start", method: "turn.start", params: { threadId: thread.id, input: steer.input, images: steer.images, deliveryId: steer.deliveryId } });
  assert.ok(retry.success); assert.equal((retry.result as Turn).id, turnId);
  const mismatch = await session.request({ id: "bad-reuse", method: "turn.start", params: { ...params, input: "换成另一项任务" } });
  assert.equal(mismatch.success, false); assert.equal(model.requests.length, 2);
  const reopened = new Store(session.store.dataDirectory);
  try {
    assert.deepEqual(reopened.inputReceipts(thread.id, ["stable-start", "stable-steer"]), ["stable-start", "stable-steer"]);
    assert.equal(reopened.findInputDelivery(thread.id, "stable-start", "", [image])!.turnId, turnId);
    assert.equal(reopened.listTurns(thread.id).length, 1);
  } finally { reopened.close(); }
});

test("图片 RPC 经真实进程协议支持纯图开始、运行中图片引导和工具缩略图引用", { timeout: 10000 }, async (context) => {
  const model = await mockModel(context); const session = openSession(context, model.baseURL);
  const imported = await session.request({ id: "image-import", method: "image.import", params: { base64: png.toString("base64"), name: "截图.png" } });
  assert.ok(imported.success); const image = imported.result as ImageRef;
  const read = await session.request({ id: "image-read", method: "image.read", params: { imageId: image.id } });
  assert.ok(read.success); assert.equal((read.result as ImageData).dataUrl, `data:image/png;base64,${png.toString("base64")}`);
  const thread = session.store.createThread("纯图对话");
  const started = await session.request({ id: "image-start", method: "turn.start", params: { threadId: thread.id, input: "", images: [image] } });
  assert.ok(started.success); const turnId = (started.result as Turn).id;
  await session.waitFor((e) => "event" in e && e.event === "message.delta" && e.itemId === "response_0_message");
  const steered = await session.request({ id: "image-steer", method: "turn.steer", params: { turnId, input: "比较这张", images: [image] } });
  assert.ok(steered.success);
  const path = join(session.store.dataDirectory, "local.png"); writeFileSync(path, png);
  model.finish(0, false, [{ name: "view_image", arguments: JSON.stringify({ path }) }]);
  await session.waitFor((e) => "event" in e && e.event === "message.delta" && e.itemId === "response_1_message");
  const input = JSON.stringify(model.requests[1]!.input);
  assert.ok(!input.includes("tilot-image:")); assert.equal(input.split(png.toString("base64")).length - 1, 3);
  const history = await session.request({ id: "image-history", method: "turn.attempts", params: { turnId } });
  assert.ok(history.success); const tool = (history.result as AttemptView[])[0]!.tools[0]!;
  assert.equal(tool.images![0]!.id, image.id); assert.ok(!JSON.stringify(tool).includes(png.toString("base64")));
  model.finish(1); await session.waitFor((e) => "event" in e && e.event === "turn.finished" && e.turn.id === turnId);
});

test("提问 RPC 在运行中追加答案，重复提交不重发，空闲提交只创建一个新轮次", { timeout: 15000 }, async (context) => {
  for (const duringRun of [true, false]) {
    const model = await mockModel(context); const session = openSession(context, model.baseURL);
    const thread = session.store.createThread("异步问题"); const turn = await session.start(thread.id, "开始");
    await session.waitFor((e) => "event" in e && e.event === "message.delta" && e.turnId === turn);
    model.finish(0, false, [{ name: "request_user_input_async", arguments: '{"questions":[{"title":"方案？","options":["A","B"]}]}' }]);
    const event = await session.waitFor((e) => "event" in e && e.event === "question.updated");
    assert.ok("event" in event && event.event === "question.updated");
    const group = event.question; const draft = emptyQuestionDraft(group.questions);
    await session.waitFor((e) => "event" in e && e.event === "message.delta" && e.itemId === "response_1_message");
    if (!duringRun) {
      model.finish(1);
      await session.waitFor((e) => "event" in e && e.event === "turn.finished" && e.turn.id === turn);
    }
    draft.answers[0] = { mode: "option", optionIndex: 1, text: "草稿不发送" };
    const saved = await session.request({ id: "save", method: "question.draft", params: { questionId: group.id, draft } });
    assert.ok(saved.success); assert.deepEqual((saved.result as QuestionGroup).draft, draft);
    const result = await session.request({ id: "answer", method: "question.submit", params: { questionId: group.id, draft } });
    assert.ok(result.success); const delivery = result.result as QuestionDelivery;
    assert.equal(delivery.turn.id === turn, duringRun);
    const duplicate = await session.request({ id: "duplicate-answer", method: "question.submit", params: { questionId: group.id, draft } });
    assert.ok(duplicate.success); assert.equal((duplicate.result as QuestionDelivery).input.id, delivery.input.id);
    if (duringRun) model.finish(1);
    await session.waitFor((e) => "event" in e && e.event === "message.delta" && e.itemId === "response_2_message");
    assert.equal(model.requests.length, 3);
    const input = model.requests[2]!.input as { role?: string; content?: string }[];
    assert.match(input.at(-1)!.content!, /回答：B/); assert.doesNotMatch(input.at(-1)!.content!, /草稿不发送/);
    model.finish(2);
    await session.waitFor((e) => "event" in e && e.event === "turn.finished" && e.turn.id === delivery.turn.id);
    assert.equal(session.store.listTurns(thread.id).length, duringRun ? 1 : 2);
  }
});

test("停止保留待答组，停止后提交开启新轮次，缺少凭据时答案不被伪装成已投递", { timeout: 10000 }, async (context) => {
  const model = await mockModel(context); const session = openSession(context, model.baseURL);
  const thread = session.store.createThread("停止后回答"); const turnId = await session.start(thread.id, "提问");
  await session.waitFor((e) => "event" in e && e.event === "message.delta" && e.itemId === "response_0_message");
  model.finish(0, false, [{ name: "request_user_input_async", arguments: '{"questions":[{"title":"补充要求？"}]}' }]);
  const event = await session.waitFor((e) => "event" in e && e.event === "question.updated");
  assert.ok("event" in event && event.event === "question.updated");
  await session.waitFor((e) => "event" in e && e.event === "message.delta" && e.itemId === "response_1_message");
  await session.request({ id: "stop-question", method: "turn.interrupt", params: { turnId } });
  await session.waitFor((e) => "event" in e && e.event === "turn.finished" && e.turn.id === turnId);
  const draft = emptyQuestionDraft(event.question.questions); draft.answers[0] = { mode: "text", optionIndex: null, text: "继续处理这个要求" };
  session.store.credentials.retain([]);
  const failed = await session.request({ id: "no-key", method: "question.submit", params: { questionId: event.question.id, draft } });
  assert.equal(failed.success, false); assert.equal(session.store.questions.pending(thread.id)?.id, event.question.id);
  assert.equal(session.store.listTurns(thread.id).length, 1);
  session.store.credentials.saveApiKey("default", model.baseURL, "local-test-only");
  const result = await session.request({ id: "retry-answer", method: "question.submit", params: { questionId: event.question.id, draft } });
  assert.ok(result.success); const next = (result.result as QuestionDelivery).turn;
  assert.notEqual(next.id, turnId);
  await session.waitFor((e) => "event" in e && e.event === "message.delta" && e.itemId === "response_2_message");
  model.finish(2); await session.waitFor((e) => "event" in e && e.event === "turn.finished" && e.turn.id === next.id);
  assert.equal(session.store.getTurn(turnId)!.status, "cancelled");
  assert.equal(session.store.listTurnInputs(next.id)[0]!.questionId, event.question.id);
});

/** 启动本地模拟模型服务，先发送增量，再由测试决定何时发送终态。 */
async function mockModel(context: TestContext) {
  const pending: { response: ServerResponse; id: string }[] = [];
  const requests: Record<string, unknown>[] = [];
  const server = createServer((request, response) => {
    let body = "";
    request.setEncoding("utf8").on("data", (chunk: string) => { body += chunk; });
    request.on("end", () => { requests.push(JSON.parse(body) as Record<string, unknown>); });
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
  function finish(index: number, failed = false, calls: { name: string; arguments: string }[] = [], usage?: ResponseUsage, title?: string): void {
    const { response, id } = pending[index]!;
    if (failed) {
      response.end(sse({ type: "response.failed", sequence_number: 5, response: { id, status: "failed", output: [], error: { message: "模拟模型失败" }, ...(usage ? { usage } : {}) } }));
      return;
    }
    const output = [
      { type: "reasoning", id: `${id}_reasoning`, status: "completed", summary: [], content: [{ type: "reasoning_text", text: "思考正文" }] },
      { type: "message", id: `${id}_message`, role: "assistant", status: "completed", content: [{ type: "output_text", text: "答案", annotations: [] }] },
      ...calls.map((call, index) => ({ type: "function_call", id: `${id}_tool_${index}`, call_id: `${id}_call_${index}`, status: "completed", ...call })),
    ];
    let sequence_number = 5;
    for (const [output_index, item] of output.entries()) {
      if (output_index >= 2) response.write(sse({ type: "response.output_item.added", sequence_number: sequence_number++, output_index, item }));
      response.write(sse({ type: "response.output_item.done", sequence_number: sequence_number++, output_index, item }));
    }
    response.end(sse({ type: "response.completed", sequence_number, response: { id, status: "completed", output, ...(usage ? { usage } : {}), ...(title === undefined ? {} : { title }) } }));
  }
  return { baseURL: `http://127.0.0.1:${address.port}`, finish, requests };
}

/** 编码测试用 SSE 事件，正式模型传输仍由 OpenAI SDK 处理。 */
function sse(event: Record<string, unknown>): string {
  return `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
}

test("继续仅接受最新中断轮次，创建新轮次并统一使用正式提示词", { timeout: 10000 }, async (context) => {
  const model = await mockModel(context);
  const session = openSession(context, model.baseURL);
  const thread = session.store.createThread("恢复");
  const old = session.store.startTurn(thread.id, "原任务输入");
  assert.equal((await session.request({ id: "running", method: "turn.resume", params: { turnId: old.id } })).success, false);
  session.store.recoverInterruptedTurns();
  const result = await session.request({ id: "resume", method: "turn.resume", params: { turnId: old.id } });
  assert.ok(result.success && result.result && !Array.isArray(result.result) && "threadId" in result.result);
  const resumed = result.result;
  assert.notEqual(resumed.id, old.id);
  assert.equal(session.store.listTurnInputs(resumed.id)[0]?.content, readPrompt("resume"));
  assert.equal((await session.request({ id: "duplicate", method: "turn.resume", params: { turnId: old.id } })).success, false);
  await session.waitFor((message) => "event" in message && message.event === "message.delta" && message.turnId === resumed.id);
  assert.equal(model.requests[0]?.instructions, readPrompt("system"));
  assert.deepEqual(model.requests[0]?.input, [{ role: "user", content: "原任务输入" }, { role: "developer", content: readPrompt("interrupted-turn") }, { role: "user", content: readPrompt("resume") }]);
  model.finish(0);
  await session.waitFor((message) => "event" in message && message.event === "turn.finished" && message.turn.id === resumed.id);
  assert.equal(session.store.getTurn(old.id)?.status, "interrupted");
});

test("工具开始但结果未落库时异常退出，RPC 恢复可完成新轮次且不改写未知结果", { timeout: 10000 }, async (context) => {
  const model = await mockModel(context);
  const session = openSession(context, model.baseURL);
  const thread = session.store.createThread("工具退出恢复", session.store.dataDirectory, "full-access");
  const old = session.store.startTurn(thread.id, "执行旧工具");
  const attempt = session.store.history.startAttempt(old.id, session.store.listTurnInputs(old.id)[0]!.id);
  const call = { type: "function_call", id: "old-item", call_id: "old-call", name: "write", arguments: '{"path":"kept.txt","content":"不应重跑"}', status: "completed" };
  session.store.history.finishAttempt(attempt.id, { status: "completed", response: { id: "old-response", status: "completed", output: [call] } as ModelResponse });
  const tool = session.store.history.listToolCalls(attempt.id)[0]!;
  session.store.history.startTool(tool.id);
  writeFileSync(join(session.store.dataDirectory, "kept.txt"), "已发生的副作用", "utf8");
  session.store.recoverInterruptedTurns();
  const result = await session.request({ id: "resume-unknown", method: "turn.resume", params: { turnId: old.id } });
  assert.ok(result.success && result.result && !Array.isArray(result.result) && "threadId" in result.result);
  const resumed = result.result;
  await session.waitFor((message) => "event" in message && message.event === "message.delta" && message.turnId === resumed.id);
  const input = model.requests[0]!.input as { type?: string; call_id?: string; output?: string }[];
  const unknown = input.find((item) => item.type === "function_call_output" && item.call_id === call.call_id);
  assert.equal(JSON.parse(unknown!.output!).status, "unknown");
  model.finish(0);
  await session.waitFor((message) => "event" in message && message.event === "turn.finished" && message.turn.id === resumed.id);
  assert.equal(session.store.getTurn(resumed.id)!.status, "completed");
  assert.equal(session.store.history.listToolCalls(attempt.id)[0]!.result, null);
  assert.equal(readFileSync(join(session.store.dataDirectory, "kept.txt"), "utf8"), "已发生的副作用");
  assert.ok(session.store.listTurns(thread.id).every((turn) => turn.status !== "running"));
});

/** 创建完整服务连接及数据库，使用本地模拟模型地址和测试密钥。 */
function openSession(context: TestContext, baseURL: string) {
  const directory = mkdtempSync(join(tmpdir(), "tilot-turns-"));
  const store = new Store(directory);
  const config = store.getConfig();
  store.saveConfig({ ...config, providers: [{ ...config.providers[0]!, baseURL }] });
  store.credentials.saveApiKey("default", baseURL, "local-test-only");
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
  const globalSkillsDirectory = join(directory, "global-skills");
  const serving = serveStdio(store, input, output, { mcp: new McpManager(join(directory, "mcp.json")), globalSkillsDirectory });
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
    const result = await request({ id, method: "turn.start", params: { threadId, input: "输入" } });
    assert.ok(result.success && result.result && !Array.isArray(result.result) && "threadId" in result.result);
    return result.result.id;
  }
  return { store, input, output, serving, received, waitFor, request, start, globalSkillsDirectory };
}

test("MCP 真实子进程经过行协议审批、输出计时和连接退出清理，单服务错误独立通知", { timeout: 10000 }, async (context) => {
  const model = await mockModel(context);
  const session = openSession(context, model.baseURL);
  writeFileSync(join(session.store.dataDirectory, "mcp.json"), JSON.stringify({ mcpServers: {
    local: { command: process.execPath, args: [fileURLToPath(new URL("../../tool/tests/mcp-fixture.mjs", import.meta.url))] },
    invalid: { url: "invalid" },
  } }), "utf8");
  const thread = session.store.createThread("MCP 协议", session.store.dataDirectory);
  const turnId = await session.start(thread.id, "mcp-start");
  await session.waitFor((message) => "event" in message && message.event === "turn.notice" && message.turnId === turnId);
  await session.waitFor((message) => "event" in message && message.event === "message.delta" && message.turnId === turnId);
  model.finish(0, false, [{ name: "mcp__local__inspect", arguments: '{"value":"协议联调"}' }]);
  const approval = await session.waitFor((message) => "event" in message && message.event === "approval.requested");
  assert.ok("event" in approval && approval.event === "approval.requested");
  assert.equal(approval.approval.name, "mcp__local__inspect");
  assert.ok((await session.request({ id: "mcp-allow", method: "approval.respond", params: { approvalId: approval.approval.id, allowed: true } })).success);
  const result = await session.waitFor((message) => "event" in message && message.event === "attempt.updated" && message.attempt.tools.some((tool) => tool.output !== null));
  assert.ok("event" in result && result.event === "attempt.updated");
  const tool = result.attempt.tools[0]!;
  assert.ok(tool.startedAt !== null && tool.durationMs !== null);
  const output = JSON.parse(tool.output!);
  assert.equal(output.status, "ok");
  const value = JSON.parse(output.data.output);
  assert.equal(value.value, "协议联调");
  await session.waitFor((message) => "event" in message && message.event === "attempt.updated" && message.attempt.sequence === 2);
  model.finish(1);
  await session.waitFor((message) => "event" in message && message.event === "turn.finished" && message.turn.id === turnId);
  session.input.end();
  await session.serving;
  assert.throws(() => process.kill(value.pid, 0), { code: "ESRCH" });
});

test("思考起点和结束通过行协议交付，正文仍在生成时计时已停止，成功和失败历史保留耗时", { timeout: 10000 }, async (context) => {
  const model = await mockModel(context);
  const session = openSession(context, model.baseURL);
  const thread = session.store.createThread("思考计时事件");
  for (const [index, failed] of [false, true].entries()) {
    const turnId = await session.start(thread.id, `timing-${index}`);
    const started = await session.waitFor((message) => "event" in message && message.event === "message.timing" &&
      message.turnId === turnId && message.timing.durationMs === null);
    const stopped = await session.waitFor((message) => "event" in message && message.event === "message.timing" &&
      message.turnId === turnId && message.timing.durationMs !== null);
    assert.ok("event" in started && started.event === "message.timing");
    assert.ok("event" in stopped && stopped.event === "message.timing");
    assert.equal(stopped.timing.startedAt, started.timing.startedAt);
    assert.ok(stopped.timing.durationMs! >= 0);
    assert.equal(session.store.getTurn(turnId)?.status, "running");
    model.finish(index, failed);
    await session.waitFor((message) => "event" in message && message.event === "turn.finished" && message.turn.id === turnId);
    const attempt = session.store.history.listAttempts(turnId)[0]!;
    assert.deepEqual(attempt.reasoningTimings, [stopped.timing]);
  }
});

test("请求开始及成功/失败终态推送独立用量快照，统计不必等整轮重新查询", { timeout: 10000 }, async (context) => {
  const model = await mockModel(context);
  const session = openSession(context, model.baseURL);
  const thread = session.store.createThread("实时统计");
  const usage: ResponseUsage = { input_tokens: 100, input_tokens_details: { cached_tokens: 60, cache_write_tokens: 0 },
    output_tokens: 20, output_tokens_details: { reasoning_tokens: 5 }, total_tokens: 120 };
  for (const [index, status] of ["completed", "failed"].entries()) {
    const turnId = await session.start(thread.id, `start-metrics-${index}`);
    const started = await session.waitFor((message) => "event" in message && message.event === "attempt.updated" && message.turnId === turnId && message.attempt.status === "running");
    assert.ok("event" in started && started.event === "attempt.updated");
    assert.equal(started.attempt.metrics?.outputTokens, null);
    await session.waitFor((message) => "event" in message && message.event === "message.delta" && message.turnId === turnId);
    model.finish(index, status === "failed", [], usage);
    const finished = await session.waitFor((message) => "event" in message && message.event === "attempt.updated" && message.turnId === turnId && message.attempt.status === status);
    assert.ok("event" in finished && finished.event === "attempt.updated");
    assert.equal(finished.attempt.id, started.attempt.id);
    assert.equal(finished.attempt.metrics?.inputTokens, 100);
    assert.equal(finished.attempt.metrics?.cachedTokens, 60);
    assert.equal(finished.attempt.metrics?.outputTokens, 20);
    assert.ok(finished.attempt.metrics?.firstTokenMs != null);
    assert.ok(finished.attempt.metrics?.durationMs != null);
    if (status === "failed") assert.deepEqual(finished.attempt.messages, []);
    await session.waitFor((message) => "event" in message && message.event === "turn.finished" && message.turn.id === turnId);
  }
});

test("流中引导保留同一轮次及原输出，不取消请求；多条补充进入下一请求", { timeout: 10000 }, async (context) => {
  const model = await mockModel(context);
  const session = openSession(context, model.baseURL);
  const thread = session.store.createThread("同轮引导");
  const turnId = await session.start(thread.id, "start-steer");
  await session.waitFor((message) => "event" in message && message.event === "message.delta" && message.turnId === turnId);
  const first = await session.request({ id: "steer-1", method: "turn.steer", params: { turnId, input: "补充中文🙂" } });
  const second = await session.request({ id: "steer-2", method: "turn.steer", params: { turnId, input: "保留原任务" } });
  assert.equal(first.success, true); assert.equal(second.success, true);
  assert.equal(session.store.getTurn(turnId)?.status, "running");
  assert.equal(session.store.history.listAttempts(turnId)[0]!.status, "running");
  assert.equal(model.requests.length, 1);
  assert.equal(session.store.listTurnInputs(turnId).length, 3);
  const notifications = session.received.filter((message) => "event" in message && message.event === "turn.input");
  assert.equal(notifications.length, 2);
  assert.equal((await session.request({ id: "empty", method: "turn.steer", params: { turnId, input: " " } })).success, false);
  model.finish(0);
  await session.waitFor((message) => "event" in message && message.event === "message.delta" && message.itemId === "response_1_message");
  assert.equal(session.store.listTurns(thread.id).length, 1);
  assert.deepEqual((model.requests[1]!.input as unknown[]).slice(-2), [{ role: "user", content: "补充中文🙂" }, { role: "user", content: "保留原任务" }]);
  assert.equal(session.store.history.listAttempts(turnId)[0]!.status, "completed");
  model.finish(1);
  await session.waitFor((message) => "event" in message && message.event === "turn.finished" && message.turn.id === turnId);
  assert.deepEqual(session.store.history.listAttempts(turnId).map((attempt) => attempt.status), ["completed", "completed"]);
  assert.deepEqual(await session.request({ id: "late", method: "turn.steer", params: { turnId, input: "迟到引导" } }), { id: "late", success: true, result: null });
  assert.equal(session.store.listTurnInputs(turnId).length, 3);
});

test("启动立即应答，并行任务事件有序且互不串流，完成内容替换预览", { timeout: 10000 }, async (context) => {
  const model = await mockModel(context);
  const session = openSession(context, model.baseURL);
  const thread = session.store.createThread("第一个任务");
  const first = await session.start(thread.id, "start-first");
  await session.waitFor((message) => "event" in message && message.event === "message.delta" && message.turnId === first);
  const duplicate = await session.request({ id: "duplicate", method: "turn.start", params: { threadId: thread.id, input: "重复" } });
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
  await session.waitFor((message) => "event" in message && message.event === "message.delta" && message.turnId === second);
  session.input.end();
  await session.serving;
  assert.equal(session.store.getTurn(second)?.status, "cancelled");
  assert.equal(session.store.history.listAttempts(second)[0]?.status, "cancelled");
});

test("缺少密钥不创建轮次，模型失败和输出断连均正确收尾", { timeout: 10000 }, async (context) => {
  const model = await mockModel(context);
  const session = openSession(context, model.baseURL);
  const thread = session.store.createThread("错误路径");
  session.store.credentials.retain([]);
  const missing = await session.request({ id: "missing", method: "turn.start", params: { threadId: thread.id, input: "输入" } });
  assert.equal(missing.success, false);
  assert.deepEqual(session.store.listTurns(thread.id), []);
  session.store.credentials.saveApiKey("default", model.baseURL, "local-test-only");
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

test("真实命令进度通过行协议交付，历史查询只包含最终结果和可续读的日志标识", { skip: process.platform !== "win32", timeout: 15000 }, async (context) => {
  const model = await mockModel(context);
  const session = openSession(context, model.baseURL);
  const directory = join(session.store.dataDirectory, "project");
  mkdirSync(directory);
  const thread = session.store.createThread("命令进度", directory, "full-access");
  const turnId = await session.start(thread.id, "shell");
  await session.waitFor((message) => "event" in message && message.event === "message.delta");
  model.finish(0, false, [{ name: "shell", arguments: JSON.stringify({
    command: "[Console]::Write('进行中🙂'); Start-Sleep -Milliseconds 250; [Console]::Write('完成'); Start-Sleep -Milliseconds 150",
  }) }]);
  const progress = await session.waitFor((message) => "event" in message && message.event === "tool.progress");
  assert.ok("event" in progress && progress.event === "tool.progress");
  assert.equal(progress.threadId, thread.id);
  assert.equal(progress.turnId, turnId);
  const call = session.store.history.listToolCalls(progress.attemptId)[0]!;
  assert.equal(progress.toolId, call.id);
  assert.equal(call.result, null);
  assert.equal(progress.output, "进行中🙂");
  const saved = await session.waitFor((message) => "event" in message && message.event === "attempt.updated" && message.attempt.tools.some((tool) => tool.output !== null));
  assert.ok("event" in saved && saved.event === "attempt.updated");
  const result = JSON.parse(saved.attempt.tools[0]!.output!);
  assert.equal(result.data.exitCode, 0);
  assert.equal(result.data.outputId, call.id);
  assert.equal(result.data.output, "进行中🙂完成");
  const history = await session.request({ id: "history", method: "turn.attempts", params: { turnId } });
  assert.ok(history.success);
  assert.doesNotMatch(JSON.stringify(history), /"preview"|tool\.progress/);
  await session.waitFor((message) => "event" in message && message.event === "message.delta" && message.itemId === "response_1_message");
  model.finish(1);
  await session.waitFor((message) => "event" in message && message.event === "turn.finished" && message.turn.id === turnId);
  assert.equal(session.store.getTurn(turnId)?.status, "completed");
});

test("真实审批协议逐条放行或拒绝，等待不计工具耗时，轮内切换权限不改变审批策略或工具声明", { timeout: 10000 }, async (context) => {
  const model = await mockModel(context);
  const session = openSession(context, model.baseURL);
  const project = join(session.store.dataDirectory, "project");
  mkdirSync(project);
  const thread = session.store.createThread("审批", project);
  const turnId = await session.start(thread.id, "审批开始");
  await session.waitFor((message) => "event" in message && message.event === "message.delta" && message.turnId === turnId);
  const firstPath = join(session.store.dataDirectory, "outside", "allowed.txt");
  const secondPath = join(session.store.dataDirectory, "denied", "file.txt");
  model.finish(0, false, [firstPath, secondPath].map((path) => ({ name: "write", arguments: JSON.stringify({ path, content: "单次允许" }) })));
  const first = await session.waitFor((message) => "event" in message && message.event === "approval.requested");
  assert.ok("event" in first && first.event === "approval.requested");
  assert.equal(first.approval.resolvedPath, firstPath);
  assert.equal(existsSync(join(session.store.dataDirectory, "outside")), false);
  const list = await session.request({ id: "pending", method: "approval.list", params: { threadId: thread.id } });
  assert.ok(list.success); assert.deepEqual(list.result, [first.approval]);
  const attempt = session.store.history.listAttempts(turnId)[0]!;
  assert.equal(session.store.history.listToolCalls(attempt.id)[0]!.startedAt, null);
  assert.equal((await session.request({ id: "mode", method: "thread.permission", params: { threadId: thread.id, permissionMode: "full-access" } })).success, true);
  assert.equal((await session.request({ id: "locked", method: "thread.permission", params: { threadId: thread.id, permissionMode: "read-only" } })).success, false);
  const approvedAt = Date.now();
  assert.equal((await session.request({ id: "allow", method: "approval.respond", params: { approvalId: first.approval.id, allowed: true } })).success, true);
  const second = await session.waitFor((message) => "event" in message && message.event === "approval.requested" && message.approval.id !== first.approval.id);
  assert.ok("event" in second && second.event === "approval.requested");
  assert.equal(readFileSync(firstPath, "utf8"), "单次允许");
  await session.request({ id: "deny", method: "approval.respond", params: { approvalId: second.approval.id, allowed: false } });
  await session.waitFor((message) => "event" in message && message.event === "message.delta" && message.itemId === "response_1_message");
  const calls = session.store.history.listToolCalls(attempt.id);
  assert.ok(calls[0]!.startedAt! >= approvedAt);
  assert.ok(calls[0]!.durationMs !== null);
  assert.equal(calls[1]!.startedAt, null); assert.equal(calls[1]!.durationMs, null);
  assert.match(String(calls[1]!.result!.output), /用户拒绝/);
  assert.equal(existsSync(join(session.store.dataDirectory, "denied")), false);
  assert.deepEqual(model.requests[0]!.tools, model.requests[1]!.tools);
  model.finish(1);
  await session.waitFor((message) => "event" in message && message.event === "turn.finished" && message.turn.id === turnId);
  const next = await session.start(thread.id, "下一轮");
  await session.waitFor((message) => "event" in message && message.event === "message.delta" && message.turnId === next);
  assert.equal(session.store.getTurn(next)?.permissionMode, "full-access");
  assert.deepEqual(model.requests[0]!.tools, model.requests[2]!.tools);
  model.finish(2, false, [{ name: "write", arguments: JSON.stringify({ path: secondPath, content: "自动允许" }) }]);
  await session.waitFor((message) => "event" in message && message.event === "message.delta" && message.itemId === "response_3_message");
  assert.equal(readFileSync(secondPath, "utf8"), "自动允许");
  model.finish(3);
  await session.waitFor((message) => "event" in message && message.event === "turn.finished" && message.turn.id === next);
  assert.equal(session.received.filter((message) => "event" in message && message.event === "approval.requested").length, 2);
});

test("停止与关闭连接都会取消待审批命令，不执行副作用、不记录执行耗时", { timeout: 10000 }, async (context) => {
  const model = await mockModel(context);
  const session = openSession(context, model.baseURL);
  const project = join(session.store.dataDirectory, "project"); mkdirSync(project);
  const thread = session.store.createThread("取消审批", project);
  for (const [index, close] of [false, true].entries()) {
    const turnId = await session.start(thread.id, `wait-${index}`);
    await session.waitFor((message) => "event" in message && message.event === "message.delta" && message.turnId === turnId);
    model.finish(index, false, [{ name: "shell", arguments: '{"command":"Set-Content unexpected.txt forbidden"}' }]);
    await session.waitFor((message) => "event" in message && message.event === "approval.requested" && message.approval.turnId === turnId);
    if (close) { session.input.end(); await session.serving; }
    else {
      await session.request({ id: "cancel-approval", method: "turn.interrupt", params: { turnId } });
      await session.waitFor((message) => "event" in message && message.event === "turn.finished" && message.turn.id === turnId);
    }
    const call = session.store.history.listToolCalls(session.store.history.listAttempts(turnId)[0]!.id)[0]!;
    assert.equal(session.store.getTurn(turnId)?.status, "cancelled");
    assert.equal(call.startedAt, null); assert.equal(call.durationMs, null);
    assert.match(String(call.result!.output), /cancelled/);
    assert.equal(existsSync(join(project, "unexpected.txt")), false);
  }
});
