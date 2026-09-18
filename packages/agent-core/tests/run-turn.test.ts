import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test, type TestContext } from "node:test";
import { Store } from "@tilot/store";
import { createResponsesClient } from "@tilot/responses";
import { runTurn } from "@tilot/agent-core";

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
    onEvent: (event) => {
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
