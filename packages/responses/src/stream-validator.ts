import { isDeepStrictEqual } from "node:util";
import type { ResponseOutputItem, ResponseStreamEvent } from "openai/resources/responses/responses";
import { getResponseToolCalls, type ResponseTerminalEvent } from "./output.ts";

/** 单个输出项的开始、完成快照，以及工具参数完成值；不拼接增量文本。 */
interface TrackedOutput {
  added: ResponseOutputItem;
  done?: ResponseOutputItem;
  argumentsDone?: string;
}

/** 每次模型请求独立使用的流校验器，检查事件顺序、输出关联和成功终态。 */
export class ResponseStreamValidator {
  private lastSequence = -1;
  private responseId: string | undefined;
  private readonly events = new Map<number, ResponseStreamEvent>();
  private readonly outputs = new Map<number, TrackedOutput>();
  private readonly itemIds = new Set<string>();

  /** 接收新事件；完全相同的重复事件返回 false，协议冲突抛错，其余返回 true。 */
  accept(event: ResponseStreamEvent): boolean {
    const sequence = event.sequence_number;
    if (!Number.isSafeInteger(sequence) || sequence < 0) {
      throw new Error("流式事件序号必须是非负安全整数。");
    }
    const previous = this.events.get(sequence);
    if (previous) {
      if (!isDeepStrictEqual(previous, event)) {
        throw new Error("相同序号的流式事件内容冲突。");
      }
      return false;
    }
    if (sequence <= this.lastSequence) {
      throw new Error("流式事件序号倒序。");
    }

    if ("response" in event) {
      const id = event.response?.id;
      if (typeof id !== "string" || !id.trim() || (this.responseId && id !== this.responseId)) {
        throw new Error("流式事件的响应 id 缺失或不一致。");
      }
      this.responseId = id;
    }
    if ("output_index" in event) {
      this.checkOutputEvent(event);
    }
    if (
      event.type === "response.completed" ||
      event.type === "response.failed" ||
      event.type === "response.incomplete"
    ) {
      this.checkTerminal(event);
    }

    // 保存快照，避免调用方修改已收到的事件后影响去重判断。
    this.events.set(sequence, structuredClone(event));
    this.lastSequence = sequence;
    return true;
  }

  /** 按 output_index 和 item_id 关联事件，检查输出生命周期与工具参数完成值。 */
  private checkOutputEvent(event: ResponseStreamEvent & { output_index: number }): void {
    const index = event.output_index;
    if (!Number.isSafeInteger(index) || index < 0) {
      throw new Error("输出位置必须是非负安全整数。");
    }
    if (event.type === "response.output_item.added") {
      const item = event.item;
      if (!item || typeof item.id !== "string" || !item.id.trim()) {
        throw new Error("输出项缺少 id。");
      }
      if (this.outputs.has(index) || this.itemIds.has(item.id)) {
        throw new Error("输出位置或输出项 id 重复注册。");
      }
      if (item.type !== "message" && item.type !== "reasoning" && item.type !== "function_call") {
        throw new Error(`不支持的模型输出类型：${item.type}。`);
      }
      this.outputs.set(index, { added: structuredClone(item) });
      this.itemIds.add(item.id);
      return;
    }

    const tracked = this.outputs.get(index);
    let itemId: string | undefined;
    if (event.type === "response.output_item.done") {
      itemId = event.item?.id;
    } else if ("item_id" in event) {
      itemId = event.item_id;
    }
    if (!tracked || itemId !== tracked.added.id) {
      throw new Error("流式事件的输出位置与 item_id 不匹配。");
    }
    if (tracked.done) {
      throw new Error("输出项完成后不能继续更新。");
    }
    if (event.type === "response.output_item.done") {
      checkItemIdentity(tracked.added, event.item);
      if (event.item.type === "function_call" && tracked.argumentsDone !== undefined && event.item.arguments !== tracked.argumentsDone) {
        throw new Error("工具参数完成值与输出项不一致。");
      }
      tracked.done = structuredClone(event.item);
      return;
    }

    if (event.type === "response.function_call_arguments.delta" || event.type === "response.function_call_arguments.done") {
      if (tracked.added.type !== "function_call") {
        throw new Error("工具参数事件必须关联 function_call 输出项。");
      }
      if (tracked.argumentsDone !== undefined) {
        throw new Error("工具参数完成后不能继续更新。");
      }
      const value = event.type === "response.function_call_arguments.done" ? event.arguments : event.delta;
      if (typeof value !== "string") {
        throw new Error("工具参数事件必须包含字符串。");
      }
      if (event.type === "response.function_call_arguments.done") {
        tracked.argumentsDone = value;
      }
    }
    if (event.type.startsWith("response.reasoning_text.") && tracked.added.type !== "reasoning") {
      throw new Error("推理事件必须关联 reasoning 输出项。");
    }
    if (event.type.startsWith("response.output_text.") && tracked.added.type !== "message") {
      throw new Error("正文事件必须关联 message 输出项。");
    }
  }

  /** 成功终态必须对应全部已完成输出；失败和截断允许保留部分输出用于诊断。 */
  private checkTerminal(event: ResponseTerminalEvent): void {
    getResponseToolCalls(event);
    if (event.type !== "response.completed") {
      return;
    }
    const output = event.response.output;
    if (output.length !== this.outputs.size) {
      throw new Error("最终响应与流式输出项数量不一致。");
    }
    for (const [index, item] of output.entries()) {
      const tracked = this.outputs.get(index);
      if (!tracked?.done || !isDeepStrictEqual(tracked.done, item)) {
        throw new Error("最终响应与已完成输出项不一致。");
      }
    }
  }
}

/** 输出项完成时允许内容增长，但类型、标识和工具名称不能改变。 */
function checkItemIdentity(added: ResponseOutputItem, done: ResponseOutputItem): void {
  if (added.type !== done.type || added.id !== done.id) {
    throw new Error("输出项完成时类型或 id 发生变化。");
  }
  if (added.type === "function_call" && done.type === "function_call") {
    if (added.call_id !== done.call_id || added.name !== done.name) {
      throw new Error("工具调用的 call_id 或名称发生变化。");
    }
  }
}
