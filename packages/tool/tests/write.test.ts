import assert from "node:assert/strict";
import { mkdir, readFile, readdir, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { editProjectFile, executeTool, openWorkspace, writeProjectFile } from "../src/index.ts";
import { temporaryDirectory } from "./helpers.ts";

test("write 创建父目录、覆盖和清空文件，结果可交回模型", async (context) => {
  const root = await temporaryDirectory(context);
  const workspace = await openWorkspace(root);
  const content = "中文🙂\r\n第二行\n";
  const result = JSON.parse(await executeTool(workspace, "write", JSON.stringify({ path: "src/代码.txt", content })));
  assert.equal(result.status, "ok");
  assert.equal(result.data.bytesWritten, Buffer.byteLength(content));
  assert.equal(await readFile(join(root, "src/代码.txt"), "utf8"), content);
  await writeProjectFile(workspace, { path: "src/代码.txt", content: "" });
  assert.equal(await readFile(join(root, "src/代码.txt"), "utf8"), "");
  assert.deepEqual(await readdir(join(root, "src")), ["代码.txt"]);
});

test("edit 唯一精确替换，保留 BOM、混合换行，拒绝模糊和重复匹配", async (context) => {
  const root = await temporaryDirectory(context);
  const workspace = await openWorkspace(root);
  const file = join(root, "code.txt");
  const original = "\ufeff第一行\r\n目标\n尾行";
  await writeFile(file, original, "utf8");
  const result = JSON.parse(await executeTool(workspace, "edit", JSON.stringify({ path: "code.txt", oldText: "目标", newText: "新内容🙂" })));
  assert.equal(result.status, "ok");
  assert.equal(await readFile(file, "utf8"), original.replace("目标", "新内容🙂"));
  await writeFile(file, "aaa", "utf8");
  for (const oldText of ["", "aa", "missing"]) {
    await assert.rejects(editProjectFile(workspace, { path: "code.txt", oldText, newText: "x" }));
    assert.equal(await readFile(file, "utf8"), "aaa");
  }
  for (const bytes of [Buffer.from([0xff]), Buffer.from("a\0b")]) {
    await writeFile(file, bytes);
    await assert.rejects(editProjectFile(workspace, { path: "code.txt", oldText: "a", newText: "x" }), /UTF-8|二进制/);
    assert.deepEqual(await readFile(file), bytes);
  }
});

test("修改工具拒绝越界、目录和内部链接，不改变链接目标", async (context) => {
  const root = await temporaryDirectory(context);
  const outside = await temporaryDirectory(context);
  const workspace = await openWorkspace(root);
  await mkdir(join(root, "folder"));
  await writeFile(join(outside, "keep.txt"), "保留", "utf8");
  await symlink(outside, join(root, "link"), "junction");
  for (const path of ["", "../outside", "folder", "link/keep.txt", "link/new/file.txt"]) {
    await assert.rejects(writeProjectFile(workspace, { path, content: "修改" }));
  }
  await assert.rejects(editProjectFile(workspace, { path: "link/keep.txt", oldText: "保留", newText: "修改" }));
  assert.equal(await readFile(join(outside, "keep.txt"), "utf8"), "保留");
  assert.deepEqual(await readdir(outside), ["keep.txt"]);
});

test("预先取消和非法参数不会写入，失败不残留临时文件", async (context) => {
  const root = await temporaryDirectory(context);
  const workspace = await openWorkspace(root);
  await writeFile(join(root, "keep.txt"), "原文", "utf8");
  await assert.rejects(writeProjectFile(workspace, { path: "keep.txt", content: "修改" }, AbortSignal.abort()), { name: "AbortError" });
  await assert.rejects(editProjectFile(workspace, { path: "keep.txt", oldText: "原文", newText: "修改" }, AbortSignal.abort()), { name: "AbortError" });
  assert.equal(JSON.parse(await executeTool(workspace, "write", '{"path":"keep.txt","content":null}')).status, "error");
  assert.equal(JSON.parse(await executeTool(workspace, "edit", '{"path":"keep.txt","oldText":"原文","newText":"修改","extra":true}')).status, "error");
  assert.equal(await readFile(join(root, "keep.txt"), "utf8"), "原文");
  assert.deepEqual(await readdir(root), ["keep.txt"]);
});
