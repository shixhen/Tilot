import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test, type TestContext } from "node:test";
import type { Response, ResponseOutputItem } from "openai/resources/responses/responses";
import { Store } from "@tilot/store";
import { buildContext } from "@tilot/context";

/** 为每个测试创建独立数据库，结束时关闭连接并清理本次临时目录。 */
function openTestStore(context: TestContext): Store {
  const directory = mkdtempSync(join(tmpdir(), "tilot-context-"));
  const store = new Store(directory);
  context.after(() => {
    store.close();
    assert.equal(dirname(directory), resolve(tmpdir()));
    rmSync(directory, { recursive: true, force: true });
  });
  return store;
}

/** 创建仅供本地测试的完整响应，每次使用独立的响应 id。 */
function response(output: ResponseOutputItem[] = []): Response {
  return {
    id: randomUUID(), object: "response", created_at: 1, model: "deepseek-flash",
    status: "completed", output, output_text: "", error: null, incomplete_details: null,
    instructions: null, metadata: null, parallel_tool_calls: true,
    temperature: null, top_p: null, tool_choice: "auto", tools: [],
  };
}

/** 构造包含原始参数字符串的工具调用，不执行实际工具。 */
function call(id: string): ResponseOutputItem {
  return { type: "function_call", id: `item_${id}`, call_id: id, name: "read_file", arguments: ' { "path": "a.ts" } ', status: "completed" };
}

test("按输入边界回放完整消息组，保留推理并跳过诊断，固定本次输入范围", (context) => {
  const store = openTestStore(context);
  const thread = store.createThread("多轮历史");
  const old = store.startTurn(thread.id, "  首条输入  ");
  const initial = store.listTurnInputs(old.id)[0]!;
  const first = store.history.startAttempt(old.id, initial.id);
  const snapshot = response([
    { type: "reasoning", id: "reasoning_1", summary: [], content: [{ type: "reasoning_text", text: "原始推理正文" }] },
    call("a"), call("b"),
  ]);
  store.history.finishAttempt(first.id, { status: "completed", response: snapshot });
  const extra = store.appendTurnInput(old.id, "工具执行期间的补充");
  const calls = store.history.listToolCalls(first.id);
  store.history.saveToolResult(calls[1]!.id, { type: "function_call_output", call_id: "b", output: "第二个结果" });
  store.history.saveToolResult(calls[0]!.id, { type: "function_call_output", call_id: "a", output: "第一个结果" });
  const failure = store.history.startAttempt(old.id, extra.id);
  store.history.finishAttempt(failure.id, { status: "failed", response: response([call("diagnostic")]), error: "断流" });
  const retry = store.history.startAttempt(old.id, extra.id);
  const answer: ResponseOutputItem = { type: "message", id: "answer", role: "assistant", status: "completed", content: [{ type: "output_text", text: "回答", annotations: [] }] };
  store.history.finishAttempt(retry.id, { status: "completed", response: response([answer]) });
  store.appendTurnInput(old.id, "取消前尚未发送的要求");
  store.finishTurn(old.id, "cancelled");
  const current = store.startTurn(thread.id, "新一轮");
  const boundary = store.listTurnInputs(current.id)[0]!;
  store.appendTurnInput(current.id, "边界之后的输入");
  const built = buildContext(store, { turnId: current.id, inputThroughId: boundary.id, instructions: "系统策略原文" });
  assert.equal(built.instructions, "系统策略原文");
  assert.deepEqual(built.input, [
    { role: "user", content: initial.content }, ...snapshot.output,
    { type: "function_call_output", call_id: "a", output: "第一个结果" },
    { type: "function_call_output", call_id: "b", output: "第二个结果" },
    { role: "user", content: extra.content }, answer,
    { role: "user", content: "取消前尚未发送的要求" },
    { role: "user", content: boundary.content },
  ]);
  assert.deepEqual(store.history.getAttempt(first.id)?.response, snapshot);
});

