import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import Database from "better-sqlite3";
import type { Response, ResponseOutputItem } from "openai/resources/responses/responses";
import { Store } from "@tilot/store";
import { downgradeToVersion4, downgradeToVersion7, downgradeToVersion9, temporaryDirectory } from "./helpers.ts";

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

test("完成项按原位置立即保存且不可改写，取消后配对未执行结果，原始响应保持诊断状态", (context) => {
  const store = new Store(temporaryDirectory(context));
  try {
    const turn = store.startTurn(store.createThread("保存完成项").id, "输入");
    const attempt = store.history.startAttempt(turn.id, store.listTurnInputs(turn.id)[0]!.id);
    const raw = { ...response(), status: "in_progress" as const };
    const tool = { outputIndex: 2, item: call("complete") };
    store.history.saveCompletedOutput(attempt.id, tool, { response: raw });
    store.history.saveCompletedOutput(attempt.id, tool);
    const message: ResponseOutputItem = { type: "message", id: "m1", status: "completed", role: "assistant", content: [{ type: "output_text", text: "方案 A、B", annotations: [] }] };
    store.history.saveCompletedOutput(attempt.id, { outputIndex: 0, item: message });
    assert.deepEqual(store.history.getAttempt(attempt.id)!.completedOutputs.map((entry) => entry.outputIndex), [0, 2]);
    assert.throws(() => store.history.saveCompletedOutput(attempt.id, { outputIndex: 0, item: { ...message, content: [] } }), /不能被改写/);
    assert.throws(() => store.history.saveCompletedOutput(attempt.id, { outputIndex: 3, item: { ...message, id: "partial", status: "incomplete" } }), /未完成/);
    const saved = store.history.listToolCalls(attempt.id)[0]!;
    assert.throws(() => store.history.startTool(saved.id));
    store.history.finishAttempt(attempt.id, { status: "cancelled", response: raw });
    assert.equal(store.history.getAttempt(attempt.id)!.status, "cancelled");
    assert.deepEqual(store.history.getAttempt(attempt.id)!.response, raw);
    assert.equal(JSON.parse(String(store.history.listToolCalls(attempt.id)[0]!.result!.output)).status, "not_executed");
    assert.equal(store.history.listToolCalls(attempt.id)[0]!.startedAt, null);
  } finally { store.close(); }
});

test("进程在工具执行期间退出后允许新请求，旧结果仍为空且可以日后核实补录", (context) => {
  const directory = temporaryDirectory(context);
  const store = new Store(directory);
  const old = store.startTurn(store.createThread("工具中断").id, "执行");
  const attempt = store.history.startAttempt(old.id, store.listTurnInputs(old.id)[0]!.id);
  store.history.finishAttempt(attempt.id, { status: "completed", response: response([call("unknown")]) });
  const tool = store.history.listToolCalls(attempt.id)[0]!;
  store.history.startTool(tool.id);
  store.close();
  const reopened = new Store(directory);
  try {
    reopened.recoverInterruptedTurns();
    const next = reopened.startTurn(old.threadId, "先核实");
    const request = reopened.history.startAttempt(next.id, reopened.listTurnInputs(next.id)[0]!.id);
    assert.equal(request.status, "running");
    assert.equal(reopened.history.listToolCalls(attempt.id)[0]!.result, null);
    reopened.history.finishAttempt(request.id, { status: "completed", response: response() });
    assert.equal(reopened.finishTurn(next.id, "completed").status, "completed");
    reopened.history.saveToolResult(tool.id, { type: "function_call_output", call_id: "unknown", output: "后来核实的真实结果" });
  } finally { reopened.close(); }
});

test("进程在模型流期间退出，已保存的完整调用被配为未执行，完成消息重开后保留", (context) => {
  const directory = temporaryDirectory(context);
  const store = new Store(directory);
  const turn = store.startTurn(store.createThread("流中退出").id, "输入");
  const attempt = store.history.startAttempt(turn.id, store.listTurnInputs(turn.id)[0]!.id);
  store.history.saveCompletedOutput(attempt.id, { outputIndex: 3, item: call("unexecuted") }, { response: { ...response(), status: "in_progress" } });
  store.close();
  const reopened = new Store(directory);
  try {
    reopened.recoverInterruptedTurns();
    const recovered = reopened.history.getAttempt(attempt.id)!;
    assert.equal(recovered.status, "interrupted");
    assert.equal(recovered.completedOutputs[0]!.outputIndex, 3);
    assert.equal(recovered.response?.status, "in_progress");
    assert.equal(JSON.parse(String(reopened.history.listToolCalls(attempt.id)[0]!.result!.output)).status, "not_executed");
  } finally { reopened.close(); }
});

