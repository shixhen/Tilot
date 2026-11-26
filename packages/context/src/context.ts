import { toResponseInputItems } from "openai/lib/responses/ResponseInputItems";
import type { ResponseInputItem } from "openai/resources/responses/responses";
import type { ContextCheckpoint, HistoryPosition, ModelAttempt, RetainedInput, Store, Turn, TurnInput } from "@tilot/store";
import { getResponseToolCallsFromResponse, isCompletedOutputItem } from "@tilot/responses/output";
import { readPrompt } from "./prompts.ts";
import { imageContent } from "@tilot/protocol";

/** 本次构建的边界；未覆盖系统策略时读取内置 Markdown 提示词。 */
export interface ContextOptions {
  turnId: string;
  inputThroughId: number;
  instructions?: string | undefined;
  checkpoint?: ContextCheckpoint;
}

/** 下一次请求的系统策略和 SDK 输入；模型、工具声明及预算由各自负责的模块补充。 */
export interface ModelContext {
  instructions: string;
  input: ResponseInputItem[];
}

/**
 * 从 Store 构建指定运行轮次的上下文，必须在 startAttempt 之前调用。
 * 只读取本任务截至该轮次的记录；Core 负责同任务互斥，此函数不启动模型或修改历史。
 */
export function buildContext(store: Store, options: ContextOptions): ModelContext {
  const target = store.getTurn(options.turnId);
  if (!target || target.status !== "running") {
    throw new Error("构建上下文需要存在且正在运行的轮次。");
  }
  const instructions = options.instructions ?? readPrompt("system");
  const checkpoint = options.checkpoint ?? store.compactions.checkpoint(target.threadId);
  const input: ResponseInputItem[] = [];
  if (checkpoint) {
    input.push(...checkpoint.retainedInputs.map(userInput));
    input.push({
      role: "user",
      content: `以下是此前对话的压缩摘要，供继续当前对话时参考。\n\n${checkpoint.summary}`,
    });
  }
  for (const group of readHistoryGroups(store, target.threadId, checkpoint, { throughSequence: target.sequence }, options.inputThroughId)) {
    input.push(...group.items);
  }
  return { instructions, input };
}

interface HistoryGroup {
  items: ResponseInputItem[];
  user?: { input: RetainedInput; turnSequence: number };
}

export function coversNewHistory(through: HistoryPosition, after?: HistoryPosition): boolean {
  if (through.throughSequence !== (after?.throughSequence ?? 0)) return through.throughSequence > (after?.throughSequence ?? 0);
  return (through.throughAttempt ?? Infinity) > (after?.throughAttempt ?? Infinity);
}

/** 回放到指定轮次。压缩按同样的边界读取，完整工具调用和结果始终在同一组。 */
export function* readHistoryGroups(
  store: Store, threadId: string, after: HistoryPosition | undefined, through: HistoryPosition, inputThroughId?: number,
): Generator<HistoryGroup> {
  if (!coversNewHistory(through, after)) return;
  const { throughSequence, throughAttempt } = through;
  const itemIds = new Set<string>();
  const callIds = new Set<string>();
  let afterSequence = after ? after.throughSequence - Number(after.throughAttempt !== undefined) : 0;
  while (afterSequence < throughSequence) {
    const turns = store.listTurns(threadId, afterSequence);
    for (const turn of turns) {
      if (turn.sequence > throughSequence) break;
      const inputs = readTurnInputs(store, turn.id);
      const boundary = turn.sequence === throughSequence && inputThroughId !== undefined ? inputThroughId : inputs.at(-1)?.id;
      if (boundary === undefined || !inputs.some((item) => item.id === boundary)) {
        throw new Error("上下文输入边界不属于该轮次，或轮次缺少用户输入。");
      }
      const skipAttempts = turn.sequence === after?.throughSequence ? after.throughAttempt ?? 0 : 0;
      const stopAfterAttempt = turn.sequence === throughSequence ? throughAttempt : undefined;
      yield* buildTurnInput(store, turn, inputs.filter((item) => item.id <= boundary), itemIds, callIds, skipAttempts, stopAfterAttempt);
      afterSequence = turn.sequence;
      if (afterSequence === throughSequence) return;
    }
    if (turns.length === 0 || turns.at(-1)!.sequence > throughSequence) {
      throw new Error("未能读取目标轮次，历史记录不完整。");
    }
  }
}

/** 读完轮次的全部输入，避免默认分页悄悄截掉第 51 条及后续记录。 */
function readTurnInputs(store: Store, turnId: string): TurnInput[] {
  const inputs: TurnInput[] = [];
  let afterId = 0;
  while (true) {
    const page = store.listTurnInputs(turnId, afterId);
    if (page.length === 0) return inputs;
    inputs.push(...page);
    afterId = page.at(-1)!.id;
  }
}

