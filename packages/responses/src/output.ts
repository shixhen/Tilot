import type {
  ResponseCompletedEvent,
  ResponseFailedEvent,
  ResponseFunctionToolCall,
  ResponseIncompleteEvent,
  ResponseOutputItem,
} from "openai/resources/responses/responses";

/** SDK 的三种终态事件；复用原始响应，不另外定义模型响应结构。 */
export type ResponseTerminalEvent =
  | ResponseCompletedEvent
  | ResponseFailedEvent
  | ResponseIncompleteEvent;

/**
 * 校验终态响应，按原顺序返回成功响应中的工具调用；失败和截断返回空数组。
 * 不修改原始响应或解析 arguments；具体参数和权限仍须由 Tool 校验。
 * 任意输出项不合法时整体抛错，不返回已经收集的部分调用。
 */
export function getResponseToolCalls(event: ResponseTerminalEvent): ResponseFunctionToolCall[] {
  const expectedStatus = {
    "response.completed": "completed",
    "response.failed": "failed",
    "response.incomplete": "incomplete",
  }[event.type];
  const response = event.response;
  if (!expectedStatus || !response || response.status !== expectedStatus) {
    throw new Error("模型终态事件与响应状态不一致。");
  }
  if (typeof response.id !== "string" || !response.id.trim() || !Array.isArray(response.output)) {
    throw new Error("模型响应缺少有效的 id 或 output 数组。");
  }
  if (response.status !== "completed") {
    return [];
  }
  if (response.error != null || response.incomplete_details != null) {
    throw new Error("成功响应不能包含失败或截断信息。");
  }

  const itemIds = new Set<string>();
  const callIds = new Set<string>();
  const toolCalls: ResponseFunctionToolCall[] = [];
  for (const item of response.output) {
    validateOutputItem(item);
    registerId(item.id, itemIds, "输出项 id");
    if (item.type === "function_call") {
      registerId(item.call_id, callIds, "工具 call_id");
      toolCalls.push(item);
    }
  }
  return toolCalls;
}

/** 检查首版支持的输出项及回放所需字段；未知工具类型不能静默忽略。 */
function validateOutputItem(item: ResponseOutputItem): void {
  if (!item || typeof item !== "object") {
    throw new Error("模型输出项必须是对象。");
  }
  switch (item.type) {
    case "message":
      if (item.role !== "assistant" || item.status !== "completed") {
        throw new Error("成功响应中的消息必须是已完成的 assistant 消息。");
      }
      validateTextParts(item.content, "output_text");
      break;
    case "reasoning":
      if (item.status !== undefined && item.status !== "completed") {
        throw new Error("成功响应中不能包含未完成的推理项。");
      }
      // DeepSeek 回放需要明文 content，不能只留下 summary 或 encrypted_content。
      validateTextParts(item.content, "reasoning_text");
      break;
    case "function_call":
      if (item.status !== undefined && item.status !== "completed") {
        throw new Error("成功响应中不能包含未完成的工具调用。");
      }
      if (typeof item.name !== "string" || !item.name.trim() || typeof item.arguments !== "string") {
        throw new Error("工具调用必须包含有效名称和 arguments 字符串。");
      }
      break;
    default:
      throw new Error(`不支持的模型输出类型：${item.type}。`);
  }
}

/** 检查正文或推理的内容块；正文允许拒绝信息，空文本仍是合法内容。 */
function validateTextParts(content: unknown, textType: "output_text" | "reasoning_text"): void {
  if (!Array.isArray(content)) {
    throw new Error("消息或推理项缺少 content 数组。");
  }
  for (const part of content) {
    if (part && part.type === textType && typeof part.text === "string") {
      continue;
    }
    if (textType === "output_text" && part?.type === "refusal" && typeof part.refusal === "string") {
      continue;
    }
    throw new Error(`无效的 ${textType} 内容块。`);
  }
}

/** 检查标识非空且在对应集合内唯一；输出项 id 和 call_id 使用独立集合。 */
function registerId(value: unknown, seen: Set<string>, label: string): void {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${label} 不能为空。`);
  }
  if (seen.has(value)) {
    throw new Error(`${label} 重复。`);
  }
  seen.add(value);
}
