import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type Database from "better-sqlite3";
import type { AttemptCompletion, CompletedOutput, ModelAttempt, StoredToolCall, ToolResult } from "./history-types.ts";
import { validatePagination } from "./pagination.ts";

/** 数据库中的请求记录；完整 SDK 响应以 JSON 保存。 */
type AttemptRow = Omit<ModelAttempt, "response" | "reasoningTimings" | "completedOutputs"> & { responseJson: string | null; reasoningTimingsJson: string; completedOutputsJson: string };

/** 数据库中的工具记录；完整 SDK 结果以 JSON 保存。 */
type ToolCallRow = Omit<StoredToolCall, "result"> & { resultJson: string | null };

/** 模型请求与工具结果的持久化接口；共享 Store 的数据库连接，不调度模型或工具。 */
export class ModelHistoryStore {
  private readonly database: Database.Database;

  /** 使用 Store 已打开的连接；连接生命周期仍由 Store 管理。 */
  constructor(database: Database.Database) {
    this.database = database;
  }

  /** 未决调用阻止继续；旧中断轮次可由 Context 配 unknown 说明后继续，不改写实际结果。 */
  startAttempt(turnId: string, inputThroughId: number): ModelAttempt {
    return this.database.transaction(() => {
      const turn = this.database.prepare<[string, number], { threadId: string }>(`
        SELECT turns.threadId FROM turns JOIN turn_inputs ON turn_inputs.turnId = turns.id
        WHERE turns.id = ? AND turns.status = 'running' AND turn_inputs.id = ?
      `).get(turnId, inputThroughId);
      if (!turn) {
        throw new Error("轮次未运行，或输入边界不属于该轮次。");
      }
      const pending = this.database.prepare(`
        SELECT 1 FROM tool_calls
        JOIN model_attempts ON model_attempts.id = tool_calls.attemptId
        JOIN turns ON turns.id = model_attempts.turnId
        WHERE turns.threadId = ? AND turns.status != 'interrupted' AND tool_calls.resultJson IS NULL LIMIT 1
      `).get(turn.threadId);
      if (pending) {
        throw new Error("该任务仍有工具调用缺少结果，请先核对并补齐。");
      }
      const row = this.database.prepare<[string, string, string, number, number], AttemptRow>(`
        INSERT INTO model_attempts (id, turnId, sequence, inputThroughId, status, createdAt)
        VALUES (?, ?, (SELECT COALESCE(MAX(sequence), 0) + 1 FROM model_attempts WHERE turnId = ?), ?, 'running', ?)
        RETURNING *
      `).get(randomUUID(), turnId, turnId, inputThroughId, Date.now())!;
      return decodeAttempt(row);
    }).immediate();
  }

  /** 完整输出先于界面通知落库；工具仅登记意图，成功终态前不能执行。 */
  saveCompletedOutput(id: string, output: CompletedOutput, diagnostics: Pick<AttemptCompletion, "response" | "firstTokenMs" | "reasoningTimings"> = {}): void {
    if (!Number.isSafeInteger(output.outputIndex) || output.outputIndex < 0 || !output.item.id) throw new Error("完整输出缺少有效位置或标识。");
    const { item } = output;
    const failedWebCall = item.type === "web_search_call" && item.status === "failed";
    if ("status" in item && item.status !== undefined && item.status !== "completed" && !failedWebCall) {
      throw new Error("不能保存未完成的输出项。");
    }
    this.database.transaction(() => {
      const attempt = this.getAttempt(id);
      if (!attempt || attempt.status !== "running") throw new Error("请求尝试不存在或已结束。");
      const existing = attempt.completedOutputs.find((entry) => entry.outputIndex === output.outputIndex || entry.item.id === output.item.id);
      if (existing) {
        if (!isDeepStrictEqual(existing, output)) throw new Error("已保存的完整输出不能被改写或移动。");
        return;
      }
      const outputs = [...attempt.completedOutputs, output].sort((a, b) => a.outputIndex - b.outputIndex);
      const updated = this.database.prepare(`
        UPDATE model_attempts SET completedOutputsJson = ?, responseJson = ?, firstTokenMs = COALESCE(?, firstTokenMs), reasoningTimingsJson = ?
          WHERE id = ? AND status = 'running'
          AND EXISTS (SELECT 1 FROM turns WHERE turns.id = model_attempts.turnId AND turns.status = 'running')
      `).run(JSON.stringify(outputs), JSON.stringify(diagnostics.response ?? attempt.response), diagnostics.firstTokenMs ?? null,
        JSON.stringify(diagnostics.reasoningTimings ?? attempt.reasoningTimings), id);
      if (updated.changes !== 1) throw new Error("请求所属轮次已结束。");
      this.registerToolCalls(id, [output], Date.now());
    })();
  }

