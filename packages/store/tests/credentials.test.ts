import assert from "node:assert/strict";
import { readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { Store } from "@tilot/store";
import { temporaryDirectory } from "./helpers.ts";

test("文件凭据可替换并重开读取，仅匹配保存地址，删除不影响配置", (context) => {
  const directory = temporaryDirectory(context);
  const store = new Store(directory);
  try {
    assert.equal(store.credentials.getApiKey("https://example.test"), undefined);
    store.credentials.saveApiKey("https://example.test", "local-test-first");
    store.credentials.saveApiKey("https://example.test/", "local-test-replacement");
    assert.throws(() => store.credentials.saveApiKey("https://example.test/", " "), /不能为空/);
    assert.throws(() => store.credentials.saveApiKey("file:///secret", "local-test"), /HTTP/);
    assert.equal(readdirSync(directory).some((name) => name.endsWith(".tmp")), false);
  } finally {
    store.close();
  }
  const reopened = new Store(directory);
  try {
    assert.equal(reopened.credentials.getApiKey("https://example.test"), "local-test-replacement");
    assert.equal(reopened.credentials.getApiKey("https://other.test"), undefined);
    assert.equal(reopened.credentials.getApiKey("https://example.test/v1"), undefined);
    assert.equal("apiKey" in reopened.getConfig(), false);
    reopened.credentials.deleteApiKey();
    reopened.credentials.deleteApiKey();
    assert.equal(reopened.credentials.getApiKey("https://example.test"), undefined);
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
      assert.throws(() => store.credentials.getApiKey("https://example.test"), /凭据文件/);
    }
  } finally {
    store.close();
  }
});
