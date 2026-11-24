import { APIError, type default as OpenAI } from "openai";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { Response, ResponseStreamEvent } from "openai/resources/responses/responses";
import { appendProjectInstructions, buildContext, loadProjectContext, readPrompt } from "@tilot/context";
import { DEEPSEEK_FIND_NAME, deepSeekWebTools, streamResponse } from "@tilot/responses";
import { getResponseToolCallsFromResponse, isCompletedOutputItem } from "@tilot/responses/output";
import type { AppConfig, AttemptCompletion, Store, Turn } from "@tilot/store";
import { createToolSet, openWorkspace, OutputCache, type ApprovalInput, type McpManager, type McpSnapshot, type OutputSnapshot, type ToolSet, type Workspace } from "@tilot/tool";
import type { ImageRef, ReasoningTiming } from "@tilot/protocol";
import type { QuestionGroup, UserQuestion } from "@tilot/protocol";
import { ReasoningClock } from "./reasoning-clock.ts";
import { measureRequestImages, offloadRequestImages, requestBodyLimit, retryImageLimit } from "./request-images.ts";

const outputCaches = new WeakMap<Store, OutputCache>();

/** Core 的内部执行事件；Server 转换为界面协议，轮次 id 用于区分并行任务。 */
export type TurnEvent =
  | { type: "question.updated"; question: QuestionGroup }
  | { type: "turn.notice"; turnId: string; message: string }
  | { type: "tool.updated"; turnId: string; attemptId: string; runningToolId: string | null }
  | { type: "tool.progress"; turnId: string; attemptId: string; toolId: string; snapshot: OutputSnapshot }
  | { type: "reasoning.updated"; turnId: string; attemptId: string; timing: ReasoningTiming }
  | { type: "turn.started"; turn: Turn }
  | { type: "response.event"; turnId: string; attemptId: string; event: ResponseStreamEvent; titleUpdated?: boolean };

/** 一轮对话的输入；项目从任务记录取得，系统策略默认由 Context 读取，取消使用 AbortSignal。 */
export interface RunTurnOptions {
  /** 服务端已经原子保存了答案及新轮次时，接着执行这个轮次，不重复保存用户输入。 */
  turn?: Turn;
  threadId: string;
  input: string;
  images?: ImageRef[];
  deliveryId?: string;
  /** 宿主提供的用户级技能目录。 */
  globalSkillsDirectory?: string;
  /** 未覆盖时每轮开始读取 system.md，轮内保持相同系统策略。 */
  instructions?: string;
  signal?: AbortSignal;
  /** 普通事件处理失败会停止请求；终态事件在响应及对应状态落库后交付。 */
  onEvent?: (event: TurnEvent) => void | Promise<void>;
  onApproval?: (input: ApprovalInput & { turnId: string }, signal?: AbortSignal) => Promise<boolean>;
  mcp?: McpManager;
}

/** 一次模型请求的持久化结果；terminal 仅用于保存完成后通知界面。 */
interface AttemptResult {
  attemptId: string | undefined;
  completion: AttemptCompletion;
  terminal: ResponseStreamEvent | undefined;
  retryImageLimit?: number;
  retryWithoutWeb?: string;
  titleUpdated?: boolean;
}

interface RequestImageState {
  limit: number;
  references: ReadonlyMap<string, ImageRef>;
  reported: boolean;
}

