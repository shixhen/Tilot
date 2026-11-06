import { lstat, open, readFile, readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { parseDocument } from "yaml";
import { readPrompt } from "./prompts.ts";

/** 只提供技能索引，不自动把正文加入上下文。 */
export interface SkillMetadata { name: string; description: string; path: string }

/** 项目根指令与技能元数据，每次模型请求前重新读取。 */
export interface ProjectContext { instructions: string; skills: SkillMetadata[]; warnings?: string[] }

/** 缺少可选文件时返回空；权限错误、内部链接及错误类型明确报告。 */
async function existsAs(path: string, kind: "file" | "directory"): Promise<boolean> {
  try {
    const info = await lstat(path);
    if (info.isSymbolicLink()) throw new Error(`上下文不允许内部链接：${path}`);
    if (kind === "file" ? !info.isFile() : !info.isDirectory()) throw new Error(`上下文路径类型错误：${path}`);
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
async function readSkill(path: string, reference: string, signal?: AbortSignal): Promise<SkillMetadata> {
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
      const yaml = decode(Buffer.from(matched[1]!, "latin1"), reference);
      const document = parseDocument(yaml, { prettyErrors: false });
      if (document.errors.length || document.warnings.length) throw new Error(`技能元数据 YAML 无效：${reference}`);
      const name = document.get("name");
      const description = document.get("description");
      if (typeof name !== "string" || !name.trim() || typeof description !== "string" || !description.trim()) {
        throw new Error(`技能元数据必须包含非空 name 和 description：${reference}`);
      }
      return { name: name.trim(), description: description.trim(), path: reference };
    }
    throw new Error(`技能缺少完整 YAML 元数据或元数据超过 64 KiB：${reference}`);
  } finally { await file.close(); }
}

/** 两种技能来源共用文件和元数据校验。全局错误作为通知交给宿主。 */
async function scanSkills(directory: string, scope: "project" | "global", signal?: AbortSignal) {
  const skills: SkillMetadata[] = [];
  const warnings: string[] = [];
  function report(error: unknown, path: string): void {
    signal?.throwIfAborted();
    if (scope === "project") throw error;
    const reason = error instanceof Error ? error.message : String(error);
    warnings.push(`已跳过全局技能。${reason.includes(path) ? reason : `${path} ${reason}`}`);
  }

  let entries;
  try {
    if (!await existsAs(dirname(directory), "directory") || !await existsAs(directory, "directory")) return { skills, warnings };
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    report(error, directory);
    return { skills, warnings };
  }
  const byName = new Map<string, SkillMetadata[]>();
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    signal?.throwIfAborted();
    if (entry.isSymbolicLink() || !entry.isDirectory()) continue;
    const path = join(directory, entry.name, "SKILL.md");
    const reference = scope === "project" ? `.tilot/skills/${entry.name}/SKILL.md` : path;
    let skill: SkillMetadata;
    try {
      if (!await existsAs(path, "file")) continue;
      skill = await readSkill(path, reference, signal);
    } catch (error) {
      report(error, path);
      continue;
    }
    const group = byName.get(skill.name);
    if (!group) byName.set(skill.name, [skill]);
    else if (scope === "project") throw new Error(`技能名称重复：${skill.name}`);
    else group.push(skill);
  }
  for (const [name, group] of byName) {
    if (group.length === 1) skills.push(group[0]!);
    else warnings.push(`已跳过同名全局技能 ${name}。冲突文件：${group.map((skill) => skill.path).join("、")}`);
  }
  return { skills, warnings };
}

/** 加载根目录指令及项目、全局技能索引。同名时项目技能优先。 */
export async function loadProjectContext(root: string, signal?: AbortSignal, globalSkillsDirectory?: string): Promise<ProjectContext> {
  signal?.throwIfAborted();
  const agents = join(root, "AGENTS.md");
  const instructions = await existsAs(agents, "file") ? decode(await readFile(agents, { signal }), "AGENTS.md") : "";
  const project = await scanSkills(join(root, ".tilot", "skills"), "project", signal);
  if (!globalSkillsDirectory) return { instructions, skills: project.skills };

  const global = await scanSkills(globalSkillsDirectory, "global", signal);
  const projectNames = new Set(project.skills.map((skill) => skill.name));
  return {
    instructions,
    skills: [...project.skills, ...global.skills.filter((skill) => !projectNames.has(skill.name))],
    ...(global.warnings.length ? { warnings: global.warnings } : {}),
  };
}

/** 将根指令和技能索引追加到系统策略；技能正文保持按需读取。 */
export function appendProjectInstructions(base: string, project: ProjectContext): string {
  const sections = [base];
  if (project.instructions.trim()) sections.push(`${readPrompt("project-instructions")}\n${project.instructions}`);
  if (project.skills.length) sections.push(`${readPrompt("skills")}\n${JSON.stringify(project.skills)}`);
  return sections.filter(Boolean).join("\n\n");
}
