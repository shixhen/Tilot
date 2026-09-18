import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import Database from "better-sqlite3";
import { Store } from "@tilot/store";
import { temporaryDirectory } from "./helpers.ts";

test("创建任务、重命名和分页列表可在重启后恢复，项目绑定不变", (context) => {
  const directory = temporaryDirectory(context);
  const store = new Store(directory);
  const project = store.createThread("项目任务", directory);
  const chat = store.createThread("普通对话");
  try {
    const renamed = store.renameThread(project.id, " 修改后的标题 ");
    assert.equal(renamed.title, "修改后的标题");
    assert.equal(renamed.projectPath, directory);
    assert.equal(renamed.createdAt, project.createdAt);
    assert.equal(chat.projectPath, null);
    assert.equal(store.listThreads(1, 0).length, 1);
    assert.notEqual(store.listThreads(1, 0)[0]?.id, store.listThreads(1, 1)[0]?.id);
    assert.deepEqual(store.listThreads(1, 2), []);
  } finally {
    store.close();
  }
  const reopened = new Store(directory);
  try {
    assert.equal(reopened.getThread(project.id)?.title, "修改后的标题");
    assert.equal(reopened.getThread(project.id)?.projectPath, directory);
    assert.deepEqual(reopened.getThread(chat.id), chat);
  } finally {
    reopened.close();
  }
});

test("无效操作不修改任务，不存在的任务不会被自动创建", (context) => {
  const store = new Store(temporaryDirectory(context));
  try {
    const thread = store.createThread("保留的标题");
    assert.throws(() => store.renameThread(thread.id, " "));
    assert.deepEqual(store.getThread(thread.id), thread);
    assert.throws(() => store.createThread(" "));
    assert.throws(() => store.createThread("任务", "relative/path"));
    assert.throws(() => store.listThreads(-1));
    assert.equal(store.getThread("missing"), undefined);
    assert.throws(() => store.renameThread("missing", "标题"), /任务不存在/);
    assert.equal(store.listThreads().length, 1);
  } finally {
    store.close();
  }
});

test("版本 1 数据库升级后保留配置；迁移失败时版本号不会提前更新", (context) => {
  const directory = temporaryDirectory(context);
  const store = new Store(directory);
  const config = { ...store.getConfig(), model: "saved-model" };
  try {
    store.saveConfig(config);
  } finally {
    store.close();
  }
  // 仅在测试目录中恢复旧版结构，模拟已保存配置的版本 1 数据库。
  const legacy = new Database(join(directory, "tilot.sqlite"));
  try {
    legacy.exec("DROP TABLE tool_calls; DROP TABLE model_attempts; DROP TABLE turn_inputs; DROP TABLE turns; DROP TABLE threads; PRAGMA user_version = 1;");
    legacy.exec("CREATE TABLE threads (conflict TEXT);");
    assert.throws(() => new Store(directory));
    assert.equal(legacy.pragma("user_version", { simple: true }), 1);
    legacy.exec("DROP TABLE threads;");
  } finally {
    legacy.close();
  }
  const migrated = new Store(directory);
  try {
    assert.deepEqual(migrated.getConfig(), config);
    const thread = migrated.createThread("升级后创建");
    assert.deepEqual(migrated.getThread(thread.id), thread);
  } finally {
    migrated.close();
  }
});
