import { mkdirSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { isAbsolute, join } from "node:path";
import Database from "better-sqlite3";
import type { AppConfig } from "./config.ts";
import { migrateDatabase } from "./database.ts";
import type { Thread } from "./thread.ts";
import type { Turn, TurnFinalStatus, TurnInput } from "./turn.ts";

export type { AppConfig } from "./config.ts";
export type { Thread } from "./thread.ts";
export type { Turn, TurnFinalStatus, TurnInput } from "./turn.ts";

/** 本地 SQLite 存储；由 Server 创建和关闭，负责配置、任务、轮次和用户输入。 */
export class Store {
  private readonly database: Database.Database;

  /** 打开指定绝对目录下的 tilot.sqlite 并迁移结构；初始化失败时关闭连接。 */
  constructor(dataDirectory: string) {
    if (!isAbsolute(dataDirectory)) {
      throw new Error("应用数据目录必须是绝对路径。");
    }
    mkdirSync(dataDirectory, { recursive: true });
    this.database = new Database(join(dataDirectory, "tilot.sqlite"));
    try {
      this.database.pragma("foreign_keys = ON");
      migrateDatabase(this.database);
      this.database.pragma("journal_mode = WAL");
    } catch (error) {
      this.database.close();
      throw error;
    }
  }

  /** 读取已保存配置；数据库缺少配置记录时报告错误，不用默认值掩盖损坏。 */
  getConfig(): AppConfig {
    const config = this.database.prepare<[], AppConfig>(`
      SELECT baseURL, model, reasoningEffort, contextBudgetTokens,
             maxOutputTokens, reserveTokens, maxStepsPerRun, maxAutomaticRetries
      FROM app_config WHERE id = 1
    `).get();
    if (!config) {
      throw new Error("数据库缺少应用配置记录。");
    }
    return config;
  }

  /** 校验服务地址后整份保存配置；单条 UPDATE 保证失败时不会留下部分修改。 */
  saveConfig(config: AppConfig): void {
    const url = new URL(config.baseURL);
    if ((url.protocol !== "http:" && url.protocol !== "https:") || url.username || url.password || url.search || url.hash) {
      throw new Error("模型服务地址必须使用 HTTP/HTTPS，且不能包含凭据、查询参数或片段。");
    }
    const result = this.database.prepare(`
      UPDATE app_config SET
        baseURL = @baseURL, model = @model, reasoningEffort = @reasoningEffort,
        contextBudgetTokens = @contextBudgetTokens, maxOutputTokens = @maxOutputTokens,
        reserveTokens = @reserveTokens, maxStepsPerRun = @maxStepsPerRun,
        maxAutomaticRetries = @maxAutomaticRetries
      WHERE id = 1
    `).run(config);
    if (result.changes !== 1) {
      throw new Error("数据库缺少应用配置记录。");
    }
  }

  /** 创建任务；项目路径应由 Server 验证并解析为真实绝对路径，无项目时传 null。 */
  createThread(title: string, projectPath: string | null = null): Thread {
    if (projectPath !== null && !isAbsolute(projectPath)) {
      throw new Error("任务的项目路径必须是绝对路径。");
    }
    const now = Date.now();
    const thread: Thread = {
      id: randomUUID(), title: title.trim(), projectPath, createdAt: now, updatedAt: now,
    };
    this.database.prepare(`
      INSERT INTO threads (id, title, projectPath, createdAt, updatedAt)
      VALUES (@id, @title, @projectPath, @createdAt, @updatedAt)
    `).run(thread);
    return thread;
  }

  /** 按 id 读取任务；不存在时返回 undefined，由调用方决定如何向用户展示。 */
  getThread(id: string): Thread | undefined {
    return this.database.prepare<[string], Thread>(`
      SELECT id, title, projectPath, createdAt, updatedAt FROM threads WHERE id = ?
    `).get(id);
  }

  /** 按最近更新时间分页读取任务；同一时间使用 id 排序，保证排序确定。 */
  listThreads(limit = 50, offset = 0): Thread[] {
    validatePagination(limit, offset);
    return this.database.prepare<[number, number], Thread>(`
      SELECT id, title, projectPath, createdAt, updatedAt FROM threads
      ORDER BY updatedAt DESC, id DESC LIMIT ? OFFSET ?
    `).all(limit, offset);
  }

  /** 修改任务标题并返回更新后的记录；不会修改项目绑定，不存在的任务报错。 */
  renameThread(id: string, title: string): Thread {
    const thread = this.database.prepare<[string, number, string], Thread>(`
      UPDATE threads SET title = ?, updatedAt = ? WHERE id = ?
      RETURNING id, title, projectPath, createdAt, updatedAt
    `).get(title.trim(), Date.now(), id);
    if (!thread) {
      throw new Error("任务不存在。");
    }
    return thread;
  }

  /** 原子创建运行中的轮次及首条输入；同一任务的运行中轮次由数据库唯一索引限制。 */
  startTurn(threadId: string, input: string): Turn {
    return this.database.transaction(() => {
      const turn = this.database.prepare<{ id: string; threadId: string; createdAt: number }, Turn>(`
        INSERT INTO turns (id, threadId, sequence, status, createdAt)
        VALUES (@id, @threadId,
          (SELECT COALESCE(MAX(sequence), 0) + 1 FROM turns WHERE threadId = @threadId),
          'running', @createdAt)
        RETURNING id, threadId, sequence, status, createdAt, finishedAt, error
      `).get({ id: randomUUID(), threadId, createdAt: Date.now() })!;
      this.appendTurnInput(turn.id, input);
      return turn;
    }).immediate();
  }

  /** 按 id 读取轮次；不存在时返回 undefined，不创建隐含轮次。 */
  getTurn(id: string): Turn | undefined {
    return this.database.prepare<[string], Turn>(`
      SELECT id, threadId, sequence, status, createdAt, finishedAt, error FROM turns WHERE id = ?
    `).get(id);
  }

  /** 按任务内顺序分页读取轮次；下一页传入本页最后一个 sequence，避免时间戳相同导致乱序。 */
  listTurns(threadId: string, afterSequence = 0, limit = 50): Turn[] {
    validatePagination(limit, afterSequence);
    return this.database.prepare<[string, number, number], Turn>(`
      SELECT id, threadId, sequence, status, createdAt, finishedAt, error FROM turns
      WHERE threadId = ? AND sequence > ? ORDER BY sequence LIMIT ?
    `).all(threadId, afterSequence, limit);
  }

  /** 向运行中的轮次追加用户输入并更新任务时间；保存原文，不在此决定何时发送给模型。 */
  appendTurnInput(turnId: string, content: string): TurnInput {
    if (!content.trim()) {
      throw new Error("用户输入不能为空。");
    }
    return this.database.transaction(() => {
      const input = this.database.prepare<[string, number, string], TurnInput>(`
        INSERT INTO turn_inputs (turnId, content, createdAt)
        SELECT id, ?, ? FROM turns WHERE id = ? AND status = 'running'
        RETURNING id, turnId, content, createdAt
      `).get(content, Date.now(), turnId);
      if (!input) {
        throw new Error("轮次不存在或已结束，不能追加输入。");
      }
      this.database.prepare(`
        UPDATE threads SET updatedAt = ? WHERE id = (SELECT threadId FROM turns WHERE id = ?)
      `).run(input.createdAt, turnId);
      return input;
    })();
  }

  /** 按保存顺序分页读取用户输入；下一页传入本页最后一个 id，不修改原始内容。 */
  listTurnInputs(turnId: string, afterId = 0, limit = 50): TurnInput[] {
    validatePagination(limit, afterId);
    return this.database.prepare<[string, number, number], TurnInput>(`
      SELECT id, turnId, content, createdAt FROM turn_inputs
      WHERE turnId = ? AND id > ? ORDER BY id LIMIT ?
    `).all(turnId, afterId, limit);
  }

  /** 结束运行中的轮次；失败需提供错误信息，已结束的轮次不能被再次改写。 */
  finishTurn(id: string, status: TurnFinalStatus, error: string | null = null): Turn {
    return this.database.transaction(() => {
      const turn = this.database.prepare<[TurnFinalStatus, number, string | null, string], Turn>(`
        UPDATE turns SET status = ?, finishedAt = ?, error = ? WHERE id = ? AND status = 'running'
        RETURNING id, threadId, sequence, status, createdAt, finishedAt, error
      `).get(status, Date.now(), error, id);
      if (!turn) {
        throw new Error("轮次不存在或已结束。");
      }
      this.database.prepare("UPDATE threads SET updatedAt = ? WHERE id = ?").run(turn.finishedAt, turn.threadId);
      return turn;
    })();
  }

  /** 由 Server 确认旧执行已停止后调用，标记遗留轮次为中断；打开连接本身不会触发恢复。 */
  recoverInterruptedTurns(): number {
    return this.database.transaction(() => {
      const now = Date.now();
      this.database.prepare(`
        UPDATE threads SET updatedAt = ? WHERE id IN (SELECT threadId FROM turns WHERE status = 'running')
      `).run(now);
      return this.database.prepare(`
        UPDATE turns SET status = 'interrupted', finishedAt = ? WHERE status = 'running'
      `).run(now).changes;
    }).immediate();
  }

  /** 释放 SQLite 连接，由 Server 在应用退出时调用。 */
  close(): void {
    this.database.close();
  }
}

/** 检查列表页大小和起始位置；位置可表示偏移量或递增记录游标。 */
function validatePagination(limit: number, position: number): void {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100 || !Number.isSafeInteger(position) || position < 0) {
    throw new Error("每页需为 1 至 100 条，起始位置需为非负整数。");
  }
}
