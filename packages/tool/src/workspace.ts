import { lstat, realpath, stat } from "node:fs/promises";
import { isAbsolute, join, relative, sep } from "node:path";

/** 用户选中的项目目录；rootPath 是解析根目录链接后的绝对路径。 */
export interface Workspace {
  readonly rootPath: string;
}

/** 验证用户选择的绝对目录，允许根目录本身是链接，保存其真实路径。 */
export async function openWorkspace(directory: string): Promise<Workspace> {
  if (!isAbsolute(directory)) throw new Error("项目目录必须是绝对路径。");
  const rootPath = await realpath(directory);
  if (!(await stat(rootPath)).isDirectory()) {
    throw new Error("请选择目录，不能选择文件。");
  }
  return { rootPath };
}

/** 检查工具使用的项目相对路径；统一使用 /，空字符串表示项目根目录。 */
export function pathSegments(path: string): string[] {
  if (path === "") return [];
  const segments = path.split("/");
  if (segments.some((segment) =>
    segment === "" || segment === "." || segment === ".." ||
    /[\\:<>"|?*\x00-\x1f]/.test(segment) ||
    /[. ]$/.test(segment) ||
    /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(segment)
  )) {
    throw new Error("请使用项目内以 / 分隔的相对路径，不能包含 ..、绝对路径或 Windows 特殊文件名。");
  }
  return segments;
}

/** 解析已存在的项目内路径，逐层拒绝符号链接和目录联接，再核对真实路径边界。 */
export async function resolveWorkspacePath(workspace: Workspace, path: string): Promise<string> {
  const segments = pathSegments(path);
  if (await realpath(workspace.rootPath) !== workspace.rootPath) {
    throw new Error("项目根目录已发生变化，请重新选择项目。");
  }
  let target = workspace.rootPath;
  for (const segment of segments) {
    target = join(target, segment);
    if ((await lstat(target)).isSymbolicLink()) {
      throw new Error("不允许访问项目内部的符号链接或目录联接。");
    }
  }
  const resolved = await realpath(target);
  const fromRoot = relative(workspace.rootPath, resolved);
  if (isAbsolute(fromRoot) || fromRoot === ".." || fromRoot.startsWith(`..${sep}`)) {
    throw new Error("路径超出项目目录。");
  }
  return resolved;
}
