import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { TestContext } from "node:test";
import type Database from "better-sqlite3";

/** 把测试数据库退回版本 5 的结构：default 服务的模型回到 models 表，恢复全局 baseURL，删除服务表和任务的服务列。 */
export function downgradeToVersion5(database: Database.Database): void {
  database.exec(`
    ALTER TABLE model_attempts DROP COLUMN firstTokenMs;
    ALTER TABLE model_attempts DROP COLUMN durationMs;
    CREATE TABLE models (
      id TEXT PRIMARY KEY CHECK (length(trim(id)) > 0),
      contextTokens INTEGER NOT NULL CHECK (contextTokens > 0)
    ) STRICT;
    INSERT INTO models (id, contextTokens) SELECT id, contextTokens FROM provider_models WHERE providerId = 'default' ORDER BY rowid;
    ALTER TABLE app_config ADD COLUMN baseURL TEXT NOT NULL DEFAULT '';
    UPDATE app_config SET baseURL = (SELECT baseURL FROM providers WHERE id = 'default');
    ALTER TABLE app_config DROP COLUMN providerId;
    ALTER TABLE threads DROP COLUMN providerId;
    DROP TABLE provider_models;
    DROP TABLE providers;
    PRAGMA user_version = 5;
  `);
}

/** 把测试数据库退回版本 4 的结构：配置恢复全局最大上下文（取默认模型的值），删除模型表和任务的模型列。 */
export function downgradeToVersion4(database: Database.Database): void {
  downgradeToVersion5(database);
  database.exec(`
    CREATE TABLE app_config_v4 (
      id INTEGER PRIMARY KEY CHECK (id = 1), baseURL TEXT NOT NULL, model TEXT NOT NULL, reasoningEffort TEXT NOT NULL,
      contextBudgetTokens INTEGER NOT NULL, maxOutputTokens INTEGER NOT NULL, reserveTokens INTEGER NOT NULL,
      maxStepsPerRun INTEGER NOT NULL, maxAutomaticRetries INTEGER NOT NULL
    ) STRICT;
    INSERT INTO app_config_v4 SELECT id, baseURL, model, reasoningEffort,
      (SELECT contextTokens FROM models WHERE models.id = app_config.model),
      maxOutputTokens, reserveTokens, maxStepsPerRun, maxAutomaticRetries FROM app_config;
    DROP TABLE app_config;
    ALTER TABLE app_config_v4 RENAME TO app_config;
    DROP TABLE models;
    ALTER TABLE threads DROP COLUMN model;
    ALTER TABLE threads DROP COLUMN reasoningEffort;
    PRAGMA user_version = 4;
  `);
}

/** 创建测试专用数据目录并注册清理；调用方须在清理前关闭数据库连接。 */
export function temporaryDirectory(context: TestContext): string {
  const directory = mkdtempSync(join(tmpdir(), "tilot-store-test-"));
  context.after(() => {
    assert.equal(dirname(directory), resolve(tmpdir()));
    rmSync(directory, { recursive: true, force: true });
  });
  return directory;
}
