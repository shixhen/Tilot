import { projectFiles, resolveRipgrep } from "./ripgrep.ts";
import { SearchBuffer, searchLimit, searchPath, searchPattern, withSearchTimeout } from "./search.ts";
import { validateKeys, type Tool } from "./tool.ts";
import { resolveWorkspacePath, type Workspace } from "./workspace.ts";

const MAX_FILES = 1000;
/** 按 glob 查找文件；path 只限制搜索起点，返回值始终相对项目根目录。 */
export interface FindInput { pattern: string; path?: string; limit?: number }

/** find 与 grep 共用宿主 rg，glob 匹配交给 rg，不增加另一套匹配器。 */
export function createFindTool(workspace: Workspace): Tool {
  return { definition: { type: "function", name: "find", strict: false,
    description: `按 rg glob 查找项目文件，包含隐藏文件，遵守 .gitignore/.ignore/.rgignore，排除 .git，不跟随内部链接。*.ts 匹配各层文件名，src/**/*.ts 相对项目根目录；path 只限制起点，不改变 glob 的基准。默认及最多 ${MAX_FILES} 条，JSON 正文最多 50 KiB；truncated 表示应缩小范围。返回项目相对路径，可直接交给 read。搜索最多 30 秒，宿主必须提供 rg。`,
    parameters: { type: "object", additionalProperties: false, required: ["pattern"], properties: {
      pattern: { type: "string", description: "单行 rg glob，例如 *.ts 或 src/**/*.ts，最多 2 KiB；使用 /。" },
      path: { type: "string", description: "搜索目录的项目相对路径；省略或空字符串表示根目录。" },
      limit: { type: "integer", minimum: 1, maximum: MAX_FILES, description: `最多返回文件数，默认 ${MAX_FILES}。` },
    } },
  }, async execute(args, signal) {
    validateKeys(args, ["pattern", "path", "limit"]);
    return findProjectFiles(workspace, { pattern: searchPattern(args.pattern, "pattern", true), path: searchPath(args.path), limit: searchLimit(args.limit, MAX_FILES, MAX_FILES) }, signal);
  } };
}

/** 迭代文件名并验证项目边界，达到结果预算后关闭全部枚举进程。 */
export async function findProjectFiles(workspace: Workspace, input: FindInput, signal?: AbortSignal) {
  const path = searchPath(input.path);
  const pattern = searchPattern(input.pattern, "pattern", true);
  const result = new SearchBuffer<string>(searchLimit(input.limit, MAX_FILES, MAX_FILES), path);
  return withSearchTimeout(signal, async (signal) => {
    const executable = await resolveRipgrep();
    for await (const file of projectFiles(workspace, path, executable, signal, pattern)) {
      signal.throwIfAborted();
      await resolveWorkspacePath(workspace, file);
      if (!result.add(file)) break;
    }
    return { path, files: result.items, ...result.state };
  });
}
