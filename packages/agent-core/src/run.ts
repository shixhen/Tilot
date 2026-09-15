import { CancellationSource, Cancelled, nextEvent } from "./cancellation.js";
import { canonical, snapshot, validateHistory, validateResult, validateTurn } from "./values.js";
import type {
  AgentDependencies, Cancellation, HistoryEntry, JsonValue, ModelRequest, ModelTurn,
  RunInput, RunLimits, RunRecord, RunResult, StopReason, ToolIntent, ToolOutcome, ToolResult,
} from "./types.js";

export const DEFAULT_LIMITS: RunLimits = Object.freeze({ maxSteps: 30, maxToolCalls: 100, maxActiveMs: 20 * 60 * 1000 });
export class JournalCommitError extends Error {
  constructor(cause: unknown) { super("运行记录提交失败；已停止后续执行，终态未确认保存。", { cause }); }
}
class ModelFailure extends Error {
  constructor(readonly reason: "provider_error" | "invalid_response") { super(reason); }
}

function rejected(status: ToolResult["status"], code: string, message: string): ToolResult {
  return { status, summary: message, error: { code, message } };
}

async function collectTurn(request: ModelRequest, deps: AgentDependencies, cancellation: Cancellation, ids: ReadonlySet<string>): Promise<ModelTurn> {
  const iterator = deps.provider.stream(request, cancellation)[Symbol.asyncIterator]();
  let turn: ModelTurn | undefined;
  let exhausted = false;
  try {
    while (true) {
      const next = await nextEvent(iterator, cancellation);
      if (cancellation.cancelled) throw new Cancelled();
      if (next.done) { exhausted = true; break; }
      const event = next.value;
      if (!event || turn) throw new ModelFailure("invalid_response");
      if (event.type === "failed") throw new ModelFailure("provider_error");
      if (event.type === "completed") {
        try { validateTurn(event.turn, ids); turn = snapshot(event.turn); }
        catch { throw new ModelFailure("invalid_response"); }
      } else if (["text_delta", "reasoning_delta", "tool_delta"].includes(event.type) && "delta" in event && typeof event.delta === "string") {
        try { deps.onPreview?.({ runId: request.runId, attemptId: request.attemptId, type: event.type, delta: event.delta }); }
        catch { /* Preview is disposable; it cannot own execution. */ }
      } else throw new ModelFailure("invalid_response");
    }
    if (!turn) throw new ModelFailure("invalid_response");
    return turn;
  } finally {
    // Never wait forever for a non-cooperative stream. Its adapter still owns resource cleanup.
    if (!exhausted && iterator.return) {
      try { void Promise.resolve(iterator.return()).catch(() => {}); } catch { /* Preserve the original failure. */ }
    }
  }
}

