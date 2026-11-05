import assert from "node:assert/strict";
import { copyFileSync, mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { test, type TestContext } from "node:test";
import { readPrompt } from "@tilot/context";

/** 在独立位置运行同一读取模块，修改临时文件不会影响其他并行测试或实际提示词。 */
async function fixture(context: TestContext) {
  const root = mkdtempSync(join(tmpdir(), "tilot-prompts-"));
  context.after(() => {
    assert.equal(dirname(root), resolve(tmpdir()));
    rmSync(root, { recursive: true, force: true });
  });
  const directory = join(root, "中文 提示词#");
  mkdirSync(join(directory, "src"), { recursive: true });
  mkdirSync(join(directory, "prompts"));
  writeFileSync(join(directory, "package.json"), '{"type":"module"}', "utf8");
  const modulePath = join(directory, "src/prompts.ts");
  copyFileSync(new URL("../src/prompts.ts", import.meta.url), modulePath);
  const loader: typeof import("../src/prompts.ts") = await import(pathToFileURL(modulePath).href);
  return { directory, path: join(directory, "prompts/system.md"), read: () => loader.readPrompt("system") };
}

test("内置 Markdown 提示词均可读取，正文不再嵌在 TypeScript 常量中", () => {
  for (const name of ["system", "project-instructions", "skills", "resume", "unknown-tool-result", "cancelled-turn", "failed-turn", "interrupted-turn"] as const) {
    assert.ok(readPrompt(name).length > 0);
  }
  assert.match(readPrompt("system"), /你是 Tilot/);
  assert.match(readPrompt("resume"), /先核实已有修改和执行结果/);
});

test("提示词相对模块定位，UTF-8 中文与 Markdown 原样保留，修改后再次读取立即生效", async (context) => {
  const prompt = await fixture(context);
  writeFileSync(prompt.path, "\ufeff# 系统策略\n\n- 中文规则🙂\n", "utf8");
  assert.equal(prompt.read(), "# 系统策略\n\n- 中文规则🙂");
  writeFileSync(prompt.path, "更新后的策略", "utf8");
  assert.equal(prompt.read(), "更新后的策略");
});

test("提示词丢失、空白和编码损坏明确报错，不回退到已读取内容", async (context) => {
  const prompt = await fixture(context);
  writeFileSync(prompt.path, "有效策略", "utf8");
  assert.equal(prompt.read(), "有效策略");
  renameSync(prompt.path, join(prompt.directory, "prompts/system.backup.md"));
  assert.throws(prompt.read, /无法读取内置提示词 system.md/);
  writeFileSync(prompt.path, " \n\r\n", "utf8");
  assert.throws(prompt.read, /不能为空/);
  writeFileSync(prompt.path, Buffer.from([0xff, 0xfe]));
  assert.throws(prompt.read, /UTF-8/);
});
