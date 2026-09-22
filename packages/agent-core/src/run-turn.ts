import type OpenAI from "openai";
import type { Response, ResponseStreamEvent } from "openai/resources/responses/responses";
import { buildContext } from "@tilot/context";
import { streamResponse } from "@tilot/responses";
import { getResponseToolCallsFromResponse } from "@tilot/responses/output";
import type { AppConfig, AttemptCompletion, Store, Turn } from "@tilot/store";
import { executeTool, projectTools, type Workspace } from "@tilot/tool";

/** Core 的内部执行事件；Server 转换为界面协议，轮次 id 用于区分并行任务。 */
export type TurnEvent =
  | { type: "turn.started"; turn: Turn }
  | { type: "response.event"; turnId: string; attemptId: string; event: ResponseStreamEvent };

/** 一轮对话的输入；项目从任务记录取得，系统策略由调用方提供，取消使用 AbortSignal。 */
export interface RunTurnOptions {
  threadId: string;
  input: string;
  instructions: string;
  signal?: AbortSignal;
  /** 普通事件处理失败会停止请求；终态事件在响应及对应状态落库后交付。 */
  onEvent?: (event: TurnEvent) => void | Promise<void>;
}

/** 一次模型请求的持久化结果；terminal 仅用于保存完成后通知界面。 */
interface AttemptResult {
  attemptId: string | undefined;
  completion: AttemptCompletion;
  terminal: ResponseStreamEvent | undefined;
}

/** 执行模型与工具循环；冻结配置和首条输入，不自动重试，存储与终态通知错误向上抛出。 */
export async function runTurn(store: Store, client: OpenAI, options: RunTurnOptions): Promise<Turn> {
  options.signal?.throwIfAborted();
  const turn = store.startTurn(options.threadId, options.input);
  const input = store.listTurnInputs(turn.id, 0, 1)[0]!;
  const config = store.getConfig();
  const projectPath = store.getThread(options.threadId)!.projectPath;
  const workspace = projectPath === null ? undefined : { rootPath: projectPath };
  try {
    await options.onEvent?.({ type: "turn.started", turn });
  } catch (error) {
    return store.finishTurn(turn.id, options.signal?.aborted ? "cancelled" : "failed", errorMessage(error));
  }

  for (let step = 1; step <= config.maxStepsPerRun; step++) {
    const { completion, attemptId, terminal } = await requestAttempt(store, client, turn, input.id, config, workspace, options);
    let finished: Turn | undefined;
    if (completion.status !== "completed") {
      const status = completion.status === "cancelled" ? "cancelled" : "failed";
      finished = store.finishTurn(turn.id, status, status === "failed" ? completion.error! : null);
    } else {
      const calls = getResponseToolCallsFromResponse(completion.response!);
      if (calls.length === 0) {
        finished = store.finishTurn(turn.id, "completed");
      } else {
        const records = store.history.listToolCalls(attemptId!);
        // 最后一步不再执行无法交回模型的命令；仍保存配对结果，保证历史可继续。
        for (const [index, call] of calls.entries()) {
          const skipped = options.signal?.aborted ? "轮次已取消，工具未执行。"
            : step === config.maxStepsPerRun ? "已达到最大模型请求次数，工具未执行。" : null;
          const output = skipped ? JSON.stringify({ status: "not_executed", error: skipped })
            : await executeTool(workspace!, call.name, call.arguments, options.signal);
          store.history.saveToolResult(records[index]!.id, { type: "function_call_output", call_id: call.call_id, output });
        }
        if (options.signal?.aborted) finished = store.finishTurn(turn.id, "cancelled");
        else if (step === config.maxStepsPerRun) finished = store.finishTurn(turn.id, "failed", "已达到最大模型请求次数。");
      }
    }
    // 成功响应和全部工具结果已经保存；通知失败不能改写响应或重跑工具。
    try {
      if (terminal && attemptId) await options.onEvent?.({ type: "response.event", turnId: turn.id, attemptId, event: terminal });
    } catch (error) {
      if (!finished) store.finishTurn(turn.id, "failed", errorMessage(error));
      throw error;
    }
    if (finished) return finished;
  }
  throw new Error("maxStepsPerRun 必须大于零。");
}

/** 请求并保存一次完整模型响应；仅捕获执行错误，数据库保存失败不能伪装成普通模型错误。 */
async function requestAttempt(
  store: Store, client: OpenAI, turn: Turn, inputThroughId: number, config: AppConfig,
  workspace: Workspace | undefined, options: RunTurnOptions,
): Promise<AttemptResult> {
  let attemptId: string | undefined;
  let snapshot: Response | undefined;
  let terminal: ResponseStreamEvent | undefined;
  let completion: AttemptCompletion;
  let context;
  try {
    options.signal?.throwIfAborted();
    context = buildContext(store, { turnId: turn.id, inputThroughId, instructions: options.instructions });
  } catch (error) {
    return { attemptId, terminal, completion: { status: options.signal?.aborted ? "cancelled" : "failed", error: errorMessage(error) } };
  }
  attemptId = store.history.startAttempt(turn.id, inputThroughId).id;
  try {
    const previousIds = new Set<string>();
    const previousCallIds = new Set<string>();
    for (const item of context.input) {
      if ("id" in item && item.id) previousIds.add(item.id);
      if (item.type === "function_call") previousCallIds.add(item.call_id);
    }
    for await (const event of streamResponse(client, {
      ...context, model: config.model, reasoning: { effort: config.reasoningEffort },
      max_output_tokens: config.maxOutputTokens,
      tools: workspace ? projectTools : [], tool_choice: workspace ? "auto" : "none",
    }, options.signal)) {
      if (event.type === "response.created" || event.type === "response.in_progress" ||
        event.type === "response.completed" || event.type === "response.failed" || event.type === "response.incomplete") snapshot = event.response;
      if (event.type === "response.completed") {
        if (event.response.output.some((item) => (item.id && previousIds.has(item.id)) ||
          (item.type === "function_call" && previousCallIds.has(item.call_id)))) {
          throw new Error("模型响应重复使用历史输出或工具调用标识，拒绝重复执行。");
        }
        if (!workspace && event.response.output.some((item) => item.type === "function_call")) {
          throw new Error("无工具对话收到未声明的工具调用。");
        }
        completion = { status: "completed", response: event.response };
        terminal = event;
        break;
      }
      if (event.type === "response.failed" || event.type === "response.incomplete") {
        completion = {
          status: event.type === "response.failed" ? "failed" : "incomplete", response: event.response,
          error: event.response.error?.message ?? "模型响应未完成：" + (event.response.incomplete_details?.reason ?? event.response.status) + "。",
        };
        terminal = event;
        break;
      }
      await options.onEvent?.({ type: "response.event", turnId: turn.id, attemptId, event });
      options.signal?.throwIfAborted();
    }
  } catch (error) {
    completion = {
      status: options.signal?.aborted ? "cancelled" : "failed", error: errorMessage(error),
      ...(snapshot ? { response: snapshot } : {}),
    };
  }
  // streamResponse 无终态会抛错，所以这里必定已有成功或失败结果。
  store.history.finishAttempt(attemptId, completion!);
  return { attemptId, completion: completion!, terminal };
}

/** 将未知异常转换为可保存、可展示的错误文本。 */
function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
