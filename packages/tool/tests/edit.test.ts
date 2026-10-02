import assert from "node:assert/strict";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { applyPatch } from "diff";
import { createToolSet, editProjectFile, openWorkspace, type TextEdit } from "../src/index.ts";
import { MAX_OUTPUT_BYTES } from "../src/text.ts";
import { temporaryDirectory } from "./helpers.ts";

test("多处替换基于原文件，乱序和相邻替换保留 BOM、Unicode 与未修改换行", async (context) => {
  const root = await temporaryDirectory(context);
  const workspace = await openWorkspace(root);
  const file = join(root, "code.txt");
  const original = "\ufeff开头🙂\r\n甲\r\n乙\n未修改\r\n丙丁\n结尾";
  const expected = "\ufeff开头🙂\r\n甲一\r\n甲二\r\n乙\n未修改\r\n丙一丁二\n结尾";
  await writeFile(file, original, "utf8");
  const result = await editProjectFile(workspace, { path: "code.txt", edits: [
    { oldText: "丁", newText: "丁二" }, { oldText: "甲\n", newText: "甲一\n甲二\n" }, { oldText: "丙", newText: "丙一" },
  ] });
  assert.deepEqual(await readFile(file), Buffer.from(expected, "utf8"));
  assert.equal(result.path, "code.txt");
  assert.equal(result.bytesWritten, Buffer.byteLength(expected));
  assert.equal(result.replacements, 3);
  assert.equal(result.firstChangedLine, 2);
  assert.equal(result.diffTruncated, false);
  assert.equal(applyPatch(original, result.diff, { autoConvertLineEndings: false }), expected);
  assert.deepEqual(await readdir(root), ["code.txt"]);
});

test("LF 与 CRLF 双向匹配，插入换行优先沿用匹配片段，其次沿用文件，否则用 LF", async (context) => {
  const root = await temporaryDirectory(context);
  const workspace = await openWorkspace(root);
  const file = join(root, "code.txt");
  const cases = [
    { original: "头\r\n甲\n乙\r\n尾", oldText: "甲\r\n乙", newText: "新\r\n行", expected: "头\r\n新\n行\r\n尾" },
    { original: "头\n甲\r\n乙\n尾", oldText: "甲\n乙", newText: "新\n行", expected: "头\n新\r\n行\n尾" },
    { original: "头\r\n目标\n尾", oldText: "目标", newText: "新\n行", expected: "头\r\n新\r\n行\n尾" },
    { original: "头\n目标\r\n尾", oldText: "目标", newText: "新\r\n行", expected: "头\n新\n行\r\n尾" },
    { original: "\ufeff目标", oldText: "目标", newText: "新\r\n行", expected: "\ufeff新\n行" },
    { original: "🙂\r\n目标\r\n尾", oldText: "\n目标\n", newText: "\n替换\n", expected: "🙂\r\n替换\r\n尾" },
  ];
  for (const { original, oldText, newText, expected } of cases) {
    await writeFile(file, original, "utf8");
    const result = await editProjectFile(workspace, { path: "code.txt", edits: [{ oldText, newText }] });
    assert.equal(await readFile(file, "utf8"), expected);
    assert.equal(applyPatch(original, result.diff, { autoConvertLineEndings: false }), expected);
  }
});

test("任一项无匹配、重复或重叠时零写入，后一项不能引用前一项新内容", async (context) => {
  const root = await temporaryDirectory(context);
  const workspace = await openWorkspace(root);
  const file = join(root, "code.txt");
  const original = "alpha beta abcdef aaa\n同\r\n文 / 同\n文";
  const cases: { edits: TextEdit[]; error: RegExp }[] = [
    { edits: [{ oldText: "alpha", newText: "new" }, { oldText: "missing", newText: "x" }], error: /第 2 项未找到/ },
    { edits: [{ oldText: "alpha", newText: "new" }, { oldText: "new", newText: "x" }], error: /第 2 项未找到/ },
    { edits: [{ oldText: "aa", newText: "x" }], error: /匹配多处/ },
    { edits: [{ oldText: "同\n文", newText: "x" }], error: /匹配多处/ },
    { edits: [{ oldText: "abcdef", newText: "x" }, { oldText: "bcd", newText: "y" }], error: /重叠/ },
    { edits: [{ oldText: "bcd", newText: "x" }, { oldText: "def", newText: "y" }], error: /重叠/ },
    { edits: [{ oldText: "alpha", newText: "x" }, { oldText: "alpha", newText: "y" }], error: /重叠/ },
  ];
  await writeFile(file, original, "utf8");
  for (const { edits, error } of cases) {
    await assert.rejects(editProjectFile(workspace, { path: "code.txt", edits }), error);
    assert.deepEqual(await readFile(file), Buffer.from(original, "utf8"));
    assert.deepEqual(await readdir(root), ["code.txt"]);
  }
});

test("空格、尾部空白、引号、Unicode、大小写和单独 CR 均不作容错", async (context) => {
  const root = await temporaryDirectory(context);
  const workspace = await openWorkspace(root);
  const file = join(root, "code.txt");
  for (const [original, oldText] of [
    ["甲  乙", "甲 乙"], ["甲 \n乙", "甲\n乙"], ["“甲”", '"甲"'], ["甲\u00a0乙", "甲 乙"],
    ["甲\u202f乙", "甲 乙"], ["e\u0301", "é"], ["Alpha", "alpha"], ["甲\r乙", "甲\n乙"],
  ]) {
    await writeFile(file, original!, "utf8");
    await assert.rejects(editProjectFile(workspace, { path: "code.txt", edits: [{ oldText: oldText!, newText: "修改" }] }), /未找到/);
    assert.equal(await readFile(file, "utf8"), original);
  }
});

