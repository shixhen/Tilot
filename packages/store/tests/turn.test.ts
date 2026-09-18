import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import Database from "better-sqlite3";
import { Store } from "@tilot/store";
import { temporaryDirectory } from "./helpers.ts";

test("轮次和补充输入按原文持久化，分页顺序稳定，结束后可开始下一轮", (context) => {
  const directory = temporaryDirectory(context);
  const store = new Store(directory);
  const thread = store.createThread("执行任务");
  const first = store.startTurn(thread.id, "  第一条输入\n保留换行  ");
  try {
    store.appendTurnInput(first.id, "补充要求");
    const inputs = store.listTurnInputs(first.id, 0, 1);
    assert.equal(inputs[0]?.content, "  第一条输入\n保留换行  ");
    assert.equal(store.listTurnInputs(first.id, inputs[0]!.id, 1)[0]?.content, "补充要求");
    const completed = store.finishTurn(first.id, "completed");
    assert.equal(completed.status, "completed");
    assert.equal(completed.error, null);
    assert.equal(store.getThread(thread.id)?.updatedAt, completed.finishedAt);
    const second = store.startTurn(thread.id, "第二轮");
    assert.equal(second.sequence, first.sequence + 1);
    const failed = store.finishTurn(second.id, "failed", "请求失败");
    assert.equal(failed.error, "请求失败");
    assert.deepEqual(store.listTurns(thread.id, 0, 1), [completed]);
    assert.deepEqual(store.listTurns(thread.id, completed.sequence, 1), [failed]);
  } finally {
    store.close();
  }
  const reopened = new Store(directory);
  try {
    assert.equal(reopened.getTurn(first.id)?.status, "completed");
    assert.deepEqual(reopened.listTurnInputs(first.id).map((input) => input.content), ["  第一条输入\n保留换行  ", "补充要求"]);
    assert.equal(reopened.listTurns(thread.id).length, 2);
  } finally {
    reopened.close();
  }
});

test("多个连接共享运行互斥，非法创建整体回滚，已结束轮次不可改写", (context) => {
  const directory = temporaryDirectory(context);
  const store = new Store(directory);
  const other = new Store(directory);
  try {
    const thread = store.createThread("唯一运行轮次");
    assert.throws(() => store.startTurn(thread.id, " \n "), /输入不能为空/);
    assert.deepEqual(store.listTurns(thread.id), []);
    assert.throws(() => store.startTurn("missing-thread", "输入"));
    const turn = store.startTurn(thread.id, "执行");
    assert.equal(turn.sequence, 1);
    assert.throws(() => other.startTurn(thread.id, "不能并行"));
    assert.equal(store.listTurns(thread.id).length, 1);
    assert.equal(store.listTurnInputs(turn.id).length, 1);
    // 其他任务可持有独立轮次；是否实际并行运行由 Core 决定。
    const independent = other.createThread("其他任务");
    assert.equal(other.startTurn(independent.id, "独立输入").status, "running");
    assert.throws(() => store.finishTurn(turn.id, "failed"));
    assert.equal(store.getTurn(turn.id)?.status, "running");
    const cancelled = store.finishTurn(turn.id, "cancelled");
    assert.throws(() => other.finishTurn(turn.id, "completed"), /已结束/);
    assert.throws(() => store.appendTurnInput(turn.id, "结束后补充"), /已结束/);
    assert.deepEqual(store.getTurn(turn.id), cancelled);
    assert.equal(store.getTurn("missing-turn"), undefined);
  } finally {
    other.close();
    store.close();
  }
});

test("显式恢复仅中断遗留运行轮次，保留输入，不改写已完成轮次", (context) => {
  const directory = temporaryDirectory(context);
  const store = new Store(directory);
  const thread = store.createThread("重启恢复");
  const completed = store.startTurn(thread.id, "已完成的输入");
  const finished = store.finishTurn(completed.id, "completed");
  const running = store.startTurn(thread.id, "未完成的输入");
  store.close();
  const reopened = new Store(directory);
  try {
    assert.equal(reopened.getTurn(running.id)?.status, "running");
    assert.equal(reopened.recoverInterruptedTurns(), 1);
    assert.equal(reopened.getTurn(running.id)?.status, "interrupted");
    assert.equal(reopened.listTurnInputs(running.id)[0]?.content, "未完成的输入");
    assert.deepEqual(reopened.getTurn(completed.id), finished);
    assert.equal(reopened.recoverInterruptedTurns(), 0);
    assert.equal(reopened.startTurn(thread.id, "继续任务").sequence, 3);
  } finally {
    reopened.close();
  }
});

test("版本 2 升级保留配置和任务，新增轮次表可用", (context) => {
  const directory = temporaryDirectory(context);
  const store = new Store(directory);
  const thread = store.createThread("旧任务");
  const config = { ...store.getConfig(), model: "saved-model" };
  try {
    store.saveConfig(config);
  } finally {
    store.close();
  }
  // 仅移除测试数据库的新表，恢复版本 2 的真实结构。
  const legacy = new Database(join(directory, "tilot.sqlite"));
  try {
    legacy.exec("DROP TABLE tool_calls; DROP TABLE model_attempts; DROP TABLE turn_inputs; DROP TABLE turns; PRAGMA user_version = 2;");
  } finally {
    legacy.close();
  }
  const migrated = new Store(directory);
  try {
    assert.deepEqual(migrated.getConfig(), config);
    assert.deepEqual(migrated.getThread(thread.id), thread);
    assert.equal(migrated.startTurn(thread.id, "升级后执行").sequence, 1);
  } finally {
    migrated.close();
  }
});
