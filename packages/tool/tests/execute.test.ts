import assert from "node:assert/strict";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { createToolSet, openWorkspace } from "../src/index.ts";
import { temporaryDirectory } from "./helpers.ts";

test("工具集合只执行本轮声明的工具，无项目时不能访问文件", async (context) => {
  const root = await temporaryDirectory(context);
  const tools = createToolSet(await openWorkspace(root));
  const result = JSON.parse(await tools.execute("write", '{"path":"test.txt","content":"原文"}'));
  assert.equal(result.status, "ok");
  assert.equal(await readFile(join(root, "test.txt"), "utf8"), "原文");
  assert.equal(JSON.parse(await tools.execute("unknown", "{}")).status, "error");
  const empty = createToolSet();
  assert.deepEqual(empty.definitions, []);
  assert.equal(JSON.parse(await empty.execute("write", '{"path":"test.txt","content":"不应执行"}')).status, "error");
  assert.equal(await readFile(join(root, "test.txt"), "utf8"), "原文");
});

test("非法参数和已取消调用不会产生文件或命令副作用", async (context) => {
  const root = await temporaryDirectory(context);
  const tools = createToolSet(await openWorkspace(root));
  await writeFile(join(root, "keep.txt"), "原文", "utf8");
  for (const argumentsJson of ["bad json", "null", "[]", '"text"']) {
    assert.equal(JSON.parse(await tools.execute("write", argumentsJson)).status, "error");
  }
  const samples = [
    ["write", { path: "keep.txt", content: null }],
    ["write", { path: "keep.txt", content: "修改", extra: true }],
    ["edit", { path: "keep.txt", edits: [{ oldText: "原文", newText: null }] }],
    ["edit", { path: "keep.txt", edits: [{ oldText: "原文", newText: "修改" }], extra: true }],
    ["edit", { path: "keep.txt", oldText: "原文", newText: "修改" }],
    ["read", { path: "keep.txt", offset: null }],
    ["read", { path: "keep.txt", offset: 1.5 }],
    ["read", { path: "keep.txt", limit: 2001 }],
    ["read", { path: "keep.txt", rootPath: "C:/" }],
    ["shell", { command: "Set-Content blocked.txt changed", timeoutSeconds: null }],
    ["shell", { command: "Set-Content blocked.txt changed", timeoutSeconds: 1.5 }],
    ["shell", { command: "Set-Content blocked.txt changed", extra: true }],
  ] as const;
  for (const [name, args] of samples) {
    assert.equal(JSON.parse(await tools.execute(name, JSON.stringify(args))).status, "error");
  }
  assert.equal(JSON.parse(await tools.execute("write", '{"path":"keep.txt","content":"修改"}', AbortSignal.abort())).status, "cancelled");
  assert.equal(await readFile(join(root, "keep.txt"), "utf8"), "原文");
  assert.deepEqual(await readdir(root), ["keep.txt"]);
});
