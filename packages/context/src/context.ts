import { toResponseInputItems } from "openai/lib/responses/ResponseInputItems";
import type { ResponseInputItem } from "openai/resources/responses/responses";
import type { ModelAttempt, Store, Turn, TurnInput } from "@tilot/store";
import { getResponseToolCallsFromResponse } from "@tilot/responses/output";

/** 本次构建的边界；Core 在开始请求前选定轮次、用户输入边界和系统策略。 */
export interface ContextOptions {
  turnId: string;
  inputThroughId: number;
  instructions: string;
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
  const input: ResponseInputItem[] = [];
  const itemIds = new Set<string>();
  const callIds = new Set<string>();
  let afterSequence = 0;
  while (true) {
    const turns = store.listTurns(target.threadId, afterSequence);
    for (const turn of turns) {
      const inputs = readTurnInputs(store, turn.id);
      const boundary = turn.id === target.id ? options.inputThroughId : inputs.at(-1)?.id;
      if (boundary === undefined || !inputs.some((item) => item.id === boundary)) {
        throw new Error("上下文输入边界不属于该轮次，或轮次缺少用户输入。");
      }
      input.push(...buildTurnInput(store, turn, inputs.filter((item) => item.id <= boundary), itemIds, callIds));
      if (turn.id === target.id) {
        return { instructions: options.instructions, input };
      }
      afterSequence = turn.sequence;
    }
    if (turns.length === 0) {
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

/** 按成功请求的输入边界插入用户消息，工具消息组中间不插入新输入；失败尝试仅作诊断。 */
function buildTurnInput(
  store: Store, turn: Turn, inputs: TurnInput[], itemIds: Set<string>, callIds: Set<string>,
): ResponseInputItem[] {
  const result: ResponseInputItem[] = [];
  let inputIndex = 0;
  let afterSequence = 0;
  let previousBoundary = 0;
  while (true) {
    const attempts = store.history.listAttempts(turn.id, afterSequence);
    if (attempts.length === 0) break;
    for (const attempt of attempts) {
      if (attempt.status === "running") {
        throw new Error("该轮次仍有运行中的请求，不能同时构建下一次上下文。");
      }
      if (attempt.status === "completed") {
        if (attempt.inputThroughId < previousBoundary || !inputs.some((item) => item.id === attempt.inputThroughId)) {
          throw new Error("成功请求的输入边界倒退或超出本次上下文范围。");
        }
        while (inputIndex < inputs.length && inputs[inputIndex]!.id <= attempt.inputThroughId) {
          result.push({ role: "user", content: inputs[inputIndex++]!.content });
        }
        result.push(...buildResponseGroup(store, attempt, itemIds, callIds));
        previousBoundary = attempt.inputThroughId;
      }
      afterSequence = attempt.sequence;
    }
  }
  // 尚未被成功请求消费的输入也保留，取消或中断不能使用户要求消失。
  for (const item of inputs.slice(inputIndex)) {
    result.push({ role: "user", content: item.content });
  }
  return result;
}

/** 校验并转换一份成功响应及全部配对结果，保留推理正文和工具参数，不修改存储记录。 */
function buildResponseGroup(
  store: Store, attempt: ModelAttempt, itemIds: Set<string>, callIds: Set<string>,
): ResponseInputItem[] {
  const response = attempt.response;
  if (!response || response.status !== "completed") {
    throw new Error("成功尝试缺少完整的成功响应。");
  }
  const calls = getResponseToolCallsFromResponse(response);
  const storedCalls = store.history.listToolCalls(attempt.id);
  if (calls.length !== storedCalls.length) {
    throw new Error("响应中的工具调用与存储记录数量不一致。");
  }
  for (const item of response.output) {
    // Responses 已校验字段；这里同时收窄 SDK 中其他输出类型的可选 id。
    if (!item.id || itemIds.has(item.id)) throw new Error("上下文中存在缺失或重复的输出项 id。");
    itemIds.add(item.id);
  }
  const results: ResponseInputItem[] = [];
  for (const [index, call] of calls.entries()) {
    const stored = storedCalls[index]!;
    if (callIds.has(call.call_id)) throw new Error("上下文中存在重复的工具 call_id。");
    callIds.add(call.call_id);
    if (stored.callId !== call.call_id || response.output[stored.outputIndex] !== call ||
        stored.result?.type !== "function_call_output" || stored.result.call_id !== call.call_id) {
      throw new Error("工具调用缺少配对结果，或结果与原始调用不一致。");
    }
    results.push(stored.result);
  }
  return toResponseInputItems([...response.output, ...results]);
}
