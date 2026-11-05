import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import Database from "better-sqlite3";
import { Store, type AppConfig } from "@tilot/store";
import { downgradeToVersion4, downgradeToVersion5, downgradeToVersion7, downgradeToVersion8, temporaryDirectory } from "./helpers.ts";

/** 在 config 基础上替换 default 服务的地址和模型。 */
function withModels(config: AppConfig, models: AppConfig["providers"][number]["models"], baseURL = config.providers[0]!.baseURL): AppConfig {
  return { ...config, providers: [{ ...config.providers[0]!, baseURL, models }] };
}

test("首次创建默认配置，保存后关闭重开可恢复", (context) => {
  const directory = join(temporaryDirectory(context), "data");
  const store = new Store(directory);
  const original = store.getConfig();
  assert.equal(original.providers[0]!.baseURL, "https://api.deepseek.com");
  const updated = { ...withModels(original, [{ id: "other-model" }, { id: "custom-model" }], "http://localhost:1234/v1"),
    model: "custom-model", providers: [
      ...withModels(original, [{ id: "other-model" }, { id: "custom-model" }], "http://localhost:1234/v1").providers,
      { id: "second", name: "第二个服务", baseURL: "https://second.test/v1", models: [{ id: "custom-model" }] },
    ] };
  try {
    store.saveConfig(updated);
  } finally {
    store.close();
  }
  const reopened = new Store(directory);
  try {
    assert.deepEqual(reopened.getConfig(), updated);
  } finally {
    reopened.close();
  }
});

test("无效地址、服务或模型列表不能覆盖已保存值", (context) => {
  const store = new Store(temporaryDirectory(context));
  try {
    const original = store.getConfig();
    const provider = original.providers[0]!;
    const model = provider.models[0]!;
    for (const config of [
      withModels(original, [model], "not-a-url"), { ...original, model: " " }, { ...original, maxAutomaticRetries: -1 },
      withModels(original, []), { ...original, model: "missing-model" },
      withModels(original, [model, model]), withModels(original, [model, { id: " " }]),
      { ...original, providers: [] }, { ...original, providers: [provider, provider] }, { ...original, providers: [{ ...provider, name: " " }] },
      { ...original, providerId: "missing" },
    ]) {
      assert.throws(() => store.saveConfig(config));
      assert.deepEqual(store.getConfig(), original);
    }
  } finally {
    store.close();
  }
});

test("配置保存只写声明的字段，额外密钥字段不会被持久化", (context) => {
  const directory = temporaryDirectory(context);
  const store = new Store(directory);
  try {
    const config = { ...store.getConfig(), apiKey: "test-only-not-a-real-key" };
    store.saveConfig(config);
  } finally {
    store.close();
  }
  const reopened = new Store(directory);
  try {
    assert.equal("apiKey" in reopened.getConfig(), false);
  } finally {
    reopened.close();
  }
});

test("版本 7 升级移除请求次数配置，保留模型选择、用户输入和请求历史", (context) => {
  const directory = temporaryDirectory(context);
  const store = new Store(directory);
  const config = { ...store.getConfig(), reasoningEffort: "low" as const };
  store.saveConfig(config);
  const thread = store.createThread("原有任务");
  const turn = store.startTurn(thread.id, "保留原文🙂");
  const input = store.listTurnInputs(turn.id)[0]!;
  const attempt = store.history.startAttempt(turn.id, input.id);
  const savedAttempt = store.history.finishAttempt(attempt.id, { status: "failed", error: "原有失败记录" });
  const savedTurn = store.finishTurn(turn.id, "failed", "原有失败记录");
  const savedThread = store.getThread(thread.id)!;
  store.close();
  const legacy = new Database(join(directory, "tilot.sqlite"));
  try {
    downgradeToVersion7(legacy);
    legacy.exec("UPDATE app_config SET maxStepsPerRun = 1;");
  } finally { legacy.close(); }
  const migrated = new Store(directory);
  try {
    assert.deepEqual(migrated.getConfig(), config);
    assert.equal("maxStepsPerRun" in migrated.getConfig(), false);
    assert.deepEqual(migrated.getThread(thread.id), savedThread);
    assert.deepEqual(migrated.getTurn(turn.id), savedTurn);
    assert.deepEqual(migrated.listTurnInputs(turn.id), [input]);
    assert.deepEqual(migrated.history.getAttempt(attempt.id), savedAttempt);
  } finally { migrated.close(); }
  const database = new Database(join(directory, "tilot.sqlite"));
  try {
    assert.equal(database.pragma("user_version", { simple: true }), 15);
    assert.equal(database.prepare<[], { name: string }>("PRAGMA table_info(app_config)").all().some((column) => column.name === "maxStepsPerRun"), false);
  } finally { database.close(); }
});

