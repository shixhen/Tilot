import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test, type TestContext } from "node:test";
import { appendProjectInstructions, checkContextBudget, loadProjectContext } from "@tilot/context";
import { DEFAULT_CONFIG } from "../../store/src/config.ts";

/** 创建独立项目，清理时验证目标仍位于系统临时目录。 */
async function project(context: TestContext): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "tilot-instructions-"));
  context.after(async () => {
    assert.equal(dirname(root), resolve(tmpdir()));
    await rm(root, { recursive: true, force: true });
  });
  return root;
}

test("仅加载根指令和技能名称描述路径，不注入正文或子目录指令", async (context) => {
  const root = await project(context);
  await mkdir(join(root, ".codex/skills/example"), { recursive: true });
  await mkdir(join(root, "src"));
  await writeFile(join(root, "AGENTS.md"), "\ufeff根目录规则", "utf8");
  await writeFile(join(root, "src/AGENTS.md"), "禁止加载的子目录规则", "utf8");
  await writeFile(join(root, ".codex/skills/example/SKILL.md"), '\ufeff---\r\nname: example\r\ndescription: >-\r\n  第一行\r\n  第二行\r\n---\r\n不应自动加载的正文', "utf8");
  const loaded = await loadProjectContext(root);
  assert.equal(loaded.instructions, "根目录规则");
  assert.deepEqual(loaded.skills, [{ name: "example", description: "第一行 第二行", path: ".codex/skills/example/SKILL.md" }]);
  const instructions = appendProjectInstructions("系统策略", loaded);
  assert.match(instructions, /根目录规则/);
  assert.doesNotMatch(instructions, /不应自动加载的正文|禁止加载的子目录规则/);
  await writeFile(join(root, "AGENTS.md"), "更新后的规则", "utf8");
  assert.equal((await loadProjectContext(root)).instructions, "更新后的规则");
});

test("缺少配置不报错，非法元数据及重复技能名明确失败", async (context) => {
  const root = await project(context);
  assert.deepEqual(await loadProjectContext(root), { instructions: "", skills: [] });
  await mkdir(join(root, ".codex/skills/a"), { recursive: true });
  const path = join(root, ".codex/skills/a/SKILL.md");
  for (const source of ["没有元数据", "---\nname: a\n---\n", "---\nname: a\nname: b\ndescription: test\n---\n"]) {
    await writeFile(path, source, "utf8");
    await assert.rejects(loadProjectContext(root), /元数据|YAML/);
  }
  const valid = "---\nname: a\ndescription: test\n---\n正文";
  await writeFile(path, valid, "utf8");
  await mkdir(join(root, ".codex/skills/b"));
  await writeFile(join(root, ".codex/skills/b/SKILL.md"), valid, "utf8");
  await assert.rejects(loadProjectContext(root), /名称重复/);
});

test("不通过项目内目录链接加载外部技能，预先取消不读取", async (context) => {
  const root = await project(context);
  const external = await project(context);
  await symlink(external, join(root, ".codex"), "junction");
  await assert.rejects(loadProjectContext(root), /内部链接/);
  await assert.rejects(loadProjectContext(root, AbortSignal.abort()), { name: "AbortError" });
});

test("预算包含指令、中文历史和工具声明，超限不裁剪原文", () => {
  const context = { instructions: "项目规则", input: [{ role: "user" as const, content: "中文🙂" }] };
  const tools = [{ type: "function" as const, name: "read", description: "读取", strict: false, parameters: {} }];
  const measured = checkContextBudget(context, tools, { ...DEFAULT_CONFIG });
  assert.equal(measured.estimatedInputTokens, Buffer.byteLength(JSON.stringify({ ...context, tools })));
  assert.ok(measured.estimatedInputTokens > checkContextBudget(context, [], { ...DEFAULT_CONFIG }).estimatedInputTokens);
  const limit = (contextTokens: number) => ({ ...DEFAULT_CONFIG, maxOutputTokens: 10, reserveTokens: 10,
    providers: [{ ...DEFAULT_CONFIG.providers[0]!, models: [{ id: DEFAULT_CONFIG.model, contextTokens }] }] });
  checkContextBudget(context, tools, limit(measured.estimatedInputTokens + 20));
  assert.throws(() => checkContextBudget(context, tools, limit(measured.estimatedInputTokens + 19)), /上下文超出预算/);
  assert.throws(() => checkContextBudget(context, tools, { ...DEFAULT_CONFIG, model: "missing" }), /模型列表中没有 missing/);
  assert.equal(context.input[0]!.content, "中文🙂");
});
