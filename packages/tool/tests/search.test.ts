import assert from "node:assert/strict";
import childProcess, { type ChildProcess, type SpawnOptions } from "node:child_process";
import { mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { createToolSet, findProjectFiles, grepProject, listProjectDirectory, openWorkspace, readProjectFile } from "../src/index.ts";
import { resolveRipgrep, ripgrepRecords } from "../src/ripgrep.ts";
import { temporaryDirectory } from "./helpers.ts";

/** 非 Git 项目也包含嵌套忽略规则、隐藏文件和中文路径，所有内容仅为测试样本。 */
async function searchFixture(context: TestContext) {
  const workspace = await openWorkspace(await temporaryDirectory(context));
  const files: Record<string, string> = {
    ".gitignore": "ignored.ts\nbuild/\n",
    ".ignore": "*.tmp\n",
    ".rgignore": "rg-ignored.ts\n",
    "src/.gitignore": "skip.ts\n",
    "src/a.ts": "前文\r\nneedle 中文🙂\r\n后文\n",
    "src/.hidden.ts": "needle hidden",
    "src/nested/b.ts": "needle nested",
    "src/skip.ts": "needle excluded nested",
    "src/data.tmp": "needle excluded ignore",
    "src/.private/c.ts": "needle private",
    "metadata/.GiT/secret.ts": "needle excluded git alias",
    "源代码/你好 world.ts": "needle unicode",
    "ignored.ts": "needle excluded root",
    "rg-ignored.ts": "needle excluded rgignore",
    "build/out.ts": "needle excluded build",
    "notes.txt": "needle note",
    "🙂.ts": "needle emoji",
    "\ue000.ts": "needle private character",
  };
  for (const [path, text] of Object.entries(files)) {
    await mkdir(join(workspace.rootPath, path, ".."), { recursive: true });
    await writeFile(join(workspace.rootPath, path), text, "utf8");
  }
  return workspace;
}

test("ls 包含隐藏项、稳定排序和项目路径，目录链接只列出而不访问目标", async (context) => {
  const workspace = await searchFixture(context);
  const outside = await temporaryDirectory(context);
  await writeFile(join(outside, "secret.txt"), "external fixture", "utf8");
  await symlink(outside, join(workspace.rootPath, "linked"), process.platform === "win32" ? "junction" : "dir");
  const root = await listProjectDirectory(workspace);
  assert.equal(root.truncated, false);
  assert.deepEqual(root.entries.map((entry) => entry.path), root.entries.map((entry) => entry.path).sort());
  assert.ok(root.entries.some((entry) => entry.path === ".gitignore" && entry.type === "file"));
  assert.ok(root.entries.some((entry) => entry.path === "src" && entry.type === "directory"));
  assert.ok(root.entries.some((entry) => entry.path === "linked" && entry.type === "link"));
  const directory = await listProjectDirectory(workspace, { path: "源代码", limit: 1 });
  assert.equal(directory.entries[0]!.path, "源代码/你好 world.ts");
  assert.equal(directory.truncated, false);
  assert.equal((await readProjectFile(workspace, { path: directory.entries[0]!.path })).content, "needle unicode");
  const limited = await listProjectDirectory(workspace, { limit: 1 });
  assert.equal(limited.truncatedBy, "items");
  await assert.rejects(listProjectDirectory(workspace, { path: "linked" }), /链接|联接/);
  await assert.rejects(listProjectDirectory(workspace, { path: "notes.txt" }), /必须是项目目录/);
});

test("find 的 glob 不覆盖嵌套忽略规则，包含隐藏文件和 Unicode，排除 .git 与内外部链接", async (context) => {
  const workspace = await searchFixture(context);
  const outside = await temporaryDirectory(context);
  await mkdir(join(workspace.rootPath, ".git"));
  await writeFile(join(workspace.rootPath, ".git/secret.ts"), "needle git", "utf8");
  await writeFile(join(outside, "outside.ts"), "needle outside", "utf8");
  await symlink(outside, join(workspace.rootPath, "external"), process.platform === "win32" ? "junction" : "dir");
  await symlink(join(workspace.rootPath, "src"), join(workspace.rootPath, "internal"), process.platform === "win32" ? "junction" : "dir");
  const result = await findProjectFiles(workspace, { pattern: "*.ts" });
  assert.equal(result.truncated, false);
  assert.deepEqual(new Set(result.files), new Set(["src/a.ts", "src/.hidden.ts", "src/nested/b.ts", "src/.private/c.ts", "源代码/你好 world.ts", "🙂.ts", "\ue000.ts"]));
  const hidden = await findProjectFiles(workspace, { pattern: "src/**/*.ts", path: "src" });
  assert.deepEqual(new Set(hidden.files), new Set(["src/a.ts", "src/.hidden.ts", "src/nested/b.ts", "src/.private/c.ts"]));
  assert.deepEqual((await findProjectFiles(workspace, { pattern: "nested/*.ts", path: "src" })).files, []);
  const narrow = await findProjectFiles(workspace, { pattern: "src/*.ts", path: "src" });
  assert.deepEqual(new Set(narrow.files), new Set(["src/a.ts", "src/.hidden.ts"]));
  assert.deepEqual((await findProjectFiles(workspace, { pattern: "ignored.ts" })).files, []);
  assert.equal((await findProjectFiles(workspace, { pattern: "*.ts", limit: 2 })).truncatedBy, "items");
  await assert.rejects(findProjectFiles(workspace, { pattern: "*", path: "external" }), /链接|联接/);
  await assert.rejects(findProjectFiles(workspace, { pattern: "*", path: ".git" }), /不访问/);
  await assert.rejects(findProjectFiles(workspace, { pattern: "*", path: ".GIT" }), /不访问/);
  await assert.rejects(grepProject(workspace, { pattern: "needle", path: ".GIT/secret.ts" }), /不访问/);
  assert.equal((await grepProject(workspace, { pattern: "needle", glob: "*.ts" })).matches.length, 7);
});

test("grep 返回可直接读取的路径和行号，glob 不搜索忽略文件，空匹配是完整成功结果", async (context) => {
  const workspace = await searchFixture(context);
  const result = await grepProject(workspace, { pattern: "needle", glob: "*.ts" });
  assert.equal(result.truncated, false);
  assert.equal(result.matches.length, 7);
  const match = result.matches.find((entry) => entry.path === "src/a.ts")!;
  assert.equal(match.line, 2);
  assert.equal(match.text, "needle 中文🙂");
  assert.equal((await readProjectFile(workspace, { path: match.path, offset: match.line, limit: 1 })).content, match.text + "\r\n");
  assert.deepEqual((await grepProject(workspace, { pattern: "no-such-text", glob: "*.ts" })).matches, []);
  assert.equal((await grepProject(workspace, { pattern: "no-such-text" })).truncated, false);
  assert.equal((await grepProject(workspace, { pattern: "needle", path: "ignored.ts" })).matches[0]!.path, "ignored.ts");
  await assert.rejects(grepProject(workspace, { pattern: "[", glob: "no-such-file" }), /regex|正则/);
});

test("单文件 grep 支持正则、字面和大小写匹配，重叠上下文来自同一份 rg 输出", async (context) => {
  const workspace = await openWorkspace(await temporaryDirectory(context));
  const content = "\ufeff前序\r\nfoo.bar\r\nFOO.BAR\r\nfooXbar\n结尾";
  await writeFile(join(workspace.rootPath, "text.txt"), content, "utf8");
  const regex = await grepProject(workspace, { pattern: "foo.bar", path: "text.txt" });
  assert.deepEqual(regex.matches.map((entry) => entry.line), [2, 4]);
  const literal = await grepProject(workspace, { pattern: "foo.bar", path: "text.txt", literal: true, ignoreCase: true, context: 1 });
  assert.deepEqual(literal.matches.map((entry) => entry.line), [2, 3]);
  assert.deepEqual(literal.matches[0]!.before.map((entry) => entry.text), ["前序"]);
  assert.deepEqual(literal.matches[0]!.after.map((entry) => entry.text), ["FOO.BAR"]);
  assert.deepEqual(literal.matches[1]!.before.map((entry) => entry.text), ["foo.bar"]);
  assert.deepEqual(literal.matches[1]!.after.map((entry) => entry.text), ["fooXbar"]);
  assert.equal((await grepProject(workspace, { pattern: "结尾", path: "text.txt", limit: 1 })).truncated, false);
  assert.equal((await grepProject(workspace, { pattern: "foo", path: "text.txt", limit: 1 })).truncatedBy, "items");
  await assert.rejects(grepProject(workspace, { pattern: "foo", path: "text.txt", glob: "*" }), /省略 glob/);
});

test("文件和模式中的选项前缀及命令字符作为普通参数，不执行 shell 语法", async (context) => {
  const workspace = await openWorkspace(await temporaryDirectory(context));
  const name = "-semi; $() &.txt";
  await writeFile(join(workspace.rootPath, name), "-needle", "utf8");
  const found = await findProjectFiles(workspace, { pattern: "-*.txt" });
  assert.deepEqual(found.files, [name]);
  const result = await grepProject(workspace, { pattern: "-needle", path: name, literal: true });
  assert.equal(result.matches[0]!.path, name);
  assert.equal(result.matches[0]!.text, "-needle");
  await writeFile(join(workspace.rootPath, "-"), "dash-file", "utf8");
  assert.equal((await grepProject(workspace, { pattern: "dash-file", path: "-" })).matches[0]!.path, "-");
  assert.deepEqual((await findProjectFiles(workspace, { pattern: "-" })).files, ["-"]);
});

test("三工具的 JSON 输出有界，grep 长行不切断 UTF-8，过大 rg 记录明确失败", async (context) => {
  const workspace = await openWorkspace(await temporaryDirectory(context));
  for (let index = 0; index < 300; index++) await writeFile(join(workspace.rootPath, `${String(index).padStart(3, "0")}-${"a".repeat(180)}.txt`), "needle", "utf8");
  const results = [await listProjectDirectory(workspace), await findProjectFiles(workspace, { pattern: "*.txt" }), await grepProject(workspace, { pattern: "needle", context: 10, limit: 1000 })];
  for (const result of results) {
    assert.equal(result.truncatedBy, "bytes");
    assert.ok(Buffer.byteLength(JSON.stringify(result), "utf8") <= 50 * 1024);
  }
  await writeFile(join(workspace.rootPath, "long.txt"), "needle 中文🙂".repeat(1000), "utf8");
  const long = await grepProject(workspace, { pattern: "needle", path: "long.txt" });
  assert.equal(long.matches[0]!.textTruncated, true);
  assert.ok(Buffer.byteLength(long.matches[0]!.text) <= 1024);
  assert.ok(!long.matches[0]!.text.includes("\ufffd"));
  await writeFile(join(workspace.rootPath, "long.txt"), "needle" + "x".repeat(2 * 1024 * 1024), "utf8");
  await assert.rejects(grepProject(workspace, { pattern: "needle", path: "long.txt" }), /单条输出超过 1 MiB/);
  await writeFile(join(workspace.rootPath, "invalid.txt"), Buffer.from([0x6e, 0x65, 0x65, 0x64, 0x6c, 0x65, 0xff]));
  await assert.rejects(grepProject(workspace, { pattern: "needle", path: "invalid.txt" }), /有效的 UTF-8/);
});

test("无效参数、未声明工具和预先取消不搜索文件，缺少 rg 不影响 ls/read", async (context) => {
  const workspace = await searchFixture(context);
  const tools = createToolSet(workspace);
  const invalid = [
    ["ls", { path: null }], ["ls", { path: "../outside" }], ["ls", { limit: 501 }],
    ["find", { pattern: "" }], ["find", { pattern: "*", limit: 1001 }], ["find", { pattern: "../*" }], ["find", { pattern: "*", path: "notes.txt" }],
    ["grep", { pattern: "needle", context: null }], ["grep", { pattern: "needle", context: 11 }], ["grep", { pattern: "needle", literal: 1 }],
    ["grep", { pattern: "needle", ignoreCase: null }], ["grep", { pattern: "needle", glob: "src\\*" }],
    ["grep", { pattern: "needle", rgPath: "C:/fake.exe" }], ["grep", { pattern: "needle", path: ".git/file" }],
  ] as const;
  for (const [name, args] of invalid) assert.equal(JSON.parse(await tools.execute(name, JSON.stringify(args))).status, "error", JSON.stringify(args));
  for (const [name, args] of [["ls", {}], ["find", { pattern: "*" }], ["grep", { pattern: "needle" }]]) {
    assert.equal(JSON.parse(await tools.execute(name as string, JSON.stringify(args), AbortSignal.abort())).status, "cancelled");
    assert.equal(JSON.parse(await createToolSet().execute(name as string, JSON.stringify(args))).status, "error");
  }
  const previous = process.env.TILOT_RG_PATH;
  process.env.TILOT_RG_PATH = workspace.rootPath;
  context.after(() => { if (previous === undefined) delete process.env.TILOT_RG_PATH; else process.env.TILOT_RG_PATH = previous; });
  await assert.rejects(findProjectFiles(workspace, { pattern: "*" }), /TILOT_RG_PATH/);
  assert.equal((await listProjectDirectory(workspace)).truncated, false);
  assert.equal((await readFile(join(workspace.rootPath, "notes.txt"), "utf8")), "needle note");
  assert.equal(JSON.parse(await tools.execute("read", '{"path":"notes.txt"}')).status, "ok");
});

test("流中取消和截断会等待所有 rg 进程退出，包括 glob 交集的两路枚举", async (context) => {
  const workspace = await openWorkspace(await temporaryDirectory(context));
  await writeFile(join(workspace.rootPath, "many.txt"), "needle\n".repeat(50000), "utf8");
  const executable = await resolveRipgrep();
  const children: ChildProcess[] = [];
  const spawn = childProcess.spawn;
  context.mock.method(childProcess, "spawn", (command: string, args: readonly string[], options: SpawnOptions) => {
    const child = spawn(command, args, options); children.push(child); return child;
  });
  const controller = new AbortController();
  await assert.rejects(async () => {
    for await (const _record of ripgrepRecords(executable, workspace.rootPath, ["--json", "--", "needle", "many.txt"], "\n", controller.signal)) controller.abort();
  }, { name: "AbortError" });
  for (let index = 0; index < 5; index++) await writeFile(join(workspace.rootPath, `${index}.txt`), "needle", "utf8");
  assert.equal((await findProjectFiles(workspace, { pattern: "*.txt", limit: 1 })).truncated, true);
  assert.ok(children.length >= 3);
  for (const child of children) {
    assert.ok(child.exitCode !== null || child.signalCode !== null);
    assert.throws(() => process.kill(child.pid!, 0), { code: "ESRCH" });
  }
});
