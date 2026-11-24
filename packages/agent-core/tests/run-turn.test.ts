import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test, type TestContext } from "node:test";
import { Store } from "@tilot/store";
import { createResponsesClient } from "@tilot/responses";
import { runTurn, type TurnEvent } from "@tilot/agent-core";
import { readPrompt } from "@tilot/context";
import { httpFixture } from "../../tool/tests/http-fixture.ts";
import { McpManager } from "@tilot/tool";
import { fileURLToPath } from "node:url";
import { emptyQuestionDraft } from "@tilot/protocol";
import { png } from "../../tool/tests/image-fixture.ts";

test("官方联网被明确拒绝时只重试一次，快速模式和普通错误不触发降级", async (context) => {
  const store = openTestStore(context);
  for (const [effort, reason, expected] of [
    ["high", "deepseek_web_search is not supported by this model", 2],
    ["high", "Invalid request body", 1],
    ["none", "deepseek_web_search is not supported by this model", 1],
  ] as const) {
    const thread = store.createThread("联网请求");
    store.updateThreadModel(thread.id, thread.providerId, thread.model, effort);
    const requests: { tools: { type: string; name?: string }[] }[] = [];
    const notices: string[] = [];
    const client = createResponsesClient({ apiKey: "local-test-placeholder" }).withOptions({
      fetch: async (_url, options) => {
        requests.push(JSON.parse(String(options?.body)));
        if (requests.length > 1) return sse(sampleEvents());
        return Response.json({ error: { message: reason } }, { status: 400 });
      },
    });
    const turn = await runTurn(store, client, { threadId: thread.id, input: "搜索", onEvent(event) {
      if (event.type === "turn.notice") notices.push(event.message);
    } });
    assert.equal(turn.status, expected === 2 ? "completed" : "failed");
    assert.equal(requests.length, expected);
    const webTypes = ({ tools }: typeof requests[number]) => tools.filter((tool) => tool.type !== "function").map((tool) => tool.type);
    assert.deepEqual(webTypes(requests[0]!), effort === "none" ? [] : ["deepseek_web_search", "deepseek_read_url"]);
    if (requests[1]) assert.deepEqual(webTypes(requests[1]), []);
    assert.ok(requests.every(({ tools }) => tools.some((tool) => tool.name === "web_fetch")));
    assert.deepEqual(store.history.listAttempts(turn.id).map((attempt) => attempt.status), expected === 2 ? ["failed", "completed"] : ["failed"]);
    assert.equal(notices.filter((notice) => notice.includes(reason)).length, expected - 1);
  }
});

test("取消后只回放已完成的服务端联网项并保留签名，不创建本地工具调用", async (context) => {
  const store = openTestStore(context);
  const thread = store.createThread("取消联网");
  store.updateThreadModel(thread.id, thread.providerId, thread.model, "high");
  const finalized = {
    type: "web_search_call", id: "read_link_1", status: "completed", kind: "read_link", signature: "saved-page-signature",
    action: { type: "open_page", url: "https://example.com/" }, page: { url: "https://example.com/", title: "网页" },
  };
  const events = [
    { type: "response.created", response: { id: "response-web", status: "in_progress", output: [] } },
    { type: "response.output_item.added", output_index: 0, item: { ...finalized, status: "in_progress", signature: undefined } },
    { type: "response.web_search_call.in_progress", output_index: 0, item_id: finalized.id },
    { type: "response.output_item.added", output_index: 1, item: { ...finalized, id: "pending_link", status: "in_progress", signature: undefined } },
    { type: "response.web_search_call.completed", output_index: 0, item_id: finalized.id },
    { type: "response.output_item.done", output_index: 0, item: finalized },
  ].map((event, sequence_number) => ({ ...event, sequence_number }));
  const signal = new AbortController();
  const requests: { input: { type?: string }[] }[] = [];
  const client = createResponsesClient({ apiKey: "local-test-placeholder" }).withOptions({
    fetch: async (_url, options) => {
      requests.push(JSON.parse(String(options?.body)));
      return sse(requests.length === 1 ? events : sampleEvents());
    },
  });
  const stopped = await runTurn(store, client, { threadId: thread.id, input: "读取链接", signal: signal.signal, onEvent(event) {
    if (event.type === "response.event" && event.event.type === "response.output_item.done") signal.abort();
  } });
  assert.equal(stopped.status, "cancelled");
  const saved = store.history.listAttempts(stopped.id)[0]!;
  assert.equal(saved.status, "cancelled");
  assert.deepEqual(saved.completedOutputs, [{ outputIndex: 0, item: finalized }]);
  assert.deepEqual(store.history.listToolCalls(saved.id), []);
  const next = await runTurn(store, client, { threadId: thread.id, input: "复述已读网页" });
  assert.equal(next.status, "completed");
  assert.deepEqual(requests[1]!.input.filter((item) => item.type === "web_search_call"), [finalized]);
});

test("服务拒绝图片时保留原用户图片和失败记录，不切换模型或自动重试", async (context) => {
  const store = openTestStore(context); const thread = store.createThread("视觉不支持");
  const image = await store.images.save(png, "保留.png"); let requests = 0;
  const client = createResponsesClient({ apiKey: "local-test-placeholder", baseURL: "http://localhost:1234" }).withOptions({
    fetch: async (_url, options) => {
      requests++; const body = JSON.parse(String(options?.body));
      assert.equal(body.model, thread.model); assert.equal(body.input[0].content[0].type, "input_image");
      return new Response(JSON.stringify({ error: { message: "Unsupported image input", type: "invalid_request_error" } }), { status: 400, headers: { "content-type": "application/json" } });
    },
  });
  const turn = await runTurn(store, client, { threadId: thread.id, input: "", images: [image] });
  assert.equal(turn.status, "failed"); assert.match(turn.error!, /Unsupported image input/); assert.equal(requests, 1);
  assert.deepEqual(store.listTurnInputs(turn.id)[0]!.images, [image]);
  assert.equal(await store.images.dataUrl(image.id), `data:image/png;base64,${png.toString("base64")}`);
});

test("用户图片、图片引导和 view_image 结果进入标准 Responses，取消后使用副本回放", async (context) => {
  const store = openTestStore(context); const directory = projectDirectory(context);
  const path = join(directory, "picture.png"); writeFileSync(path, png);
  const image = await store.images.importFile(path); const thread = store.createThread("图片联调", directory);
  const controller = new AbortController(); let count = 0;
  const { client, requests } = mockClient(() => ++count === 1
    ? toolEvents([{ name: "view_image", arguments: JSON.stringify({ path }) }]) : sampleEvents());
  const turn = await runTurn(store, client, { threadId: thread.id, input: "", images: [image], signal: controller.signal,
    onEvent: (event) => {
      if (event.type === "turn.started") store.appendTurnInput(event.turn.id, "这张也看看", [image]);
      if (event.type === "tool.updated" && event.runningToolId === null) controller.abort();
    } });
  assert.equal(turn.status, "cancelled"); assert.equal(requests.length, 1);
  assert.deepEqual(JSON.parse(String(requests[0]!.body)).input[0], { role: "user", content: [{ type: "input_image", image_url: `data:image/png;base64,${png.toString("base64")}`, detail: "auto" }] });
  const attempt = store.history.listAttempts(turn.id)[0]!;
  assert.ok(Array.isArray(store.history.listToolCalls(attempt.id)[0]!.result!.output));
  writeFileSync(path, "源文件已经改变", "utf8");
  await runTurn(store, client, { threadId: thread.id, input: "继续比较" });
  const replay = JSON.parse(String(requests[1]!.body)).input;
  assert.ok(!JSON.stringify(replay).includes("tilot-image:"));
  assert.equal(JSON.stringify(replay).split(png.toString("base64")).length - 1, 3);
  assert.equal(replay.filter((item: { role?: string; content?: unknown }) => item.role === "user").length, 3);
  const tool = replay.find((item: { type?: string }) => item.type === "function_call_output");
  assert.equal(tool.output[1].type, "input_image");
});

test("图片副本损坏时明确失败且无 API 请求，不遗留 running 轮次", async (context) => {
  const store = openTestStore(context); const image = await store.images.save(png, "图片.png");
  writeFileSync(join(store.dataDirectory, "images", `${image.id}.bin`), "损坏", "utf8");
  const { client, requests } = mockClient(); const thread = store.createThread("损坏图片");
  const turn = await runTurn(store, client, { threadId: thread.id, input: "", images: [image] });
  assert.equal(turn.status, "failed"); assert.match(turn.error!, /副本损坏/);
  assert.equal(requests.length, 0); assert.equal(store.history.listAttempts(turn.id).length, 0);
});