export async function runAgent(input: RunInput, deps: AgentDependencies): Promise<RunResult> {
  input = snapshot(input);
  const limits = { ...DEFAULT_LIMITS, ...input.limits };
  if (![input.taskId, input.runId, input.text].every(v => typeof v === "string" && v.trim().length > 0)
    || !Object.values(limits).every(v => Number.isSafeInteger(v) && v > 0)) throw new Error("Invalid run input or budget");
  const history: HistoryEntry[] = [...snapshot(input.history ?? [])];
  const callIds = validateHistory(history);
  const definitions = snapshot(deps.tools.definitions);
  if (new Set(definitions.map(t => t.name)).size !== definitions.length) throw new Error("Duplicate tool definition");
  const source = new CancellationSource();
  let cancellationReason: "cancelled" | "deadline" = "cancelled";
  const cancel = (reason: typeof cancellationReason) => {
    if (source.token.cancelled) return;
    cancellationReason = reason;
    source.cancel();
  };
  const unlink = deps.cancellation.subscribe(() => cancel("cancelled"));
  let clearDeadline = () => {};
  let steps = 0;
  let toolCalls = 0;
  let text = "";
  let partial = false;
  let lastFailure = "";
  let repeats = 0;

  async function commit(records: readonly RunRecord[]): Promise<void> {
    try { await deps.journal.commit(snapshot({ taskId: input.taskId, runId: input.runId, records })); }
    catch (error) { throw new JournalCommitError(error); }
  }
  async function finish(reason: StopReason): Promise<RunResult> {
    const status = reason === "completed" ? "completed"
      : reason === "cancelled" ? "cancelled"
      : reason === "unknown_effect" ? "interrupted" : "failed";
    const result: RunResult = {
      status, outcome: status === "completed" ? partial ? "partial" : "success" : null,
      reason, text, steps, toolCalls,
    };
    await commit([{ type: "run_finished", timestamp: deps.services.now(), result }]);
    return snapshot(result);
  }
  async function execute(intent: ToolIntent): Promise<ToolResult> {
    const call = intent.call;
    const definition = definitions.find(tool => tool.name === call.name);
    if (!definition) return rejected("error", "UNKNOWN_TOOL", "未注册的工具");
    if (definition.effect !== "read") return rejected("denied", "UNSUPPORTED_EFFECT", "首批仅支持内存只读工具");
    let args: JsonValue;
    try { args = snapshot(JSON.parse(call.argumentsJson) as JsonValue); }
    catch { return rejected("error", "INVALID_ARGUMENTS", "工具参数必须是合法 JSON"); }
    try {
      const checked = await deps.tools.validate(call.name, args);
      if (!checked.ok) return validateResult({ status: "error", summary: checked.error.message, error: checked.error });
      args = snapshot(checked.arguments);
    } catch { return rejected("error", "INVALID_ARGUMENTS", "工具参数校验失败"); }
    if (source.token.cancelled) return rejected("cancelled", "CANCELLED", "调用尚未执行，运行已停止");
    try {
      return validateResult(await deps.tools.execute(snapshot({ executionId: intent.executionId, callId: call.callId, name: call.name, arguments: args }), source.token));
    } catch { return rejected("error", "TOOL_EXECUTION", "只读工具执行失败"); }
  }

  try {
    clearDeadline = deps.services.scheduleDeadline(limits.maxActiveMs, () => cancel("deadline"));
    const user: HistoryEntry = { type: "user", text: input.text };
    await commit([{ type: "run_started", timestamp: deps.services.now() }, user]);
    history.push(user);
    while (true) {
      if (source.token.cancelled) return await finish(cancellationReason);
      if (steps >= limits.maxSteps) return await finish("step_limit");
      const stepId = deps.services.newId();
      const attemptId = deps.services.newId();
      const request = snapshot({ taskId: input.taskId, runId: input.runId, stepId, attemptId, history, tools: definitions });
      steps++;
      let turn: ModelTurn;
      try { turn = await collectTurn(request, deps, source.token, callIds); }
      catch (error) {
        const reason = source.token.cancelled ? cancellationReason : error instanceof ModelFailure ? error.reason : "provider_error";
        await commit([{ type: "attempt_failed", stepId, attemptId, reason }]);
        return await finish(reason);
      }
      if (source.token.cancelled) return await finish(cancellationReason);
      const intents = turn.toolCalls.map(call => ({ executionId: deps.services.newId(), call }));
      const model: HistoryEntry = { type: "model", stepId, attemptId, turn, intents };
      await commit([model]);
      history.push(model);
      for (const call of turn.toolCalls) callIds.add(call.callId);
      text = turn.text;
      if (!intents.length) return await finish(source.token.cancelled ? cancellationReason : "completed");
      const results: ToolOutcome[] = [];
      let batchStop: StopReason | undefined;
      for (const intent of intents) {
        let result: ToolResult;
        if (source.token.cancelled) result = rejected("cancelled", "CANCELLED", "调用尚未执行，运行已停止");
        else if (batchStop) result = rejected("denied", "NOT_EXECUTED", `调用尚未执行：${batchStop}`);
        else if (toolCalls >= limits.maxToolCalls) {
          batchStop = "tool_limit";
          result = rejected("denied", "TOOL_LIMIT", "工具调用预算已耗尽");
        } else {
          toolCalls++;
          result = await execute(intent);
          if (result.status === "unknown") batchStop = "unknown_effect";
          if (result.status === "error" || result.status === "denied") {
            let argumentsKey = intent.call.argumentsJson;
            try { argumentsKey = canonical(JSON.parse(argumentsKey)); } catch { /* Keep malformed arguments verbatim. */ }
            const key = canonical([intent.call.name, argumentsKey, result.error?.code ?? result.status]);
            repeats = key === lastFailure ? repeats + 1 : 1;
            lastFailure = key;
            if (repeats >= 3) batchStop = "repeated_error";
          } else { lastFailure = ""; repeats = 0; }
        }
        partial ||= result.status !== "ok";
        results.push({ executionId: intent.executionId, callId: intent.call.callId, result });
      }
      const group: HistoryEntry = { type: "tool_results", stepId, results };
      await commit([group]);
      history.push(group);
      if (batchStop === "unknown_effect") return await finish(batchStop);
      if (source.token.cancelled) return await finish(cancellationReason);
      if (batchStop) return await finish(batchStop);
    }
  } finally { clearDeadline(); unlink(); }
}
