import type { Response } from "openai/resources/responses/responses";
import type { AttemptView, MessagePart, MessageView } from "@tilot/protocol";
import type { Store } from "@tilot/store";
import { getResponseToolCallsFromResponse } from "@tilot/responses/output";

/** 按顺序分页读取模型请求的展示记录；只选取界面字段，不传出原始响应或失败片段。 */
export function listAttemptViews(store: Store, turnId: string, afterSequence = 0, limit = 50): AttemptView[] {
  return store.history.listAttempts(turnId, afterSequence, limit).map((attempt) => {
    let messages: MessageView[] = [];
    if (attempt.status === "completed") {
      if (!attempt.response) throw new Error("成功请求缺少已保存的响应。");
      messages = projectMessages(attempt.response);
    }
    return {
      id: attempt.id, turnId: attempt.turnId, sequence: attempt.sequence,
      inputThroughId: attempt.inputThroughId, status: attempt.status, error: attempt.error,
      createdAt: attempt.createdAt, finishedAt: attempt.finishedAt, messages,
    };
  });
}

/** 将成功响应投影为正文、推理和拒绝文本，实时完成事件和历史查询共用，不改变保存数据。 */
export function projectMessages(response: Response): MessageView[] {
  if (response.status !== "completed") throw new Error("只有成功响应可以生成正式历史消息。");
  getResponseToolCallsFromResponse(response);
  const messages: MessageView[] = [];
  for (const [outputIndex, item] of response.output.entries()) {
    const parts: MessagePart[] = [];
    if (item.type === "message") {
      for (const part of item.content) {
        parts.push(part.type === "refusal" ? { kind: "refusal", text: part.refusal } : { kind: "text", text: part.text });
      }
    } else if (item.type === "reasoning") {
      for (const part of item.content!) parts.push({ kind: "reasoning", text: part.text });
    } else {
      continue;
    }
    messages.push({ itemId: item.id, outputIndex, parts });
  }
  return messages;
}
