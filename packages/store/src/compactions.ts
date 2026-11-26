import type Database from "better-sqlite3";
import type { CompactionView, TurnInput } from "@tilot/protocol";

export type RetainedInput = Pick<TurnInput, "content" | "images">;

/** 不含请求边界时覆盖整轮。部分覆盖时，该轮的用户原话仍参与回放。 */
export interface HistoryPosition {
  throughSequence: number;
  throughAttempt?: number;
}

/** 原始记录仍由聊天历史保存。 */
export interface ContextCheckpoint extends HistoryPosition {
  summary: string;
  retainedInputs: RetainedInput[];
}

export interface CompactionUsage { inputTokens: number; outputTokens: number }

const viewColumns = "id, threadId, status, error, createdAt, finishedAt";

export class CompactionStore {
  private readonly database: Database.Database;

  constructor(database: Database.Database) { this.database = database; }

  latest(threadId: string, kind?: "manual" | "automatic"): CompactionView | undefined {
    return this.database.prepare<[string, string | null], CompactionView>(`
      SELECT ${viewColumns} FROM context_compactions WHERE threadId = ? AND kind = COALESCE(?, kind)
      ORDER BY id DESC LIMIT 1
    `).get(threadId, kind ?? null);
  }

  checkpoint(threadId: string): ContextCheckpoint | undefined {
    const row = this.database.prepare<[string], { checkpointJson: string }>(`
      SELECT checkpointJson FROM context_compactions WHERE threadId = ? AND status = 'completed' ORDER BY id DESC LIMIT 1
    `).get(threadId);
    return row ? JSON.parse(row.checkpointJson) : undefined;
  }

  start(threadId: string, stopping: boolean, kind: "manual" | "automatic" = "manual"): CompactionView {
    return this.database.prepare<[string, string, string, number], CompactionView>(`
      INSERT INTO context_compactions (threadId, status, kind, createdAt) VALUES (?, ?, ?, ?) RETURNING ${viewColumns}
    `).get(threadId, stopping ? "stopping" : "running", kind, Date.now())!;
  }

  begin(id: number): CompactionView {
    const result = this.database.prepare<[number], CompactionView>(`
      UPDATE context_compactions SET status = 'running' WHERE id = ? AND status = 'stopping' RETURNING ${viewColumns}
    `).get(id);
    if (!result) throw new Error("找不到等待开始的上下文压缩。");
    return result;
  }

  finish(id: number, result: { checkpoint: ContextCheckpoint; usage: CompactionUsage | null } |
    { status: "failed" | "interrupted"; error: string; usage?: CompactionUsage | null }): CompactionView {
    const success = "checkpoint" in result;
    const updated = this.database.prepare<[string, number, string | null, string | null, string | null, number], CompactionView>(`
      UPDATE context_compactions SET status = ?, finishedAt = ?, error = ?, checkpointJson = ?, usageJson = ?
      WHERE id = ? AND status IN ('stopping', 'running') RETURNING ${viewColumns}
    `).get(success ? "completed" : result.status, Date.now(), success ? null : result.error,
      success ? JSON.stringify(result.checkpoint) : null, result.usage ? JSON.stringify(result.usage) : null, id);
    if (!updated) throw new Error("上下文压缩已经结束或不存在。");
    return updated;
  }

  recover(): void {
    this.database.prepare(`
      UPDATE context_compactions SET status = 'interrupted', finishedAt = ?, error = '应用退出，压缩未完成。'
      WHERE status IN ('stopping', 'running')
    `).run(Date.now());
  }
}