test("版本 11 迁移只为成功历史补齐完整输出清单，不把失败诊断当作确认内容", (context) => {
  const directory = temporaryDirectory(context);
  const store = new Store(directory);
  const turn = store.startTurn(store.createThread("旧数据").id, "输入");
  const first = store.history.startAttempt(turn.id, store.listTurnInputs(turn.id)[0]!.id);
  const snapshot = response([call("saved")]);
  store.history.finishAttempt(first.id, { status: "completed", response: snapshot });
  const tool = store.history.listToolCalls(first.id)[0]!;
  store.history.saveToolResult(tool.id, { type: "function_call_output", call_id: "saved", output: "结果" });
  const second = store.history.startAttempt(turn.id, first.inputThroughId);
  store.history.finishAttempt(second.id, { status: "cancelled", response: response([call("diagnostic")]) });
  store.close();
  const legacy = new Database(join(directory, "tilot.sqlite"));
  legacy.exec("DROP TABLE context_compactions; ALTER TABLE model_attempts DROP COLUMN estimatedInputTokens; ALTER TABLE threads DROP COLUMN autoTitle; ALTER TABLE provider_models DROP COLUMN contextTokens; DROP TABLE user_questions; ALTER TABLE turn_inputs DROP COLUMN imagesJson; DROP INDEX inputs_delivery; ALTER TABLE turn_inputs DROP COLUMN deliveryId; ALTER TABLE model_attempts DROP COLUMN completedOutputsJson; PRAGMA user_version = 11;");
  legacy.close();
  const reopened = new Store(directory);
  try {
    assert.deepEqual(reopened.history.getAttempt(first.id)!.completedOutputs, [{ outputIndex: 0, item: snapshot.output[0] }]);
    assert.deepEqual(reopened.history.getAttempt(second.id)!.completedOutputs, []);
  } finally { reopened.close(); }
});

test("单段思考和工具执行时间重开后保留，版本 9 的旧过程不估算耗时", (context) => {
  const directory = temporaryDirectory(context);
  const store = new Store(directory);
  const turn = store.startTurn(store.createThread("计时持久化").id, "输入");
  const attempt = store.history.startAttempt(turn.id, store.listTurnInputs(turn.id)[0]!.id);
  const snapshot = response([call("a"), call("b")]);
  const reasoningTimings = [{ itemId: "r1", contentIndex: 0, startedAt: 1000, durationMs: 1250 }];
  store.history.finishAttempt(attempt.id, { status: "completed", response: snapshot, reasoningTimings });
  const calls = store.history.listToolCalls(attempt.id);
  store.history.startTool(calls[0]!.id);
  assert.throws(() => store.history.startTool(calls[0]!.id), /已开始/);
  store.history.saveToolResult(calls[0]!.id, { type: "function_call_output", call_id: "a", output: "结果" }, 12.5);
  store.history.saveToolResult(calls[1]!.id, { type: "function_call_output", call_id: "b", output: "未执行" });
  store.finishTurn(turn.id, "completed");
  store.close();
  const reopened = new Store(directory);
  try {
    assert.deepEqual(reopened.history.getAttempt(attempt.id)?.reasoningTimings, reasoningTimings);
    const persisted = reopened.history.listToolCalls(attempt.id);
    assert.notEqual(persisted[0]!.startedAt, null);
    assert.equal(persisted[0]!.durationMs, 12.5);
    assert.equal(persisted[1]!.startedAt, null);
    assert.equal(persisted[1]!.durationMs, null);
    assert.deepEqual(reopened.history.getAttempt(attempt.id)?.response, snapshot);
  } finally { reopened.close(); }
  const legacy = new Database(join(directory, "tilot.sqlite"));
  try { downgradeToVersion9(legacy); } finally { legacy.close(); }
  const migrated = new Store(directory);
  try {
    assert.deepEqual(migrated.history.getAttempt(attempt.id)?.reasoningTimings, []);
    assert.deepEqual(migrated.history.getAttempt(attempt.id)?.response, snapshot);
    assert.deepEqual(migrated.history.listToolCalls(attempt.id).map((call) => [call.startedAt, call.durationMs]), [[null, null], [null, null]]);
  } finally { migrated.close(); }
});

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

test("版本 6 升级保留历史响应，旧请求计时为空，新请求计时可保存", (context) => {
  const directory = temporaryDirectory(context);
  const store = new Store(directory);
  const turn = store.startTurn(store.createThread("旧历史").id, "输入");
  const input = store.listTurnInputs(turn.id)[0]!;
  const attempt = store.history.startAttempt(turn.id, input.id);
  const snapshot = response();
  store.history.finishAttempt(attempt.id, { status: "completed", response: snapshot });
  store.close();
  const legacy = new Database(join(directory, "tilot.sqlite"));
  try {
    downgradeToVersion7(legacy);
    legacy.exec("ALTER TABLE model_attempts DROP COLUMN firstTokenMs; ALTER TABLE model_attempts DROP COLUMN durationMs; PRAGMA user_version = 6;");
  } finally { legacy.close(); }
  const migrated = new Store(directory);
  try {
    assert.equal(migrated.history.getAttempt(attempt.id)?.firstTokenMs, null);
    assert.equal(migrated.history.getAttempt(attempt.id)?.durationMs, null);
    assert.deepEqual(migrated.history.getAttempt(attempt.id)?.response, snapshot);
    const next = migrated.history.startAttempt(turn.id, input.id);
    const saved = migrated.history.finishAttempt(next.id, { status: "completed", response: response(), firstTokenMs: 10, durationMs: 25 });
    assert.equal(saved.firstTokenMs, 10);
    assert.equal(saved.durationMs, 25);
  } finally { migrated.close(); }
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
    downgradeToVersion4(legacy);
    legacy.exec("DROP TABLE tool_calls; DROP TABLE model_attempts; PRAGMA user_version = 3;");
  } finally {
    legacy.close();
  }
  const migrated = new Store(directory);
  try {
    assert.deepEqual(migrated.getThread(thread.id), { ...savedThread, permissionLockedAt: turn.createdAt });
    assert.deepEqual(migrated.getTurn(turn.id), turn);
    assert.deepEqual(migrated.listTurnInputs(turn.id), [input]);
    assert.equal(migrated.history.startAttempt(turn.id, input.id).sequence, 1);
  } finally {
    migrated.close();
  }
});
