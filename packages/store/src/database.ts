import type Database from "better-sqlite3";
import { DEFAULT_CONFIG } from "./config.ts";

/** 按数据库版本依次升级结构；建表、默认数据和版本号在同一事务中提交。 */
export function migrateDatabase(database: Database.Database): void {
  database.transaction(() => {
    const version = database.pragma("user_version", { simple: true });
    if (typeof version !== "number" || !Number.isInteger(version) || version < 0 || version > 19) {
      throw new Error("不支持此数据库版本，请使用匹配的 Tilot 版本。");
    }
    if (version === 0) {
      database.exec(`
        CREATE TABLE app_config (
          id INTEGER PRIMARY KEY CHECK (id = 1),
          baseURL TEXT NOT NULL CHECK (length(trim(baseURL)) > 0),
          model TEXT NOT NULL CHECK (length(trim(model)) > 0),
          reasoningEffort TEXT NOT NULL CHECK (reasoningEffort IN ('none', 'low', 'high', 'max')),
          contextBudgetTokens INTEGER NOT NULL CHECK (contextBudgetTokens > 0),
          maxOutputTokens INTEGER NOT NULL CHECK (maxOutputTokens > 0),
          reserveTokens INTEGER NOT NULL CHECK (reserveTokens >= 0),
          maxStepsPerRun INTEGER NOT NULL CHECK (maxStepsPerRun > 0),
          maxAutomaticRetries INTEGER NOT NULL CHECK (maxAutomaticRetries >= 0),
          CHECK (maxOutputTokens + reserveTokens < contextBudgetTokens)
        ) STRICT;
      `);
      // 初始旧结构沿用当时的默认值，后续迁移移除请求次数与 Token 限制。
      database.prepare(`
        INSERT INTO app_config VALUES (
          1, @baseURL, @model, @reasoningEffort, @contextBudgetTokens,
          @maxOutputTokens, @reserveTokens, @maxStepsPerRun, @maxAutomaticRetries
        )
      `).run({ ...DEFAULT_CONFIG, baseURL: DEFAULT_CONFIG.providers[0]!.baseURL,
        contextBudgetTokens: 65536, maxOutputTokens: 16384, reserveTokens: 4096, maxStepsPerRun: 30 });
      database.pragma("user_version = 1");
    }
    if (version < 2) {
      database.exec(`
        CREATE TABLE threads (
          id TEXT PRIMARY KEY,
          title TEXT NOT NULL CHECK (length(trim(title)) > 0),
          projectPath TEXT,
          createdAt INTEGER NOT NULL,
          updatedAt INTEGER NOT NULL
        ) STRICT;
        CREATE INDEX threads_recent ON threads (updatedAt DESC, id DESC);
      `);
      database.pragma("user_version = 2");
    }
    if (version < 3) {
      database.exec(`
        CREATE TABLE turns (
          id TEXT PRIMARY KEY,
          threadId TEXT NOT NULL REFERENCES threads(id),
          sequence INTEGER NOT NULL CHECK (sequence > 0),
          status TEXT NOT NULL CHECK (status IN ('running', 'completed', 'failed', 'cancelled', 'interrupted')),
          createdAt INTEGER NOT NULL,
          finishedAt INTEGER,
          error TEXT,
          UNIQUE (threadId, sequence),
          CHECK ((status = 'running' AND finishedAt IS NULL) OR (status != 'running' AND finishedAt IS NOT NULL)),
          CHECK ((status = 'failed' AND error IS NOT NULL) OR (status != 'failed' AND error IS NULL))
        ) STRICT;
        CREATE UNIQUE INDEX turns_one_running ON turns (threadId) WHERE status = 'running';
        CREATE TABLE turn_inputs (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          turnId TEXT NOT NULL REFERENCES turns(id),
          content TEXT NOT NULL,
          createdAt INTEGER NOT NULL
        ) STRICT;
        CREATE INDEX turn_inputs_order ON turn_inputs (turnId, id);
      `);
      database.pragma("user_version = 3");
    }
    if (version < 4) {
      database.exec(`
        CREATE TABLE model_attempts (
          id TEXT PRIMARY KEY,
          turnId TEXT NOT NULL REFERENCES turns(id),
          sequence INTEGER NOT NULL CHECK (sequence > 0),
          inputThroughId INTEGER NOT NULL REFERENCES turn_inputs(id),
          status TEXT NOT NULL CHECK (status IN ('running', 'completed', 'failed', 'incomplete', 'cancelled', 'interrupted')),
          responseJson TEXT CHECK (responseJson IS NULL OR json_valid(responseJson)),
          error TEXT,
          createdAt INTEGER NOT NULL,
          finishedAt INTEGER,
          UNIQUE (turnId, sequence),
          CHECK ((status = 'running' AND finishedAt IS NULL) OR (status != 'running' AND finishedAt IS NOT NULL)),
          CHECK (status != 'completed' OR (responseJson IS NOT NULL AND error IS NULL))
        ) STRICT;
        CREATE UNIQUE INDEX model_attempts_one_running ON model_attempts (turnId) WHERE status = 'running';
        CREATE TABLE tool_calls (
          id TEXT PRIMARY KEY,
          attemptId TEXT NOT NULL REFERENCES model_attempts(id),
          outputIndex INTEGER NOT NULL CHECK (outputIndex >= 0),
          callId TEXT NOT NULL CHECK (length(trim(callId)) > 0),
          resultJson TEXT CHECK (resultJson IS NULL OR json_valid(resultJson)),
          createdAt INTEGER NOT NULL,
          finishedAt INTEGER,
          UNIQUE (attemptId, outputIndex),
          UNIQUE (attemptId, callId),
          CHECK ((resultJson IS NULL AND finishedAt IS NULL) OR (resultJson IS NOT NULL AND finishedAt IS NOT NULL))
        ) STRICT;
      `);
      database.pragma("user_version = 4");
    }
    if (version < 5) {
      // 最大上下文改为按模型保存；任务记住自己的模型和思考强度，已有任务沿用当前全局设置。
      // app_config 的 CHECK 引用了 contextBudgetTokens，不能直接删除该列，只能重建表。
      database.exec(`
        CREATE TABLE models (
          id TEXT PRIMARY KEY CHECK (length(trim(id)) > 0),
          contextTokens INTEGER NOT NULL CHECK (contextTokens > 0)
        ) STRICT;
        INSERT INTO models (id, contextTokens) SELECT model, contextBudgetTokens FROM app_config;
        ALTER TABLE threads ADD COLUMN model TEXT NOT NULL DEFAULT '';
        ALTER TABLE threads ADD COLUMN reasoningEffort TEXT NOT NULL DEFAULT 'high'
          CHECK (reasoningEffort IN ('none', 'low', 'high', 'max'));
        UPDATE threads SET model = (SELECT model FROM app_config), reasoningEffort = (SELECT reasoningEffort FROM app_config);
        CREATE TABLE app_config_v5 (
          id INTEGER PRIMARY KEY CHECK (id = 1),
          baseURL TEXT NOT NULL CHECK (length(trim(baseURL)) > 0),
          model TEXT NOT NULL CHECK (length(trim(model)) > 0),
          reasoningEffort TEXT NOT NULL CHECK (reasoningEffort IN ('none', 'low', 'high', 'max')),
          maxOutputTokens INTEGER NOT NULL CHECK (maxOutputTokens > 0),
          reserveTokens INTEGER NOT NULL CHECK (reserveTokens >= 0),
          maxStepsPerRun INTEGER NOT NULL CHECK (maxStepsPerRun > 0),
          maxAutomaticRetries INTEGER NOT NULL CHECK (maxAutomaticRetries >= 0)
        ) STRICT;
        INSERT INTO app_config_v5 SELECT id, baseURL, model, reasoningEffort, maxOutputTokens, reserveTokens, maxStepsPerRun, maxAutomaticRetries FROM app_config;
        DROP TABLE app_config;
        ALTER TABLE app_config_v5 RENAME TO app_config;
      `);
      database.pragma("user_version = 5");
    }
    if (version < 6) {
      // 支持多个服务：原来的地址和模型成为 id 为 default 的服务，名称取地址的域名；
      // 模型挂在服务下，任务和默认设置都额外记住服务。旧凭据文件由 CredentialStore 按 default 读取。
      const { baseURL } = database.prepare<[], { baseURL: string }>("SELECT baseURL FROM app_config").get()!;
      database.exec(`
        CREATE TABLE providers (
          id TEXT PRIMARY KEY CHECK (length(trim(id)) > 0),
          name TEXT NOT NULL CHECK (length(trim(name)) > 0),
          baseURL TEXT NOT NULL CHECK (length(trim(baseURL)) > 0)
        ) STRICT;
        CREATE TABLE provider_models (
          providerId TEXT NOT NULL REFERENCES providers(id),
          id TEXT NOT NULL CHECK (length(trim(id)) > 0),
          contextTokens INTEGER NOT NULL CHECK (contextTokens > 0),
          PRIMARY KEY (providerId, id)
        ) STRICT;
      `);
      database.prepare("INSERT INTO providers (id, name, baseURL) VALUES ('default', ?, ?)").run(new URL(baseURL).hostname, baseURL);
      database.exec(`
        INSERT INTO provider_models (providerId, id, contextTokens) SELECT 'default', id, contextTokens FROM models ORDER BY rowid;
        DROP TABLE models;
        ALTER TABLE threads ADD COLUMN providerId TEXT NOT NULL DEFAULT 'default';
        ALTER TABLE app_config ADD COLUMN providerId TEXT NOT NULL DEFAULT 'default';
        ALTER TABLE app_config DROP COLUMN baseURL;
      `);
      database.pragma("user_version = 6");
    }
    if (version < 7) {
      database.exec(`
        ALTER TABLE model_attempts ADD COLUMN firstTokenMs REAL CHECK (firstTokenMs >= 0);
        ALTER TABLE model_attempts ADD COLUMN durationMs REAL CHECK (durationMs >= 0);
      `);
      database.pragma("user_version = 7");
    }
    if (version < 8) {
      database.exec("ALTER TABLE app_config DROP COLUMN maxStepsPerRun;");
      database.pragma("user_version = 8");
    }
    if (version < 9) {
      database.exec(`
        ALTER TABLE app_config DROP COLUMN maxOutputTokens;
        ALTER TABLE app_config DROP COLUMN reserveTokens;
        ALTER TABLE provider_models DROP COLUMN contextTokens;
      `);
      database.pragma("user_version = 9");
    }
    if (version < 10) {
      database.exec(`
        ALTER TABLE model_attempts ADD COLUMN reasoningTimingsJson TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(reasoningTimingsJson));
        ALTER TABLE tool_calls ADD COLUMN startedAt INTEGER;
        ALTER TABLE tool_calls ADD COLUMN durationMs REAL CHECK (durationMs >= 0);
      `);
      database.pragma("user_version = 10");
    }
    if (version < 11) {
      database.exec(`
        ALTER TABLE app_config ADD COLUMN defaultPermissionMode TEXT NOT NULL DEFAULT 'workspace-write'
          CHECK (defaultPermissionMode IN ('read-only', 'workspace-write', 'full-access'));
        ALTER TABLE threads ADD COLUMN permissionMode TEXT NOT NULL DEFAULT 'read-only'
          CHECK (permissionMode IN ('read-only', 'workspace-write', 'full-access'));
        ALTER TABLE threads ADD COLUMN permissionLockedAt INTEGER;
        UPDATE threads SET permissionMode = 'workspace-write' WHERE projectPath IS NOT NULL;
        UPDATE threads SET permissionLockedAt = (SELECT MIN(createdAt) FROM turns WHERE threadId = threads.id);
        ALTER TABLE turns ADD COLUMN permissionMode TEXT NOT NULL DEFAULT 'read-only'
          CHECK (permissionMode IN ('read-only', 'workspace-write', 'full-access'));
        UPDATE turns SET permissionMode = (SELECT permissionMode FROM threads WHERE id = turns.threadId);
      `);
      database.pragma("user_version = 11");
    }
    if (version < 12) {
      database.exec(`
        ALTER TABLE model_attempts ADD COLUMN completedOutputsJson TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(completedOutputsJson));
      `);
      database.pragma("user_version = 12");
    }
    if (version < 13) {
      database.exec(`
        CREATE TABLE user_questions (
          id TEXT PRIMARY KEY REFERENCES tool_calls(id),
          threadId TEXT NOT NULL REFERENCES threads(id), turnId TEXT NOT NULL REFERENCES turns(id),
          questionsJson TEXT NOT NULL CHECK (json_valid(questionsJson)), draftJson TEXT NOT NULL CHECK (json_valid(draftJson)),
          status TEXT NOT NULL CHECK (status IN ('pending', 'answered', 'closed')),
          inputId INTEGER UNIQUE REFERENCES turn_inputs(id), createdAt INTEGER NOT NULL,
          CHECK ((status = 'answered') = (inputId IS NOT NULL))
        ) STRICT;
        CREATE UNIQUE INDEX questions_one_pending ON user_questions (threadId) WHERE status = 'pending';
      `);
      database.pragma("user_version = 13");
    }
    if (version < 14) {
      database.exec("ALTER TABLE turn_inputs ADD COLUMN imagesJson TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(imagesJson));");
      database.pragma("user_version = 14");
    }
    if (version < 15) {
      database.exec("ALTER TABLE turn_inputs ADD COLUMN deliveryId TEXT; CREATE UNIQUE INDEX inputs_delivery ON turn_inputs(deliveryId) WHERE deliveryId IS NOT NULL;");
      database.pragma("user_version = 15");
    }
    if (version < 16) {
      database.exec("ALTER TABLE provider_models ADD COLUMN contextTokens INTEGER CHECK (contextTokens > 0);");
      database.pragma("user_version = 16");
    }
    if (version < 17) {
      database.exec("ALTER TABLE threads ADD COLUMN autoTitle INTEGER NOT NULL DEFAULT 0 CHECK (autoTitle IN (0, 1));");
      database.pragma("user_version = 17");
    }
    if (version < 18) {
      database.exec(`
        CREATE TABLE context_compactions (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          threadId TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
          status TEXT NOT NULL CHECK (status IN ('stopping', 'running', 'completed', 'failed', 'interrupted')),
          createdAt INTEGER NOT NULL,
          finishedAt INTEGER,
          error TEXT,
          checkpointJson TEXT CHECK (checkpointJson IS NULL OR json_valid(checkpointJson)),
          usageJson TEXT CHECK (usageJson IS NULL OR json_valid(usageJson)),
          CHECK ((status = 'completed') = (checkpointJson IS NOT NULL)),
          CHECK ((status IN ('stopping', 'running')) = (finishedAt IS NULL))
        ) STRICT;
        CREATE INDEX compactions_latest ON context_compactions (threadId, id DESC);
        CREATE UNIQUE INDEX compactions_one_active ON context_compactions (threadId) WHERE status IN ('stopping', 'running');
      `);
      database.pragma("user_version = 18");
    }
    if (version < 19) {
      database.exec(`
        ALTER TABLE model_attempts ADD COLUMN estimatedInputTokens INTEGER CHECK (estimatedInputTokens >= 0);
        ALTER TABLE context_compactions ADD COLUMN kind TEXT NOT NULL DEFAULT 'manual' CHECK (kind IN ('manual', 'automatic'));
        DROP INDEX compactions_one_active;
        CREATE UNIQUE INDEX compactions_one_active ON context_compactions (threadId, kind) WHERE status IN ('stopping', 'running');
      `);
      database.pragma("user_version = 19");
    }
  }).immediate();
}
