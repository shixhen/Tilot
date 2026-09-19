import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test, type TestContext } from "node:test";
import type { Response } from "openai/resources/responses/responses";
import type { RpcRequest, RpcResult } from "@tilot/protocol";
import { Store } from "@tilot/store";
import { handleRpcLine } from "../src/rpc.ts";
import { TurnManager } from "../src/turn-manager.ts";

/** 创建独立数据库和真实 RPC 查询入口；测试不调用模型。 */
function openHistory(context: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), "tilot-history-"));
  const store = new Store(directory);
  const manager = new TurnManager(store, async () => {}, (error) => { throw error; });
  context.after(async () => {
    await manager.close();
    store.close();
    assert.equal(dirname(directory), resolve(tmpdir()));
    rmSync(directory, { recursive: true, force: true });
  });
  /** 通过 RPC 校验和分发读取历史，失败时保留明确的测试断言。 */
  async function query(request: RpcRequest): Promise<RpcResult> {
    const response = await handleRpcLine(store, JSON.stringify(request), manager);
    assert.ok(response.success);
    return response.result;
  }
  return { store, manager, query, directory };
}

/** 构造含推理、正文和拒绝块的完整响应，附加字段不应进入界面协议。 */
function sampleResponse(): Response {
  return {
    id: "response_1", object: "response", created_at: 1, model: "saved-model",
    status: "completed", output_text: "正文", error: null, incomplete_details: null,
    instructions: "不应回传的系统策略", metadata: null, parallel_tool_calls: true,
    temperature: null, top_p: null, tool_choice: "auto", tools: [],
    output: [
      { type: "reasoning", id: "reasoning_1", summary: [], content: [{ type: "reasoning_text", text: "推理正文" }] },
      { type: "message", id: "message_1", role: "assistant", status: "completed", content: [
        { type: "output_text", text: "正文", annotations: [] }, { type: "refusal", refusal: "拒绝部分" },
      ] },
    ],
  };
}

test("历史查询保留原文、输入边界和消息位置，只返回展示字段，重开后结果一致", async (context) => {
  const { store, query, directory } = openHistory(context);
  const thread = store.createThread("历史");
  const turn = store.startTurn(thread.id, "  原始输入\n ");
  const input = store.listTurnInputs(turn.id)[0]!;
  const attempt = store.history.startAttempt(turn.id, input.id);
  const snapshot = sampleResponse();
  const saved = store.history.finishAttempt(attempt.id, { status: "completed", response: snapshot });
  const extra = store.appendTurnInput(turn.id, "模型回答之后的补充");
  const finished = store.finishTurn(turn.id, "completed");
  assert.deepEqual(await query({ id: "read", method: "turn.read", params: { turnId: turn.id } }), finished);
  assert.deepEqual(await query({ id: "list", method: "turn.list", params: { threadId: thread.id } }), [finished]);
  assert.deepEqual(await query({ id: "inputs", method: "turn.inputs", params: { turnId: turn.id } }), [input, extra]);
  const expected = [{
    id: saved.id, turnId: turn.id, sequence: 1, inputThroughId: input.id, status: "completed",
    error: null, createdAt: saved.createdAt, finishedAt: saved.finishedAt,
    messages: [
      { itemId: "reasoning_1", outputIndex: 0, parts: [{ kind: "reasoning", text: "推理正文" }] },
      { itemId: "message_1", outputIndex: 1, parts: [{ kind: "text", text: "正文" }, { kind: "refusal", text: "拒绝部分" }] },
    ],
  }];
  assert.deepEqual(await query({ id: "attempts", method: "turn.attempts", params: { turnId: turn.id } }), expected);
  assert.deepEqual(store.history.getAttempt(attempt.id)?.response, snapshot);
  const reopened = new Store(directory);
  try {
    const manager = new TurnManager(reopened, async () => {}, (error) => { throw error; });
    assert.deepEqual(await handleRpcLine(reopened, JSON.stringify({ id: "reopened", method: "turn.attempts", params: { turnId: turn.id } }), manager),
      { id: "reopened", success: true, result: expected });
  } finally {
    reopened.close();
  }
});

