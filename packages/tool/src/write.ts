import { lstat, mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { pathSegments, resolveWorkspacePath, type Workspace } from "./workspace.ts";

/** 创建或覆盖文件的参数；内容以 UTF-8 原样保存。 */
export interface WriteInput { path: string; content: string }

/** 文件修改结果，不将整个文件再次塞进模型上下文。 */
export interface WriteResult { path: string; bytesWritten: number }

/** 检查目标文件，允许尚不存在的文件，但拒绝目录及内部链接。 */
async function checkTarget(workspace: Workspace, path: string): Promise<void> {
  try {
    const target = await resolveWorkspacePath(workspace, path);
    if (!(await lstat(target)).isFile()) throw new Error("目标必须是普通文件。");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

/** 逐层验证并创建父目录，不能通过现有目录链接走出项目。 */
async function prepareTarget(workspace: Workspace, path: string, signal?: AbortSignal): Promise<string> {
  const segments = pathSegments(path);
  if (segments.length === 0) throw new Error("文件路径不能为空。");
  let parent = await resolveWorkspacePath(workspace, "");
  for (let index = 0; index < segments.length - 1; index++) {
    signal?.throwIfAborted();
    const relativePath = segments.slice(0, index + 1).join("/");
    try {
      parent = await resolveWorkspacePath(workspace, relativePath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      await mkdir(join(parent, segments[index]!));
      parent = await resolveWorkspacePath(workspace, relativePath);
    }
    if (!(await lstat(parent)).isDirectory()) throw new Error("父路径必须是目录。");
  }
  await checkTarget(workspace, path);
  return join(parent, segments.at(-1)!);
}

/** 同目录临时写入后替换；取消和写入失败时清理临时文件，不截断原文件。 */
async function replaceFile(workspace: Workspace, path: string, target: string, content: string, signal?: AbortSignal): Promise<WriteResult> {
  signal?.throwIfAborted();
  const temporary = join(dirname(target), `.tilot-${randomUUID()}.tmp`);
  let created = false;
  try {
    // 不向 writeFile 传取消信号：等待临时写入结束后再检查，确保可以完整清理。
    const file = await open(temporary, "wx");
    created = true;
    try { await file.writeFile(content, "utf8"); }
    finally { await file.close(); }
    signal?.throwIfAborted();
    await checkTarget(workspace, path);
    signal?.throwIfAborted();
    await rename(temporary, target);
    created = false;
    return { path, bytesWritten: Buffer.byteLength(content, "utf8") };
  } finally {
    if (created) await unlink(temporary);
  }
}

/** 创建或覆盖项目内文件，自动创建缺少的父目录。 */
export async function writeProjectFile(workspace: Workspace, input: WriteInput, signal?: AbortSignal): Promise<WriteResult> {
  signal?.throwIfAborted();
  if (typeof input.path !== "string" || typeof input.content !== "string") throw new Error("path 和 content 必须是字符串。");
  const target = await prepareTarget(workspace, input.path, signal);
  return replaceFile(workspace, input.path, target, input.content, signal);
}

/** 精确替换一个唯一匹配的文本片段，不自动转换换行或去除 BOM。 */
export interface EditInput { path: string; oldText: string; newText: string }

/** 编辑 UTF-8 文件；无匹配或多处匹配均不修改文件。 */
export async function editProjectFile(workspace: Workspace, input: EditInput, signal?: AbortSignal): Promise<WriteResult> {
  signal?.throwIfAborted();
  if (typeof input.path !== "string" || typeof input.oldText !== "string" || typeof input.newText !== "string") throw new Error("path、oldText 和 newText 必须是字符串。");
  if (!input.oldText) throw new Error("oldText 不能为空；创建或完整覆盖文件请使用 write。");
  const target = await resolveWorkspacePath(workspace, input.path);
  if (!(await lstat(target)).isFile()) throw new Error("目标必须是普通文件。");
  const bytes = await readFile(target);
  let content: string;
  try { content = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes); }
  catch { throw new Error("文件不是有效的 UTF-8 文本。"); }
  if (/[\x00-\x08\x0e-\x1f\x7f]/.test(content)) throw new Error("文件含有二进制控制字符，不能编辑。");
  const start = content.indexOf(input.oldText);
  if (start < 0) throw new Error("未找到 oldText，请重新读取文件并核对原文和换行。");
  if (content.indexOf(input.oldText, start + 1) !== -1) throw new Error("oldText 匹配多处，请提供更多上下文以唯一定位。");
  if (input.oldText === input.newText) throw new Error("新旧文本相同，没有需要修改的内容。");
  const updated = content.slice(0, start) + input.newText + content.slice(start + input.oldText.length);
  return replaceFile(workspace, input.path, target, updated, signal);
}
