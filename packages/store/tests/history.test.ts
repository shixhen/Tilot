import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import Database from "better-sqlite3";
import type { Response, ResponseOutputItem } from "openai/resources/responses/responses";
import { Store } from "@tilot/store";
import { temporaryDirectory } from "./helpers.ts";

/** 构造完整的本地响应样本，不连接模型服务。 */
function response(output: ResponseOutputItem[] = []): Response {
  return {
    id: "resp_test", object: "response", created_at: 1, model: "deepseek-flash",
    status: "completed", output, output_text: "", error: null, incomplete_details: null,
    instructions: null, metadata: null, parallel_tool_calls: true,
    temperature: null, top_p: null, tool_choice: "auto", tools: [],
  };
}

/** 构造保留原始参数文本的函数调用样本。 */
function call(id: string): ResponseOutputItem {
  return { type: "function_call", id: `item_${id}`, call_id: id, name: "read_file", arguments: ' { "path": "a.ts" } ', status: "completed" };
}

test("完整响应及工具结果持久化，结果按模型顺序读取，补充输入边界独立保存", (context) => {
  const directory = temporaryDirectory(context);
  const store = new Store(directory);
  const thread = store.createThread("模型历史");
  const turn = store.startTurn(thread.id, "读取代码");
  const input = store.listTurnInputs(turn.id)[0]!;
  const attempt = store.history.startAttempt(turn.id, input.id);
  const snapshot = response([
    { type: "reasoning", id: "reasoning_1", summary: [], content: [{ type: "reasoning_text", text: "原始推理正文" }] },
    call("first"), call("second"),
  ]);
  try {
    store.history.finishAttempt(attempt.id, { status: "completed", response: snapshot });
    const calls = store.history.listToolCalls(attempt.id);
    assert.deepEqual(calls.map((item) => item.outputIndex), [1, 2]);
    store.history.saveToolResult(calls[1]!.id, { type: "function_call_output", call_id: "second", output: "第二个结果" });
    store.history.saveToolResult(calls[0]!.id, { type: "function_call_output", call_id: "first", output: "第一个结果" });
    assert.deepEqual(store.history.listToolCalls(attempt.id).map((item) => item.result?.output), ["第一个结果", "第二个结果"]);
    const extra = store.appendTurnInput(turn.id, "补充要求");
    const next = store.history.startAttempt(turn.id, extra.id);
    assert.equal(next.inputThroughId, extra.id);
    assert.equal(next.sequence, 2);
    store.history.finishAttempt(next.id, { status: "completed", response: response() });
    assert.equal(store.history.listAttempts(turn.id, 1, 1)[0]?.id, next.id);
    store.finishTurn(turn.id, "completed");
  } finally {
    store.close();
  }
  const reopened = new Store(directory);
  try {
    assert.deepEqual(reopened.history.getAttempt(attempt.id)?.response, snapshot);
    assert.equal(reopened.history.getAttempt(attempt.id)?.inputThroughId, input.id);
    assert.equal(reopened.history.listToolCalls(attempt.id)[0]?.result?.output, "第一个结果");
  } finally {
    reopened.close();
  }
});

