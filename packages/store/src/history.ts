import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import type { AttemptCompletion, ModelAttempt, StoredToolCall, ToolResult } from "./history-types.ts";
import { validatePagination } from "./pagination.ts";

/** 数据库中的请求记录；完整 SDK 响应以 JSON 保存。 */
type AttemptRow = Omit<ModelAttempt, "response"> & { responseJson: string | null };

/** 数据库中的工具记录；完整 SDK 结果以 JSON 保存。 */
type ToolCallRow = Omit<StoredToolCall, "result"> & { resultJson: string | null };

/** 模型请求与工具结果的持久化接口；共享 Store 的数据库连接，不调度模型或工具。 */
export class ModelHistoryStore {
  private readonly database: Database.Database;

  /** 使用 Store 已打开的连接；连接生命周期仍由 Store 管理。 */
  constructor(database: Database.Database) {
    this.database = database;
  }

  /** 开始一次请求，绑定当前轮次的输入边界；前次工具结果未补齐时不能发起下一次请求。 */
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
        WHERE turns.threadId = ? AND tool_calls.resultJson IS NULL LIMIT 1
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

  /** 原子保存请求终态及工具意图；只为成功响应登记调用，不修改原始响应或解析参数。 */
  finishAttempt(id: string, completion: AttemptCompletion): ModelAttempt {
    const response = completion.response ?? null;
    const error = completion.error ?? null;
    if (completion.status === "completed" && (response?.status !== "completed" || error !== null)) {
      throw new Error("成功尝试必须提供成功响应，且不能包含本地错误。");
    }
    return this.database.transaction(() => {
      const now = Date.now();
      const row = this.database.prepare<[string, string | null, string | null, number, string], AttemptRow>(`
        UPDATE model_attempts SET status = ?, responseJson = ?, error = ?, finishedAt = ?
        WHERE id = ? AND status = 'running'
          AND EXISTS (SELECT 1 FROM turns WHERE turns.id = model_attempts.turnId AND turns.status = 'running')
        RETURNING *
      `).get(completion.status, response === null ? null : JSON.stringify(response), error, now, id);
      if (!row) {
        throw new Error("请求尝试不存在或已结束，或所属轮次已结束。");
      }
      if (completion.status === "completed" && response) {
        const insert = this.database.prepare(`
          INSERT INTO tool_calls (id, attemptId, outputIndex, callId, createdAt) VALUES (?, ?, ?, ?, ?)
        `);
        for (const [index, item] of response.output.entries()) {
          if (item.type === "function_call") {
            insert.run(randomUUID(), id, index, item.call_id, now);
          }
        }
      }
      this.database.prepare(`
        UPDATE threads SET updatedAt = ? WHERE id = (SELECT threadId FROM turns WHERE id = ?)
      `).run(now, row.turnId);
      return decodeAttempt(row);
    })();
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

  /** 按本地执行 id 保存匹配的 SDK 结果，结果只能写入一次；允许为中断轮次补录核实后的结果。 */
  saveToolResult(executionId: string, result: ToolResult): StoredToolCall {
    if (result.type !== "function_call_output" || typeof result.call_id !== "string" || !result.call_id.trim()) {
      throw new Error("工具结果必须是带有 call_id 的 function_call_output。");
    }
    const row = this.database.prepare<[string, number, string, string], ToolCallRow>(`
      UPDATE tool_calls SET resultJson = ?, finishedAt = ?
      WHERE id = ? AND callId = ? AND resultJson IS NULL RETURNING *
    `).get(JSON.stringify(result), Date.now(), executionId, result.call_id);
    if (!row) {
      throw new Error("工具调用不存在、call_id 不匹配，或结果已保存。");
    }
    return decodeToolCall(row);
  }
}

/** 恢复完整 SDK 响应；数据库中的 JSON 损坏时直接报错，不丢弃历史或填充假响应。 */
function decodeAttempt(row: AttemptRow): ModelAttempt {
  const { responseJson, ...attempt } = row;
  return { ...attempt, response: responseJson === null ? null : JSON.parse(responseJson) };
}

/** 恢复完整 SDK 工具结果，保留 output 字符串和原始 call_id。 */
function decodeToolCall(row: ToolCallRow): StoredToolCall {
  const { resultJson, ...call } = row;
  return { ...call, result: resultJson === null ? null : JSON.parse(resultJson) };
}