test("版本 8 升级删除输入和输出 Token 限制，保留服务、任务及请求计时", (context) => {
  const directory = temporaryDirectory(context);
  const store = new Store(directory);
  const config = store.getConfig();
  const thread = store.createThread("升级保留");
  const turn = store.startTurn(thread.id, "保留输入");
  const attempt = store.history.startAttempt(turn.id, store.listTurnInputs(turn.id)[0]!.id);
  const saved = store.history.finishAttempt(attempt.id, { status: "failed", error: "原有失败", firstTokenMs: 200, durationMs: 500 });
  store.finishTurn(turn.id, "failed", "原有失败");
  store.close();
  const legacy = new Database(join(directory, "tilot.sqlite"));
  try {
    downgradeToVersion8(legacy);
    legacy.exec("UPDATE app_config SET maxOutputTokens = 16, reserveTokens = 1; UPDATE provider_models SET contextTokens = 100000;");
  } finally { legacy.close(); }
  const migrated = new Store(directory);
  try {
    assert.deepEqual(migrated.getConfig(), config);
    assert.equal(migrated.getThread(thread.id)?.model, thread.model);
    assert.deepEqual(migrated.history.getAttempt(attempt.id), saved);
    assert.equal(migrated.listTurnInputs(turn.id)[0]!.content, "保留输入");
  } finally { migrated.close(); }
  const database = new Database(join(directory, "tilot.sqlite"));
  try {
    assert.equal(database.pragma("user_version", { simple: true }), 15);
    const configColumns = database.prepare<[], { name: string }>("PRAGMA table_info(app_config)").all().map((column) => column.name);
    assert.ok(!configColumns.includes("maxOutputTokens") && !configColumns.includes("reserveTokens"));
    assert.deepEqual(database.prepare<[], { name: string }>("PRAGMA table_info(provider_models)").all().map((column) => column.name), ["providerId", "id"]);
  } finally { database.close(); }
});

test("版本 4 升级保留模型列表，已有任务沿用当前默认模型和强度", (context) => {
  const directory = temporaryDirectory(context);
  const store = new Store(directory);
  const thread = store.createThread("旧任务");
  store.saveConfig({ ...withModels(store.getConfig(), [{ id: "deepseek-flash" }]), reasoningEffort: "low" });
  store.close();
  const legacy = new Database(join(directory, "tilot.sqlite"));
  try {
    downgradeToVersion4(legacy);
  } finally {
    legacy.close();
  }
  const migrated = new Store(directory);
  try {
    assert.deepEqual(migrated.getConfig().providers[0]!.models, [{ id: "deepseek-flash" }]);
    assert.deepEqual(migrated.getThread(thread.id), { ...thread, reasoningEffort: "low" });
  } finally {
    migrated.close();
  }
});

test("新任务使用默认服务、模型和强度，之后可单独修改；模型必须属于所选服务", (context) => {
  const store = new Store(temporaryDirectory(context));
  try {
    const base = withModels(store.getConfig(), [{ id: "a" }, { id: "b" }]);
    const second = { id: "second", name: "第二个服务", baseURL: "https://second.test", models: [{ id: "c" }] };
    store.saveConfig({ ...base, model: "b", reasoningEffort: "max", providers: [...base.providers, second] });
    const thread = store.createThread("任务");
    assert.equal(thread.providerId, "default");
    assert.equal(thread.model, "b");
    assert.equal(thread.reasoningEffort, "max");
    assert.deepEqual(store.updateThreadModel(thread.id, "second", "c", "none"), { ...thread, providerId: "second", model: "c", reasoningEffort: "none" });
    assert.throws(() => store.updateThreadModel(thread.id, "second", "a", "low"), /模型不在该服务的模型列表中/);
    assert.throws(() => store.updateThreadModel("missing-thread", "default", "a", "low"), /任务不存在/);
    assert.equal(store.getThread(thread.id)!.model, "c");
    // 被任务使用的服务不能删除，未使用的可以删除。
    assert.throws(() => store.saveConfig({ ...base, model: "b" }), /第二个服务 仍被对话使用/);
    store.updateThreadModel(thread.id, "default", "a", "low");
    store.saveConfig({ ...base, model: "b" });
    assert.equal(store.getConfig().providers.length, 1);
  } finally {
    store.close();
  }
});

test("版本 5 升级把原地址和模型变成 default 服务，已有任务使用该服务", (context) => {
  const directory = temporaryDirectory(context);
  const store = new Store(directory);
  const thread = store.createThread("旧任务");
  store.saveConfig(withModels(store.getConfig(), [{ id: "deepseek-flash" }], "https://api.example.test/v1"));
  store.close();
  const legacy = new Database(join(directory, "tilot.sqlite"));
  try {
    downgradeToVersion5(legacy);
  } finally {
    legacy.close();
  }
  const migrated = new Store(directory);
  try {
    assert.deepEqual(migrated.getConfig().providers, [{ id: "default", name: "api.example.test", baseURL: "https://api.example.test/v1",
      models: [{ id: "deepseek-flash" }] }]);
    assert.equal(migrated.getThread(thread.id)!.providerId, "default");
  } finally {
    migrated.close();
  }
});