test("DeepSeek 请求接近字节上限时优先省略旧工具图，可从同一对话回读原图", async (context) => {
  const store = openTestStore(context);
  const directory = projectDirectory(context);
  const firstPath = join(directory, "first.png");
  const latestPath = join(directory, "latest.png");
  const firstBytes = Buffer.concat([png, Buffer.alloc(18 * 1024 * 1024)]);
  const latestBytes = Buffer.concat([png, Buffer.alloc(18 * 1024 * 1024, 1)]);
  writeFileSync(firstPath, firstBytes);
  writeFileSync(latestPath, latestBytes);
  const attachment = await store.images.save(png, "用户附件.png");
  const first = await store.images.importFile(firstPath);
  const latest = await store.images.importFile(latestPath);
  const thread = store.createThread("图片预算", directory);
  let requests = 0;
  const client = createResponsesClient({ apiKey: "local-test-placeholder" }).withOptions({
    fetch: async (_url, options) => {
      const body = String(options?.body);
      assert.ok(Buffer.byteLength(body) < 48 * 1024 * 1024);
      const input = JSON.parse(body).input;
      if (++requests === 1) {
        assert.equal(input[0].content[1].image_url, `data:image/png;base64,${png.toString("base64")}`);
        return sse(toolEvents([firstPath, latestPath].map((path) => ({ name: "view_image", arguments: JSON.stringify({ path }) }))));
      }
      const outputs = input.filter((item: { type: string }) => item.type === "function_call_output");
      assert.equal(input[0].content[1].type, "input_image");
      assert.match(outputs[0].output[0].text, /"status":"ok"/);
      assert.match(outputs[0].output[1].text, new RegExp(first.id));
      assert.ok(input.some((item: { type: string; call_id: string }) => item.type === "function_call" && item.call_id === outputs[0].call_id));
      if (requests === 2) {
        assert.equal(outputs[1].output[1].image_url, `data:image/png;base64,${latestBytes.toString("base64")}`);
        writeFileSync(firstPath, "源文件变动", "utf8");
        return sse(toolEvents([{ name: "view_image", arguments: JSON.stringify({ imageId: first.id }) }]));
      }
      assert.match(outputs[1].output[1].text, new RegExp(latest.id));
      assert.equal(outputs[2].output[1].image_url, `data:image/png;base64,${firstBytes.toString("base64")}`);
      return sse(sampleEvents());
    },
  });
  const notices: string[] = [];
  const turn = await runTurn(store, client, {
    threadId: thread.id, input: "比较图片", images: [attachment],
    onEvent: (event) => { if (event.type === "turn.notice") notices.push(event.message); },
  });
  assert.equal(turn.error, null);
  assert.equal(turn.status, "completed");
  assert.equal(requests, 3);
  assert.equal(notices.filter((message) => message.includes("可回读")).length, 1);
  const [attempt] = store.history.listAttempts(turn.id);
  const [firstCall, latestCall] = store.history.listToolCalls(attempt!.id);
  assert.match(JSON.stringify(firstCall!.result), new RegExp(`tilot-image:${first.id}`));
  assert.match(JSON.stringify(latestCall!.result), new RegExp(`tilot-image:${latest.id}`));
});

test("服务返回 413 后只重试一次更小的请求，保留失败记录和真实工具结果", async (context) => {
  const store = openTestStore(context);
  const directory = projectDirectory(context);
  const paths = ["a.png", "b.png"].map((name, index) => {
    const path = join(directory, name);
    writeFileSync(path, Buffer.concat([png, Buffer.alloc(2048, index)]));
    return path;
  });
  const thread = store.createThread("请求过大", directory);
  let requests = 0;
  let rejectedBytes = 0;
  const client = createResponsesClient({ apiKey: "local-test-placeholder", baseURL: "http://localhost:1234" }).withOptions({
    fetch: async (_url, options) => {
      if (++requests === 1) return sse(toolEvents(paths.map((path) => ({ name: "view_image", arguments: JSON.stringify({ path }) }))));
      const body = String(options?.body);
      const outputs = JSON.parse(body).input.filter((item: { type: string }) => item.type === "function_call_output");
      if (requests === 2) {
        assert.equal(outputs[0].output[1].type, "input_image");
        rejectedBytes = Buffer.byteLength(body);
        for (const path of paths) writeFileSync(path, "禁止重新读取源文件", "utf8");
      } else {
        assert.equal(outputs[0].output[1].type, "input_text");
        assert.equal(outputs[1].output[1].type, "input_image");
        assert.ok(Buffer.byteLength(body) < rejectedBytes);
      }
      return new Response(`request body too large (request_id: too-big-${requests})`, { status: 413 });
    },
  });
  const turn = await runTurn(store, client, { threadId: thread.id, input: "读图" });
  assert.equal(requests, 3);
  assert.equal(turn.status, "failed");
  assert.match(turn.error!, /413.*too-big-3/);
  const attempts = store.history.listAttempts(turn.id);
  assert.deepEqual(attempts.map(({ status }) => status), ["completed", "failed", "failed"]);
  assert.match(attempts[1]!.error!, /413.*too-big-2/);
  assert.equal(store.history.listToolCalls(attempts[0]!.id).length, 2);
});

test("异步提问立即返回，重复提问不覆盖，整组答案按引导进入后续上下文", async (context) => {
  const store = openTestStore(context);
  const thread = store.createThread("异步问答");
  const questions = [{ title: "选方案", options: ["A", "B"] }, { title: "说明", options: [] }];
  let count = 0;
  const { client, requests } = mockClient(() => ++count === 1 ? toolEvents([
    { name: "request_user_input_async", arguments: JSON.stringify({ questions }) },
    { name: "request_user_input_async", arguments: JSON.stringify({ questions }) },
  ]) : sampleEvents());
  const turn = await runTurn(store, client, { threadId: thread.id, input: "先问再继续", onEvent(event) {
    if (event.type !== "tool.updated" || event.runningToolId !== null || !store.questions.pending(thread.id)) return;
    const group = store.questions.pending(thread.id)!;
    const calls = store.history.listToolCalls(event.attemptId);
    if (calls.some((call) => call.result === null)) return;
    const draft = emptyQuestionDraft(group.questions);
    draft.answers[0] = { mode: "option", optionIndex: 1, text: "不发送" }; draft.answers[1]!.mode = "skipped";
    store.answerQuestion(group.id, draft, event.turnId);
  } });
  assert.equal(turn.status, "completed"); assert.equal(requests.length, 2);
  const calls = store.history.listToolCalls(store.history.listAttempts(turn.id)[0]!.id);
  assert.equal(JSON.parse(String(calls[0]!.result!.output)).data.accepted, true);
  assert.match(JSON.parse(String(calls[1]!.result!.output)).error, /已有待回答/);
  const second = JSON.parse(String(requests[1]!.body));
  assert.match(second.input.at(-1).content, /回答：B/); assert.doesNotMatch(second.input.at(-1).content, /不发送/);
  assert.equal(store.questions.pending(thread.id), null);
});

test("没有回答时提问工具不阻塞轮次，取消不会丢失已经登记的问题", async (context) => {
  for (const cancel of [false, true]) {
    const store = openTestStore(context); const thread = store.createThread("待答问题");
    const controller = new AbortController(); let count = 0;
    const { client, requests } = mockClient(() => ++count === 1 ? toolEvents([{ name: "request_user_input_async", arguments: '{"questions":[{"title":"你的偏好？"}]}' }]) : sampleEvents());
    const turn = await runTurn(store, client, { threadId: thread.id, input: "提问", signal: controller.signal,
      onEvent(event) { if (cancel && event.type === "question.updated") controller.abort(); } });
    assert.equal(turn.status, cancel ? "cancelled" : "completed");
    assert.equal(requests.length, cancel ? 1 : 2);
    assert.ok(store.questions.pending(thread.id));
  }
});