test("所有层级读完分页，历史不会混入其他任务", (context) => {
  const store = openTestStore(context);
  const thread = store.createThread("分页历史");
  const independent = store.startTurn(store.createThread("其他任务").id, "不得出现");
  for (let index = 0; index < 51; index++) {
    const turn = store.startTurn(thread.id, `旧轮次 ${index}`);
    store.finishTurn(turn.id, "completed");
  }
  const current = store.startTurn(thread.id, "当前输入");
  let boundary = store.listTurnInputs(current.id)[0]!;
  for (let index = 0; index < 51; index++) {
    const attempt = store.history.startAttempt(current.id, boundary.id);
    store.history.finishAttempt(attempt.id, { status: "completed", response: response() });
    boundary = store.appendTurnInput(current.id, `补充 ${index}`);
  }
  const built = buildContext(store, { turnId: current.id, inputThroughId: boundary.id, instructions: "" });
  assert.equal(built.input.length, 103);
  assert.deepEqual(built.input.at(-1), { role: "user", content: "补充 50" });
  assert.equal(store.getTurn(independent.id)?.status, "running");
});

test("拒绝未决调用、运行中请求、无效边界和结束后的目标轮次", (context) => {
  const store = openTestStore(context);
  const turn = store.startTurn(store.createThread("边界检查").id, "输入");
  const input = store.listTurnInputs(turn.id)[0]!;
  const options = { turnId: turn.id, inputThroughId: input.id, instructions: "" };
  assert.throws(() => buildContext(store, { ...options, inputThroughId: input.id + 1 }), /输入边界/);
  const attempt = store.history.startAttempt(turn.id, input.id);
  assert.throws(() => buildContext(store, options), /运行中的请求/);
  store.history.finishAttempt(attempt.id, { status: "completed", response: response([call("pending")]) });
  assert.throws(() => buildContext(store, options), /缺少配对结果/);
  const stored = store.history.listToolCalls(attempt.id)[0]!;
  store.history.saveToolResult(stored.id, { type: "function_call_output", call_id: stored.callId, output: "已核实" });
  const extra = store.appendTurnInput(turn.id, "新输入");
  const next = store.history.startAttempt(turn.id, extra.id);
  store.history.finishAttempt(next.id, { status: "completed", response: response() });
  assert.throws(() => buildContext(store, options), /超出本次上下文/);
  const backwards = store.history.startAttempt(turn.id, input.id);
  store.history.finishAttempt(backwards.id, { status: "completed", response: response() });
  assert.throws(() => buildContext(store, { ...options, inputThroughId: extra.id }), /边界倒退/);
  store.finishTurn(turn.id, "completed");
  assert.throws(() => buildContext(store, options), /正在运行/);
});

test("跨响应重复调用标识使整体回放失败，SDK 专用解析字段不进入请求", (context) => {
  const store = openTestStore(context);
  const turn = store.startTurn(store.createThread("标识检查").id, "输入");
  const input = store.listTurnInputs(turn.id)[0]!;
  const first = store.history.startAttempt(turn.id, input.id);
  const original = call("same");
  Reflect.set(original, "parsed_arguments", { path: "a.ts" });
  store.history.finishAttempt(first.id, { status: "completed", response: response([original]) });
  const saved = store.history.listToolCalls(first.id)[0]!;
  store.history.saveToolResult(saved.id, { type: "function_call_output", call_id: "same", output: "结果" });
  const options = { turnId: turn.id, inputThroughId: input.id, instructions: "" };
  assert.equal("parsed_arguments" in buildContext(store, options).input[1]!, false);
  assert.equal("parsed_arguments" in store.history.getAttempt(first.id)!.response!.output[0]!, true);
  const second = store.history.startAttempt(turn.id, input.id);
  store.history.finishAttempt(second.id, { status: "completed", response: response([{ ...call("same"), id: "different_item" }]) });
  const duplicate = store.history.listToolCalls(second.id)[0]!;
  store.history.saveToolResult(duplicate.id, { type: "function_call_output", call_id: "same", output: "另一次结果" });
  assert.throws(() => buildContext(store, options), /重复的工具 call_id/);
});
