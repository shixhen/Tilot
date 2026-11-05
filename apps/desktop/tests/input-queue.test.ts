import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { Turn, TurnInput } from "@tilot/protocol";
import { InputQueue } from "../src/input-queue.ts";
import { PendingInputs } from "../src/workspace/pending-inputs.tsx";
import type { ImageRef } from "@tilot/protocol";

test("整个图文队列跨重启恢复为暂停，核对已接收回执后只发送未送达消息", async () => {
  let saved: string | null = null;
  const storage = { getItem: () => saved, setItem: (_key: string, value: string) => { saved = value; } };
  const image: ImageRef = { id: "a".repeat(64), name: "截图.png", bytes: 70, mimeType: "image/png" };
  const initial: string[] = [];
  const first = new InputQueue({ start: (_thread, _input, _images, id) => { initial.push(id); return new Promise(() => {}); },
    steer: async () => null, changed: () => {}, error: (error) => { throw error; } }, storage);
  first.setConnected(true);
  first.enqueue("thread", "服务收到但没来得及确认"); first.enqueue("thread", "", [image]);
  const waiting = first.view("thread").messages[1]!;
  const delivered: { content: string; images: ImageRef[]; id: string }[] = [];
  const restored = new InputQueue({ receipts: async (_thread, ids) => { assert.deepEqual(ids, [initial[0], waiting.id]); return [initial[0]!]; },
    start: async (_thread, content, images, id) => { delivered.push({ content, images, id }); return turn(2); },
    steer: async () => null, changed: () => {}, error: (error) => { throw error; } }, storage);
  await restored.restore(); restored.setConnected(true); await flush();
  assert.equal(restored.view("thread").paused, true); assert.equal(delivered.length, 0);
  assert.deepEqual(restored.view("thread").messages, [waiting]);
  restored.resume("thread"); await flush();
  assert.deepEqual(delivered, [{ content: "", images: [image], id: waiting.id }]);
  assert.equal(restored.view("thread").messages.length, 0);
});

test("队列存档失败保留发送草稿的责任交给调用方，不执行未可靠入队的消息", async () => {
  let starts = 0; const errors: unknown[] = [];
  const queue = new InputQueue({ start: async () => { starts++; return turn(); }, steer: async () => null,
    changed: () => {}, error: (error) => { errors.push(error); } }, { getItem: () => null, setItem: () => { throw new Error("磁盘满"); } });
  queue.setConnected(true); assert.equal(queue.enqueue("thread", "不能丢失"), false); await flush();
  assert.equal(queue.view("thread").messages.length, 0); assert.equal(starts, 0); assert.equal(errors.length, 1);
});

/** 构造明确的轮次顺序，测试迟到应答与结束事件交错。 */
function turn(sequence = 1, status: Turn["status"] = "running", threadId = "thread"): Turn {
  return { id: `${threadId}-${sequence}`, threadId, sequence, permissionMode: "read-only", status, createdAt: sequence, finishedAt: status === "running" ? null : sequence + 1, error: null };
}

/** 保留在途应答，由测试控制事件与应答顺序。 */
function harness() {
  const starts: { threadId: string; input: string; reply: ReturnType<typeof Promise.withResolvers<Turn>> }[] = [];
  const steers: { turnId: string; input: string; reply: ReturnType<typeof Promise.withResolvers<TurnInput | null>> }[] = [];
  const errors: unknown[] = [];
  const queue = new InputQueue({
    start: (threadId, input) => { const reply = Promise.withResolvers<Turn>(); starts.push({ threadId, input, reply }); return reply.promise; },
    steer: (turnId, input) => { const reply = Promise.withResolvers<TurnInput | null>(); steers.push({ turnId, input, reply }); return reply.promise; },
    changed: () => {}, error: (error) => { errors.push(error); },
  });
  queue.setConnected(true);
  return { queue, starts, steers, errors };
}

/** 让请求确认及后续队列发送的微任务执行完，不引入真实等待。 */
async function flush(): Promise<void> { await new Promise<void>((resolve) => setImmediate(resolve)); }

test("答案等待在途启动后优先于下一条普通消息，提交不会恢复暂停队列", async () => {
  const { queue, starts } = harness();
  queue.enqueue("thread", "已发出的任务"); queue.enqueue("thread", "后面的普通消息");
  let answered = false;
  const priority = queue.withPriority("thread", async () => { answered = true; queue.observe(turn(3)); });
  queue.observe(turn(2, "completed")); starts[0]!.reply.resolve(turn(2));
  await priority; assert.equal(answered, true); assert.equal(starts.length, 1);
  queue.pause("thread");
  await queue.withPriority("thread", async () => { queue.observe(turn(3, "completed")); });
  assert.equal(queue.view("thread").paused, true); assert.equal(starts.length, 1);
});

