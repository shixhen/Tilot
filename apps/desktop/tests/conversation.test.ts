import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { TurnMessages } from "../src/workspace/transcript.tsx";
import type { AttemptView, Turn } from "@tilot/protocol";
import { applyEvent, loadConversation, mergeHistory, type TurnRecord } from "../src/conversation.ts";
import type { Request } from "../src/client.ts";

/** 创建独立轮次，供历史与实时事件交错测试使用。 */
function turn(id = "turn"): Turn {
  return { id, threadId: "thread", sequence: 1, status: "running", createdAt: 1, finishedAt: null, error: null };
}

// 前端更新而旧 Node 服务仍在运行时，缺少新增字段不能让历史渲染白屏。
test("旧服务未返回 tools 时仍可加载、合并并渲染回答", async () => {
  const savedTurn = { ...turn(), status: "completed" as const };
  const request = (async (method: string) => {
    if (method === "turn.list") return [savedTurn];
    if (method === "turn.inputs") return [{ id: 1, turnId: savedTurn.id, content: "你好", createdAt: 1 }];
    if (method === "turn.attempts") return [{
      id: "old-attempt", turnId: savedTurn.id, sequence: 1, inputThroughId: 1,
      status: "completed", error: null, createdAt: 1, finishedAt: 2,
      messages: [{ itemId: "answer", outputIndex: 0, parts: [{ kind: "text", text: "已收到消息" }] }],
    }];
    throw new Error(`不应调用 ${method}`);
  }) as Request;
  const records = mergeHistory([], await loadConversation(request, "thread"));
  assert.deepEqual(records[0]!.attempts[0]!.tools, []);
  const html = renderToStaticMarkup(createElement(TurnMessages, { record: records[0]! }));
  assert.match(html, /已收到消息/);
  assert.match(html, /你好/);
});

// 工具完成事件与旧历史查询交错时，结果不能退回执行中，消息不能重复。
test("工具快照替换预览并保留比历史查询更新的结果", () => {
  const running = turn();
  const attempt: AttemptView = {
    id: "attempt", turnId: running.id, sequence: 1, inputThroughId: 1,
    status: "completed", error: null, createdAt: 1, finishedAt: 2,
    messages: [{ itemId: "reasoning", outputIndex: 0, parts: [{ kind: "reasoning", text: "读取文件" }] }],
    tools: [{ id: "tool", outputIndex: 1, name: "read", arguments: '{"path":"a.ts"}', output: null, running: true }],
  };
  let records = applyEvent([], { event: "turn.started", turn: running, seq: 1 });
  records = applyEvent(records, { event: "message.delta", threadId: "thread", turnId: running.id, itemId: "reasoning", contentIndex: 0, kind: "reasoning", delta: "读取", seq: 2 });
  records = applyEvent(records, { event: "attempt.updated", threadId: "thread", turnId: running.id, attempt, seq: 3 });
  assert.equal(records[0]!.previews.length, 0);
  const finished = { ...attempt, tools: [{ ...attempt.tools[0]!, running: false, output: '{"status":"ok"}' }] };
  records = applyEvent(records, { event: "attempt.updated", threadId: "thread", turnId: running.id, attempt: finished, seq: 4 });
  records = mergeHistory(records, [{ turn: running, inputs: [], attempts: [attempt], previews: [] }]);
  assert.deepEqual(records[0]!.attempts[0]!.tools, finished.tools);
});

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
  records = mergeHistory(records, [{ ...old, turn: { ...running, status: "completed" }, attempts: [{ id: "attempt", turnId: running.id, sequence: 1, inputThroughId: 1, status: "completed", error: null, createdAt: 1, finishedAt: 2, tools: [], messages: [{ itemId: "answer", outputIndex: 0, parts: completed.parts }] }] }]);
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
    if (method === "turn.attempts") return params.afterSequence === 0 ? Array.from({ length: 100 }, (_, index) => ({ id: String(index), sequence: index + 1, tools: [], messages: [] })) : [];
    throw new Error(`不应调用 ${method}`);
  }) as Request;
  const records = await loadConversation(request, "thread");
  assert.equal(records.length, 101);
  assert.equal(records.at(-1)?.inputs.at(-1)?.content, "最后一页");
  assert.equal(records.at(-1)?.attempts.length, 100);
});
