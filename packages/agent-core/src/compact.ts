import type OpenAI from "openai";
import { coversNewHistory, readHistoryGroups, readPrompt } from "@tilot/context";
import { DEFAULT_CONTEXT_TOKENS, type Thread } from "@tilot/protocol";
import { streamResponse } from "@tilot/responses";
import type { AppConfig, CompactionUsage, ContextCheckpoint, HistoryPosition, RetainedInput, Store } from "@tilot/store";
import { requestBodyLimit } from "./request-images.ts";

/** 独立请求摘要。全部完成后才把检查点交给调用方保存。 */
export async function compactHistory(
  store: Store, client: OpenAI, thread: Thread, signal: AbortSignal | undefined, through?: HistoryPosition,
  capacity = configuredContextCapacity(store.getConfig(), thread),
): Promise<{ checkpoint: ContextCheckpoint; usage: CompactionUsage | null }> {
  signal?.throwIfAborted();
  if (!through) {
    const latest = store.getLatestTurn(thread.id);
    if (!latest || latest.status === "running") throw new Error("手动上下文压缩需要已经结束的对话轮次。");
    through = { throughSequence: latest.sequence };
  }
  const previous = store.compactions.checkpoint(thread.id);
  if (!coversNewHistory(through, previous)) throw new Error("上次压缩后没有新的对话内容。");
  const instructions = readPrompt("compact");
  // 用保守的字节估算划分摘要输入，并为模型输出留出空间。
  const historyBytes = Math.floor(capacity * 1.3) - Buffer.byteLength(instructions);
  const retainedBudget = Math.min(20_000, Math.floor(capacity / 4));
  const imageBudget = requestBodyLimit(client.baseURL) / 2;
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
  const prefix = () => JSON.stringify({ previousSummary: summary });
  let prefixBytes = Buffer.byteLength(prefix());
  async function summarize(): Promise<void> {
    signal?.throwIfAborted();
    for await (const event of streamResponse(client, {
      model: thread.model, instructions, reasoning: { effort: thread.reasoningEffort },
      input: [{ role: "user", content: [prefix(), ...batch].join("\n") }],
    }, signal)) {
      if (event.type === "response.failed" || event.type === "response.incomplete") {
        throw new Error(event.response.error?.message ?? "模型未能完成对话摘要。");
      }
      if (event.type !== "response.completed") continue;
      summary = event.response.output.flatMap((item) => item.type === "message"
        ? item.content.flatMap((part) => part.type === "output_text" ? [part.text] : []) : []).join("\n").trim();
      if (!summary) throw new Error("模型没有返回有效的对话摘要。");
      const reported = event.response.usage;
      if (usage && reported && Number.isFinite(reported.input_tokens) && Number.isFinite(reported.output_tokens)) {
        usage.inputTokens += reported.input_tokens;
        usage.outputTokens += reported.output_tokens;
      } else usage = null;
    }
    batch = [];
    batchBytes = 0;
    prefixBytes = Buffer.byteLength(prefix());
  }
  async function append(line: string): Promise<void> {
    const size = Buffer.byteLength(line) + 1;
    if (batch.length && prefixBytes + batchBytes + size > historyBytes) await summarize();
    if (prefixBytes + size > historyBytes) throw new Error("一组完整的历史内容超过压缩请求可用空间。");
    batch.push(line);
    batchBytes += size;
  }

  // 调用与已保存结果只作为历史资料发送。
  for (const input of previous?.retainedInputs ?? []) {
    await append(JSON.stringify({ earlierUserMessage: input.content, images: input.images?.map((image) => image.name) }));
  }
  for (const group of readHistoryGroups(store, thread.id, previous, through)) {
    if (group.user && (through.throughAttempt === undefined || group.user.turnSequence < through.throughSequence)) retain(group.user.input);
    const items = group.items.filter((item) => item.type !== "reasoning");
    if (items.length) await append(JSON.stringify(items));
  }
  if (batch.length) await summarize();
  signal?.throwIfAborted();
  return { checkpoint: { ...through, summary, retainedInputs: retained.map(({ input }) => input) }, usage };
}

export function configuredContextCapacity(config: AppConfig, model: Pick<Thread, "providerId" | "model">): number {
  return config.providers.find((provider) => provider.id === model.providerId)?.models
    .find((item) => item.id === model.model)?.contextTokens ?? DEFAULT_CONTEXT_TOKENS;
}
