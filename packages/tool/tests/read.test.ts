import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { openWorkspace, readProjectFile } from "../src/index.ts";
import { temporaryDirectory } from "./helpers.ts";

test("读取 BOM、中文、混合换行和末尾无换行的文件，分页可以重组原文", async (context) => {
  const directory = await temporaryDirectory(context);
  const workspace = await openWorkspace(directory);
  const content = "中文🙂\r\n\r\n第三行\n最后一行";
  await writeFile(join(directory, "代码.txt"), "\ufeff" + content, "utf8");
  const first = await readProjectFile(workspace, { path: "代码.txt", limit: 2 });
  assert.deepEqual(first, { path: "代码.txt", content: "中文🙂\r\n\r\n", offset: 1, lineCount: 2, nextOffset: 3 });
  const second = await readProjectFile(workspace, { path: "代码.txt", offset: first.nextOffset! });
  assert.equal(first.content + second.content, content);
  assert.equal(second.lineCount, 2);
  assert.equal(second.nextOffset, null);
  await writeFile(join(directory, "empty.txt"), "", "utf8");
  assert.equal((await readProjectFile(workspace, { path: "empty.txt" })).lineCount, 0);
  await assert.rejects(readProjectFile(workspace, { path: "代码.txt", offset: 5 }), /超出文件行数/);
});

test("按行数和 UTF-8 字节限制截断，不切断字符或丢失续读内容", async (context) => {
  const directory = await temporaryDirectory(context);
  const workspace = await openWorkspace(directory);
  await writeFile(join(directory, "many.txt"), "x\n".repeat(201), "utf8");
  const lines = await readProjectFile(workspace, { path: "many.txt" });
  assert.equal(lines.lineCount, 200);
  assert.equal(lines.nextOffset, 201);
  assert.equal((await readProjectFile(workspace, { path: "many.txt", offset: 201 })).nextOffset, null);
  const line = "中".repeat(10000) + "\r\n";
  await writeFile(join(directory, "bytes.txt"), line.repeat(2), "utf8");
  const first = await readProjectFile(workspace, { path: "bytes.txt" });
  assert.equal(first.content, line);
  assert.equal(first.nextOffset, 2);
  const second = await readProjectFile(workspace, { path: "bytes.txt", offset: 2 });
  assert.equal(second.content, line);
  assert.equal(second.nextOffset, null);
  await writeFile(join(directory, "long.txt"), "x".repeat(100000) + "\n目标行", "utf8");
  await assert.rejects(readProjectFile(workspace, { path: "long.txt" }), /超过 50 KiB/);
  assert.equal((await readProjectFile(workspace, { path: "long.txt", offset: 2 })).content, "目标行");
});

test("拒绝无效 UTF-8、截断编码及二进制控制字符", async (context) => {
  const directory = await temporaryDirectory(context);
  const workspace = await openWorkspace(directory);
  for (const bytes of [Buffer.from([0xff]), Buffer.from([0xe4, 0xb8]), Buffer.from("abc\0def")]) {
    await writeFile(join(directory, "invalid.txt"), bytes);
    await assert.rejects(readProjectFile(workspace, { path: "invalid.txt" }), /UTF-8|二进制/);
  }
});

test("拒绝无效读取参数、目录和越界路径，已取消的读取立即终止", async (context) => {
  const directory = await temporaryDirectory(context);
  const workspace = await openWorkspace(directory);
  await writeFile(join(directory, "file.txt"), "hello", "utf8");
  for (const input of [{ path: "" }, { path: "file.txt", offset: 0 },
    { path: "file.txt", limit: 201 }, { path: "file.txt", limit: 1.5 }, { path: "../outside" }]) {
    await assert.rejects(readProjectFile(workspace, input));
  }
  await assert.rejects(readProjectFile(workspace, { path: "file.txt" }, AbortSignal.abort()), { name: "AbortError" });
  await mkdir(join(directory, "folder"));
  await assert.rejects(readProjectFile(workspace, { path: "folder" }), /普通文件/);
});