  /** 请求状态与完整输出独立保存；未成功的请求仅为已确认调用补未执行结果。 */
  finishAttempt(id: string, completion: AttemptCompletion): ModelAttempt {
    const error = completion.error ?? null;
    if (completion.status === "completed" && (completion.response?.status !== "completed" || error !== null)) {
      throw new Error("成功尝试必须提供成功响应，且不能包含本地错误。");
    }
    return this.database.transaction(() => {
      const current = this.getAttempt(id);
      if (!current || current.status !== "running") throw new Error("请求尝试不存在或已结束。");
      const response = completion.response ?? current.response;
      const outputs = completion.status === "completed" ? response!.output.map((item, outputIndex) => ({ outputIndex, item })) : current.completedOutputs;
      if (completion.status === "completed" && current.completedOutputs.some((saved) => !isDeepStrictEqual(response!.output[saved.outputIndex], saved.item))) {
        throw new Error("成功响应与已保存的完整输出不一致。");
      }
      const now = Date.now();
      const row = this.database.prepare<[string, string | null, string | null, number, number | null, number | null, string, string, string], AttemptRow>(`
        UPDATE model_attempts SET status = ?, responseJson = ?, error = ?, finishedAt = ?, firstTokenMs = ?, durationMs = ?, reasoningTimingsJson = ?, completedOutputsJson = ?
        WHERE id = ? AND status = 'running'
          AND EXISTS (SELECT 1 FROM turns WHERE turns.id = model_attempts.turnId AND turns.status = 'running')
        RETURNING *
      `).get(completion.status, response === null ? null : JSON.stringify(response), error, now, completion.firstTokenMs ?? null, completion.durationMs ?? null,
        JSON.stringify(completion.reasoningTimings ?? []), JSON.stringify(completion.status === "completed" ? [] : outputs), id);
      if (!row) {
        throw new Error("请求尝试不存在或已结束，或所属轮次已结束。");
      }
      this.registerToolCalls(id, outputs, now);
      if (completion.status !== "completed") {
        const reasons = { cancelled: "用户取消了模型请求，此工具调用未执行。", interrupted: "模型请求因进程退出而中断，此工具调用未执行。",
          failed: "模型请求失败，此工具调用未执行。", incomplete: "模型请求未完整结束，此工具调用未执行。" };
        this.database.prepare(`
          UPDATE tool_calls SET resultJson = json_object('type', 'function_call_output', 'call_id', callId, 'output', ?), finishedAt = ?
          WHERE attemptId = ? AND resultJson IS NULL
        `).run(JSON.stringify({ status: "not_executed", error: reasons[completion.status] }), now, id);
      }
      this.database.prepare(`
        UPDATE threads SET updatedAt = ? WHERE id = (SELECT threadId FROM turns WHERE id = ?)
      `).run(now, row.turnId);
      return decodeAttempt(row);
    })();
  }

  private registerToolCalls(id: string, outputs: CompletedOutput[], now: number): void {
    const existing = this.listToolCalls(id);
    for (const { outputIndex, item } of outputs) {
      if (item.type !== "function_call") continue;
      const saved = existing.find((call) => call.outputIndex === outputIndex);
      if (saved) {
        if (saved.callId !== item.call_id) throw new Error("完整输出与工具调用记录不一致。");
      } else {
        this.database.prepare("INSERT INTO tool_calls (id, attemptId, outputIndex, callId, createdAt) VALUES (?, ?, ?, ?, ?)")
          .run(randomUUID(), id, outputIndex, item.call_id, now);
      }
    }
  }