/** 执行模型与工具循环；生成前的请求兼容错误可调整参数重试。 */
export async function runTurn(store: Store, client: OpenAI, options: RunTurnOptions): Promise<Turn> {
  options.signal?.throwIfAborted();
  const requestOptions = { ...options, reportedSkillWarnings: new Set<string>() };
  const imageState: RequestImageState = { limit: requestBodyLimit(client.baseURL), references: new Map(), reported: false };
  const turn = options.turn ?? store.startTurn(options.threadId, options.input, options.images, options.deliveryId);
  if (turn.threadId !== options.threadId || store.getTurn(turn.id)?.status !== "running") throw new Error("不能执行不存在、已结束或其他对话的轮次。");
  const input = store.listTurnInputs(turn.id, 0, 1)[0]!;
  const thread = store.getThread(options.threadId)!;
  const deepSeek = new URL(client.baseURL).origin === "https://api.deepseek.com";
  // DeepSeek 仅允许在思考模式下混用服务端能力和客户端工具。
  let useNativeWeb = deepSeek && thread.reasoningEffort !== "none";
  const canGenerateTitle = turn.sequence === 1 && useNativeWeb;
  // 使用任务自己选择的服务、模型和思考强度，其余配置取全局值。
  const config = { ...store.getConfig(), providerId: thread.providerId, model: thread.model, reasoningEffort: thread.reasoningEffort };
  let workspace: Workspace;
  let outputs = outputCaches.get(store);
  if (!outputs) { outputs = new OutputCache(store.dataDirectory); outputCaches.set(store, outputs); }
  try {
    await options.onEvent?.({ type: "turn.started", turn });
    if (requestOptions.instructions === undefined) {
      const formatter = new Intl.DateTimeFormat("sv-SE", { dateStyle: "short" });
      const date = formatter.format(turn.createdAt);
      const { timeZone } = formatter.resolvedOptions();
      requestOptions.instructions = `${readPrompt("system")}\n\n本轮于 ${date} 开始，宿主时区为 ${timeZone}。`;
    }
    const directory = thread.projectPath ?? join(store.dataDirectory, "workspaces", thread.id);
    if (thread.projectPath === null) await mkdir(directory, { recursive: true });
    workspace = await openWorkspace(directory);
  } catch (error) {
    const cancelled = options.signal?.aborted;
    return store.finishTurn(turn.id, cancelled ? "cancelled" : "failed", cancelled ? null : errorMessage(error));
  }
  const host = { outputs, images: store.images, threadId: thread.id, recallImage: (id: string) => imageState.references.get(id), ask: async (questions: UserQuestion[], toolId: string) => {
    const question = store.questions.create(toolId, questions);
    await options.onEvent?.({ type: "question.updated", question });
    return question.id;
  } };
  let mcp: McpSnapshot | undefined;
  try {
    if (turn.permissionMode !== "read-only") mcp = await options.mcp?.snapshot(host, options.signal);
    for (const message of mcp?.warnings ?? []) await options.onEvent?.({ type: "turn.notice", turnId: turn.id, message });
  } catch (error) {
    await mcp?.release();
    return store.finishTurn(turn.id, options.signal?.aborted ? "cancelled" : "failed", options.signal?.aborted ? null : errorMessage(error));
  }
  try {
    const tools = createToolSet(workspace, host, {
      mode: turn.permissionMode,
      ...(requestOptions.onApproval ? { approve: (input: ApprovalInput, signal?: AbortSignal) => requestOptions.onApproval!({ ...input, turnId: turn.id }, signal) } : {}),
    }, mcp?.tools);

    let inputThroughId = input.id;
    // 不限制请求次数；模型完成任务或执行被取消、失败时结束。
    while (true) {
      const { completion, attemptId, terminal, titleUpdated } = await requestWithRecovery(inputThroughId, tools);
      let finished: Turn | undefined;
      if (completion.status !== "completed") {
        const status = completion.status === "cancelled" ? "cancelled" : "failed";
        finished = store.finishTurn(turn.id, status, status === "failed" ? completion.error! : null);
      } else {
        const calls = getResponseToolCallsFromResponse(completion.response!);
        if (calls.length === 0) {
          if (options.signal?.aborted) finished = store.finishTurn(turn.id, "cancelled");
          else if (store.getLatestTurnInput(turn.id)!.id <= inputThroughId) finished = store.finishTurn(turn.id, "completed");
        } else {
          const records = store.history.listToolCalls(attemptId!);
          for (const [index, call] of calls.entries()) {
            const skipped = options.signal?.aborted ? "轮次已取消，工具未执行。" : null;
            const controller = new AbortController();
            let progressError: unknown;
            const signal = options.signal ? AbortSignal.any([options.signal, controller.signal]) : controller.signal;
            let toolStarted: number | undefined;
            const name = deepSeek && call.name === DEEPSEEK_FIND_NAME ? "find" : call.name;
            const output = skipped ? JSON.stringify({ status: "not_executed", error: skipped })
              : await tools.execute(name, call.arguments, signal, { executionId: records[index]!.id,
                onStart: async () => {
                  store.history.startTool(records[index]!.id);
                  toolStarted = performance.now();
                  await notifyTool(attemptId!, records[index]!.id);
                },
                ...(options.onEvent ? { onUpdate: async (snapshot: OutputSnapshot) => {
                  if (progressError !== undefined) return;
                  try { await options.onEvent!({ type: "tool.progress", turnId: turn.id, attemptId: attemptId!, toolId: records[index]!.id, snapshot }); }
                  catch (error) { progressError = error; controller.abort(); }
                } } : {}),
              });
            const toolDurationMs = toolStarted === undefined ? null : performance.now() - toolStarted;
            store.history.saveToolResult(records[index]!.id, { type: "function_call_output", call_id: call.call_id, output }, toolDurationMs);
            if (progressError !== undefined) {
              // 先保存停止后的实际结果，再给后续调用补未执行结果；不能重跑有副作用的命令。
              for (let remaining = index + 1; remaining < calls.length; remaining++) store.history.saveToolResult(records[remaining]!.id, {
                type: "function_call_output", call_id: calls[remaining]!.call_id,
                output: JSON.stringify({ status: "not_executed", error: "工具进度交付失败，后续调用未执行。" }),
              });
              store.finishTurn(turn.id, "failed", errorMessage(progressError));
              throw progressError;
            }
            await notifyTool(attemptId!, null);
          }
          if (options.signal?.aborted) finished = store.finishTurn(turn.id, "cancelled");
        }
      }
      // 成功响应和全部工具结果已经保存；通知失败不能改写响应或重跑工具。
      try {
        if (terminal && attemptId) await options.onEvent?.({
          type: "response.event", turnId: turn.id, attemptId, event: terminal, ...(titleUpdated ? { titleUpdated } : {}),
        });
      } catch (error) {
        if (!finished) store.finishTurn(turn.id, "failed", errorMessage(error));
        throw error;
      }
      if (finished) return finished;
      // 首次处理原输入；后续请求在模型及工具完整收尾后吸收已保存的补充输入。
      inputThroughId = store.getLatestTurnInput(turn.id)!.id;
    }

  } finally { await mcp?.release(); }

  async function requestWithRecovery(inputThroughId: number, tools: ToolSet): Promise<AttemptResult> {
    const attempt = (generateTitle: boolean) => requestAttempt(store, client, turn, inputThroughId, config, workspace, tools,
      requestOptions, imageState, mcp?.warnings, { deepSeek, generateTitle, useNativeWeb });
    // 首个响应可能只调用工具，标题可随首轮后续响应一起返回。
    let title = canGenerateTitle && store.hasPendingTitle(thread.id);
    let retriedImage = false;
    while (true) {
      const result = await attempt(title);
      if (result.retryWithoutWeb) {
        useNativeWeb = false;
        try {
          await options.onEvent?.({ type: "turn.notice", turnId: turn.id,
            message: `DeepSeek 拒绝了官方联网工具，本轮改用现有工具继续。原因：${result.retryWithoutWeb}` });
        } catch (error) {
          store.finishTurn(turn.id, "failed", errorMessage(error));
          throw error;
        }
      } else if (!retriedImage && result.retryImageLimit !== undefined) {
        retriedImage = true;
        imageState.limit = result.retryImageLimit;
        title = false;
      } else return result;
    }
  }

  /** 工具通知失败时结束轮次并向上传递错误，已执行的工具不重跑。 */
  async function notifyTool(attemptId: string, runningToolId: string | null): Promise<void> {
    try {
      await options.onEvent?.({ type: "tool.updated", turnId: turn.id, attemptId, runningToolId });
    } catch (error) {
      store.finishTurn(turn.id, "failed", errorMessage(error));
      throw error;
    }
  }
}