test("请求互斥、工具配对及事务回滚阻止不完整历史继续执行", (context) => {
  const store = new Store(temporaryDirectory(context));
  try {
    const turn = store.startTurn(store.createThread("配对约束").id, "输入");
    const input = store.listTurnInputs(turn.id)[0]!;
    assert.throws(() => store.history.startAttempt(turn.id, input.id + 1), /输入边界/);
    const attempt = store.history.startAttempt(turn.id, input.id);
    assert.throws(() => store.history.startAttempt(turn.id, input.id));
    assert.throws(() => store.finishTurn(turn.id, "cancelled"), /仍在运行/);
    assert.throws(() => store.history.finishAttempt(attempt.id, { status: "completed", response: response([call("same"), call("same")]) }));
    assert.equal(store.history.getAttempt(attempt.id)?.status, "running");
    assert.deepEqual(store.history.listToolCalls(attempt.id), []);
    store.history.finishAttempt(attempt.id, { status: "completed", response: response([call("a"), call("b")]) });
    assert.throws(() => store.history.finishAttempt(attempt.id, { status: "failed" }), /已结束/);
    const calls = store.history.listToolCalls(attempt.id);
    assert.throws(() => store.history.saveToolResult(calls[0]!.id, { type: "function_call_output", output: "无标识" }), /call_id/);
    assert.throws(() => store.history.saveToolResult(calls[0]!.id, { type: "function_call_output", call_id: "wrong", output: "错误配对" }), /不匹配/);
    const result = { type: "function_call_output" as const, call_id: "a", output: "结果" };
    store.history.saveToolResult(calls[0]!.id, result);
    assert.throws(() => store.history.saveToolResult(calls[0]!.id, result), /已保存/);
    assert.throws(() => store.history.startAttempt(turn.id, input.id), /缺少结果/);
    assert.throws(() => store.finishTurn(turn.id, "completed"), /尚未补齐/);
    store.finishTurn(turn.id, "cancelled");
    const next = store.startTurn(turn.threadId, "重启后继续");
    const nextInput = store.listTurnInputs(next.id)[0]!;
    assert.throws(() => store.history.startAttempt(next.id, nextInput.id), /缺少结果/);
    // 补录经过核实的结果，不因新轮次自动重跑未决工具。
    store.history.saveToolResult(calls[1]!.id, { type: "function_call_output", call_id: "b", output: "已核实的结果" });
    assert.equal(store.history.startAttempt(next.id, nextInput.id).status, "running");
  } finally {
    store.close();
  }
});

test("失败诊断不登记工具调用，显式恢复只中断仍运行的尝试", (context) => {
  const directory = temporaryDirectory(context);
  const store = new Store(directory);
  const turn = store.startTurn(store.createThread("失败恢复").id, "输入");
  const input = store.listTurnInputs(turn.id)[0]!;
  const snapshot = response([call("diagnostic")]);
  for (const status of ["failed", "incomplete", "cancelled"] as const) {
    const attempt = store.history.startAttempt(turn.id, input.id);
    store.history.finishAttempt(attempt.id, { status, response: snapshot, error: "诊断信息" });
    assert.deepEqual(store.history.listToolCalls(attempt.id), []);
    assert.deepEqual(store.history.getAttempt(attempt.id)?.response, snapshot);
  }
  const running = store.history.startAttempt(turn.id, input.id);
  store.close();
  const reopened = new Store(directory);
  try {
    assert.equal(reopened.history.getAttempt(running.id)?.status, "running");
    assert.equal(reopened.recoverInterruptedTurns(), 1);
    assert.deepEqual(reopened.history.listAttempts(turn.id).map((item) => item.status), ["failed", "incomplete", "cancelled", "interrupted"]);
    assert.equal(reopened.history.getAttempt(running.id)?.response, null);
    assert.throws(() => reopened.history.finishAttempt(running.id, { status: "completed", response: response() }), /已结束/);
    assert.equal(reopened.recoverInterruptedTurns(), 0);
  } finally {
    reopened.close();
  }
});

test("版本 3 升级保留轮次和输入，并增加模型历史表", (context) => {
  const directory = temporaryDirectory(context);
  const store = new Store(directory);
  const thread = store.createThread("旧任务");
  const turn = store.startTurn(thread.id, "原有输入");
  const input = store.listTurnInputs(turn.id)[0]!;
  const savedThread = store.getThread(thread.id);
  store.close();
  const legacy = new Database(join(directory, "tilot.sqlite"));
  try {
    legacy.exec("DROP TABLE tool_calls; DROP TABLE model_attempts; PRAGMA user_version = 3;");
  } finally {
    legacy.close();
  }
  const migrated = new Store(directory);
  try {
    assert.deepEqual(migrated.getThread(thread.id), savedThread);
    assert.deepEqual(migrated.getTurn(turn.id), turn);
    assert.deepEqual(migrated.listTurnInputs(turn.id), [input]);
    assert.equal(migrated.history.startAttempt(turn.id, input.id).sequence, 1);
  } finally {
    migrated.close();
  }
});
