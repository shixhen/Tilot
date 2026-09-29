import { lstat, open, readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { parseDocument } from "yaml";
import { PROJECT_INSTRUCTIONS_LABEL, SKILLS_INSTRUCTIONS } from "@tilot/prompts";

/** 只提供技能索引，不自动把正文加入上下文。 */
export interface SkillMetadata { name: string; description: string; path: string }

/** 项目根指令与技能元数据，每次模型请求前重新读取。 */
export interface ProjectContext { instructions: string; skills: SkillMetadata[] }

/** 缺少可选文件时返回空；权限错误、内部链接及错误类型明确报告。 */
async function existsAs(path: string, kind: "file" | "directory"): Promise<boolean> {
  try {
    const info = await lstat(path);
    if (info.isSymbolicLink()) throw new Error(`项目上下文不允许内部链接：${path}`);
    if (kind === "file" ? !info.isFile() : !info.isDirectory()) throw new Error(`项目上下文路径类型错误：${path}`);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

/** 严格解码 UTF-8，损坏的项目指令不能被静默替换字符后发送。 */
function decode(bytes: Uint8Array, path: string): string {
  try { return new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
  catch { throw new Error(`项目上下文文件不是 UTF-8：${path}`); }
}

/** 只扫描文件开头的 YAML 区域；正文不解析、不注入，元数据最多 64 KiB。 */
async function readSkill(path: string, relativePath: string, signal?: AbortSignal): Promise<SkillMetadata> {
  const file = await open(path, "r");
  try {
    const fileSize = (await file.stat()).size;
    const chunks: Buffer[] = [];
    const block = Buffer.alloc(4096);
    for (let size = 0; size < 65536;) {
      signal?.throwIfAborted();
      const { bytesRead } = await file.read(block, 0, Math.min(block.length, 65536 - size), null);
      if (!bytesRead) break;
      chunks.push(Buffer.from(block.subarray(0, bytesRead)));
      size += bytesRead;
      const bytes = Buffer.concat(chunks);
      // latin1 仅用于定位 ASCII 分隔符，避免解码跨块 UTF-8 字符或技能正文。
      const matched = /^(?:\xef\xbb\xbf)?---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(bytes.toString("latin1"));
      if (!matched) continue;
      if (matched[0].length === bytes.length && !matched[0].endsWith("\n") && size < fileSize) continue;
      const yaml = decode(Buffer.from(matched[1]!, "latin1"), relativePath);
      const document = parseDocument(yaml, { prettyErrors: false });
      if (document.errors.length || document.warnings.length) throw new Error(`技能元数据 YAML 无效：${relativePath}`);
      const name = document.get("name");
      const description = document.get("description");
      if (typeof name !== "string" || !name.trim() || typeof description !== "string" || !description.trim()) {
        throw new Error(`技能元数据必须包含非空 name 和 description：${relativePath}`);
      }
      return { name: name.trim(), description: description.trim(), path: relativePath };
    }
    throw new Error(`技能缺少完整 YAML 元数据或元数据超过 64 KiB：${relativePath}`);
  } finally { await file.close(); }
}

/** 只加载根目录 AGENTS.md 和 .codex/skills 各技能目录的 SKILL.md，不搜索父目录或全局目录。 */
export async function loadProjectContext(root: string, signal?: AbortSignal): Promise<ProjectContext> {
  signal?.throwIfAborted();
  const result: ProjectContext = { instructions: "", skills: [] };
  const agents = join(root, "AGENTS.md");
  if (await existsAs(agents, "file")) result.instructions = decode(await readFile(agents, { signal }), "AGENTS.md");
  if (!await existsAs(join(root, ".codex"), "directory")) return result;
  const directory = join(root, ".codex", "skills");
  if (!await existsAs(directory, "directory")) return result;
  const names = new Set<string>();
  for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    signal?.throwIfAborted();
    if (entry.isSymbolicLink() || !entry.isDirectory()) continue;
    const relativePath = `.codex/skills/${entry.name}/SKILL.md`;
    const path = join(directory, entry.name, "SKILL.md");
    if (!await existsAs(path, "file")) continue;
    const skill = await readSkill(path, relativePath, signal);
    if (names.has(skill.name)) throw new Error(`技能名称重复：${skill.name}`);
    names.add(skill.name);
    result.skills.push(skill);
  }
  return result;
}

/** 将根指令和技能索引追加到系统策略；技能正文保持按需读取。 */
export function appendProjectInstructions(base: string, project: ProjectContext): string {
  const sections = [base];
  if (project.instructions.trim()) sections.push(`${PROJECT_INSTRUCTIONS_LABEL}\n${project.instructions}`);
  if (project.skills.length) sections.push(`${SKILLS_INSTRUCTIONS}\n${JSON.stringify(project.skills)}`);
  return sections.filter(Boolean).join("\n\n");
}
