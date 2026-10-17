import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import Database from "better-sqlite3";
import { Store } from "@tilot/store";
import { temporaryDirectory } from "./helpers.ts";

test("项目对话使用全局默认，普通新对话始终只读，普通对话不能选择项目内修改", (context) => {
  const directory = temporaryDirectory(context);
  const store = new Store(directory);
  try {
    assert.equal(store.getConfig().defaultPermissionMode, "workspace-write");
    assert.equal(store.createThread("项目", directory).permissionMode, "workspace-write");
    store.saveConfig({ ...store.getConfig(), defaultPermissionMode: "full-access" });
    assert.equal(store.createThread("项目", directory).permissionMode, "full-access");
    assert.equal(store.createThread("普通").permissionMode, "read-only");
    assert.equal(store.createThread("普通", null, "full-access").permissionMode, "full-access");
    assert.throws(() => store.createThread("普通", null, "workspace-write"), /权限模式/);
  } finally { store.close(); }
});

test("首次发送后禁止跨只读边界切换，修改与完全访问互换不改变运行轮次快照，重启仍锁定", (context) => {
  const directory = temporaryDirectory(context);
  const store = new Store(directory);
  const thread = store.createThread("项目", directory);
  store.updateThreadPermission(thread.id, "read-only");
  store.updateThreadPermission(thread.id, "workspace-write");
  const first = store.startTurn(thread.id, "发送");
  store.updateThreadPermission(thread.id, "full-access");
  assert.equal(store.getTurn(first.id)?.permissionMode, "workspace-write");
  assert.throws(() => store.updateThreadPermission(thread.id, "read-only"), /首次发送/);
  store.finishTurn(first.id, "failed", "测试失败");
  assert.equal(store.startTurn(thread.id, "下一轮").permissionMode, "full-access");
  const readonly = store.createThread("只读");
  store.lockThreadPermissions(readonly.id);
  assert.throws(() => store.updateThreadPermission(readonly.id, "full-access"), /首次发送/);
  store.close();
  const reopened = new Store(directory);
  try {
    assert.equal(reopened.getThread(thread.id)?.permissionMode, "full-access");
    assert.throws(() => reopened.updateThreadPermission(thread.id, "read-only"), /首次发送/);
    assert.throws(() => reopened.updateThreadPermission(readonly.id, "full-access"), /首次发送/);
  } finally { reopened.close(); }
});

test("版本 10 升级保留历史并锁定已有对话，未发送的对话仍可自由选择", (context) => {
  const directory = temporaryDirectory(context);
  const store = new Store(directory);
  const project = store.createThread("已有项目", directory);
  const chat = store.createThread("已有普通");
  const empty = store.createThread("空项目", directory);
  const turns = [store.startTurn(project.id, "项目输入"), store.startTurn(chat.id, "普通输入")];
  store.close();
  const legacy = new Database(join(directory, "tilot.sqlite"));
  legacy.exec(`ALTER TABLE app_config DROP COLUMN defaultPermissionMode;
    ALTER TABLE threads DROP COLUMN permissionMode; ALTER TABLE threads DROP COLUMN permissionLockedAt;
    ALTER TABLE turns DROP COLUMN permissionMode; PRAGMA user_version = 10;`);
  legacy.close();
  const migrated = new Store(directory);
  try {
    assert.equal(migrated.getThread(project.id)?.permissionMode, "workspace-write");
    assert.equal(migrated.getThread(chat.id)?.permissionMode, "read-only");
    assert.equal(migrated.getThread(project.id)?.permissionLockedAt, turns[0]!.createdAt);
    assert.equal(migrated.getThread(empty.id)?.permissionLockedAt, null);
    assert.throws(() => migrated.updateThreadPermission(chat.id, "full-access"), /首次发送/);
    assert.equal(migrated.updateThreadPermission(empty.id, "read-only").permissionMode, "read-only");
    assert.equal(migrated.listTurnInputs(turns[1]!.id)[0]?.content, "普通输入");
  } finally { migrated.close(); }
});
