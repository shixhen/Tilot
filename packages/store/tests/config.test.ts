import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { Store } from "@tilot/store";
import { temporaryDirectory } from "./helpers.ts";

test("首次创建默认配置，保存后关闭重开可恢复", (context) => {
  const directory = join(temporaryDirectory(context), "data");
  const store = new Store(directory);
  const original = store.getConfig();
  assert.equal(original.baseURL, "https://api.deepseek.com");
  const updated = { ...original, baseURL: "http://localhost:1234/v1", model: "custom-model" };
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

test("无效地址或预算配置不能覆盖已保存值", (context) => {
  const store = new Store(temporaryDirectory(context));
  try {
    const original = store.getConfig();
    for (const patch of [
      { baseURL: "not-a-url" }, { model: " " }, { maxStepsPerRun: 0 },
      { maxOutputTokens: original.contextBudgetTokens }, { maxAutomaticRetries: -1 },
    ]) {
      assert.throws(() => store.saveConfig({ ...original, ...patch }));
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
