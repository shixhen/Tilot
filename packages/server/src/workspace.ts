import { realpath, stat } from "node:fs/promises";
import { isAbsolute } from "node:path";

/** 用户选中的项目目录；rootPath 是解析符号链接后的绝对路径。 */
export interface Workspace {
  readonly rootPath: string;
}

/** 验证用户选择的绝对目录路径，返回项目根目录；路径无效时抛出错误。 */
export async function openWorkspace(directory: string): Promise<Workspace> {
  if (!isAbsolute(directory)) {
    throw new Error("项目目录必须是绝对路径。");
  }

  const rootPath = await realpath(directory);
  const info = await stat(rootPath);

  if (!info.isDirectory()) {
    throw new Error("请选择目录，不能选择文件。");
  }

  return { rootPath };
}