test("等待消息逐轮按序发送，重复完成和迟到启动应答不重发，后台任务仍独立推进", async () => {
  const { queue, starts } = harness();
  queue.observe(turn());
  queue.enqueue("thread", "第一条");
  queue.enqueue("thread", "第二条");
  assert.equal(starts.length, 0);
  queue.observe(turn(1, "completed"));
  assert.deepEqual(starts.map((entry) => entry.input), ["第一条"]);
  queue.observe(turn(2));
  queue.observe(turn(2, "completed"));
  queue.observe(turn(2, "completed"));
  starts[0]!.reply.resolve(turn(2));
  await flush();
  assert.deepEqual(starts.map((entry) => entry.input), ["第一条", "第二条"]);
  starts[1]!.reply.resolve(turn(3));
  await flush();
  assert.equal(queue.view("thread").messages.length, 0);
  queue.enqueue("other", "另一任务");
  assert.equal(starts[2]!.threadId, "other");
  queue.observe(turn(3, "completed"));
  assert.equal(starts.length, 3);
  starts[2]!.reply.resolve(turn(1, "running", "other"));
  await flush();
});

test("失败、主动停止及断连暂停队列；请求失败保留原文，手动继续才重试", async () => {
  for (const status of ["failed", "cancelled", "interrupted"] as const) {
    const { queue, starts, errors } = harness();
    queue.observe(turn());
    queue.enqueue("thread", "保留中文🙂");
    queue.observe(turn(1, status));
    assert.equal(starts.length, 0);
    assert.equal(queue.view("thread").paused, true);
    queue.resume("thread");
    starts[0]!.reply.reject(new Error("未发送成功"));
    await flush();
    assert.equal(errors.length, 1);
    assert.equal(queue.view("thread").messages[0]!.content, "保留中文🙂");
    assert.equal(queue.view("thread").paused, true);
    queue.resume("thread");
    starts[1]!.reply.resolve(turn(2));
    await flush();
    assert.equal(queue.view("thread").messages.length, 0);
  }
  const { queue, starts } = harness();
  queue.observe(turn()); queue.enqueue("thread", "停止后不能自动运行");
  queue.pause("thread"); queue.observe(turn(1, "completed"));
  assert.equal(starts.length, 0);
  queue.setConnected(false); queue.setConnected(true);
  assert.equal(starts.length, 0);
  queue.resume("thread"); starts[0]!.reply.resolve(turn(2)); await flush();
});

test("引导指定消息，确认前保留且不能重复提交；其他消息继续按顺序等待", async () => {
  const { queue, starts, steers } = harness();
  queue.observe(turn()); queue.enqueue("thread", "后续任务"); queue.enqueue("thread", "补充要求");
  const id = queue.view("thread").messages[1]!.id;
  const sending = queue.steer("thread", id);
  await queue.steer("thread", id);
  queue.remove("thread", id);
  assert.equal(steers.length, 1);
  assert.equal(queue.view("thread").messages.length, 2);
  queue.observe(turn(1, "completed"));
  assert.equal(starts.length, 0);
  steers[0]!.reply.resolve({ id: 2, turnId: turn().id, content: "补充要求", createdAt: 2 });
  await sending;
  assert.equal(starts[0]!.input, "后续任务");
  starts[0]!.reply.resolve(turn(2)); await flush();
});

test("手动恢复后迟到的失败查询不能再次暂停队列", async () => {
  const { queue, starts } = harness();
  queue.observe(turn()); queue.enqueue("thread", "第一条"); queue.enqueue("thread", "第二条");
  queue.observe(turn(1, "failed"));
  queue.resume("thread");
  queue.observe(turn(1, "failed"));
  assert.equal(queue.view("thread").paused, false);
  starts[0]!.reply.resolve(turn(2)); await flush();
  queue.observe(turn(2, "completed"));
  assert.equal(starts[1]!.input, "第二条");
  starts[1]!.reply.resolve(turn(3)); await flush();
});

test("引导与轮次结束竞态保留消息；未接收的引导随后按原顺序作为新轮次发送", async () => {
  const { queue, starts, steers } = harness();
  queue.observe(turn()); queue.enqueue("thread", "第一条"); queue.enqueue("thread", "引导已经结束的轮次");
  const sending = queue.steer("thread", queue.view("thread").messages[1]!.id);
  queue.observe(turn(1, "completed"));
  steers[0]!.reply.resolve(null); await sending;
  assert.equal(starts[0]!.input, "第一条");
  starts[0]!.reply.resolve(turn(2)); await flush();
  queue.observe(turn(2, "completed"));
  assert.equal(starts[1]!.input, "引导已经结束的轮次");
  starts[1]!.reply.resolve(turn(3)); await flush();
});

test("等待区保留中文与换行，转义 HTML，显示引导和暂停后的继续操作", () => {
  const html = renderToStaticMarkup(createElement(PendingInputs, {
    queue: { messages: [{ id: "pending", content: "中文🙂\n<script>bad</script>", status: "waiting" }], paused: true, busy: false },
    running: true, connected: true, onSteer: () => {}, onRemove: () => {}, onResume: () => {},
  }));
  assert.match(html, /等待已暂停/); assert.match(html, /继续发送/); assert.match(html, /引导当前轮次/);
  assert.match(html, /中文🙂/); assert.match(html, /&lt;script&gt;/); assert.doesNotMatch(html, /<script>/);
});