test("完整 A/B 消息后取消，重开后能选择第二个方案；完整未执行调用有结果，未完成参数不回放", async (context) => {
  let store: Store;
  context.after(() => store.close());
  const directory = projectDirectory(context);
  store = new Store(directory);
  const thread = store.createThread("取消后选择", directory, "full-access");
  const controller = new AbortController();
  const answer = { type: "message", id: "options-complete", role: "assistant", status: "completed", content: [{ type: "output_text", text: "A：保守方案；B：第二个方案", annotations: [] }] };
  const completeCall = { type: "function_call", id: "complete-call", call_id: "not-executed", name: "write", arguments: '{"path":"not-created.txt","content":"不应执行"}', status: "completed" };
  const unfinishedCall = { ...completeCall, id: "partial-call", call_id: "partial", status: "in_progress", arguments: "" };
  const events = [
    { type: "response.created", response: { id: "cancel-response", status: "in_progress", output: [] } },
    { type: "response.output_item.added", output_index: 0, item: { ...answer, content: [], status: "in_progress" } },
    { type: "response.output_item.done", output_index: 0, item: answer },
    { type: "response.output_item.added", output_index: 1, item: { ...completeCall, arguments: "", status: "in_progress" } },
    { type: "response.output_item.done", output_index: 1, item: completeCall },
    { type: "response.output_item.added", output_index: 2, item: unfinishedCall },
    { type: "response.function_call_arguments.delta", output_index: 2, item_id: unfinishedCall.id, delta: '{"path":' },
    { type: "response.output_item.added", output_index: 3, item: { ...unfinishedCall, id: "args-only", call_id: "args-only" } },
    { type: "response.function_call_arguments.done", output_index: 3, item_id: "args-only", arguments: completeCall.arguments },
    { type: "response.output_item.added", output_index: 4, item: { ...answer, id: "partial-text", status: "in_progress", content: [] } },
    { type: "response.output_text.delta", output_index: 4, item_id: "partial-text", content_index: 0, delta: "继续解释但没有生成完" },
  ].map((event, sequence_number) => ({ ...event, sequence_number }));
  const { client } = mockClient(() => events);
  const cancelled = await runTurn(store, client, { threadId: thread.id, input: "给我 A/B 方案", signal: controller.signal,
    onEvent: (event) => {
      if (event.type === "response.event" && event.event.type === "response.output_item.done") {
        const itemId = event.event.item.id;
        assert.ok(store.history.getAttempt(event.attemptId)!.completedOutputs.some((entry) => entry.item.id === itemId));
      }
      if (event.type === "response.event" && event.event.type === "response.output_text.delta") controller.abort();
    },
  });
  assert.equal(cancelled.status, "cancelled");
  const attempt = store.history.listAttempts(cancelled.id)[0]!;
  assert.equal(attempt.status, "cancelled");
  assert.equal(attempt.response?.status, "in_progress");
  assert.deepEqual(attempt.completedOutputs.map((entry) => entry.item.id), [answer.id, completeCall.id]);
  const tool = store.history.listToolCalls(attempt.id)[0]!;
  assert.equal(JSON.parse(String(tool.result!.output)).status, "not_executed");
  assert.equal(tool.startedAt, null);
  assert.equal(existsSync(join(directory, "not-created.txt")), false);
  store.close();
  store = new Store(directory);
  const next = mockClient();
  const finished = await runTurn(store, next.client, { threadId: thread.id, input: "选第二个" });
  assert.equal(finished.status, "completed");
  const input = JSON.parse(String(next.requests[0]!.body)).input;
  assert.deepEqual(input[1], answer);
  assert.equal(input.filter((item: { id?: string }) => item.id === answer.id).length, 1);
  assert.ok(input.every((item: { id?: string }) => !["partial-text", "partial-call", "args-only"].includes(item.id ?? "")));
  assert.deepEqual(input.at(-2), { role: "developer", content: readPrompt("cancelled-turn") });
  assert.deepEqual(input.at(-1), { role: "user", content: "选第二个" });
  assert.equal(store.getTurn(cancelled.id)!.status, "cancelled");
});

test("旧工具开始后进程退出，新轮可携带 unknown 结果完成请求，不重跑或遗留 running", async (context) => {
  let store: Store;
  context.after(() => store.close());
  const directory = projectDirectory(context);
  store = new Store(directory);
  const thread = store.createThread("退出恢复", directory, "full-access");
  const old = store.startTurn(thread.id, "写文件");
  const attempt = store.history.startAttempt(old.id, store.listTurnInputs(old.id)[0]!.id);
  const terminal = toolEvents([{ name: "write", arguments: '{"path":"side-effect.txt","content":"重复执行了"}' }]).at(-1)!;
  store.history.finishAttempt(attempt.id, { status: "completed", response: terminal.response as import("openai/resources/responses/responses").Response });
  const tool = store.history.listToolCalls(attempt.id)[0]!;
  store.history.startTool(tool.id);
  writeFileSync(join(directory, "side-effect.txt"), "已有副作用", "utf8");
  store.close();
  store = new Store(directory);
  store.recoverInterruptedTurns();
  const { client, requests } = mockClient();
  const next = await runTurn(store, client, { threadId: thread.id, input: "核实后继续" });
  assert.equal(next.status, "completed");
  assert.equal(store.getTurn(old.id)!.status, "interrupted");
  assert.equal(store.history.listToolCalls(attempt.id)[0]!.result, null);
  assert.equal(readFileSync(join(directory, "side-effect.txt"), "utf8"), "已有副作用");
  const input = JSON.parse(String(requests[0]!.body)).input;
  const unknown = input.find((item: { type: string; call_id?: string }) => item.type === "function_call_output" && item.call_id === tool.callId);
  assert.equal(JSON.parse(unknown.output).status, "unknown");
  assert.deepEqual(input.at(-2), { role: "developer", content: readPrompt("interrupted-turn") });
  assert.ok(store.listTurns(thread.id).every((turn) => turn.status !== "running"));
});

test("请求登记失败也结束新轮次，不遗留没有模型请求的 running 状态", async (context) => {
  const store = openTestStore(context);
  const mock = context.mock.method(store.history, "startAttempt", () => { throw new Error("请求登记失败"); });
  const { client, requests } = mockClient();
  const thread = store.createThread("登记失败");
  const turn = await runTurn(store, client, { threadId: thread.id, input: "开始" });
  assert.equal(turn.status, "failed");
  assert.equal(turn.error, "请求登记失败");
  assert.equal(requests.length, 0);
  mock.mock.restore();
  assert.equal((await runTurn(store, client, { threadId: thread.id, input: "再试一次" })).status, "completed");
});

test("MCP 整轮声明和配置固定，真实工具审批执行并落库，局部配置错误通知模型和界面", { timeout: 15000 }, async (context) => {
  const store = openTestStore(context);
  const project = projectDirectory(context);
  const path = join(project, "mcp.json");
  const config = (version: string) => JSON.stringify({ mcpServers: {
    local: { command: process.execPath, args: [fileURLToPath(new URL("../../tool/tests/mcp-fixture.mjs", import.meta.url))], env: { TILOT_MCP_VERSION: version } },
    invalid: { url: "not-a-url" },
  } });
  writeFileSync(path, config("1"), "utf8");
  const manager = new McpManager(path);
  context.after(() => manager.close());
  const thread = store.createThread("MCP 联调", project);
  const notices: string[] = [];
  let request = 0;
  let approvals = 0;
  const { client, requests } = mockClient(() => {
    if (++request === 1) {
      writeFileSync(path, config("2"), "utf8");
      return toolEvents([{ name: "mcp__local__inspect", arguments: '{"value":"中文"}' }]);
    }
    return sampleEvents();
  });
  const turn = await runTurn(store, client, { threadId: thread.id, input: "使用 MCP", mcp: manager,
    onEvent: (event) => { if (event.type === "turn.notice") notices.push(event.message); },
    onApproval: async (input) => { approvals++; assert.equal(input.name, "mcp__local__inspect"); assert.equal(input.turnId, store.getTurn(input.turnId)?.id); return true; },
  });
  assert.equal(turn.status, "completed");
  assert.equal(approvals, 1);
  assert.match(notices.join(), /MCP invalid/);
  const attempts = store.history.listAttempts(turn.id);
  const tool = store.history.listToolCalls(attempts[0]!.id)[0]!;
  const result = JSON.parse(String(tool.result!.output));
  assert.equal(result.status, "ok");
  assert.equal(JSON.parse(result.data.output).version, "1");
  assert.ok(tool.durationMs !== null && tool.startedAt !== null);
  const bodies = requests.map((options) => JSON.parse(String(options.body)));
  assert.deepEqual(bodies[0].tools, bodies[1].tools);
  assert.match(JSON.stringify(bodies[0]), /MCP invalid/);
  assert.ok(bodies[1].input.some((item: { type: string; output?: string }) => item.type === "function_call_output" && item.output === tool.result!.output));
  assert.equal((await runTurn(store, client, { threadId: thread.id, input: "下一轮", mcp: manager })).status, "completed");
});

