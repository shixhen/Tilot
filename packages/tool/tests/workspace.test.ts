import assert from "node:assert/strict";
import { mkdir, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { openWorkspace, pathSegments, resolveWorkspacePath } from "../src/workspace.ts";
import { temporaryDirectory } from "./helpers.ts";

test("项目内中文和空格路径可解析，失效路径及非目录根路径报错", async (context) => {
  const directory = await temporaryDirectory(context);
  await mkdir(join(directory, "源代码"));
  await writeFile(join(directory, "源代码", "hello world.ts"), "export {};", "utf8");
  const workspace = await openWorkspace(directory);
  assert.equal(await resolveWorkspacePath(workspace, ""), workspace.rootPath);
  assert.equal(await resolveWorkspacePath(workspace, "源代码/hello world.ts"),
    join(workspace.rootPath, "源代码", "hello world.ts"));
  await assert.rejects(resolveWorkspacePath(workspace, "missing.ts"), { code: "ENOENT" });
  await assert.rejects(openWorkspace(join(directory, "源代码", "hello world.ts")), /不能选择文件/);
  await assert.rejects(openWorkspace("relative"), /绝对路径/);
});

test("拒绝目录穿越、绝对路径和 Windows 路径别名", () => {
  for (const path of ["../secret", "src/../../secret", "/etc/passwd", "C:/secret",
    "C:secret", "\\\\server\\share", "src\\file.ts", "a//b", "./a", "a/",
    "file:stream", "file.", "file ", "NUL", "con.txt", "a\u0000b"]) {
    assert.throws(() => pathSegments(path), /相对路径/, path);
  }
  assert.deepEqual(pathSegments("src/main.ts"), ["src", "main.ts"]);
});

test("允许选择根目录链接，但拒绝项目内指向内外部的目录链接", async (context) => {
  const directory = await temporaryDirectory(context);
  const root = join(directory, "project");
  const outside = join(directory, "outside");
  await mkdir(root);
  await mkdir(outside);
  await mkdir(join(root, "src"));
  await writeFile(join(outside, "secret.txt"), "private", "utf8");
  const linkType = process.platform === "win32" ? "junction" : "dir";
  await symlink(root, join(directory, "selected"), linkType);
  await symlink(outside, join(root, "external"), linkType);
  await symlink(join(root, "src"), join(root, "internal"), linkType);
  const workspace = await openWorkspace(join(directory, "selected"));
  assert.equal(workspace.rootPath, (await openWorkspace(root)).rootPath);
  await assert.rejects(resolveWorkspacePath(workspace, "external/secret.txt"), /链接|联接/);
  await assert.rejects(resolveWorkspacePath(workspace, "internal"), /链接|联接/);
});
