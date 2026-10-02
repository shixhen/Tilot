import { lstat, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { SearchBuffer, searchLimit, searchPath } from "./search.ts";
import { validateKeys, type Tool } from "./tool.ts";
import { resolveWorkspacePath, type Workspace } from "./workspace.ts";

const MAX_ENTRIES = 500;
/** 非递归目录参数和结果；链接只显示名称与类型，不读取目标。 */
export interface LsInput { path?: string; limit?: number }
export interface DirectoryEntry { path: string; type: "file" | "directory" | "link" | "other" }

/** 声明与执行同模块，保持和 Pi 一样简单的目录工具。 */
export function createLsTool(workspace: Workspace): Tool {
  return { definition: { type: "function", name: "ls", strict: false,
    description: `非递归列出项目目录，包含隐藏项并稳定排序。省略 path 或空字符串表示项目根目录。默认及最多 ${MAX_ENTRIES} 项，JSON 正文最多 50 KiB；truncated 表示结果不完整，应缩小目录范围。条目路径可直接交给 read；link 只显示名称，不跟随或读取。`,
    parameters: { type: "object", additionalProperties: false, properties: {
      path: { type: "string", description: "项目目录相对路径，使用 /；省略或空字符串表示根目录。" },
      limit: { type: "integer", minimum: 1, maximum: MAX_ENTRIES, description: `最多返回条目数，默认 ${MAX_ENTRIES}。` },
    } },
  }, async execute(args, signal) {
    validateKeys(args, ["path", "limit"]);
    return listProjectDirectory(workspace, { path: searchPath(args.path), limit: searchLimit(args.limit, MAX_ENTRIES, MAX_ENTRIES) }, signal);
  } };
}

/** 按名称排序后检查条目类型；枚举时的 I/O 错误不伪造为空目录。 */
export async function listProjectDirectory(workspace: Workspace, input: LsInput = {}, signal?: AbortSignal) {
  const path = searchPath(input.path);
  const result = new SearchBuffer<DirectoryEntry>(searchLimit(input.limit, MAX_ENTRIES, MAX_ENTRIES), path);
  signal?.throwIfAborted();
  const directory = await resolveWorkspacePath(workspace, path);
  if (!(await stat(directory)).isDirectory()) throw new Error("ls 的起点必须是项目目录。");
  const names = (await readdir(directory)).sort();
  for (const name of names) {
    signal?.throwIfAborted();
    const entry = await lstat(join(directory, name));
    const type = entry.isSymbolicLink() ? "link" : entry.isDirectory() ? "directory" : entry.isFile() ? "file" : "other";
    if (!result.add({ path: path ? `${path}/${name}` : name, type })) break;
  }
  return { path, entries: result.items, ...result.state };
}
