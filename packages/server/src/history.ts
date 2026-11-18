import type { Response, ResponseInputItem } from "openai/resources/responses/responses";
import type { AttemptView, MessagePart, MessageView, ReasoningTiming, ToolView } from "@tilot/protocol";
import { isImageRef } from "@tilot/protocol";
import type { CompletedOutput, Store } from "@tilot/store";
import { getResponseToolCallsFromResponse, isCompletedOutputItem } from "@tilot/responses/output";
import { DEEPSEEK_FIND_NAME } from "@tilot/responses";
import { projectWebTool, webSource, webToolCalls } from "./web-tools.ts";

/** 按顺序分页读取已确认输出的展示记录；不传出原始响应或未完成片段。 */
export function listAttemptViews(store: Store, turnId: string, afterSequence = 0, limit = 50): AttemptView[] {
  return store.history.listAttempts(turnId, afterSequence, limit).map((attempt) => {
    const messages = projectCompletedMessages(attempt.completedOutputs, attempt.reasoningTimings);
    const tools: ToolView[] = attempt.completedOutputs.flatMap(({ outputIndex, item }) =>
      item.type === "web_search_call" ? [projectWebTool(item, outputIndex)] : []);
    for (const record of store.history.listToolCalls(attempt.id)) {
      const call = attempt.completedOutputs.find((entry) => entry.outputIndex === record.outputIndex)?.item;
      if (call?.type !== "function_call") throw new Error("工具记录与模型响应不匹配。");
      tools.push({
        id: record.id, outputIndex: record.outputIndex, name: call.name === DEEPSEEK_FIND_NAME ? "find" : call.name, arguments: call.arguments,
        ...projectToolOutput(record.result?.output ?? null),
        running: false, startedAt: record.startedAt, durationMs: record.durationMs,
      });
    }
    return {
      id: attempt.id, turnId: attempt.turnId, sequence: attempt.sequence,
      inputThroughId: attempt.inputThroughId, status: attempt.status, error: attempt.error,
      createdAt: attempt.createdAt, finishedAt: attempt.finishedAt, messages, tools: tools.sort((a, b) => a.outputIndex - b.outputIndex),
      reasoningTimings: attempt.reasoningTimings,
      metrics: {
        firstTokenMs: attempt.firstTokenMs,
        durationMs: attempt.durationMs,
        inputTokens: attempt.response?.usage?.input_tokens ?? null,
        cachedTokens: attempt.response?.usage?.input_tokens_details?.cached_tokens ?? null,
        outputTokens: attempt.response?.usage?.output_tokens ?? null,
        webToolCalls: webToolCalls(attempt.response?.usage),
      },
    };
  });
}

/** 展示层只传图片引用；原始多模态工具结果仍完整保存在模型历史中。 */
function projectToolOutput(output: ResponseInputItem.FunctionCallOutput["output"] | null): Pick<ToolView, "output" | "images"> {
  if (output === null || typeof output === "string") return { output };
  const text = output.filter((part) => part.type === "input_text").map((part) => part.text).join("\n");
  // 引用已经保存在文本元数据中，即使图片文件损坏也能读取历史并显示取图错误。
  let metadata;
  try { metadata = JSON.parse(text); } catch { return { output: text }; }
  const images = Array.isArray(metadata?.data?.images) ? metadata.data.images.filter(isImageRef) : [];
  return { output: text, ...(images.length ? { images } : {}) };
}

/** 将成功响应投影为正文、推理和拒绝文本，实时完成事件和历史查询共用，不改变保存数据。 */
export function projectMessages(response: Response, timings: ReasoningTiming[] = []): MessageView[] {
  if (response.status !== "completed") throw new Error("只有成功响应可以生成正式历史消息。");
  getResponseToolCallsFromResponse(response);
  return projectCompletedMessages(response.output.map((item, outputIndex) => ({ item, outputIndex })), timings);
}

/** 输出是否已确认完整与整个请求的终态无关，保留原始位置供界面排序。 */
function projectCompletedMessages(outputs: CompletedOutput[], timings: ReasoningTiming[]): MessageView[] {
  const messages: MessageView[] = [];
  for (const { outputIndex, item } of outputs) {
    if (!isCompletedOutputItem(item)) throw new Error("正式历史中包含未完整生成的输出项。");
    const parts: MessagePart[] = [];
    if (item.type === "message") {
      for (const part of item.content) {
        if (part.type === "refusal") parts.push({ kind: "refusal", text: part.refusal });
        else {
          const sources = part.annotations?.flatMap((annotation) => annotation.type === "url_citation" ? webSource(annotation) ?? [] : []);
          parts.push({ kind: "text", text: part.text, ...(sources?.length ? { sources } : {}) });
        }
      }
    } else if (item.type === "reasoning") {
      for (const [contentIndex, part] of item.content!.entries()) {
        const timing = timings.find((entry) => entry.itemId === item.id && entry.contentIndex === contentIndex);
        parts.push({ kind: "reasoning", text: part.text, ...(timing ? { timing: { startedAt: timing.startedAt, durationMs: timing.durationMs } } : {}) });
      }
    } else {
      continue;
    }
    messages.push({ itemId: item.id, outputIndex, parts });
  }
  return messages;
}
