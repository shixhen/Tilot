import assert from "node:assert/strict";
import { test } from "node:test";
import type { ResponseStreamEvent } from "openai/resources/responses/responses";
import { ReasoningClock } from "../src/reasoning-clock.ts";

function delta(item = "r1", contentIndex = 0, text = "思考"): ResponseStreamEvent {
  return { type: "response.reasoning_text.delta", item_id: item, content_index: contentIndex, output_index: 0, delta: text, sequence_number: 1 };
}

test("思考从非空增量开始，各段独立计时，排除首 token 等待且不受系统时钟调整影响", () => {
  const clock = new ReasoningClock();
  assert.deepEqual(clock.update(delta("r1", 0, ""), 100, 10000), []);
  assert.deepEqual(clock.update(delta(), 5000, 20000), [{ itemId: "r1", contentIndex: 0, startedAt: 20000, durationMs: null }]);
  assert.deepEqual(clock.update(delta(), 5300, 10000), []);
  const next = clock.update(delta("r1", 1), 5400, 20100);
  assert.equal(next[0]!.durationMs, 400);
  assert.equal(next[1]!.durationMs, null);
  assert.deepEqual(clock.update({ type: "response.reasoning_text.done", item_id: "r1", content_index: 1, output_index: 0,
    text: "思考", sequence_number: 2 }, 5500), [{ itemId: "r1", contentIndex: 1, startedAt: 20100, durationMs: 100 }]);
  clock.finish(30000);
  assert.deepEqual(clock.snapshot().map((segment) => segment.durationMs), [400, 100]);
});

test("省略思考 done 时在正文或工具参数开始结束，取消和断流只截到实际停止时间", () => {
  for (const type of ["response.output_text.delta", "response.function_call_arguments.delta"] as const) {
    const clock = new ReasoningClock();
    clock.update(delta(), 100, 1000);
    const event = { type, item_id: "later", output_index: 1, content_index: 0, delta: "内容", sequence_number: 2, logprobs: [] };
    assert.equal(clock.update(event, 250)[0]!.durationMs, 150);
    clock.finish(8000);
    assert.equal(clock.snapshot()[0]!.durationMs, 150);
  }
  const stopped = new ReasoningClock();
  stopped.update(delta(), 100, 1000);
  assert.equal(stopped.finish(180)[0]!.durationMs, 80);
  assert.deepEqual(stopped.finish(250), []);
  // 没有思考增量的完整响应不能用整个请求的时间冒充思考时间。
  const unknown = new ReasoningClock();
  unknown.finish(10000);
  assert.deepEqual(unknown.snapshot(), []);
});