test("只读轮次不读取 MCP 配置或启动服务", async (context) => {
  const store = openTestStore(context);
  const manager = new McpManager();
  context.mock.method(manager, "snapshot", async () => { throw new Error("只读不得发现 MCP"); });
  const { client, requests } = mockClient();
  const turn = await runTurn(store, client, { threadId: store.createThread("只读 MCP").id, input: "读取", mcp: manager });
  assert.equal(turn.status, "completed");
  assert.ok(JSON.parse(String(requests[0]!.body)).tools.every((tool: { name: string }) => !tool.name.startsWith("mcp__")));
  await manager.close();
});

/** 创建独立项目目录，与测试数据库分开，并在测试后清理。 */
function projectDirectory(context: TestContext): string {
  const directory = mkdtempSync(join(tmpdir(), "tilot-core-project-"));
  context.after(() => {
    assert.equal(dirname(directory), resolve(tmpdir()));
    rmSync(directory, { recursive: true, force: true });
  });
  return realpathSync(directory);
}

/** 构造含推理及多个工具调用的真实 SDK 流样本，保留每个调用独立的标识。 */
function toolEvents(calls: { name: string; arguments: string }[]): Record<string, unknown>[] {
  const id = randomUUID();
  const output = [
    { type: "reasoning", id: `reason_${id}`, status: "completed", summary: [], content: [{ type: "reasoning_text", text: "先使用工具检查项目。" }] },
    ...calls.map((call, index) => ({ type: "function_call", id: `item_${id}_${index}`, call_id: `call_${id}_${index}`, status: "completed", ...call })),
  ];
  return [
    { type: "response.created", response: { id, status: "in_progress", output: [] } },
    ...output.flatMap((item, output_index) => [
      { type: "response.output_item.added", output_index, item },
      { type: "response.output_item.done", output_index, item },
    ]),
    { type: "response.completed", response: { id, status: "completed", output } },
  ].map((event, sequence_number) => ({ ...event, sequence_number }));
}

/** 每个测试使用独立数据库，清理前验证临时目录范围。 */
function openTestStore(context: TestContext): Store {
  const directory = mkdtempSync(join(tmpdir(), "tilot-core-"));
  const store = new Store(directory);
  context.after(() => {
    store.close();
    assert.equal(dirname(directory), resolve(tmpdir()));
    rmSync(directory, { recursive: true, force: true });
  });
  return store;
}

/** 创建带独立标识的本地流式样本，可选择模拟服务端意外返回工具调用。 */
function sampleEvents(tool = false): Record<string, unknown>[] {
  const id = randomUUID();
  const item = tool
    ? { type: "function_call", id: `item_${id}`, call_id: `call_${id}`, name: "unexpected", arguments: "{}", status: "completed" }
    : { type: "message", id: `item_${id}`, role: "assistant", status: "completed", content: [{ type: "output_text", text: "回答", annotations: [] }] };
  const output = [item];
  return [
    { type: "response.created", response: { id, status: "in_progress", output: [] } },
    { type: "response.output_item.added", output_index: 0, item },
    ...(tool ? [] : [{ type: "response.output_text.delta", output_index: 0, item_id: item.id, content_index: 0, delta: "回答" }]),
    { type: "response.output_item.done", output_index: 0, item },
    { type: "response.completed", response: { id, status: "completed", output } },
  ].map((event, sequence_number) => ({ ...event, sequence_number }));
}

/** 替换 SDK 的网络边界，仍走真实 SDK 解析、Responses 校验和 Core 存储流程。 */
function mockClient(events: () => Record<string, unknown>[] = sampleEvents, gate?: Promise<void>) {
  const requests: RequestInit[] = [];
  const client = createResponsesClient({ apiKey: "local-test-placeholder", baseURL: "http://localhost:1234" }).withOptions({
    fetch: async (_url, options) => {
      requests.push(options ?? {});
      await gate;
      return sse(events());
    },
  });
  return { client, requests };
}

function sse(events: Record<string, unknown>[]): Response {
  const body = events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join("");
  return new Response(body, { headers: { "content-type": "text/event-stream" } });
}

test("思考计时随流交付并落库，成功和失败工具均记录实际执行耗时，取消后未执行工具没有耗时", async (context) => {
  for (const cancel of [false, true]) {
    const store = openTestStore(context);
    const project = projectDirectory(context);
    const thread = store.createThread("过程计时", project);
    const controller = new AbortController();
    let request = 0;
    const { client } = mockClient(() => {
      if (++request > 1) return sampleEvents();
      const events = toolEvents([
        { name: "write", arguments: '{"path":"ok.txt","content":"结果"}' },
        { name: "read", arguments: '{"path":"missing.txt"}' },
      ]);
      const added = events.findIndex((event) => event.type === "response.output_item.added");
      const item = events[added]!.item as { id: string };
      events.splice(added + 1, 0,
        { type: "response.reasoning_text.delta", item_id: item.id, output_index: 0, content_index: 0, delta: "先使用工具检查项目。" },
        { type: "response.reasoning_text.done", item_id: item.id, output_index: 0, content_index: 0, text: "先使用工具检查项目。" });
      return events.map((event, sequence_number) => ({ ...event, sequence_number }));
    });
    const timings: (number | null)[] = [];
    const turn = await runTurn(store, client, { threadId: thread.id, input: "计时", instructions: "", signal: controller.signal,
      onEvent: (event) => {
        if (event.type === "reasoning.updated") timings.push(event.timing.durationMs);
        if (event.type === "tool.updated" && event.runningToolId) {
          const call = store.history.listToolCalls(event.attemptId).find((call) => call.id === event.runningToolId)!;
          assert.notEqual(call.startedAt, null);
          assert.equal(call.durationMs, null);
        }
        if (cancel && event.type === "tool.updated" && event.runningToolId === null) controller.abort();
      },
    });
    assert.equal(turn.status, cancel ? "cancelled" : "completed");
    assert.equal(timings.length, 2);
    assert.equal(timings[0], null);
    assert.ok(timings[1] !== null && timings[1]! >= 0);
    const attempt = store.history.listAttempts(turn.id)[0]!;
    assert.equal(attempt.reasoningTimings[0]!.durationMs, timings[1]);
    assert.ok(attempt.reasoningTimings[0]!.durationMs! <= attempt.durationMs!);
    const calls = store.history.listToolCalls(attempt.id);
    assert.ok(calls[0]!.durationMs !== null && calls[0]!.durationMs >= 0);
    const second = JSON.parse(String(calls[1]!.result!.output));
    if (cancel) {
      assert.equal(second.status, "not_executed");
      assert.equal(calls[1]!.startedAt, null);
      assert.equal(calls[1]!.durationMs, null);
    } else {
      assert.equal(second.status, "error");
      assert.ok(calls[1]!.durationMs !== null && calls[1]!.durationMs >= 0);
    }
  }
});

test("思考生成中取消也保存该段耗时，没有收到推理增量时不估算", async (context) => {
  const store = openTestStore(context);
  const controller = new AbortController();
  const { client } = mockClient(() => {
    const events = toolEvents([]);
    const item = events[1]!.item as { id: string };
    events.splice(2, 0, { type: "response.reasoning_text.delta", item_id: item.id, output_index: 0, content_index: 0, delta: "思考片段" });
    return events.map((event, sequence_number) => ({ ...event, sequence_number }));
  });
  const turn = await runTurn(store, client, { threadId: store.createThread("思考取消").id, input: "思考", instructions: "", signal: controller.signal,
    onEvent: (event) => { if (event.type === "response.event" && event.event.type === "response.reasoning_text.delta") controller.abort(); },
  });
  assert.equal(turn.status, "cancelled");
  const attempt = store.history.listAttempts(turn.id)[0]!;
  assert.equal(attempt.status, "cancelled");
  assert.ok(attempt.reasoningTimings[0]!.durationMs !== null && attempt.reasoningTimings[0]!.durationMs >= 0);
});