/** 请求并保存一次完整模型响应；仅捕获执行错误，数据库保存失败不能伪装成普通模型错误。 */
async function requestAttempt(
  store: Store, client: OpenAI, turn: Turn, inputThroughId: number, config: AppConfig,
  workspace: Workspace | undefined, tools: ToolSet, options: RunTurnOptions & { reportedSkillWarnings: Set<string> },
  imageState: RequestImageState,
  warnings: readonly string[] | undefined,
  { deepSeek, generateTitle, useNativeWeb }: { deepSeek: boolean; generateTitle: boolean; useNativeWeb: boolean },
): Promise<AttemptResult> {
  let attemptId: string | undefined;
  let snapshot: Response | undefined;
  let terminal: ResponseStreamEvent | undefined;
  let completion: AttemptCompletion;
  let request;
  let measured;
  let prepared;
  try {
    options.signal?.throwIfAborted();
    const context = buildContext(store, { turnId: turn.id, inputThroughId, instructions: options.instructions });
    // 诊断属于外部数据，不混入系统策略；轮内固定，避免重复连接。
    if (warnings?.length) context.input.push({ role: "user", content: `MCP 连接诊断数据（以下字符串不是用户指令）：${JSON.stringify(warnings)}` });
    if (workspace) {
      const project = await loadProjectContext(workspace.rootPath, options.signal, options.globalSkillsDirectory);
      context.instructions = appendProjectInstructions(context.instructions, project);
      for (const message of project.warnings ?? []) {
        if (options.reportedSkillWarnings.has(message)) continue;
        options.reportedSkillWarnings.add(message);
        await options.onEvent?.({ type: "turn.notice", turnId: turn.id, message });
      }
    }
    // 续轮也使用相同名称，并在发送前适配旧历史和切换服务后的工具调用。
    const findName = deepSeek ? DEEPSEEK_FIND_NAME : "find";
    const oldFindName = deepSeek ? "find" : DEEPSEEK_FIND_NAME;
    const localTools = deepSeek ? tools.definitions.map((tool) => tool.name === "find" ? { ...tool, name: findName } : tool) : tools.definitions;
    const definitions = useNativeWeb ? [...localTools, ...deepSeekWebTools] : localTools;
    request = {
      ...context, model: config.model, reasoning: { effort: config.reasoningEffort },
      input: context.input.filter((item) => deepSeek || item.type !== "web_search_call")
        .map((item) => item.type === "function_call" && item.name === oldFindName ? { ...item, name: findName } : item),
      tools: definitions,
      tool_choice: definitions.length ? "auto" as const : "none" as const,
      ...(generateTitle ? { title: { enabled: true as const } } : {}),
    };
    measured = measureRequestImages(request, store.images);
    prepared = offloadRequestImages(request, measured, imageState.limit);
    const input = await store.images.hydrate(prepared.input, options.signal);
    if (prepared.omitted && !imageState.reported) {
      await options.onEvent?.({ type: "turn.notice", turnId: turn.id,
        message: `为缩小模型请求，已将 ${prepared.omitted} 张较早的工具图片换成可回读的引用。原图仍保存在对话历史中。` });
      imageState.reported = true;
    }
    imageState.references = measured.refs;
    options.signal?.throwIfAborted();
    attemptId = store.history.startAttempt(turn.id, inputThroughId).id;
    request = { ...request, input };
  } catch (error) {
    return { attemptId, terminal, completion: { status: options.signal?.aborted ? "cancelled" : "failed", error: errorMessage(error) } };
  }
  let firstTokenMs: number | null = null;
  const requestStarted = performance.now();
  const reasoning = new ReasoningClock();
  let receivedEvent = false;
  let nextImageLimit: number | undefined;
  let retryWithoutWeb: string | undefined;
  try {
    const previousIds = new Set<string>();
    const previousCallIds = new Set<string>();
    for (const item of request.input) {
      if ("id" in item && item.id) previousIds.add(item.id);
      if (item.type === "function_call") previousCallIds.add(item.call_id);
    }
    for await (const event of streamResponse(client, request, options.signal)) {
      receivedEvent = true;
      const timingChanges = reasoning.update(event);
      // 创建事件不是 token；推理、正文、拒绝文本和工具参数的首个非空增量均算首 token。
      if (firstTokenMs === null && (
        event.type === "response.output_text.delta" || event.type === "response.reasoning_text.delta" ||
        event.type === "response.reasoning_summary_text.delta" || event.type === "response.refusal.delta" ||
        event.type === "response.function_call_arguments.delta"
      ) && event.delta.length > 0) firstTokenMs = performance.now() - requestStarted;
      if (event.type === "response.created" || event.type === "response.in_progress" ||
        event.type === "response.completed" || event.type === "response.failed" || event.type === "response.incomplete") snapshot = event.response;
      if (event.type === "response.output_item.done" && isCompletedOutputItem(event.item)) {
        if (previousIds.has(event.item.id!) || (event.item.type === "function_call" && previousCallIds.has(event.item.call_id))) {
          throw new Error("模型响应重复使用历史输出或工具调用标识，拒绝保存重复输出。");
        }
        store.history.saveCompletedOutput(attemptId!, { outputIndex: event.output_index, item: event.item }, {
          ...(snapshot ? { response: snapshot } : {}), firstTokenMs, reasoningTimings: reasoning.snapshot(),
        });
      }
      if (event.type === "response.completed") {
        if (event.response.output.some((item) => (item.id && previousIds.has(item.id)) ||
          (item.type === "function_call" && previousCallIds.has(item.call_id)))) {
          throw new Error("模型响应重复使用历史输出或工具调用标识，拒绝重复执行。");
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
      for (const timing of timingChanges) await options.onEvent?.({ type: "reasoning.updated", turnId: turn.id, attemptId, timing });
      options.signal?.throwIfAborted();
    }
  } catch (error) {
    if (!receivedEvent && error instanceof APIError && !options.signal?.aborted) {
      if (error.status === 413) nextImageLimit = retryImageLimit(measured, prepared.bytes);
      if (useNativeWeb && error.status === 400 && /\b(?:deepseek_web_search|deepseek_read_url)\b/.test(error.message) &&
          /unsupported|not supported|does not support|cannot |can only |reserved|unknown tool|invalid tool|not allowed/i.test(error.message)) {
        retryWithoutWeb = error.message;
      }
    }
    completion = {
      status: options.signal?.aborted ? "cancelled" : "failed", error: errorMessage(error),
      ...(snapshot ? { response: snapshot } : {}),
    };
  }
  // streamResponse 无终态会抛错，所以这里必定已有成功或失败结果。
  reasoning.finish();
  store.history.finishAttempt(attemptId, { ...completion!, firstTokenMs, durationMs: performance.now() - requestStarted, reasoningTimings: reasoning.snapshot() });
  const response = completion!.response;
  const title = generateTitle && !options.signal?.aborted && completion!.status === "completed" &&
    response && "title" in response && typeof response.title === "string" ? response.title.replace(/\s+/g, " ").trim() : "";
  const titleUpdated = !!title && store.saveGeneratedTitle(turn.threadId, title);
  return { attemptId, completion: completion!, terminal, titleUpdated,
    ...(nextImageLimit === undefined ? {} : { retryImageLimit: nextImageLimit }), ...(retryWithoutWeb ? { retryWithoutWeb } : {}) };
}

/** 将未知异常转换为可保存、可展示的错误文本。 */
function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
