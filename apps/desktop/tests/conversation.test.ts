import assert from "node:assert/strict";
import { test } from "node:test";
import type { Turn } from "@tilot/protocol";
import { applyEvent, loadConversation, mergeHistory, type TurnRecord } from "../src/conversation.ts";
import type { Request } from "../src/client.ts";

/** 创建独立轮次，供历史与实时事件交错测试使用。 */
function turn(id = "turn"): Turn {
  return { id, threadId: "thread", sequence: 1, status: "running", createdAt: 1, finishedAt: null, error: null };
}

// 查询可能晚于事件完成；正式消息替换预览，迟到的完成事件不应重复显示。
test("历史与流式事件交错时保留终态、替换预览并隔离轮次", () => {
  const running = turn();
  let records = applyEvent([], { event: "turn.started", turn: running, seq: 1 });
  records = applyEvent(records, { event: "message.delta", seq: 2, threadId: "thread", turnId: running.id, itemId: "answer", contentIndex: 0, kind: "text", delta: "前半" });
  const old: TurnRecord = { turn: running, inputs: [], attempts: [], previews: [] };
  records = applyEvent(records, { event: "turn.finished", turn: { ...running, status: "completed" }, seq: 3 });
  records = mergeHistory(records, [old]);
  assert.equal(records[0]?.turn.status, "completed");
  assert.equal(records[0]?.previews[0]?.parts[0]?.text, "前半");
  const completed = { event: "message.completed" as const, seq: 4, threadId: "thread", turnId: running.id, itemId: "answer", outputIndex: 0, parts: [{ kind: "text" as const, text: "完整回答" }] };
  records = applyEvent(records, completed);
  assert.equal(records[0]?.previews[0]?.parts[0]?.text, "完整回答");
  records = mergeHistory(records, [{ ...old, turn: { ...running, status: "completed" }, attempts: [{ id: "attempt", turnId: running.id, sequence: 1, inputThroughId: 1, status: "completed", error: null, createdAt: 1, finishedAt: 2, messages: [{ itemId: "answer", outputIndex: 0, parts: completed.parts }] }] }]);
  records = applyEvent(records, completed);
  assert.equal(records[0]?.previews.length, 0);
  const other = applyEvent(records, { event: "message.delta", seq: 5, threadId: "other", turnId: "other", itemId: "answer", contentIndex: 0, kind: "text", delta: "不能混入" });
  assert.deepEqual(other, records);
});

// 取消时保留临时推理与正文，但不能把它们当作正式保存的回答。
test("取消保留独立推理和正文预览，迟到启动应答不恢复运行状态", () => {
  const running = turn();
  let records = applyEvent([], { event: "turn.started", turn: running, seq: 1 });
  for (const [index, kind] of ["reasoning", "text"].entries()) {
    records = applyEvent(records, { event: "message.delta", seq: index + 2, threadId: "thread", turnId: "turn", itemId: kind, contentIndex: 0, kind: kind as "reasoning" | "text", delta: "片段" });
  }
  records = applyEvent(records, { event: "turn.finished", turn: { ...running, status: "cancelled" }, seq: 4 });
  records = applyEvent(records, { event: "turn.started", turn: running, seq: 0 });
  assert.equal(records[0]?.turn.status, "cancelled");
  assert.deepEqual(records[0]?.previews.map((preview) => [preview.parts[0]?.kind, preview.complete]), [["reasoning", false], ["text", false]]);
  assert.deepEqual(records[0]?.attempts, []);
});

// 三类列表都必须读取后续页，而非只处理默认第一页。
test("历史读取覆盖轮次、输入与请求的全部分页", async () => {
  const request: Request = (async (method: string, params: Record<string, number | string>) => {
    if (method === "turn.list") return params.afterSequence === 0 ? Array.from({ length: 100 }, (_, index) => ({ ...turn(String(index)), sequence: index + 1 })) : [{ ...turn("last"), sequence: 101 }];
    if (method === "turn.inputs") return params.afterId === 0 ? Array.from({ length: 100 }, (_, index) => ({ id: index + 1, turnId: params.turnId, content: "输入", createdAt: 1 })) : [{ id: 101, turnId: params.turnId, content: "最后一页", createdAt: 1 }];
    if (method === "turn.attempts") return params.afterSequence === 0 ? Array.from({ length: 100 }, (_, index) => ({ id: String(index), sequence: index + 1, messages: [] })) : [];
    throw new Error(`不应调用 ${method}`);
  }) as Request;
  const records = await loadConversation(request, "thread");
  assert.equal(records.length, 101);
  assert.equal(records.at(-1)?.inputs.at(-1)?.content, "最后一页");
  assert.equal(records.at(-1)?.attempts.length, 100);
});
