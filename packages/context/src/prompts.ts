import { readFileSync } from "node:fs";

/** 应用自带的提示词正文，不接受项目路径或用户提供的任意文件名。 */
export type PromptName = "system" | "project-instructions" | "skills" | "resume" | "unknown-tool-result";

/** 按模块位置读取 UTF-8 Markdown，不缓存；编辑后下一次使用即生效。 */
export function readPrompt(name: PromptName): string {
  const path = new URL(`../prompts/${name}.md`, import.meta.url);
  let text: string;
  try { text = new TextDecoder("utf-8", { fatal: true }).decode(readFileSync(path)).trim(); }
  catch (error) { throw new Error(`无法读取内置提示词 ${name}.md，请检查文件及 UTF-8 编码。`, { cause: error }); }
  if (!text) throw new Error(`内置提示词 ${name}.md 不能为空。`);
  return text;
}
