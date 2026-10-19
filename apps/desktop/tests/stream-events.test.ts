import assert from "node:assert/strict";
import { test } from "node:test";
import type { ServerEvent, Turn } from "@tilot/protocol";
import { StreamEvents } from "../src/stream-events.ts";
import { applyEvent, type TurnRecord } from "../src/conversation.ts";

type Delta = Extract<ServerEvent, { event: "message.delta" }>;
function delta(seq: number, patch: Partial<Delta> = {}): Delta {
  return { event: "message.delta", threadId: "thread", turnId: "turn", itemId: "item", contentIndex: 0,
    kind: "reasoning", seq, delta: "中文🙂", ...patch };
}

test("首段即时显示，持续 200 次增量合并为每秒约 20 次刷新，文字完整且不修改原事件", (context) => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  const batches: ServerEvent[][] = [];
  const stream = new StreamEvents((events) => batches.push(events));
  const first = delta(1);
  stream.push(first);
  assert.deepEqual(batches, [[first]]);
  context.mock.timers.tick(5);
  for (let seq = 2; seq <= 200; seq++) {
    stream.push(delta(seq));
    context.mock.timers.tick(5);
  }
  assert.equal(batches.length, 21);
  const received = batches.flat() as Delta[];
  assert.equal(received.map((event) => event.delta).join(""), "中文🙂".repeat(200));
  assert.equal(received.at(-1)!.seq, 200);
  assert.equal(first.delta, "中文🙂");
  context.mock.timers.tick(500);
  assert.equal(batches.length, 21);
  stream.dispose();
});

test("不同对话、轮次、消息、内容段及思考正文保持边界和顺序", (context) => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  const received: ServerEvent[] = [];
  const stream = new StreamEvents((events) => received.push(...events));
  const events = [delta(1), delta(2, { threadId: "other" }), delta(3, { turnId: "other" }),
    delta(4, { itemId: "other" }), delta(5, { contentIndex: 1 }), delta(6, { kind: "text" }), delta(7)];
  events.forEach((event) => stream.push(event));
  context.mock.timers.tick(50);
  assert.deepEqual(received, events);
  stream.dispose();
});

test("成功、失败、取消和中断立即提交剩余文字，最终记录与逐条处理一致", (context) => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  for (const status of ["completed", "failed", "cancelled", "interrupted"] as const) {
    const turn: Turn = { id: "turn", threadId: "thread", sequence: 1, permissionMode: "read-only", status: "running",
      createdAt: 1000, finishedAt: null, error: null };
    const events: ServerEvent[] = [{ event: "turn.started", seq: 1, turn }, delta(2), delta(3), delta(4),
      { event: "turn.finished", seq: 5, turn: { ...turn, status, finishedAt: 2000 } }];
    let records: TurnRecord[] = [];
    const stream = new StreamEvents((batch) => { records = batch.reduce(applyEvent, records); });
    events.forEach((event) => stream.push(event));
    assert.deepEqual(records, events.reduce(applyEvent, [] as TurnRecord[]));
    assert.equal(records[0]!.previews[0]!.parts[0]!.text, "中文🙂".repeat(3));
    assert.equal(records[0]!.turn.status, status);
    context.mock.timers.tick(100);
    assert.equal(records[0]!.previews[0]!.parts[0]!.text, "中文🙂".repeat(3));
    stream.dispose();
  }
});

test("思考计时、正式消息、审批和工具事件到达时先提交前面的增量", (context) => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  const boundaries: ServerEvent[] = [
    { event: "message.timing", seq: 3, threadId: "thread", turnId: "turn", timing: { itemId: "item", contentIndex: 0, startedAt: 1000, durationMs: 100 } },
    { event: "message.completed", seq: 3, threadId: "thread", turnId: "turn", itemId: "item", outputIndex: 0, parts: [{ kind: "text", text: "正式消息" }] },
    { event: "approval.resolved", seq: 3, threadId: "thread", turnId: "turn", approvalId: "approval" },
    { event: "tool.progress", seq: 3, threadId: "thread", turnId: "turn", attemptId: "attempt", toolId: "tool", output: "日志", truncated: false, partialLine: false },
  ];
  for (const boundary of boundaries) {
    const batches: ServerEvent[][] = [];
    const stream = new StreamEvents((events) => batches.push(events));
    const first = delta(1), second = delta(2);
    stream.push(first);
    stream.push(second);
    stream.push(boundary);
    assert.deepEqual(batches, [[first], [second, boundary]]);
    context.mock.timers.tick(100);
    assert.equal(batches.length, 2);
    stream.dispose();
  }
});

test("断连可立即刷新，卸载会清理等待且拒绝迟到事件", (context) => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  const batches: ServerEvent[][] = [];
  const stream = new StreamEvents((events) => batches.push(events));
  stream.push(delta(1));
  stream.push(delta(2));
  stream.flush();
  assert.equal(batches.length, 2);
  stream.push(delta(3));
  stream.push(delta(4));
  stream.dispose();
  stream.push(delta(5));
  context.mock.timers.tick(500);
  assert.equal(batches.length, 3);
});
