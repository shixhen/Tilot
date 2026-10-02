import assert from "node:assert/strict";
import { readFile, readdir, symlink, unlink, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { test } from "node:test";
import { createToolSet, openWorkspace, OutputCache, readOutputLog } from "../src/index.ts";
import { temporaryDirectory } from "./helpers.ts";

test("日志跨实例保留并按行续读，归属和路径参数不能越过缓存边界", async (context) => {
  const data = await temporaryDirectory(context);
  const root = await temporaryDirectory(context);
  const cache = new OutputCache(data);
  const log = await cache.create("thread");
  const original = "\ufeff中文🙂\r\n\u001b[31m错误\u001b[0m\n尾行";
  await log.append(original);
  const artifact = await log.finish();
  assert.equal(artifact.bytesWritten, Buffer.byteLength(original));
  const host = { outputs: new OutputCache(data), threadId: "thread" };
  const first = await readOutputLog(host, { outputId: artifact.outputId, limit: 1 });
  assert.ok("nextOffset" in first);
  assert.equal(first.content, "\ufeff中文🙂\r\n");
  assert.equal(first.nextOffset, 2);
  const second = await readOutputLog(host, { outputId: artifact.outputId, offset: first.nextOffset!, limit: 2 });
  assert.ok("nextOffset" in second);
  assert.equal(first.content + second.content, original);
  assert.equal(second.nextOffset, null);
  assert.equal("path" in first, false);
  await assert.rejects(readOutputLog({ ...host, threadId: "another" }, { outputId: artifact.outputId }), /过期或不存在/);
  for (const outputId of [join(data, "outputs", `${artifact.outputId}.log`), "../secret", randomUUID()]) {
    await assert.rejects(readOutputLog(host, { outputId }));
  }
  const tools = createToolSet(await openWorkspace(root), host);
  for (const args of [{}, { path: "x", outputId: artifact.outputId }, { outputId: null }, { outputId: artifact.outputId, byteOffset: 0, offset: 1 },
    { outputId: artifact.outputId, byteOffset: 0, limit: 1 }, { path: "x", byteOffset: 0 }, { outputId: artifact.outputId, byteOffset: -1 },
    { outputId: artifact.outputId, byteOffset: 0.5 }, { outputId: artifact.outputId, byteOffset: null }]) {
    assert.equal(JSON.parse(await tools.execute("read", JSON.stringify(args))).status, "error");
  }
  const result = JSON.parse(await tools.execute("read", JSON.stringify({ outputId: artifact.outputId })));
  assert.equal(result.status, "ok");
  assert.equal(result.data.content, original);
  assert.deepEqual(await readdir(root), []);
  for (const name of ["write", "edit"]) assert.equal(JSON.parse(await tools.execute(name, JSON.stringify({ outputId: artifact.outputId }))).status, "error");
});

test("超长日志行返回字符边界上的字节位置，续读可完整重组混合 UTF-8 输出", async (context) => {
  const cache = new OutputCache(await temporaryDirectory(context));
  const log = await cache.create("thread");
  const prefix = "\ufeff前一行🙂\r\n";
  const longLine = "中文🙂".repeat(20000) + "\r\n末行";
  await log.append(prefix + longLine);
  const { outputId } = await log.finish();
  const host = { outputs: cache, threadId: "thread" };
  const first = await readOutputLog(host, { outputId, offset: 2 });
  assert.ok("partialLine" in first);
  assert.equal(first.partialLine, true);
  assert.equal(first.truncatedBy, "bytes");
  assert.equal(first.nextOffset, null);
  assert.equal(first.nextByteOffset, Buffer.byteLength(prefix + first.content));
  let assembled = first.content;
  let byteOffset: number | undefined = first.nextByteOffset;
  let pages = 0;
  while (byteOffset !== undefined) {
    const next = await readOutputLog(host, { outputId, byteOffset });
    assert.ok("byteOffset" in next);
    assert.ok(Buffer.byteLength(next.content) <= 50 * 1024);
    assert.ok(!next.content.includes("\ufffd"));
    assembled += next.content;
    byteOffset = next.nextByteOffset ?? undefined;
    pages++;
  }
  assert.ok(pages > 1);
  assert.equal(assembled, longLine);
  await assert.rejects(readOutputLog(host, { outputId, byteOffset: 1 }), /UTF-8 字符边界/);
  await assert.rejects(readOutputLog(host, { outputId, byteOffset: Buffer.byteLength(prefix + longLine) + 1 }), /超出/);
  await assert.rejects(readOutputLog(host, { outputId }, AbortSignal.abort()), { name: "AbortError" });
});

test("单日志达到上限保留完整 UTF-8 前缀，不将后续片段拼接到截断缓存", async (context) => {
  const cache = new OutputCache(await temporaryDirectory(context), { artifactBytes: 1023, cacheBytes: 8192 });
  const log = await cache.create("thread");
  await log.append("🙂".repeat(400));
  await log.append("不应写入的后续内容");
  const artifact = await log.finish();
  assert.equal(artifact.artifactTruncated, true);
  assert.equal(artifact.bytesWritten, 1020);
  const result = await readOutputLog({ outputs: cache, threadId: "thread" }, { outputId: artifact.outputId, byteOffset: 0 });
  assert.ok("nextByteOffset" in result);
  assert.equal(result.content, "🙂".repeat(255));
  assert.equal(result.artifactTruncated, true);
  assert.equal(result.nextByteOffset, null);
});

test("容量清理淘汰旧日志，运行中日志不回收，满额明确拒绝新日志", async (context) => {
  const data = await temporaryDirectory(context);
  const cache = new OutputCache(data, { artifactBytes: 512, cacheBytes: 1900 });
  const first = await cache.create("thread");
  await first.append("x".repeat(100));
  await first.finish();
  const metadataPath = join(data, "outputs", `${first.outputId}.json`);
  const metadata = JSON.parse(await readFile(metadataPath, "utf8"));
  await writeFile(metadataPath, JSON.stringify({ ...metadata, finishedAt: Date.now() - 1000 }), "utf8");
  const second = await cache.create("thread");
  await second.append("y".repeat(100));
  await second.finish();
  const active = await cache.create("thread");
  await active.append("进行中");
  await cache.cleanup();
  assert.ok((await readdir(join(data, "outputs"))).includes(`${active.outputId}.pending`));
  await assert.rejects(cache.create("thread"), /正在保存的输出占满/);
  await assert.rejects(cache.read("thread", first.outputId, async () => true), /过期或不存在/);
  assert.equal(await cache.read("thread", second.outputId, async () => true), true);
  await active.discard();
  const next = await cache.create("thread");
  await next.discard();
  await assert.rejects(cache.create("thread", second.outputId), /不能覆盖/);
});

test("过期日志不可读且可清理，重启遗留的未发布日志清理后不占容量", async (context) => {
  const data = await temporaryDirectory(context);
  const cache = new OutputCache(data);
  const log = await cache.create("thread");
  await log.append("旧日志");
  await log.finish();
  const path = join(data, "outputs", `${log.outputId}.json`);
  const metadata = JSON.parse(await readFile(path, "utf8"));
  await writeFile(path, JSON.stringify({ ...metadata, finishedAt: Date.now() - 8 * 24 * 60 * 60 * 1000 }), "utf8");
  await assert.rejects(cache.read("thread", log.outputId, async () => true), /过期或不存在/);
  await writeFile(join(data, "outputs", `${randomUUID()}.pending`), "遗留写入", "utf8");
  await writeFile(join(data, "outputs", `${randomUUID()}.log`), "没有元数据", "utf8");
  await cache.cleanup();
  assert.deepEqual(await readdir(join(data, "outputs")), []);
});

test("缓存文件与目录链接不能用作日志读取来源", async (context) => {
  const data = await temporaryDirectory(context);
  const outside = await temporaryDirectory(context);
  const cache = new OutputCache(data);
  const log = await cache.create("thread");
  await log.append("保持");
  await log.finish();
  const logPath = join(data, "outputs", `${log.outputId}.log`);
  await writeFile(join(outside, "secret.txt"), "外部数据", "utf8");
  await unlink(logPath);
  // 文件链接需要 Windows 开发者模式；目录 junction 不需要，且同样必须拒绝。
  await symlink(outside, logPath, "junction");
  await assert.rejects(cache.read("thread", log.outputId, async () => true), /过期或不存在/);
  const linkedData = await temporaryDirectory(context);
  await symlink(join(data, "outputs"), join(linkedData, "outputs"), "junction");
  await assert.rejects(new OutputCache(linkedData).read("thread", log.outputId, async () => true), /不能是链接/);
});
