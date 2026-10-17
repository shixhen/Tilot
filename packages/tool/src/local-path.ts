import { lstat, realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, parse, relative, resolve, sep } from "node:path";
import { pathSegments, type Workspace } from "./workspace.ts";

/** 相对路径从对话工作目录开始；设备名、流路径和不完整盘符不能作为普通文件使用。 */
function absolutePath(workspace: Workspace, path: string): string {
  if (typeof path !== "string" || !path.isWellFormed() || /[\x00-\x1f]/.test(path) ||
      (process.platform === "win32" && (/^\\\\[?.]\\/.test(path) || /^[a-z]:($|[^\\/])/i.test(path) || /^\\(?!\\)/.test(path)))) {
    throw new Error("文件路径无效，请使用普通文件的相对路径或完整绝对路径。");
  }
  const target = resolve(workspace.rootPath, path);
  pathSegments(relative(parse(target).root, target).split(sep).join("/"));
  return target;
}

/** 所有权限模式都可以读取项目外文件；读取允许解析链接。 */
export async function resolveLocalPath(workspace: Workspace, path: string): Promise<string> {
  return realpath(absolutePath(workspace, path));
}

/** 只读解析尚不存在的写入目标，不创建目录；现有父目录链接按真实位置判断权限。 */
export async function localWriteLocation(workspace: Workspace, path: string, expectedTarget?: string) {
  if (!path) throw new Error("文件路径不能为空。");
  const target = absolutePath(workspace, path);
  try {
    if ((await lstat(target)).isSymbolicLink()) throw new Error("不能直接替换文件链接，请使用目标文件的真实路径。");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const missing = [basename(target)];
  let parent = dirname(target);
  while (true) {
    try {
      const rootPath = await realpath(parent);
      const local = missing.join("/");
      pathSegments(local);
      const resolved = join(rootPath, ...missing);
      if (expectedTarget !== undefined && resolved !== expectedTarget) throw new Error("写入目标路径已变化，请重新发起调用。");
      return { workspace: { rootPath }, path: local, target: resolved };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT" || dirname(parent) === parent) throw error;
      missing.unshift(basename(parent));
      parent = dirname(parent);
    }
  }
}

/** canonical 路径比较，避免把相似目录名误判为项目内。 */
export function isWithinWorkspace(workspace: Workspace, target: string): boolean {
  const path = relative(workspace.rootPath, target);
  return !isAbsolute(path) && path !== ".." && !path.startsWith(`..${sep}`);
}

/** 输出项目内相对路径、项目外绝对路径，均可直接交给其他文件工具。 */
export function displayLocalPath(workspace: Workspace, target: string): string {
  return (isWithinWorkspace(workspace, target) ? relative(workspace.rootPath, target) : target).split(sep).join("/");
}