test("默认策略从 Markdown 读取，整轮只取得一次系统策略，后续轮次重新读取", async (context) => {
  const store = openTestStore(context);
  const thread = store.createThread("Markdown 系统策略");
  const { client, requests } = mockClient();
  let reads = 0;
  const options = {
    threadId: thread.id, input: "任务",
    get instructions() { return `策略版本 ${++reads}`; },
    onEvent: (event: TurnEvent) => {
      if (event.type === "turn.started") store.appendTurnInput(event.turn.id, "补充输入，触发后续请求");
    },
  };
  await runTurn(store, client, options);
  assert.equal(reads, 1);
  assert.equal(requests.length, 2);
  assert.ok(requests.every((request) => JSON.parse(String(request.body)).instructions === "策略版本 1"));
  const next = await runTurn(store, client, { threadId: thread.id, input: "下一轮", onEvent: options.onEvent });
  const formatter = new Intl.DateTimeFormat("sv-SE", { dateStyle: "short" });
  const expected = `${readPrompt("system")}\n\n本轮于 ${formatter.format(next.createdAt)} 开始，宿主时区为 ${formatter.resolvedOptions().timeZone}。`;
  assert.equal(requests.length, 4);
  assert.ok(requests.slice(2).every((request) => JSON.parse(String(request.body)).instructions === expected));
});

test("首请求保持原输入与冻结配置，补充输入在同一轮后续请求中处理并完整回放", async (context) => {
  const store = openTestStore(context);
  const original = store.getConfig();
  const config = { ...original, model: "configured-model", providers: [{ ...original.providers[0]!,
    models: [{ id: "configured-model" }, { id: "changed-model" }] }] };
  store.saveConfig(config);
  const thread = store.createThread("连续对话");
  const { client, requests } = mockClient();
  const events: string[] = [];
  const first = await runTurn(store, client, {
    threadId: thread.id, input: "你好", instructions: "系统策略",
    onEvent: (event) => {
      events.push(event.type === "response.event" ? event.event.type : event.type);
      if (event.type === "turn.started") {
        store.appendTurnInput(event.turn.id, "稍后补充");
        store.updateThreadModel(thread.id, "default", "changed-model", "none");
      } else if (event.type === "response.event" && event.event.type === "response.completed") {
        assert.equal(store.getTurn(event.turnId)?.status, requests.length === 1 ? "running" : "completed");
        assert.equal(store.history.getAttempt(event.attemptId)?.status, "completed");
        const saved = store.history.getAttempt(event.attemptId)!;
        assert.ok(saved.firstTokenMs !== null && saved.firstTokenMs >= 0);
        assert.ok(saved.durationMs !== null && saved.durationMs >= saved.firstTokenMs);
      }
    },
  });
  assert.equal(first.status, "completed");
  assert.equal(events[0], "turn.started");
  assert.ok(events.includes("response.output_text.delta"));
  const body = JSON.parse(String(requests[0]!.body));
  assert.equal(body.model, config.model);
  assert.equal(body.instructions, "系统策略");
  assert.equal("max_output_tokens" in body, false);
  assert.deepEqual(body.reasoning, { effort: config.reasoningEffort });
  assert.deepEqual(body.input, [{ role: "user", content: "你好" }]);
  assert.deepEqual(body.tools.map((tool: { name: string }) => tool.name), ["read", "ls", "find", "grep", "web_fetch", "request_user_input_async", "view_image"]);
  assert.equal(body.tool_choice, "auto");
  const steered = JSON.parse(String(requests[1]!.body));
  assert.equal(steered.model, config.model);
  assert.deepEqual(steered.reasoning, { effort: config.reasoningEffort });
  assert.deepEqual(steered.input.slice(2), [{ role: "user", content: "稍后补充" }]);
  await runTurn(store, client, { threadId: thread.id, input: "继续", instructions: "新策略" });
  const next = JSON.parse(String(requests[2]!.body));
  assert.equal(next.instructions, "新策略");
  assert.equal(next.input[1].type, "message");
  assert.deepEqual(next.input[2], { role: "user", content: "稍后补充" });
  assert.equal(next.input[3].type, "message");
  assert.deepEqual(next.input[4], { role: "user", content: "继续" });
  assert.equal(requests[0]!.signal?.aborted, true);
});

test("工具期间的引导在全部配对结果保存后进入下一请求，不中止或重跑已排定工具", async (context) => {
  const store = openTestStore(context);
  const project = projectDirectory(context);
  const thread = store.createThread("工具边界引导", project);
  let modelRequests = 0;
  const { client, requests } = mockClient(() => ++modelRequests === 1 ? toolEvents([
    { name: "write", arguments: JSON.stringify({ path: "one.txt", content: "一" }) },
    { name: "write", arguments: JSON.stringify({ path: "two.txt", content: "二" }) },
  ]) : sampleEvents());
  let appended = false;
  const turn = await runTurn(store, client, { threadId: thread.id, input: "创建两个文件", instructions: "",
    onEvent: (event) => {
      if (!appended && event.type === "tool.updated" && event.runningToolId === null) {
        appended = true;
        store.appendTurnInput(event.turnId, "补充：最后用中文说明");
      }
    },
  });
  assert.equal(turn.status, "completed");
  assert.equal(readFileSync(join(project, "one.txt"), "utf8"), "一");
  assert.equal(readFileSync(join(project, "two.txt"), "utf8"), "二");
  const nextInput = JSON.parse(String(requests[1]!.body)).input;
  assert.equal(nextInput.filter((item: { type?: string }) => item.type === "function_call_output").length, 2);
  assert.deepEqual(nextInput.at(-1), { role: "user", content: "补充：最后用中文说明" });
  assert.equal(store.listTurns(thread.id).length, 1);
});

test("连续引导超过 30 次模型请求仍在同一轮处理完成", async (context) => {
  const store = openTestStore(context);
  const thread = store.createThread("持续引导");
  const { client, requests } = mockClient();
  const turn = await runTurn(store, client, { threadId: thread.id, input: "原任务", instructions: "",
    onEvent: (event) => {
      if (event.type === "response.event" && event.event.type === "response.output_text.delta" && requests.length <= 32) {
        store.appendTurnInput(event.turnId, `补充 ${requests.length}`);
      }
    },
  });
  assert.equal(turn.status, "completed");
  assert.equal(requests.length, 33);
  assert.equal(store.listTurns(thread.id).length, 1);
  const attempts = store.history.listAttempts(turn.id);
  assert.equal(attempts.length, 33);
  assert.ok(attempts.every((attempt) => attempt.status === "completed"));
  assert.equal(attempts.at(-1)!.inputThroughId, store.getLatestTurnInput(turn.id)!.id);
  assert.equal(store.getLatestTurnInput(turn.id)!.content, "补充 32");
});

test("失败、截断和断流结束为失败，不重试或登记工具意图", async (context) => {
  const store = openTestStore(context);
  const samples = [
    [{ type: "response.failed", sequence_number: 0, response: { id: "failed", status: "failed", output: [], error: { message: "服务错误" } } }],
    [{ type: "response.incomplete", sequence_number: 0, response: { id: "incomplete", status: "incomplete", output: [], incomplete_details: { reason: "max_output_tokens" } } }],
    [],
  ];
  for (const [index, events] of samples.entries()) {
    const { client, requests } = mockClient(() => events);
    const turn = await runTurn(store, client, { threadId: store.createThread(`失败 ${index}`).id, input: "输入", instructions: "" });
    assert.equal(turn.status, "failed");
    assert.ok(turn.error);
    const attempts = store.history.listAttempts(turn.id);
    assert.equal(attempts.length, 1);
    assert.equal(attempts[0]!.status, index === 1 ? "incomplete" : "failed");
    assert.deepEqual(store.history.listToolCalls(attempts[0]!.id), []);
    assert.equal(requests.length, 1);
  }
});

