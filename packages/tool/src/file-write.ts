import { lstat, mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { pathSegments, resolveWorkspacePath, type Workspace } from "./workspace.ts";

/** 文件修改结果，不将整个文件再次塞进模型上下文。 */
export interface WriteResult { path: string; bytesWritten: number }

const mutationQueues = new Map<string, Promise<void>>();

/** 同一目标的修改按调用顺序排队，失败也释放队列；不同文件独立执行。 */
export async function withFileMutation<T>(
  workspace: Workspace, path: string, signal: AbortSignal | undefined, operation: () => Promise<T>,
): Promise<T> {
  const segments = pathSegments(path);
  if (segments.length === 0) throw new Error("文件路径不能为空。");
  // Workspace 根目录已由宿主解析为真实路径，模型路径不允许包含别名或内部链接。
  const target = join(workspace.rootPath, ...segments);
  const key = process.platform === "win32" ? target.toLowerCase() : target;
  const previous = mutationQueues.get(key) ?? Promise.resolve();
  let release!: () => void;
  const pending = new Promise<void>((resolve) => { release = resolve; });
  const current = previous.then(() => pending);
  mutationQueues.set(key, current);
  await previous;
  try {
    signal?.throwIfAborted();
    return await operation();
  } finally {
    release();
    if (mutationQueues.get(key) === current) mutationQueues.delete(key);
  }
}

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
export async function prepareTarget(workspace: Workspace, path: string, signal?: AbortSignal): Promise<string> {
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
      try { await mkdir(join(parent, segments[index]!)); }
      catch (error) {
        // 不同文件的并行写入可能同时创建同一个父目录，随后仍验证实际目录。
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
      parent = await resolveWorkspacePath(workspace, relativePath);
    }
    if (!(await lstat(parent)).isDirectory()) throw new Error("父路径必须是目录。");
  }
  await checkTarget(workspace, path);
  return join(parent, segments.at(-1)!);
}

/** 同目录临时写入后替换；rename 成功即已提交，不再把之后的取消当成未写入。 */
export async function replaceFile(
  workspace: Workspace, path: string, target: string, content: string, signal?: AbortSignal, expectedContent?: Buffer,
): Promise<WriteResult> {
  signal?.throwIfAborted();
  const temporary = join(dirname(target), `.tilot-${randomUUID()}.tmp`);
  let created = false;
  try {
    // 等待临时写入结束后再检查取消，不提前释放仍在执行 I/O 的修改队列。
    const file = await open(temporary, "wx");
    created = true;
    try { await file.writeFile(content, "utf8"); }
    finally { await file.close(); }
    signal?.throwIfAborted();
    await checkTarget(workspace, path);
    if (expectedContent !== undefined) {
      let current: Buffer;
      try { current = await readFile(target); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        throw new Error("文件已被外部修改或删除，请重新读取后再编辑。");
      }
      if (!current.equals(expectedContent)) throw new Error("文件已被外部修改，请重新读取后再编辑。");
    }
    signal?.throwIfAborted();
    await rename(temporary, target);
    created = false;
    return { path, bytesWritten: Buffer.byteLength(content, "utf8") };
  } finally {
    if (created) await unlink(temporary);
  }
}