test("整个结果无变化时报错，部分无变化不干扰实际差异的首个变更行", async (context) => {
  const root = await temporaryDirectory(context);
  const workspace = await openWorkspace(root);
  const file = join(root, "code.txt");
  const original = "\ufeff首行\r\n末行\n";
  await writeFile(file, original, "utf8");
  await assert.rejects(editProjectFile(workspace, { path: "code.txt", edits: [{ oldText: "首行\n", newText: "首行\n" }] }), /没有需要修改/);
  assert.equal(await readFile(file, "utf8"), original);
  const result = await editProjectFile(workspace, { path: "code.txt", edits: [
    { oldText: "首行", newText: "首行" }, { oldText: "末行", newText: "更新" },
  ] });
  assert.equal(result.replacements, 2);
  assert.equal(result.firstChangedLine, 2);
  assert.equal(applyPatch(original, result.diff, { autoConvertLineEndings: false }), await readFile(file, "utf8"));
});

test("参数只接受 1–20 项对象，旧格式、错误类型、未知字段和无效 Unicode 均不写入", async (context) => {
  const root = await temporaryDirectory(context);
  const workspace = await openWorkspace(root);
  const tools = createToolSet(workspace);
  const file = join(root, "code.txt");
  await writeFile(file, "原文", "utf8");
  for (const args of [
    { path: "code.txt", oldText: "原文", newText: "修改" },
    ...[undefined, null, "text", [], Array(21).fill({ oldText: "原文", newText: "修改" }),
      [null], ["原文", "修改"], [["原文", "修改"]], [{ oldText: "", newText: "x" }],
      [{ oldText: 1, newText: "x" }], [{ oldText: "原文", newText: null }], [{ oldText: "原文" }],
      [{ oldText: "原文", newText: "x", extra: true }], [{ oldText: "原文", newText: "\ud800" }],
    ].map((edits) => ({ path: "code.txt", edits })),
  ]) {
    const result = JSON.parse(await tools.execute("edit", JSON.stringify(args)));
    assert.equal(result.status, "error");
    assert.equal(await readFile(file, "utf8"), "原文");
    assert.deepEqual(await readdir(root), ["code.txt"]);
  }
  const original = Array.from({ length: 20 }, (_, index) => `[${index}]`).join(" ");
  await writeFile(file, original, "utf8");
  const result = await editProjectFile(workspace, { path: "code.txt", edits: Array.from({ length: 20 }, (_, index) => ({ oldText: `[${index}]`, newText: `(${index})` })) });
  assert.equal(result.replacements, 20);
  assert.equal(await readFile(file, "utf8"), original.replace(/\[/g, "(").replace(/\]/g, ")"));
});

test("删除、文件末尾增行及缺少末尾换行的差异与写入一致", async (context) => {
  const root = await temporaryDirectory(context);
  const workspace = await openWorkspace(root);
  const file = join(root, "code.txt");
  for (const { original, edit, expected, line } of [
    { original: "甲\n乙\n丙", edit: { oldText: "乙\n", newText: "" }, expected: "甲\n丙", line: 2 },
    { original: "甲\n", edit: { oldText: "甲\n", newText: "甲\n乙\n" }, expected: "甲\n乙\n", line: 2 },
    { original: "甲", edit: { oldText: "甲", newText: "" }, expected: "", line: 1 },
    { original: "\ufeff甲\r\n", edit: { oldText: "甲\n", newText: "" }, expected: "\ufeff", line: 1 },
  ]) {
    await writeFile(file, original, "utf8");
    const result = await editProjectFile(workspace, { path: "code.txt", edits: [edit] });
    assert.equal(await readFile(file, "utf8"), expected);
    assert.equal(result.firstChangedLine, line);
    assert.equal(applyPatch(original, result.diff, { autoConvertLineEndings: false }), expected);
  }
});

test("大差异限制为 50 KiB，截断保持 UTF-8 完整且不会截断实际写入", async (context) => {
  const root = await temporaryDirectory(context);
  const workspace = await openWorkspace(root);
  const file = join(root, "code.txt");
  const original = "旧内容\n";
  const updated = "🙂中文".repeat(10000) + "\n";
  await writeFile(file, original, "utf8");
  const result = await editProjectFile(workspace, { path: "code.txt", edits: [{ oldText: original, newText: updated }] });
  assert.equal(result.diffTruncated, true);
  assert.ok(Buffer.byteLength(result.diff, "utf8") <= MAX_OUTPUT_BYTES);
  assert.equal(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.from(result.diff)), result.diff);
  assert.ok(!result.diff.includes("\ufffd"));
  assert.match(result.diff, /^--- a\/code.txt\n\+\+\+ b\/code.txt\n@@/);
  assert.equal(await readFile(file, "utf8"), updated);
  assert.equal(result.bytesWritten, Buffer.byteLength(updated));
  assert.equal(result.firstChangedLine, 1);
});
