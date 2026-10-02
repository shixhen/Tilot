import assert from "node:assert/strict";
import { readFile, readdir, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { editProjectFile, openWorkspace, writeProjectFile } from "../src/index.ts";
import { replaceFile, withFileMutation } from "../src/file-write.ts";
import { temporaryDirectory } from "./helpers.ts";

test("不同任务同时编辑同文件，先前修改和后续修改都保留", async (context) => {
  const root = await temporaryDirectory(context);
  const firstWorkspace = await openWorkspace(root);
  const secondWorkspace = await openWorkspace(root);
  await writeFile(join(root, "code.txt"), "第一处 第二处", "utf8");
  await Promise.all([
    editProjectFile(firstWorkspace, { path: "code.txt", edits: [{ oldText: "第一处", newText: "更新一" }] }),
    editProjectFile(secondWorkspace, { path: "code.txt", edits: [{ oldText: "第二处", newText: "更新二" }] }),
  ]);
  assert.equal(await readFile(join(root, "code.txt"), "utf8"), "更新一 更新二");
});

test("write 与 edit 共享队列，大小写别名不能绕过 Windows 排队", async (context) => {
  const root = await temporaryDirectory(context);
  const workspace = await openWorkspace(root);
  const editPath = process.platform === "win32" ? "New/File.txt" : "new/file.txt";
  await Promise.all([
    writeProjectFile(workspace, { path: "new/file.txt", content: "先创建" }),
    editProjectFile(workspace, { path: editPath, edits: [{ oldText: "先创建", newText: "再编辑" }] }),
  ]);
  assert.equal(await readFile(join(root, "new/file.txt"), "utf8"), "再编辑");
});

test("前一次修改失败仍放行后续调用，共享父目录的不同文件可以同时创建", async (context) => {
  const root = await temporaryDirectory(context);
  const workspace = await openWorkspace(root);
  await writeFile(join(root, "keep.txt"), "原文", "utf8");
  const failed = assert.rejects(editProjectFile(workspace, { path: "keep.txt", edits: [{ oldText: "不存在", newText: "错误" }] }), /未找到/);
  await Promise.all([
    failed,
    editProjectFile(workspace, { path: "keep.txt", edits: [{ oldText: "原文", newText: "成功" }] }),
    writeProjectFile(workspace, { path: "shared/nested/a.txt", content: "A" }),
    writeProjectFile(workspace, { path: "shared/nested/b.txt", content: "B" }),
  ]);
  assert.equal(await readFile(join(root, "keep.txt"), "utf8"), "成功");
  assert.equal(await readFile(join(root, "shared/nested/a.txt"), "utf8"), "A");
  assert.equal(await readFile(join(root, "shared/nested/b.txt"), "utf8"), "B");
});

test("等待中取消不会写入，也不阻止后续修改或其他文件", { timeout: 5000 }, async (context) => {
  const root = await temporaryDirectory(context);
  const workspace = await openWorkspace(root);
  await writeFile(join(root, "keep.txt"), "原文", "utf8");
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const first = withFileMutation(workspace, "keep.txt", undefined, () => gate);
  const controller = new AbortController();
  const cancelled = assert.rejects(writeProjectFile(workspace, { path: "keep.txt", content: "不应写入" }, controller.signal), { name: "AbortError" });
  try {
    controller.abort();
    await writeProjectFile(workspace, { path: "other.txt", content: "独立文件" });
  } finally {
    release();
    await Promise.all([first, cancelled]);
  }
  assert.equal(await readFile(join(root, "keep.txt"), "utf8"), "原文");
  await writeProjectFile(workspace, { path: "keep.txt", content: "后续写入" });
  assert.equal(await readFile(join(root, "keep.txt"), "utf8"), "后续写入");
});

test("提交前发现外部字节变化或删除，保留外部内容并清理临时文件", async (context) => {
  const root = await temporaryDirectory(context);
  const workspace = await openWorkspace(root);
  const target = join(root, "keep.txt");
  const expected = Buffer.from("\ufeff原文\r\n", "utf8");
  for (const external of ["\ufeff外部\r\n", "原文\r\n", "\ufeff原文\n"]) {
    await writeFile(target, external, "utf8");
    await assert.rejects(replaceFile(workspace, "keep.txt", target, "不应覆盖", undefined, expected), /外部修改.*重新读取/);
    assert.equal(await readFile(target, "utf8"), external);
    assert.deepEqual(await readdir(root), ["keep.txt"]);
  }
  await unlink(target);
  await assert.rejects(replaceFile(workspace, "keep.txt", target, "不应重建", undefined, expected), /修改或删除/);
  assert.deepEqual(await readdir(root), []);
  await writeFile(target, expected);
  await replaceFile(workspace, "keep.txt", target, "成功", undefined, expected);
  assert.equal(await readFile(target, "utf8"), "成功");
});
