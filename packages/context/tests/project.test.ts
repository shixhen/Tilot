import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test, type TestContext } from "node:test";
import { appendProjectInstructions, loadProjectContext } from "@tilot/context";

/** 创建独立项目，清理时验证目标仍位于系统临时目录。 */
async function project(context: TestContext): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "tilot-instructions-"));
  context.after(async () => {
    assert.equal(dirname(root), resolve(tmpdir()));
    await rm(root, { recursive: true, force: true });
  });
  return root;
}

test("仅加载 Tilot 技能与根指令，不读取其他应用目录或注入技能正文", async (context) => {
  const root = await project(context);
  await mkdir(join(root, ".tilot/skills/example"), { recursive: true });
  await mkdir(join(root, "src"));
  await writeFile(join(root, "AGENTS.md"), "\ufeff根目录规则", "utf8");
  await writeFile(join(root, "src/AGENTS.md"), "禁止加载的子目录规则", "utf8");
  await writeFile(join(root, ".tilot/skills/example/SKILL.md"), '\ufeff---\r\nname: example\r\ndescription: >-\r\n  第一行\r\n  第二行\r\n---\r\n不应自动加载的正文', "utf8");
  await mkdir(join(root, ".codex/skills/legacy"), { recursive: true });
  await writeFile(join(root, ".codex/skills/legacy/SKILL.md"), "其他应用的文件不参与解析", "utf8");
  const loaded = await loadProjectContext(root);
  assert.equal(loaded.instructions, "根目录规则");
  assert.deepEqual(loaded.skills, [{ name: "example", description: "第一行 第二行", path: ".tilot/skills/example/SKILL.md" }]);
  const instructions = appendProjectInstructions("系统策略", loaded);
  assert.match(instructions, /根目录规则/);
  assert.doesNotMatch(instructions, /不应自动加载的正文|禁止加载的子目录规则/);
  await writeFile(join(root, "AGENTS.md"), "更新后的规则", "utf8");
  assert.equal((await loadProjectContext(root)).instructions, "更新后的规则");
});

test("缺少配置不报错，非法元数据及重复技能名明确失败", async (context) => {
  const root = await project(context);
  assert.deepEqual(await loadProjectContext(root), { instructions: "", skills: [] });
  await mkdir(join(root, ".tilot/skills/a"), { recursive: true });
  const path = join(root, ".tilot/skills/a/SKILL.md");
  for (const source of ["没有元数据", "---\nname: a\n---\n", "---\nname: a\nname: b\ndescription: test\n---\n"]) {
    await writeFile(path, source, "utf8");
    await assert.rejects(loadProjectContext(root), /元数据|YAML/);
  }
  const valid = "---\nname: a\ndescription: test\n---\n正文";
  await writeFile(path, valid, "utf8");
  await mkdir(join(root, ".tilot/skills/b"));
  await writeFile(join(root, ".tilot/skills/b/SKILL.md"), valid, "utf8");
  await assert.rejects(loadProjectContext(root), /名称重复/);
});

test("不通过项目内目录链接加载外部技能，预先取消不读取", async (context) => {
  const root = await project(context);
  const external = await project(context);
  await symlink(external, join(root, ".tilot"), "junction");
  await assert.rejects(loadProjectContext(root), /内部链接/);
  await assert.rejects(loadProjectContext(root, AbortSignal.abort()), { name: "AbortError" });
});

test("项目技能覆盖同名全局技能，全局冲突项都跳过并报告文件", async (context) => {
  const root = await project(context);
  const globalDirectory = join(await project(context), ".tilot", "skills");
  const projectDirectory = join(root, ".tilot", "skills");
  for (const [directory, folder, name, description] of [
    [projectDirectory, "review", "review", "项目审查流程"],
    [globalDirectory, "shared-review", "review", "全局审查流程"],
    [globalDirectory, "docs", "docs", "全局文档流程"],
    [globalDirectory, "duplicate-a", "duplicate", "冲突版本 A"],
    [globalDirectory, "duplicate-b", "duplicate", "冲突版本 B"],
  ] as const) {
    const skillDirectory = join(directory, folder);
    await mkdir(skillDirectory, { recursive: true });
    await writeFile(join(skillDirectory, "SKILL.md"), `---\nname: ${name}\ndescription: ${description}\n---\n正文`, "utf8");
  }

  const loaded = await loadProjectContext(root, undefined, globalDirectory);
  assert.deepEqual(loaded.skills, [
    { name: "review", description: "项目审查流程", path: ".tilot/skills/review/SKILL.md" },
    { name: "docs", description: "全局文档流程", path: join(globalDirectory, "docs", "SKILL.md") },
  ]);
  assert.equal(loaded.warnings?.length, 1);
  const warning = loaded.warnings![0]!;
  assert.match(warning, /同名全局技能 duplicate/);
  assert.ok(warning.includes(join(globalDirectory, "duplicate-a", "SKILL.md")));
  assert.ok(warning.includes(join(globalDirectory, "duplicate-b", "SKILL.md")));
});
