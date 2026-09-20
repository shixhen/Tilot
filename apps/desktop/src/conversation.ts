import type { AttemptView, MessagePart, ServerEvent, Turn, TurnInput } from "@tilot/protocol";
import type { Request } from "./client";

/** 尚未由历史查询替换的流式消息，按内容位置保存增量。 */
export interface Preview {
  itemId: string;
  parts: MessagePart[];
  complete: boolean;
}

/** 单轮界面数据；正式历史和临时预览分开保存。 */
export interface TurnRecord {
  turn: Turn;
  inputs: TurnInput[];
  attempts: AttemptView[];
  previews: Preview[];
}

/** 读取任务全部分页历史，避免默认每页 50 条导致消息静默缺失。 */
export async function loadConversation(request: Request, threadId: string): Promise<TurnRecord[]> {
  const records: TurnRecord[] = [];
  let afterSequence = 0;
  while (true) {
    const turns = await request("turn.list", { threadId, afterSequence, limit: 100 });
    for (const turn of turns) {
      const inputs: TurnInput[] = [];
      const attempts: AttemptView[] = [];
      while (true) {
        const page = await request("turn.inputs", { turnId: turn.id, afterId: inputs.at(-1)?.id ?? 0, limit: 100 });
        inputs.push(...page);
        if (page.length < 100) break;
      }
      while (true) {
        const page = await request("turn.attempts", { turnId: turn.id, afterSequence: attempts.at(-1)?.sequence ?? 0, limit: 100 });
        attempts.push(...page);
        if (page.length < 100) break;
      }
      records.push({ turn, inputs, attempts, previews: [] });
    }
    if (turns.length < 100) return records;
    afterSequence = turns.at(-1)!.sequence;
  }
}

/** 合并查询与实时数据；旧查询不能把已结束轮次改回运行中或抹掉预览。 */
export function mergeHistory(current: TurnRecord[], history: TurnRecord[]): TurnRecord[] {
  const records = new Map(current.map((record) => [record.turn.id, record]));
  for (const saved of history) {
    const live = records.get(saved.turn.id);
    const turn = live && live.turn.status !== "running" && saved.turn.status === "running" ? live.turn : saved.turn;
    const persisted = new Set(saved.attempts.flatMap((attempt) => attempt.messages.map((message) => message.itemId)));
    records.set(turn.id, { ...saved, turn, previews: live?.previews.filter((preview) => !persisted.has(preview.itemId)) ?? [] });
  }
  return [...records.values()].sort((a, b) => a.turn.sequence - b.turn.sequence);
}

/** 应用单个服务事件；完成消息替换增量，终态不被迟到的启动应答覆盖。 */
export function applyEvent(records: TurnRecord[], event: ServerEvent): TurnRecord[] {
  if ("turn" in event) {
    const existing = records.find((record) => record.turn.id === event.turn.id);
    if (!existing) return [...records, { turn: event.turn, inputs: [], attempts: [], previews: [] }];
    return records.map((record) => record !== existing || (record.turn.status !== "running" && event.turn.status === "running") ? record : { ...record, turn: event.turn });
  }
  return records.map((record) => {
    if (record.turn.id !== event.turnId) return record;
    if (record.attempts.some((attempt) => attempt.messages.some((message) => message.itemId === event.itemId))) return record;
    const previews = [...record.previews];
    const index = previews.findIndex((preview) => preview.itemId === event.itemId);
    const previous = previews[index];
    let preview: Preview;
    if (event.event === "message.completed") {
      preview = { itemId: event.itemId, parts: event.parts, complete: true };
    } else {
      if (previous?.complete) return record;
      const parts = [...(previous?.parts ?? [])];
      parts[event.contentIndex] = { kind: event.kind, text: (parts[event.contentIndex]?.text ?? "") + event.delta };
      preview = { itemId: event.itemId, parts, complete: false };
    }
    if (index < 0) previews.push(preview);
    else previews[index] = preview;
    return { ...record, previews };
  });
}