test("取消前不创建轮次，流中取消结束尝试并释放请求", async (context) => {
  const store = openTestStore(context);
  const thread = store.createThread("取消测试");
  const { client, requests } = mockClient();
  const options = { threadId: thread.id, input: "输入", instructions: "" };
  await assert.rejects(runTurn(store, client, { ...options, signal: AbortSignal.abort() }), { name: "AbortError" });
  assert.deepEqual(store.listTurns(thread.id), []);
  assert.equal(requests.length, 0);
  const controller = new AbortController();
  const turn = await runTurn(store, client, {
    ...options, signal: controller.signal,
    onEvent: (event) => {
      if (event.type === "response.event" && event.event.type === "response.output_text.delta") controller.abort();
    },
  });
  assert.equal(turn.status, "cancelled");
  assert.equal(store.history.listAttempts(turn.id)[0]?.status, "cancelled");
  assert.equal(requests[0]!.signal?.aborted, true);
});

test("同一任务拒绝并发启动，不同任务独立执行", async (context) => {
  const store = openTestStore(context);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const { client } = mockClient(sampleEvents, gate);
  const thread = store.createThread("第一个任务");
  const options = { threadId: thread.id, input: "输入", instructions: "" };
  const first = runTurn(store, client, options);
  try {
    await assert.rejects(runTurn(store, client, options));
    assert.equal(store.listTurns(thread.id).length, 1);
    const second = runTurn(store, client, { ...options, threadId: store.createThread("第二个任务").id });
    release();
    assert.deepEqual((await Promise.all([first, second])).map((turn) => turn.status), ["completed", "completed"]);
  } finally {
    release();
    await first;
  }
});

test("事件处理错误会停止请求，终态通知错误不会改写已保存的成功结果", async (context) => {
  const store = openTestStore(context);
  const { client, requests } = mockClient();
  const thread = store.createThread("通知测试");
  const options = { threadId: thread.id, input: "输入", instructions: "" };
  const first = await runTurn(store, client, {
    ...options,
    onEvent: async (event) => {
      await Promise.resolve();
      if (event.type === "response.event") throw new Error("预览通知失败");
    },
  });
  assert.equal(first.status, "failed");
  assert.equal(first.error, "预览通知失败");
  assert.equal(requests[0]!.signal?.aborted, true);
  await assert.rejects(runTurn(store, client, {
    ...options,
    onEvent: (event) => {
      if (event.type === "response.event" && event.event.type === "response.completed") throw new Error("终态通知失败");
    },
  }), /终态通知失败/);
  const second = store.listTurns(thread.id)[1]!;
  assert.equal(second.status, "completed");
  assert.equal(store.history.listAttempts(second.id)[0]?.status, "completed");
});

test("项目工具按顺序执行并配对落库，下一次请求保留推理、调用和实际结果", { skip: process.platform !== "win32" }, async (context) => {
  const store = openTestStore(context);
  const directory = projectDirectory(context);
  const thread = store.createThread("工具循环", directory, "full-access");
  let count = 0;
  const { client, requests } = mockClient(() => ++count === 1 ? toolEvents([
    { name: "shell", arguments: JSON.stringify({ command: "Set-Content -LiteralPath 'note.txt' -Value '你好' -Encoding UTF8" }) },
    { name: "read", arguments: JSON.stringify({ path: "note.txt" }) },
  ]) : sampleEvents());
  const toolUpdates: { running: boolean; savedResults: number }[] = [];
  const turn = await runTurn(store, client, {
    threadId: thread.id, input: "检查", instructions: "系统策略",
    onEvent: (event) => {
      if (event.type !== "tool.updated") return;
      toolUpdates.push({ running: event.runningToolId !== null, savedResults: store.history.listToolCalls(event.attemptId).filter((call) => call.result !== null).length });
    },
  });
  assert.deepEqual(toolUpdates, [
    { running: true, savedResults: 0 }, { running: false, savedResults: 1 },
    { running: true, savedResults: 1 }, { running: false, savedResults: 2 },
  ]);
  assert.equal(turn.status, "completed");
  const attempts = store.history.listAttempts(turn.id);
  assert.equal(attempts.length, 2);
  const calls = store.history.listToolCalls(attempts[0]!.id);
  assert.equal(calls.length, 2);
  const first = JSON.parse(String(requests[0]!.body));
  assert.deepEqual(first.tools.map((tool: { name: string }) => tool.name), ["write", "edit", "read", "shell", "ls", "find", "grep", "web_fetch", "request_user_input_async", "view_image"]);
  assert.equal(first.tool_choice, "auto");
  const second = JSON.parse(String(requests[1]!.body));
  assert.deepEqual(second.tools, first.tools);
  assert.deepEqual(second.input.map((item: { type?: string }) => item.type ?? "user"),
    ["user", "reasoning", "function_call", "function_call", "function_call_output", "function_call_output"]);
  assert.equal(second.input[1].content[0].text, "先使用工具检查项目。");
  assert.equal(JSON.parse(second.input[4].output).data.exitCode, 0);
  assert.equal(JSON.parse(second.input[5].output).data.content, "你好\r\n");
  assert.equal(second.input[4].call_id, calls[0]!.callId);
  assert.equal(second.input[5].call_id, calls[1]!.callId);
});

test("目录和代码搜索进入真实工具循环，返回的路径和行号可继续读取并回放", async (context) => {
  const store = openTestStore(context);
  const directory = projectDirectory(context);
  mkdirSync(join(directory, "src"));
  writeFileSync(join(directory, "src", "你好.ts"), "前文\nneedle 中文\n后文\n", "utf8");
  const thread = store.createThread("查找并读取", directory);
  let count = 0;
  const { client, requests } = mockClient(() => {
    count++;
    if (count === 1) return toolEvents([
      { name: "ls", arguments: "{}" },
      { name: "find", arguments: JSON.stringify({ pattern: "*.ts" }) },
      { name: "grep", arguments: JSON.stringify({ pattern: "needle", glob: "*.ts" }) },
    ]);
    if (count === 2) {
      const body = JSON.parse(String(requests[1]!.body));
      const results = body.input.filter((item: { type: string }) => item.type === "function_call_output");
      const match = JSON.parse(results[2].output).data.matches[0];
      return toolEvents([{ name: "read", arguments: JSON.stringify({ path: match.path, offset: match.line, limit: 1 }) }]);
    }
    return sampleEvents();
  });
  const turn = await runTurn(store, client, { threadId: thread.id, input: "查找 needle 并读取", instructions: "" });
  assert.equal(turn.status, "completed");
  assert.equal(requests.length, 3);
  const attempts = store.history.listAttempts(turn.id);
  const calls = store.history.listToolCalls(attempts[0]!.id);
  assert.deepEqual(attempts[0]!.response!.output.filter((item) => item.type === "function_call").map((item) => item.name), ["ls", "find", "grep"]);
  const outputs = JSON.parse(String(requests[1]!.body)).input.filter((item: { type: string }) => item.type === "function_call_output");
  assert.deepEqual(outputs.map((item: { call_id: string }) => item.call_id), calls.map((call) => call.callId));
  assert.equal(JSON.parse(outputs[0].output).data.entries[0].path, "src");
  assert.deepEqual(JSON.parse(outputs[1].output).data.files, ["src/你好.ts"]);
  const last = JSON.parse(String(requests[2]!.body)).input.at(-1);
  assert.equal(last.type, "function_call_output");
  assert.equal(JSON.parse(last.output).data.content, "needle 中文\n");
  assert.deepEqual(JSON.parse(String(requests[2]!.body)).tools, JSON.parse(String(requests[0]!.body)).tools);
});

