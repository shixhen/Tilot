import assert from "node:assert/strict";
import { readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { Store } from "@tilot/store";
import { temporaryDirectory } from "./helpers.ts";

test("按服务保存多把密钥，重开可读取，仅匹配保存时的地址，retain 删除已移除服务的密钥", (context) => {
  const directory = temporaryDirectory(context);
  const store = new Store(directory);
  try {
    assert.equal(store.credentials.getApiKey("a", "https://example.test"), undefined);
    store.credentials.saveApiKey("a", "https://example.test", "local-test-first");
    store.credentials.saveApiKey("a", "https://example.test/", "local-test-replacement");
    store.credentials.saveApiKey("b", "https://other.test", "local-test-other");
    assert.throws(() => store.credentials.saveApiKey("a", "https://example.test/", " "), /不能为空/);
    assert.throws(() => store.credentials.saveApiKey("a", "file:///secret", "local-test"), /HTTP/);
    assert.equal(readdirSync(directory).some((name) => name.endsWith(".tmp")), false);
  } finally {
    store.close();
  }
  const reopened = new Store(directory);
  try {
    assert.equal(reopened.credentials.getApiKey("a", "https://example.test"), "local-test-replacement");
    assert.equal(reopened.credentials.getApiKey("b", "https://other.test"), "local-test-other");
    assert.equal(reopened.credentials.getApiKey("a", "https://example.test/v1"), undefined);
    assert.equal("apiKey" in reopened.getConfig(), false);
    reopened.credentials.retain(["b"]);
    assert.equal(reopened.credentials.getApiKey("a", "https://example.test"), undefined);
    assert.equal(reopened.credentials.getApiKey("b", "https://other.test"), "local-test-other");
  } finally {
    reopened.close();
  }
});

test("损坏凭据直接报错，错误消息不回显文件内容", (context) => {
  const directory = temporaryDirectory(context);
  const store = new Store(directory);
  try {
    for (const content of ["private-test-data invalid JSON", '{"apiKey":23}']) {
      writeFileSync(join(directory, "credentials.json"), content, "utf8");
      assert.throws(() => store.credentials.getApiKey("default", "https://example.test"), /凭据文件/);
    }
  } finally {
    store.close();
  }
});

// 旧版只保存一组 { baseURL, apiKey }，升级后应作为 default 服务的密钥继续可用。
test("旧版单组凭据文件视为 default 服务的密钥", (context) => {
  const directory = temporaryDirectory(context);
  const store = new Store(directory);
  try {
    writeFileSync(join(directory, "credentials.json"), JSON.stringify({ baseURL: "https://api.deepseek.com", apiKey: "legacy-test-key" }), "utf8");
    assert.equal(store.credentials.getApiKey("default", "https://api.deepseek.com/"), "legacy-test-key");
    store.credentials.saveApiKey("second", "https://second.test", "second-test-key");
    assert.equal(store.credentials.getApiKey("default", "https://api.deepseek.com"), "legacy-test-key");
  } finally {
    store.close();
  }
});
