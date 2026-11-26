import type { ResponseInputItem } from "openai/resources/responses/responses";
import type { CompactionUsage, ContextCheckpoint, HistoryPosition, RetainedInput, Store, Turn } from "@tilot/store";
import { coversNewHistory, readHistoryGroups } from "./context.ts";
import { readPrompt } from "./prompts.ts";
import { SummaryContextOverflow } from "./budget.ts";
import { previewText, shortenToolResult } from "./tool-results.ts";

interface CompactionOptions {
  through?: HistoryPosition | undefined;
  capacity: number;
  imageBudget: number;
  signal?: AbortSignal | undefined;
  summarize: (instructions: string, input: string) => Promise<{ summary: string; usage: CompactionUsage | null }>;
}

/** 优先压缩最新工具结果之前的历史。 */
export function nextCompactionBoundary(store: Store, turn: Turn): HistoryPosition | undefined {
  const earlierAttempt = store.history.previousReplayableAttempt(turn.id);
  const through = earlierAttempt === undefined ? { throughSequence: turn.sequence - 1 }
    : { throughSequence: turn.sequence, throughAttempt: earlierAttempt };
  if (coversNewHistory(through, store.compactions.checkpoint(turn.threadId))) return through;
}

/** 组织历史、预算和摘要批次。检查点由调用方在成功后保存。 */
export async function compactContext(
  store: Store, threadId: string, { through, capacity, imageBudget, signal, summarize: requestSummary }: CompactionOptions,
): Promise<{ checkpoint: ContextCheckpoint; usage: CompactionUsage | null }> {
  signal?.throwIfAborted();
  if (!through) {
    const latest = store.getLatestTurn(threadId);
    if (!latest || latest.status === "running") throw new Error("手动上下文压缩需要已经结束的对话轮次。");
    through = { throughSequence: latest.sequence };
  }
  const previous = store.compactions.checkpoint(threadId);
  if (!coversNewHistory(through, previous)) throw new Error("上次压缩后没有新的对话内容。");
  const instructions = readPrompt("compact");
  // 用保守的字节估算划分摘要输入，并为模型输出留出空间。
  const historyBytes = Math.floor(capacity * 1.3) - Buffer.byteLength(instructions);
  const retainedBudget = Math.min(20_000, Math.floor(capacity / 4));
  const retained: { input: RetainedInput; tokens: number; bytes: number }[] = [];
  let retainedTokens = 0;
  let retainedImageBytes = 0;
  function retain(input: RetainedInput) {
    const tokens = Math.ceil(Buffer.byteLength(input.content) / 2) + (input.images?.length ?? 0) * 1_000 + 8;
    const bytes = (input.images ?? []).reduce((sum, image) => sum + 4 * Math.ceil(image.bytes / 3), 0);
    retained.push({ input, tokens, bytes });
    retainedTokens += tokens;
    retainedImageBytes += bytes;
    while (retainedTokens > retainedBudget || retainedImageBytes > imageBudget) {
      const removed = retained.shift()!;
      retainedTokens -= removed.tokens;
      retainedImageBytes -= removed.bytes;
    }
  }
  for (const input of previous?.retainedInputs ?? []) retain(input);

  let summary = previous?.summary ?? "";
  let usage: CompactionUsage | null = { inputTokens: 0, outputTokens: 0 };
  let batch: string[] = [];
  let batchBytes = 0;
  const prefix = (maxBytes = historyBytes / 2) => JSON.stringify({ previousSummary: previewText(summary, Math.floor(maxBytes)) });
  let prefixBytes = Buffer.byteLength(prefix());
  async function summarize(): Promise<void> {
    let input = [prefix(), ...batch].join("\n");
    for (let retry = 0; ; retry++) {
      signal?.throwIfAborted();
      try {
        const result = await requestSummary(instructions, input);
        summary = result.summary.trim();
        if (!summary) throw new Error("模型没有返回有效的对话摘要。");
        if (usage && result.usage) {
          usage.inputTokens += result.usage.inputTokens;
          usage.outputTokens += result.usage.outputTokens;
        } else usage = null;
        break;
      } catch (error) {
        if (!(error instanceof SummaryContextOverflow) || retry >= 2) throw error;
        const budget = Math.floor(Buffer.byteLength(input) / 2);
        const earlier = prefix(budget / 4);
        const omitted = "部分较早历史因摘要输入超限已省略。";
        let remaining = budget - Buffer.byteLength(earlier + omitted) - 2;
        if (remaining <= 64) throw error;
        const recent: string[] = [];
        for (let i = batch.length - 1; i >= 0; i--) {
          const line = batch[i]!;
          const size = Buffer.byteLength(line) + 1;
          if (size > remaining) {
            if (!recent.length) recent.push(fitLine(line, remaining));
            break;
          }
          recent.push(line);
          remaining -= size;
        }
        input = [earlier, omitted, ...recent.reverse()].join("\n");
      }
    }
    batch = [];
    batchBytes = 0;
    prefixBytes = Buffer.byteLength(prefix());
  }
  async function append(line: string): Promise<void> {
    let size = Buffer.byteLength(line) + 1;
    if (batch.length && prefixBytes + batchBytes + size > historyBytes) await summarize();
    if (prefixBytes + size > historyBytes) {
      line = fitLine(line, historyBytes - prefixBytes - 1);
      size = Buffer.byteLength(line) + 1;
    }
    batch.push(line);
    batchBytes += size;
  }

  // 调用与已保存结果只作为历史资料发送。
  for (const input of previous?.retainedInputs ?? []) {
    await append(JSON.stringify({ earlierUserMessage: input.content, images: input.images?.map((image) => image.name) }));
  }
  for (const group of readHistoryGroups(store, threadId, previous, through)) {
    if (group.user && (through.throughAttempt === undefined || group.user.turnSequence < through.throughSequence)) retain(group.user.input);
    const items = group.items.filter((item) => item.type !== "reasoning");
    if (!items.length) continue;
    const line = JSON.stringify(items);
    if (Buffer.byteLength(line) + prefixBytes + 1 <= historyBytes) {
      await append(line);
    } else {
      for (const unit of historyUnits(items)) {
        const available = Math.floor((historyBytes - prefixBytes) / 2);
        await append(JSON.stringify(unit.map((item) => shortenToolResult(item, available))));
      }
    }
  }
  if (batch.length) await summarize();
  signal?.throwIfAborted();
  return { checkpoint: { ...through, summary, retainedInputs: retained.map(({ input }) => input) }, usage };
}

function* historyUnits(items: ResponseInputItem[]): Generator<ResponseInputItem[]> {
  const results = new Map(items.flatMap((item) => item.type === "function_call_output" ? [[item.call_id, item] as const] : []));
  for (const item of items) {
    if (item.type === "function_call_output") continue;
    const result = item.type === "function_call" ? results.get(item.call_id) : undefined;
    yield result ? [item, result] : [item];
  }
}

function fitLine(line: string, budget: number): string {
  for (let bytes = budget; bytes >= 64; bytes = Math.floor(bytes / 2)) {
    const excerpt = JSON.stringify({ historyExcerpt: previewText(line, bytes) });
    if (Buffer.byteLength(excerpt) <= budget) return excerpt;
  }
  throw new Error("摘要请求可用空间不足。");
}