test("普通只读对话可抓取并续读网页，声明本地读取工具并在独立工作目录中执行", async (context) => {
  const fixture = await httpFixture(context, (_request, response) => {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end("<title>示例网页</title><p>第一段</p><p>第二段</p>");
  });
  const store = openTestStore(context);
  const thread = store.createThread("网页阅读");
  let count = 0;
  const { client, requests } = mockClient(() => {
    count++;
    if (count === 1) return toolEvents([{ name: "web_fetch", arguments: '{"url":"https://public.example/page","limit":1}' }]);
    if (count === 2) {
      const first = JSON.parse(String(requests[1]!.body)).input.find((item: { type: string }) => item.type === "function_call_output");
      const page = JSON.parse(first.output).data;
      return toolEvents([
        { name: "web_fetch", arguments: JSON.stringify({ outputId: page.outputId, offset: page.nextOffset }) },
        { name: "read", arguments: '{"path":"local.txt"}' },
      ]);
    }
    return sampleEvents();
  });
  const turn = await runTurn(store, client, { threadId: thread.id, input: "读取网页", instructions: "" });
  assert.equal(turn.status, "completed");
  assert.equal(requests.length, 3);
  assert.equal(fixture.calls.length, 1);
  for (const request of requests) assert.deepEqual(JSON.parse(String(request.body)).tools.map((tool: { name: string }) => tool.name), ["read", "ls", "find", "grep", "web_fetch", "request_user_input_async", "view_image"]);
  const final = JSON.parse(String(requests[2]!.body));
  const outputs = final.input.filter((item: { type: string }) => item.type === "function_call_output");
  const first = JSON.parse(outputs[0].output).data;
  const second = JSON.parse(outputs[1].output).data;
  assert.equal(first.title, "示例网页");
  assert.equal(first.finalUrl, "https://public.example/page");
  assert.equal(second.fetchedAt, first.fetchedAt);
  assert.equal(second.outputId, first.outputId);
  assert.equal(first.content + second.content, "第一段\n\n第二段");
  assert.match(JSON.parse(outputs[2].output).error, /ENOENT/);
  assert.ok(existsSync(join(store.dataDirectory, "workspaces", thread.id)));
  const calls = store.history.listAttempts(turn.id).flatMap((attempt) => store.history.listToolCalls(attempt.id));
  assert.deepEqual(outputs.map((item: { call_id: string }) => item.call_id), calls.map((call) => call.callId));
  assert.deepEqual(outputs.map((item: { output: string }) => item.output), calls.map((call) => String(call.result!.output)));
});

test("模型可连续写入、多处编辑并读取文件，差异保存并进入下一次请求", async (context) => {
  const store = openTestStore(context);
  const thread = store.createThread("文件修改", projectDirectory(context));
  let count = 0;
  const { client, requests } = mockClient(() => ++count === 1 ? toolEvents([
    { name: "write", arguments: JSON.stringify({ path: "src/a.txt", content: "第一行\r\n旧内容\n" }) },
    { name: "edit", arguments: JSON.stringify({ path: "src/a.txt", edits: [
      { oldText: "第一行\n", newText: "更新首行\n" }, { oldText: "旧内容", newText: "新内容" },
    ] }) },
    { name: "read", arguments: JSON.stringify({ path: "src/a.txt" }) },
  ]) : sampleEvents());
  const turn = await runTurn(store, client, { threadId: thread.id, input: "修改文件", instructions: "" });
  assert.equal(turn.status, "completed");
  const next = JSON.parse(String(requests[1]!.body));
  const results = next.input.filter((item: { type: string }) => item.type === "function_call_output").map((item: { output: string }) => JSON.parse(item.output));
  assert.deepEqual(results.map((result: { status: string }) => result.status), ["ok", "ok", "ok"]);
  assert.equal(results[2].data.content, "更新首行\r\n新内容\n");
  assert.equal(results[1].data.replacements, 2);
  assert.equal(results[1].data.firstChangedLine, 1);
  assert.equal(results[1].data.diffTruncated, false);
  assert.match(results[1].data.diff, /\+更新首行\r\n/);
  const calls = store.history.listToolCalls(store.history.listAttempts(turn.id)[0]!.id);
  assert.deepEqual(JSON.parse(String(calls[1]!.result!.output)), results[1]);
});

test("大输入完整发送且不设置输出上限，API 超限错误保存并结束轮次", async (context) => {
  const store = openTestStore(context);
  const thread = store.createThread("服务端限制");
  const input = "中文原文🙂".repeat(10000);
  let count = 0;
  const client = createResponsesClient({ apiKey: "local-test-placeholder", baseURL: "http://localhost:1234" }).withOptions({
    fetch: async (_url, options) => {
      count++;
      const body = JSON.parse(String(options?.body));
      assert.equal("max_output_tokens" in body, false);
      assert.equal("truncation" in body, false);
      assert.deepEqual(body.input, [{ role: "user", content: input }]);
      return new Response(JSON.stringify({ error: { message: "Context length exceeded", type: "invalid_request_error", code: "context_length_exceeded" } }),
        { status: 400, headers: { "content-type": "application/json" } });
    },
  });
  const turn = await runTurn(store, client, { threadId: thread.id, input, instructions: "原始策略" });
  assert.equal(turn.status, "failed");
  assert.match(turn.error!, /400.*Context length exceeded/);
  assert.equal(count, 1);
  const attempts = store.history.listAttempts(turn.id);
  assert.equal(attempts.length, 1);
  assert.equal(attempts[0]!.status, "failed");
  assert.equal(attempts[0]!.error, turn.error);
  assert.equal(store.listTurnInputs(turn.id)[0]!.content, input);
});

test("请求加载 Tilot 技能元数据并可按需读取正文", async (context) => {
  const store = openTestStore(context);
  const directory = projectDirectory(context);
  mkdirSync(join(directory, "skills/demo"), { recursive: true });
  writeFileSync(join(directory, "AGENTS.md"), "只修改当前项目", "utf8");
  writeFileSync(join(directory, "skills/demo/SKILL.md"), "---\nname: demo\ndescription: 示例技能\n---\n不自动发送的技能正文", "utf8");
  let count = 0;
  const { client, requests } = mockClient(() => ++count === 1 ? toolEvents([
    { name: "read", arguments: '{"path":"skills/demo/SKILL.md"}' },
  ]) : sampleEvents());
  const thread = store.createThread("项目上下文", directory);
  const first = await runTurn(store, client, { threadId: thread.id, input: "你好", instructions: "基础策略" });
  assert.equal(first.status, "completed");
  const sent = JSON.parse(String(requests[0]!.body));
  assert.match(sent.instructions, /基础策略/);
  assert.match(sent.instructions, /只修改当前项目/);
  assert.match(sent.instructions, /示例技能/);
  assert.ok(sent.instructions.includes("skills/demo/SKILL.md"));
  assert.doesNotMatch(sent.instructions, /不自动发送的技能正文/);
  const nextInput = JSON.parse(String(requests[1]!.body)).input;
  const result = JSON.parse(nextInput.find((item: { type?: string }) => item.type === "function_call_output").output);
  assert.equal(result.status, "ok");
  assert.match(result.data.content, /不自动发送的技能正文/);
});

test("未知工具、非法参数及读取失败都有配对结果，模型可继续作答", async (context) => {
  const store = openTestStore(context);
  const thread = store.createThread("工具错误", projectDirectory(context));
  let count = 0;
  const { client, requests } = mockClient(() => ++count === 1 ? toolEvents([
    { name: "unknown", arguments: "{}" },
    { name: "read", arguments: "bad json" },
    { name: "read", arguments: '{"path":"missing.txt","rootPath":"C:/"}' },
    { name: "read", arguments: '{"path":"missing.txt","offset":null}' },
    { name: "read", arguments: '{"path":"missing.txt"}' },
  ]) : sampleEvents());
  const turn = await runTurn(store, client, { threadId: thread.id, input: "检查", instructions: "" });
  assert.equal(turn.status, "completed");
  const calls = store.history.listToolCalls(store.history.listAttempts(turn.id)[0]!.id);
  assert.equal(calls.length, 5);
  for (const call of calls) assert.equal(JSON.parse(String(call.result!.output)).status, "error");
  assert.equal(requests.length, 2);
});

test("超过 30 次模型请求仍执行后续工具，保存全部结果并正常完成", async (context) => {
  const store = openTestStore(context);
  const directory = projectDirectory(context);
  writeFileSync(join(directory, "source.txt"), "内容", "utf8");
  const thread = store.createThread("长工具循环", directory);
  let count = 0;
  const { client, requests } = mockClient(() => {
    count++;
    if (count > 36) return sampleEvents();
    return toolEvents([count === 31
      ? { name: "write", arguments: '{"path":"after-30.txt","content":"仍执行"}' }
      : { name: "read", arguments: '{"path":"source.txt"}' }]);
  });
  const turn = await runTurn(store, client, { threadId: thread.id, input: "检查", instructions: "" });
  assert.equal(turn.status, "completed");
  assert.equal(requests.length, 37);
  assert.equal(readFileSync(join(directory, "after-30.txt"), "utf8"), "仍执行");
  const attempts = store.history.listAttempts(turn.id);
  assert.equal(attempts.length, 37);
  const calls = attempts.flatMap((attempt) => store.history.listToolCalls(attempt.id));
  assert.equal(calls.length, 36);
  assert.ok(calls.every((call) => JSON.parse(String(call.result!.output)).status === "ok"));
  const lastInput = JSON.parse(String(requests.at(-1)!.body)).input;
  assert.equal(lastInput.filter((item: { type?: string }) => item.type === "function_call_output").length, 36);
});

