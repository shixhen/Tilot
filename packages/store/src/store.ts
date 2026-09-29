import { mkdirSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { isAbsolute, join } from "node:path";
import Database from "better-sqlite3";
import type { AppConfig } from "./config.ts";
import { migrateDatabase } from "./database.ts";
import type { ModelInfo, Provider, ReasoningEffort, Thread } from "@tilot/protocol";
import type { Turn, TurnFinalStatus, TurnInput } from "@tilot/protocol";
import { ModelHistoryStore } from "./history.ts";
import { validatePagination } from "./pagination.ts";
import { CredentialStore, normalizeBaseURL } from "./credentials.ts";
export { acquireServiceLock } from "./service-lock.ts";

export type { AppConfig } from "./config.ts";
export type { Thread } from "@tilot/protocol";
export type { Turn, TurnFinalStatus, TurnInput } from "@tilot/protocol";
/** 任务查询统一返回的列。 */
const THREAD_COLUMNS = "id, title, projectPath, providerId, model, reasoningEffort, createdAt, updatedAt";

export type { AttemptStatus, ModelAttempt, AttemptCompletion, ToolResult, StoredToolCall } from "./history-types.ts";

/** 本地 SQLite 存储；由 Server 创建和关闭，负责配置、任务及对话历史。 */
export class Store {
  private readonly database: Database.Database;
  /** 模型请求和工具结果的存储入口，与配置、任务共用同一数据库。 */
  readonly history: ModelHistoryStore;
  /** 单独文件保存的本地凭据，不随普通配置读取返回。 */
  readonly credentials: CredentialStore;

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
      this.history = new ModelHistoryStore(this.database);
      this.credentials = new CredentialStore(dataDirectory);
    } catch (error) {
      this.database.close();
      throw error;
    }
  }

  /** 读取已保存配置及全部服务和模型（按保存顺序）；数据库缺少配置记录时报告错误，不用默认值掩盖损坏。 */
  getConfig(): AppConfig {
    const config = this.database.prepare<[], Omit<AppConfig, "providers">>(`
      SELECT providerId, model, reasoningEffort, maxOutputTokens, reserveTokens, maxStepsPerRun, maxAutomaticRetries
      FROM app_config WHERE id = 1
    `).get();
    if (!config) {
      throw new Error("数据库缺少应用配置记录。");
    }
    const models = this.database.prepare<[], ModelInfo & { providerId: string }>("SELECT providerId, id, contextTokens FROM provider_models ORDER BY rowid").all();
    const providers = this.database.prepare<[], Omit<Provider, "models">>("SELECT id, name, baseURL FROM providers ORDER BY rowid").all()
      .map((provider) => ({ ...provider, models: models.filter((model) => model.providerId === provider.id).map(({ id, contextTokens }) => ({ id, contextTokens })) }));
    return { ...config, providers };
  }

  /** 校验后整份保存配置并替换服务和模型列表；仍被任务使用的服务不能删除。在同一事务中执行，失败时不会留下部分修改。 */
  saveConfig(config: AppConfig): void {
    const minimum = config.maxOutputTokens + config.reserveTokens;
    if (config.providers.length === 0 || new Set(config.providers.map((provider) => provider.id)).size !== config.providers.length) {
      throw new Error("服务列表不能为空，也不能有重复的服务。");
    }
    for (const provider of config.providers) {
      normalizeBaseURL(provider.baseURL);
      if (!provider.name.trim()) throw new Error("服务名称不能为空。");
      if (new Set(provider.models.map((model) => model.id)).size !== provider.models.length) {
        throw new Error(`${provider.name} 中有重复的模型。`);
      }
      for (const model of provider.models) {
        if (!Number.isInteger(model.contextTokens) || model.contextTokens <= minimum) {
          throw new Error(`${model.id} 的最大上下文必须大于输出上限与预留量之和（${minimum} token）。`);
        }
      }
    }
    if (!config.providers.find((provider) => provider.id === config.providerId)?.models.some((model) => model.id === config.model)) {
      throw new Error("默认模型必须在服务的模型列表中。");
    }
    this.database.transaction(() => {
      const kept = new Set(config.providers.map((provider) => provider.id));
      const removed = this.database.prepare<[], { id: string; name: string }>(`
        SELECT id, name FROM providers WHERE id IN (SELECT providerId FROM threads)
      `).all().filter((provider) => !kept.has(provider.id));
      if (removed.length) {
        throw new Error(`${removed.map((provider) => provider.name).join("、")} 仍被对话使用，不能删除。`);
      }
      const result = this.database.prepare(`
        UPDATE app_config SET
          providerId = @providerId, model = @model, reasoningEffort = @reasoningEffort,
          maxOutputTokens = @maxOutputTokens, reserveTokens = @reserveTokens,
          maxStepsPerRun = @maxStepsPerRun, maxAutomaticRetries = @maxAutomaticRetries
        WHERE id = 1
      `).run(config);
      if (result.changes !== 1) {
        throw new Error("数据库缺少应用配置记录。");
      }
      this.database.prepare("DELETE FROM provider_models").run();
      this.database.prepare("DELETE FROM providers").run();
      const insertProvider = this.database.prepare("INSERT INTO providers (id, name, baseURL) VALUES (?, ?, ?)");
      const insertModel = this.database.prepare("INSERT INTO provider_models (providerId, id, contextTokens) VALUES (?, ?, ?)");
      for (const provider of config.providers) {
        insertProvider.run(provider.id, provider.name.trim(), provider.baseURL);
        for (const model of provider.models) insertModel.run(provider.id, model.id, model.contextTokens);
      }
    })();
  }

  /** 创建任务，服务、模型和思考强度取当前默认值；项目路径应由 Server 验证并解析为真实绝对路径，无项目时传 null。 */
  createThread(title: string, projectPath: string | null = null): Thread {
    if (projectPath !== null && !isAbsolute(projectPath)) {
      throw new Error("任务的项目路径必须是绝对路径。");
    }
    const now = Date.now();
    return this.database.prepare<{ id: string; title: string; projectPath: string | null; now: number }, Thread>(`
      INSERT INTO threads (id, title, projectPath, providerId, model, reasoningEffort, createdAt, updatedAt)
      SELECT @id, @title, @projectPath, providerId, model, reasoningEffort, @now, @now FROM app_config WHERE id = 1
      RETURNING ${THREAD_COLUMNS}
    `).get({ id: randomUUID(), title: title.trim(), projectPath, now })!;
  }

  /** 按 id 读取任务；不存在时返回 undefined，由调用方决定如何向用户展示。 */
  getThread(id: string): Thread | undefined {
    return this.database.prepare<[string], Thread>(`
      SELECT ${THREAD_COLUMNS} FROM threads WHERE id = ?
    `).get(id);
  }

  /** 按最近更新时间分页读取任务；同一时间使用 id 排序，保证排序确定。 */
  listThreads(limit = 50, offset = 0): Thread[] {
    validatePagination(limit, offset);
    return this.database.prepare<[number, number], Thread>(`
      SELECT ${THREAD_COLUMNS} FROM threads
      ORDER BY updatedAt DESC, id DESC LIMIT ? OFFSET ?
    `).all(limit, offset);
  }

  /** 修改任务标题并返回更新后的记录；不会修改项目绑定，不存在的任务报错。 */
  renameThread(id: string, title: string): Thread {
    const thread = this.database.prepare<[string, number, string], Thread>(`
      UPDATE threads SET title = ?, updatedAt = ? WHERE id = ?
      RETURNING ${THREAD_COLUMNS}
    `).get(title.trim(), Date.now(), id);
    if (!thread) {
      throw new Error("任务不存在。");
    }
    return thread;
  }

  /** 修改任务使用的服务、模型和思考强度；模型必须在该服务的模型列表中。不更新最近时间，避免改设置打乱任务顺序。 */
  updateThreadModel(id: string, providerId: string, model: string, reasoningEffort: ReasoningEffort): Thread {
    if (!this.database.prepare("SELECT 1 FROM provider_models WHERE providerId = ? AND id = ?").get(providerId, model)) {
      throw new Error("模型不在该服务的模型列表中。");
    }
    const thread = this.database.prepare<[string, string, ReasoningEffort, string], Thread>(`
      UPDATE threads SET providerId = ?, model = ?, reasoningEffort = ? WHERE id = ?
      RETURNING ${THREAD_COLUMNS}
    `).get(providerId, model, reasoningEffort, id);
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
      const running = this.database.prepare("SELECT 1 FROM model_attempts WHERE turnId = ? AND status = 'running'").get(id);
      if (running) {
        throw new Error("请先结束轮次中仍在运行的模型请求。");
      }
      if (status === "completed") {
        const pending = this.database.prepare(`
          SELECT 1 FROM tool_calls JOIN model_attempts ON model_attempts.id = tool_calls.attemptId
          WHERE model_attempts.turnId = ? AND tool_calls.resultJson IS NULL LIMIT 1
        `).get(id);
        if (pending) {
          throw new Error("工具结果尚未补齐，轮次不能标记为完成。");
        }
      }
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

  /** 由 Server 确认旧执行已停止后调用，中断遗留轮次和请求；不补造工具结果，打开连接不触发恢复。 */
  recoverInterruptedTurns(): number {
    return this.database.transaction(() => {
      const now = Date.now();
      this.database.prepare(`
        UPDATE model_attempts SET status = 'interrupted', finishedAt = ? WHERE status = 'running'
      `).run(now);
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