test("失败、取消与中断只展示状态，运行中历史查询不改变执行记录", async (context) => {
  const { store, query } = openHistory(context);
  const turn = store.startTurn(store.createThread("诊断").id, "输入");
  const input = store.listTurnInputs(turn.id)[0]!;
  for (const status of ["failed", "incomplete", "cancelled"] as const) {
    const attempt = store.history.startAttempt(turn.id, input.id);
    store.history.finishAttempt(attempt.id, { status, response: sampleResponse(), error: "诊断原因" });
  }
  const running = store.history.startAttempt(turn.id, input.id);
  const before = store.history.listAttempts(turn.id);
  const rows = await query({ id: "diagnostics", method: "turn.attempts", params: { turnId: turn.id } });
  assert.ok(Array.isArray(rows));
  assert.equal(rows.length, 4);
  for (const row of rows) {
    assert.ok("messages" in row);
    assert.deepEqual(row.messages, []);
  }
  assert.deepEqual(store.history.listAttempts(turn.id), before);
  store.recoverInterruptedTurns();
  const interrupted = await query({ id: "refresh", method: "turn.attempts", params: { turnId: turn.id, afterSequence: running.sequence - 1 } });
  assert.ok(Array.isArray(interrupted) && interrupted[0] && "status" in interrupted[0]);
  assert.equal(interrupted[0].status, "interrupted");
});

test("三类列表支持跨页读取且不串任务，非法分页被拒绝，不存在的记录不被创建", async (context) => {
  const { store, manager, query } = openHistory(context);
  const thread = store.createThread("分页");
  const other = store.startTurn(store.createThread("其他任务").id, "其他输入");
  for (let index = 0; index < 51; index++) {
    store.finishTurn(store.startTurn(thread.id, `输入 ${index}`).id, "completed");
  }
  const current = store.startTurn(thread.id, "首条");
  let input = store.listTurnInputs(current.id)[0]!;
  for (let index = 0; index < 51; index++) {
    const attempt = store.history.startAttempt(current.id, input.id);
    store.history.finishAttempt(attempt.id, { status: "failed", error: "测试重试" });
    input = store.appendTurnInput(current.id, `补充 ${index}`);
  }
  const turns = await query({ id: "turns", method: "turn.list", params: { threadId: thread.id } });
  assert.ok(Array.isArray(turns));
  assert.equal(turns.length, 50);
  assert.deepEqual(await query({ id: "next-turns", method: "turn.list", params: { threadId: thread.id, afterSequence: 50 } }), store.listTurns(thread.id, 50));
  const inputs = store.listTurnInputs(current.id);
  assert.deepEqual(await query({ id: "inputs", method: "turn.inputs", params: { turnId: current.id, afterId: inputs.at(-1)!.id } }), store.listTurnInputs(current.id, inputs.at(-1)!.id));
  const attempts = await query({ id: "attempts", method: "turn.attempts", params: { turnId: current.id, afterSequence: 50 } });
  assert.ok(Array.isArray(attempts));
  assert.equal(attempts.length, 1);
  assert.deepEqual(await query({ id: "missing", method: "turn.read", params: { turnId: "missing" } }), null);
  assert.deepEqual(await query({ id: "empty", method: "turn.inputs", params: { turnId: "missing" } }), []);
  for (const method of ["turn.list", "turn.inputs", "turn.attempts"]) {
    const response = await handleRpcLine(store, JSON.stringify({ id: method, method, params: { threadId: thread.id, turnId: current.id, limit: -1 } }), manager);
    assert.equal(response.success, false);
  }
  assert.equal(store.getTurn(other.id)?.status, "running");
});
