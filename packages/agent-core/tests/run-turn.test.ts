import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test, type TestContext } from "node:test";
import { Store } from "@tilot/store";
import { createResponsesClient } from "@tilot/responses";
import { runTurn } from "@tilot/agent-core";
import { httpFixture } from "../../tool/tests/http-fixture.ts";

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
  const original = store.getConfig();
  const config = { ...original, model: "configured-model", maxOutputTokens: 2048, providers: [{ ...original.providers[0]!,
    models: [{ id: "configured-model", contextTokens: 65536 }, { id: "changed-model", contextTokens: 65536 }] }] };
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
        assert.equal(store.getTurn(event.turnId)?.status, "completed");
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
  assert.equal(body.max_output_tokens, 2048);
  assert.deepEqual(body.reasoning, { effort: config.reasoningEffort });
  assert.deepEqual(body.input, [{ role: "user", content: "你好" }]);
  assert.deepEqual(body.tools.map((tool: { name: string }) => tool.name), ["web_fetch"]);
  assert.equal(body.tool_choice, "auto");
  await runTurn(store, client, { threadId: thread.id, input: "继续", instructions: "新策略" });
  const next = JSON.parse(String(requests[1]!.body));
  assert.equal(next.instructions, "新策略");
  assert.equal(next.input[1].type, "message");
  assert.deepEqual(next.input.slice(2), [{ role: "user", content: "稍后补充" }, { role: "user", content: "继续" }]);
  assert.equal(requests[0]!.signal?.aborted, true);
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
  const thread = store.createThread("工具循环", directory);
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
  assert.deepEqual(first.tools.map((tool: { name: string }) => tool.name), ["write", "edit", "read", "shell", "ls", "find", "grep", "web_fetch"]);
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

test("普通对话可抓取并续读网页，来源与结果配对回放，不开放项目工具", async (context) => {
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
  for (const request of requests) assert.deepEqual(JSON.parse(String(request.body)).tools.map((tool: { name: string }) => tool.name), ["web_fetch"]);
  const final = JSON.parse(String(requests[2]!.body));
  const outputs = final.input.filter((item: { type: string }) => item.type === "function_call_output");
  const first = JSON.parse(outputs[0].output).data;
  const second = JSON.parse(outputs[1].output).data;
  assert.equal(first.title, "示例网页");
  assert.equal(first.finalUrl, "https://public.example/page");
  assert.equal(second.fetchedAt, first.fetchedAt);
  assert.equal(second.outputId, first.outputId);
  assert.equal(first.content + second.content, "第一段\n\n第二段");
  assert.match(JSON.parse(outputs[2].output).error, /未声明的工具/);
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

test("请求加载项目根指令和技能元数据，预算超限时不请求模型", async (context) => {
  const store = openTestStore(context);
  const directory = projectDirectory(context);
  mkdirSync(join(directory, ".codex/skills/demo"), { recursive: true });
  writeFileSync(join(directory, "AGENTS.md"), "只修改当前项目", "utf8");
  writeFileSync(join(directory, ".codex/skills/demo/SKILL.md"), "---\nname: demo\ndescription: 示例技能\n---\n不自动发送的技能正文", "utf8");
  const { client, requests } = mockClient();
  const thread = store.createThread("项目上下文", directory);
  const first = await runTurn(store, client, { threadId: thread.id, input: "你好", instructions: "基础策略" });
  assert.equal(first.status, "completed");
  const sent = JSON.parse(String(requests[0]!.body));
  assert.match(sent.instructions, /基础策略/);
  assert.match(sent.instructions, /只修改当前项目/);
  assert.match(sent.instructions, /示例技能/);
  assert.doesNotMatch(sent.instructions, /不自动发送的技能正文/);
  const config = store.getConfig();
  store.saveConfig({ ...config, providers: config.providers.map((provider) => ({ ...provider,
    models: provider.models.map((model) => ({ ...model, contextTokens: config.maxOutputTokens + config.reserveTokens + 1 })) })) });
  const stopped = await runTurn(store, client, { threadId: thread.id, input: "继续", instructions: "基础策略" });
  assert.equal(stopped.status, "failed");
  assert.match(stopped.error!, /上下文超出预算/);
  assert.equal(requests.length, 1);
  assert.deepEqual(store.history.listAttempts(stopped.id), []);
  assert.equal(store.listTurnInputs(stopped.id)[0]!.content, "继续");
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

test("命令进度不提前落库或进入上下文，正式日志结果可驱动下一次 read 调用", { skip: process.platform !== "win32" }, async (context) => {
  const store = openTestStore(context);
  const thread = store.createThread("读取执行日志", projectDirectory(context));
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
  const thread = store.createThread("进度交付失败", directory);
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
