import type { ResponseStreamEvent } from "openai/resources/responses/responses";
import type { ReasoningTiming } from "@tilot/protocol";

/** 从首个思考增量计到段落结束；单调时钟测耗时，墙钟只供界面显示实时进度。 */
export class ReasoningClock {
  private readonly segments = new Map<string, { timing: ReasoningTiming; start: number }>();

  update(event: ResponseStreamEvent, now = performance.now(), wallTime = Date.now()): ReasoningTiming[] {
    if (event.type === "response.reasoning_text.delta" && event.delta.length > 0) {
      const key = `${event.item_id}:${event.content_index}`;
      if (this.segments.has(key)) return [];
      const changes = this.finish(now);
      const timing = { itemId: event.item_id, contentIndex: event.content_index, startedAt: wallTime, durationMs: null };
      this.segments.set(key, { timing, start: now });
      return [...changes, timing];
    }
    if (event.type === "response.reasoning_text.done") return this.finish(now, event.item_id, event.content_index);
    if (event.type === "response.output_item.done" && event.item.type === "reasoning") return this.finish(now, event.item.id);
    // 部分服务省略 reasoning_text.done；后续正文或工具参数仍明确表示思考段已结束。
    if (event.type === "response.output_text.delta" || event.type === "response.refusal.delta" || event.type === "response.function_call_arguments.delta") {
      if (event.delta.length > 0) return this.finish(now);
    }
    return [];
  }

  finish(now = performance.now(), itemId?: string, contentIndex?: number): ReasoningTiming[] {
    const changes: ReasoningTiming[] = [];
    for (const segment of this.segments.values()) {
      if (segment.timing.durationMs !== null || (itemId !== undefined && segment.timing.itemId !== itemId) ||
        (contentIndex !== undefined && segment.timing.contentIndex !== contentIndex)) continue;
      segment.timing = { ...segment.timing, durationMs: Math.max(0, now - segment.start) };
      changes.push(segment.timing);
    }
    return changes;
  }

  snapshot(): ReasoningTiming[] {
    return [...this.segments.values()].map((segment) => segment.timing);
  }
}
