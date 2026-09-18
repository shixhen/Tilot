import type Database from "better-sqlite3";
import { DEFAULT_CONFIG } from "./config.ts";

/** 按数据库版本依次升级结构；建表、默认数据和版本号在同一事务中提交。 */
export function migrateDatabase(database: Database.Database): void {
  database.transaction(() => {
    const version = database.pragma("user_version", { simple: true });
    if (typeof version !== "number" || !Number.isInteger(version) || version < 0 || version > 4) {
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
      database.prepare(`
        INSERT INTO app_config VALUES (
          1, @baseURL, @model, @reasoningEffort, @contextBudgetTokens,
          @maxOutputTokens, @reserveTokens, @maxStepsPerRun, @maxAutomaticRetries
        )
      `).run(DEFAULT_CONFIG);
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
  }).immediate();
}