  /** 读取一次请求，包括成功响应或失败诊断；调用方需根据 status 区分用途。 */
  getAttempt(id: string): ModelAttempt | undefined {
    const row = this.database.prepare<[string], AttemptRow>("SELECT * FROM model_attempts WHERE id = ?").get(id);
    return row ? decodeAttempt(row) : undefined;
  }

  /** 按轮次内顺序分页读取尝试，包含失败重试记录，不把诊断记录伪装为成功历史。 */
  listAttempts(turnId: string, afterSequence = 0, limit = 50): ModelAttempt[] {
    validatePagination(limit, afterSequence);
    return this.database.prepare<[string, number, number], AttemptRow>(`
      SELECT * FROM model_attempts WHERE turnId = ? AND sequence > ? ORDER BY sequence LIMIT ?
    `).all(turnId, afterSequence, limit).map(decodeAttempt);
  }

  /** 按模型输出顺序读取调用及结果；未记录结果的调用保留为 null，不能当成成功。 */
  listToolCalls(attemptId: string): StoredToolCall[] {
    return this.database.prepare<[string], ToolCallRow>(`
      SELECT * FROM tool_calls WHERE attemptId = ? ORDER BY outputIndex
    `).all(attemptId).map(decodeToolCall);
  }

  /** 记录实际执行起点；登记工具意图和等待前一个工具不算执行耗时。 */
  startTool(executionId: string): void {
    const result = this.database.prepare(`
      UPDATE tool_calls SET startedAt = ? WHERE id = ? AND startedAt IS NULL AND resultJson IS NULL
        AND EXISTS (SELECT 1 FROM model_attempts JOIN turns ON turns.id = model_attempts.turnId
          WHERE model_attempts.id = tool_calls.attemptId AND model_attempts.status = 'completed' AND turns.status = 'running')
    `).run(Date.now(), executionId);
    if (result.changes !== 1) throw new Error("工具调用不存在、已开始执行或已有结果。");
  }

  /** 按本地执行 id 保存匹配的 SDK 结果，结果只能写入一次；允许为中断轮次补录核实后的结果。 */
  saveToolResult(executionId: string, result: ToolResult, durationMs: number | null = null): StoredToolCall {
    if (result.type !== "function_call_output" || typeof result.call_id !== "string" || !result.call_id.trim()) {
      throw new Error("工具结果必须是带有 call_id 的 function_call_output。");
    }
    const row = this.database.prepare<[string, number, number | null, string, string], ToolCallRow>(`
      UPDATE tool_calls SET resultJson = ?, finishedAt = ?, durationMs = ?
      WHERE id = ? AND callId = ? AND resultJson IS NULL RETURNING *
    `).get(JSON.stringify(result), Date.now(), durationMs, executionId, result.call_id);
    if (!row) {
      throw new Error("工具调用不存在、call_id 不匹配，或结果已保存。");
    }
    return decodeToolCall(row);
  }
}

/** 恢复完整 SDK 响应；数据库中的 JSON 损坏时直接报错，不丢弃历史或填充假响应。 */
function decodeAttempt(row: AttemptRow): ModelAttempt {
  const { responseJson, reasoningTimingsJson, completedOutputsJson, ...attempt } = row;
  const response = responseJson === null ? null : JSON.parse(responseJson) as ModelAttempt["response"];
  // 完整成功响应本身已是可靠快照，不在数据库重复保存整份正文。
  const completedOutputs = attempt.status === "completed" && response
    ? response.output.map((item, outputIndex) => ({ item, outputIndex })) : JSON.parse(completedOutputsJson) as CompletedOutput[];
  return { ...attempt, response, reasoningTimings: JSON.parse(reasoningTimingsJson), completedOutputs };
}

/** 恢复完整 SDK 工具结果，保留 output 字符串和原始 call_id。 */
function decodeToolCall(row: ToolCallRow): StoredToolCall {
  const { resultJson, ...call } = row;
  return { ...call, result: resultJson === null ? null : JSON.parse(resultJson) };
}
