import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test, type TestContext } from "node:test";
import { Store } from "@tilot/store";
import { createResponsesClient } from "@tilot/responses";
import { runTurn } from "@tilot/agent-core";

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
      const body = events().map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join("");
      return new Response(body, { headers: { "content-type": "text/event-stream" } });
    },
  });
  return { client, requests };
}

test("完成一轮并回放历史，冻结输入与配置，终态事件在保存后交付", async (context) => {
  const store = openTestStore(context);
  const thread = store.createThread("连续对话");
  const config = { ...store.getConfig(), model: "configured-model", maxOutputTokens: 2048 };
  store.saveConfig(config);
  const { client, requests } = mockClient();
  const events: string[] = [];
  const first = await runTurn(store, client, {
    threadId: thread.id, input: "你好", instructions: "系统策略",
    onEvent: (event) => {
      events.push(event.type === "response.event" ? event.event.type : event.type);
      if (event.type === "turn.started") {
        store.appendTurnInput(event.turn.id, "稍后补充");
        store.saveConfig({ ...config, model: "changed-model" });
      } else if (event.event.type === "response.completed") {
        assert.equal(store.getTurn(event.turnId)?.status, "completed");
        assert.equal(store.history.getAttempt(event.attemptId)?.status, "completed");
      }
    },
  });
  assert.equal(first.status, "completed");
  assert.equal(events[0], "turn.started");
  assert.ok(events.includes("response.output_text.delta"));
  const body = JSON.parse(String(requests[0]!.body));
  assert.equal(body.model, config.model);
  assert.equal(body.instructions, "系统策略");
  assert.equal(body.max_output_tokens, 2048);
  assert.deepEqual(body.reasoning, { effort: config.reasoningEffort });
  assert.deepEqual(body.input, [{ role: "user", content: "你好" }]);
  assert.deepEqual(body.tools, []);
  assert.equal(body.tool_choice, "none");
  await runTurn(store, client, { threadId: thread.id, input: "继续", instructions: "新策略" });
  const next = JSON.parse(String(requests[1]!.body));
  assert.equal(next.instructions, "新策略");
  assert.equal(next.input[1].type, "message");
  assert.deepEqual(next.input.slice(2), [{ role: "user", content: "稍后补充" }, { role: "user", content: "继续" }]);
  assert.equal(requests[0]!.signal?.aborted, true);
});

test("失败、截断、断流及未声明工具均结束为失败，不重试或登记工具意图", async (context) => {
  const store = openTestStore(context);
  const samples = [
    [{ type: "response.failed", sequence_number: 0, response: { id: "failed", status: "failed", output: [], error: { message: "服务错误" } } }],
    [{ type: "response.incomplete", sequence_number: 0, response: { id: "incomplete", status: "incomplete", output: [], incomplete_details: { reason: "max_output_tokens" } } }],
    [],
    sampleEvents(true),
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
    if (index === 3) assert.equal(attempts[0]!.response?.output[0]?.type, "function_call");
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
  const thread = store.createThread("工具循环", directory);
  let count = 0;
  const { client, requests } = mockClient(() => ++count === 1 ? toolEvents([
    { name: "shell", arguments: JSON.stringify({ command: "Set-Content -LiteralPath 'note.txt' -Value '你好' -Encoding UTF8" }) },
    { name: "read", arguments: JSON.stringify({ path: "note.txt" }) },
  ]) : sampleEvents());
  const turn = await runTurn(store, client, { threadId: thread.id, input: "检查", instructions: "系统策略" });
  assert.equal(turn.status, "completed");
  const attempts = store.history.listAttempts(turn.id);
  assert.equal(attempts.length, 2);
  const calls = store.history.listToolCalls(attempts[0]!.id);
  assert.equal(calls.length, 2);
  const first = JSON.parse(String(requests[0]!.body));
  assert.deepEqual(first.tools.map((tool: { name: string }) => tool.name), ["read", "shell"]);
  assert.equal(first.tool_choice, "auto");
  const second = JSON.parse(String(requests[1]!.body));
  assert.deepEqual(second.input.map((item: { type?: string }) => item.type ?? "user"),
    ["user", "reasoning", "function_call", "function_call", "function_call_output", "function_call_output"]);
  assert.equal(second.input[1].content[0].text, "先使用工具检查项目。");
  assert.equal(JSON.parse(second.input[4].output).data.exitCode, 0);
  assert.equal(JSON.parse(second.input[5].output).data.content, "你好\r\n");
  assert.equal(second.input[4].call_id, calls[0]!.callId);
  assert.equal(second.input[5].call_id, calls[1]!.callId);
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

test("达到步骤限制不执行末次命令，历史配对完整，下一轮仍能继续", async (context) => {
  const store = openTestStore(context);
  store.saveConfig({ ...store.getConfig(), maxStepsPerRun: 1 });
  const directory = projectDirectory(context);
  const thread = store.createThread("步骤限制", directory);
  const { client, requests } = mockClient(() => toolEvents([
    { name: "shell", arguments: '{"command":"Set-Content blocked.txt changed"}' },
  ]));
  const turn = await runTurn(store, client, { threadId: thread.id, input: "检查", instructions: "" });
  assert.equal(turn.status, "failed");
  assert.match(turn.error!, /最大模型请求次数/);
  assert.equal(requests.length, 1);
  assert.equal(existsSync(join(directory, "blocked.txt")), false);
  const result = store.history.listToolCalls(store.history.listAttempts(turn.id)[0]!.id)[0]!.result!;
  assert.equal(JSON.parse(String(result.output)).status, "not_executed");
  const next = await runTurn(store, mockClient().client, { threadId: thread.id, input: "继续", instructions: "" });
  assert.equal(next.status, "completed");
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
