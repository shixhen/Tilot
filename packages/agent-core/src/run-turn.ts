import type OpenAI from "openai";
import type { Response, ResponseStreamEvent } from "openai/resources/responses/responses";
import { buildContext } from "@tilot/context";
import { streamResponse } from "@tilot/responses";
import type { AttemptCompletion, Store, Turn } from "@tilot/store";

/** Core 的内部执行事件；Server 将它转换为界面协议，轮次 id 用于区分并行任务。 */
export type TurnEvent =
  | { type: "turn.started"; turn: Turn }
  | { type: "response.event"; turnId: string; attemptId: string; event: ResponseStreamEvent };

/** 单轮无工具请求的输入；系统策略由调用方提供，取消沿用标准 AbortSignal。 */
export interface RunTurnOptions {
  threadId: string;
  input: string;
  instructions: string;
  signal?: AbortSignal;
  /** 同步交付事件；普通事件处理抛错会停止请求，终态事件在落库后交付。 */
  onEvent?: (event: TurnEvent) => void;
}

/**
 * 执行一轮无工具对话，返回已持久化的轮次终态；不自动重试。
 * Server 负责创建匹配配置的 SDK 客户端并管理 Store 生命周期。
 * 创建前的错误直接抛出，创建后的请求错误记为失败；数据库写入及终态通知错误仍向调用方抛出。
 */
export async function runTurn(store: Store, client: OpenAI, options: RunTurnOptions): Promise<Turn> {
  options.signal?.throwIfAborted();
  const turn = store.startTurn(options.threadId, options.input);
  let attemptId: string | undefined;
  let snapshot: Response | undefined;
  let terminal: ResponseStreamEvent | undefined;
  let completion: AttemptCompletion | undefined;
  try {
    // 首条输入在交付 started 之前冻结；回调追加的输入留到下一次请求。
    const input = store.listTurnInputs(turn.id, 0, 1)[0]!;
    const config = store.getConfig();
    options.onEvent?.({ type: "turn.started", turn });
    options.signal?.throwIfAborted();
    const context = buildContext(store, {
      turnId: turn.id, inputThroughId: input.id, instructions: options.instructions,
    });
    attemptId = store.history.startAttempt(turn.id, input.id).id;
    for await (const event of streamResponse(client, {
      ...context,
      model: config.model,
      reasoning: { effort: config.reasoningEffort },
      max_output_tokens: config.maxOutputTokens,
      tools: [],
      tool_choice: "none",
    }, options.signal)) {
      if (event.type === "response.created" || event.type === "response.in_progress" ||
          event.type === "response.completed" || event.type === "response.failed" || event.type === "response.incomplete") {
        snapshot = event.response;
      }
      if (event.type === "response.completed") {
        if (event.response.output.some((item) => item.type === "function_call")) {
          throw new Error("无工具对话收到未声明的工具调用。");
        }
        completion = { status: "completed", response: event.response };
        terminal = event;
        break;
      }
      if (event.type === "response.failed" || event.type === "response.incomplete") {
        completion = {
          status: event.type === "response.failed" ? "failed" : "incomplete",
          response: event.response,
          error: event.response.error?.message ?? `模型响应未完成：${event.response.incomplete_details?.reason ?? event.response.status}。`,
        };
        terminal = event;
        break;
      }
      options.onEvent?.({ type: "response.event", turnId: turn.id, attemptId, event });
      options.signal?.throwIfAborted();
    }
  } catch (error) {
    completion = {
      status: options.signal?.aborted ? "cancelled" : "failed",
      error: error instanceof Error ? error.message : String(error),
      ...(snapshot ? { response: snapshot } : {}),
    };
  }

  // streamResponse 保证正常结束前有终态，否则抛错；因此这里必定已有完成或失败结果。
  const outcome = completion!;
  if (attemptId) store.history.finishAttempt(attemptId, outcome);
  const status = outcome.status === "completed" ? "completed" : outcome.status === "cancelled" ? "cancelled" : "failed";
  const finished = store.finishTurn(turn.id, status, status === "failed" ? outcome.error! : null);
  // 先保存再通知，终态通知失败不能把已经保存的成功响应改成失败。
  if (terminal && attemptId) {
    options.onEvent?.({ type: "response.event", turnId: turn.id, attemptId, event: terminal });
  }
  return finished;
}