test("重复历史调用标识不会再次执行工具；工具后取消不会再次请求模型", async (context) => {
  const store = openTestStore(context);
  const directory = projectDirectory(context);
  const events = toolEvents([{ name: "read", arguments: '{"path":"missing.txt"}' }]);
  const repeated = mockClient(() => events);
  const turn = await runTurn(store, repeated.client, { threadId: store.createThread("重复调用", directory).id, input: "检查", instructions: "" });
  assert.equal(turn.status, "failed");
  assert.match(turn.error!, /重复/);
  const attempts = store.history.listAttempts(turn.id);
  assert.equal(attempts.length, 2);
  assert.deepEqual(store.history.listToolCalls(attempts[1]!.id), []);
  const controller = new AbortController();
  const cancelled = mockClient(() => toolEvents([{ name: "read", arguments: '{"path":"missing.txt"}' }]));
  const stopped = await runTurn(store, cancelled.client, {
    threadId: store.createThread("工具后取消", directory).id, input: "检查", instructions: "", signal: controller.signal,
    onEvent: (event) => {
      if (event.type === "response.event" && event.event.type === "response.completed") controller.abort();
    },
  });
  assert.equal(stopped.status, "cancelled");
  assert.equal(cancelled.requests.length, 1);
  assert.ok(store.history.listToolCalls(store.history.listAttempts(stopped.id)[0]!.id)[0]!.result);

  const between = new AbortController();
  const save = store.history.saveToolResult.bind(store.history);
  context.mock.method(store.history, "saveToolResult", (...args: Parameters<typeof save>) => {
    const saved = save(...args);
    between.abort();
    return saved;
  });
  const batch = mockClient(() => toolEvents([
    { name: "read", arguments: '{"path":"missing.txt"}' },
    { name: "shell", arguments: '{"command":"Set-Content skipped.txt changed"}' },
  ]));
  const batchTurn = await runTurn(store, batch.client, {
    threadId: store.createThread("调用之间取消", directory).id, input: "检查", instructions: "", signal: between.signal,
  });
  assert.equal(batchTurn.status, "cancelled");
  assert.equal(batch.requests.length, 1);
  const batchCalls = store.history.listToolCalls(store.history.listAttempts(batchTurn.id)[0]!.id);
  assert.equal(JSON.parse(String(batchCalls[1]!.result!.output)).status, "not_executed");
  assert.equal(existsSync(join(directory, "skipped.txt")), false);
});

test("普通完全访问对话使用各自保留的工作目录，相对路径不会串到其他对话", async (context) => {
  const store = openTestStore(context);
  const first = store.createThread("可写普通对话", null, "full-access");
  const second = store.createThread("另一个普通对话", null, "full-access");
  let count = 0;
  const writing = mockClient(() => ++count === 1 ? toolEvents([{ name: "write", arguments: '{"path":"saved.txt","content":"保留内容"}' }]) : sampleEvents());
  assert.equal((await runTurn(store, writing.client, { threadId: first.id, input: "保存", instructions: "" })).status, "completed");
  const file = join(store.dataDirectory, "workspaces", first.id, "saved.txt");
  assert.equal(readFileSync(file, "utf8"), "保留内容");
  for (const thread of [first, second]) {
    let request = 0;
    const reading = mockClient(() => ++request === 1 ? toolEvents([{ name: "read", arguments: '{"path":"saved.txt"}' }]) : sampleEvents());
    await runTurn(store, reading.client, { threadId: thread.id, input: "读取", instructions: "" });
    const body = JSON.parse(String(reading.requests[1]!.body));
    const output = JSON.parse(body.input.filter((item: { type: string }) => item.type === "function_call_output").at(-1).output);
    if (thread.id === first.id) assert.equal(output.data.content, "保留内容");
    else { assert.equal(output.status, "error"); assert.match(output.error, /ENOENT/); }
  }
  assert.equal(readFileSync(file, "utf8"), "保留内容");
  assert.equal(existsSync(join(store.dataDirectory, "workspaces", second.id, "saved.txt")), false);
});

test("命令进度不提前落库或进入上下文，正式日志结果可驱动下一次 read 调用", { skip: process.platform !== "win32" }, async (context) => {
  const store = openTestStore(context);
  const thread = store.createThread("读取执行日志", projectDirectory(context), "full-access");
  let count = 0;
  let outputId = "";
  const { client, requests } = mockClient(() => {
    count++;
    if (count === 1) return toolEvents([{ name: "shell", arguments: JSON.stringify({
      command: "[Console]::WriteLine('第一段🙂'); Start-Sleep -Milliseconds 250; [Console]::Write('第二段'); Start-Sleep -Milliseconds 150",
    }) }]);
    if (count === 2) {
      const body = JSON.parse(String(requests[1]!.body));
      const result = body.input.find((item: { type: string }) => item.type === "function_call_output");
      outputId = JSON.parse(result.output).data.outputId;
      return toolEvents([{ name: "read", arguments: JSON.stringify({ outputId, offset: 2 }) }]);
    }
    return sampleEvents();
  });
  let progress = 0;
  const turn = await runTurn(store, client, { threadId: thread.id, input: "执行并续读", instructions: "", onEvent(event) {
    if (event.type !== "tool.progress") return;
    progress++;
    const call = store.history.listToolCalls(event.attemptId)[0]!;
    assert.equal(event.toolId, call.id);
    assert.equal(call.result, null);
    assert.ok(event.snapshot.output.includes("第一段🙂"));
  } });
  assert.equal(turn.status, "completed");
  assert.ok(progress > 0);
  assert.equal(requests.length, 3);
  const attempts = store.history.listAttempts(turn.id);
  const shell = store.history.listToolCalls(attempts[0]!.id)[0]!;
  assert.equal(outputId, shell.id);
  assert.notEqual(outputId, shell.callId);
  const final = JSON.parse(String(requests[2]!.body));
  const results = final.input.filter((item: { type: string }) => item.type === "function_call_output");
  assert.equal(results.length, 2);
  assert.equal(JSON.parse(results[1].output).data.content, "第二段");
  assert.doesNotMatch(String(requests[2]!.body), /tool\.progress|"preview"/);
});

test("命令进度交付失败先停止进程并保存实际结果，后续工具不执行且模型不重试", { skip: process.platform !== "win32", timeout: 15000 }, async (context) => {
  const store = openTestStore(context);
  const directory = projectDirectory(context);
  const thread = store.createThread("进度交付失败", directory, "full-access");
  const pidFile = join(directory, "child.pid");
  const script = join(directory, "child.cjs");
  writeFileSync(script, `require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); process.stdout.write('实际输出'); setInterval(() => {}, 1000);`, "utf8");
  const literal = (value: string) => "'" + value.replaceAll("'", "''") + "'";
  const { client, requests } = mockClient(() => toolEvents([
    { name: "shell", arguments: JSON.stringify({ command: `& ${literal(process.execPath)} ${literal(script)}`, timeoutSeconds: 5 }) },
    { name: "write", arguments: JSON.stringify({ path: "skipped.txt", content: "不应写入" }) },
  ]));
  await assert.rejects(runTurn(store, client, { threadId: thread.id, input: "执行", instructions: "", onEvent(event) {
    if (event.type === "tool.progress") throw new Error("进度交付失败");
  } }), /进度交付失败/);
  const turn = store.listTurns(thread.id)[0]!;
  assert.equal(turn.status, "failed");
  const calls = store.history.listToolCalls(store.history.listAttempts(turn.id)[0]!.id);
  const actual = JSON.parse(String(calls[0]!.result!.output));
  assert.equal(actual.status, "ok");
  assert.equal(actual.data.status, "cancelled");
  assert.equal(actual.data.output, "实际输出");
  assert.equal(actual.data.outputId, calls[0]!.id);
  assert.equal(JSON.parse(String(calls[1]!.result!.output)).status, "not_executed");
  assert.equal(existsSync(join(directory, "skipped.txt")), false);
  assert.equal(requests.length, 1);
  assert.throws(() => process.kill(Number(readFileSync(pidFile, "utf8")), 0), { code: "ESRCH" });
});