/** 按请求边界回放已确认输出，工具消息组中间不插入补充输入。 */
function* buildTurnInput(
  store: Store, turn: Turn, inputs: TurnInput[], itemIds: Set<string>, callIds: Set<string>,
  afterSequence: number, stopAfterAttempt?: number,
): Generator<HistoryGroup> {
  let inputIndex = 0;
  let previousBoundary = 0;
  while (true) {
    const attempts = store.history.listAttempts(turn.id, afterSequence);
    if (attempts.length === 0) break;
    for (const attempt of attempts) {
      if (attempt.status === "running") {
        throw new Error("该轮次仍有运行中的请求，不能同时构建下一次上下文。");
      }
      if (attempt.status === "completed" || attempt.completedOutputs.length > 0) {
        if (attempt.inputThroughId < previousBoundary || !inputs.some((item) => item.id === attempt.inputThroughId)) {
          throw new Error("请求的输入边界倒退或超出本次上下文范围。");
        }
        while (inputIndex < inputs.length && inputs[inputIndex]!.id <= attempt.inputThroughId) {
          yield userGroup(inputs[inputIndex++]!, turn.sequence);
        }
        yield { items: buildResponseGroup(store, attempt, itemIds, callIds, turn.status === "interrupted") };
        previousBoundary = attempt.inputThroughId;
      }
      if (attempt.sequence === stopAfterAttempt) return;
      afterSequence = attempt.sequence;
    }
  }
  if (stopAfterAttempt !== undefined) throw new Error("压缩截止请求不存在。");
  // 未消费的补充输入放在该轮输出之后，结束原因只在该轮末尾出现一次。
  for (const item of inputs.slice(inputIndex)) {
    yield userGroup(item, turn.sequence);
  }
  if (turn.status === "cancelled" || turn.status === "failed" || turn.status === "interrupted") {
    yield { items: [{ role: "developer", content: readPrompt(`${turn.status}-turn`) }] };
  }
}

function userGroup({ content, images }: TurnInput, turnSequence: number): HistoryGroup {
  const input = { content, ...(images?.length ? { images } : {}) };
  return { user: { input, turnSequence }, items: [userInput(input)] };
}

function userInput(input: RetainedInput): ResponseInputItem {
  return { role: "user", content: input.images?.length
    ? [...(input.content ? [{ type: "input_text" as const, text: input.content }] : []), ...input.images.map(imageContent)] : input.content };
}

/** 完整输出及配对结果与请求终态独立；中断轮次的未知结果仅在上下文中说明。 */
function buildResponseGroup(
  store: Store, attempt: ModelAttempt, itemIds: Set<string>, callIds: Set<string>, interrupted: boolean,
): ResponseInputItem[] {
  if (attempt.status === "completed") {
    if (!attempt.response) throw new Error("成功尝试缺少完整的成功响应。");
    getResponseToolCallsFromResponse(attempt.response);
  }
  const outputs = attempt.completedOutputs;
  const calls = outputs.filter((entry) => entry.item.type === "function_call");
  const storedCalls = store.history.listToolCalls(attempt.id);
  if (calls.length !== storedCalls.length) {
    throw new Error("响应中的工具调用与存储记录数量不一致。");
  }
  for (const { item } of outputs) {
    if (!isCompletedOutputItem(item)) throw new Error("正式历史中包含未完整生成的输出项。");
    // Responses 已校验字段；这里同时收窄 SDK 中其他输出类型的可选 id。
    if (!item.id || itemIds.has(item.id)) throw new Error("上下文中存在缺失或重复的输出项 id。");
    itemIds.add(item.id);
  }
  const results: ResponseInputItem[] = [];
  for (const [index, { item: call, outputIndex }] of calls.entries()) {
    if (call.type !== "function_call") throw new Error("工具调用类型无效。");
    const stored = storedCalls[index]!;
    if (callIds.has(call.call_id)) throw new Error("上下文中存在重复的工具 call_id。");
    callIds.add(call.call_id);
    if (stored.callId !== call.call_id || stored.outputIndex !== outputIndex) {
      throw new Error("工具调用记录与原始调用不一致。");
    }
    if (stored.result === null && interrupted) {
      results.push({ type: "function_call_output", call_id: call.call_id, output: JSON.stringify({ status: "unknown", error: readPrompt("unknown-tool-result") }) });
      continue;
    }
    if (stored.result?.type !== "function_call_output" || stored.result.call_id !== call.call_id) {
      throw new Error("工具调用缺少配对结果，或结果与原始调用不一致。");
    }
    results.push(stored.result);
  }
  return toResponseInputItems([...outputs.map((entry) => entry.item), ...results]);
}
