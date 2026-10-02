import childProcess from "node:child_process";
import { stat } from "node:fs/promises";
import { delimiter, isAbsolute, join } from "node:path";
import { TextDecoder } from "node:util";
import { decodeText } from "./text.ts";
import { resolveWorkspacePath, type Workspace } from "./workspace.ts";

const MAX_RECORD_BYTES = 1024 * 1024;

/** 执行路径只从宿主环境取得，不接受模型参数，也不在调用期间下载程序。 */
export async function resolveRipgrep(): Promise<string> {
  const configured = process.env.TILOT_RG_PATH;
  if (configured !== undefined) {
    if (!isAbsolute(configured) || !(await stat(configured)).isFile()) throw new Error("TILOT_RG_PATH 必须指向 rg 的绝对文件路径。");
    return configured;
  }
  const executable = process.platform === "win32" ? "rg.exe" : "rg";
  for (const entry of (process.env.PATH ?? "").split(delimiter)) {
    const directory = entry.replace(/^"|"$/g, "");
    if (!isAbsolute(directory)) continue;
    const path = join(directory, executable);
    try { if ((await stat(path)).isFile()) return path; }
    catch (error) { if (!["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error; }
  }
  throw new Error("未找到 ripgrep（rg）。请安装并加入 PATH，或用 TILOT_RG_PATH 指定绝对路径；其他工具仍可使用。");
}

/** 增量读取一条条记录；迭代等待提供背压，停止或报错时杀死并等待 rg 退出。 */
export async function* ripgrepRecords(executable: string, cwd: string, args: string[], separator: "\0" | "\n", signal: AbortSignal): AsyncGenerator<string> {
  signal.throwIfAborted();
  const child = childProcess.spawn(executable, ["--no-config", ...args], { cwd, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  let spawnError: Error | undefined;
  let exited = false;
  let stderr = "";
  const closed = new Promise<number | null>((resolve) => {
    child.once("error", (error) => { spawnError = error; });
    child.once("close", (code) => { exited = true; resolve(code); });
  });
  child.stderr.setEncoding("utf8").on("data", (chunk: string) => { stderr = (stderr + chunk).slice(0, 4096); });
  const abort = () => { if (!exited) child.kill(); };
  signal.addEventListener("abort", abort, { once: true });
  const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
  let pending = "";
  try {
    signal.throwIfAborted();
    for await (const chunk of child.stdout) {
      signal.throwIfAborted();
      pending += decodeText(decoder, chunk as Buffer, true, true);
      let end = pending.indexOf(separator);
      while (end !== -1) {
        signal.throwIfAborted();
        const record = pending.slice(0, end);
        if (Buffer.byteLength(record, "utf8") > MAX_RECORD_BYTES) throw new Error("rg 的单条输出超过 1 MiB，请缩小范围或用 shell 定向查看超长行。");
        if (record) yield record;
        pending = pending.slice(end + 1);
        end = pending.indexOf(separator);
      }
      if (Buffer.byteLength(pending, "utf8") > MAX_RECORD_BYTES) throw new Error("rg 的单条输出超过 1 MiB，请缩小范围或用 shell 定向查看超长行。");
    }
    pending += decodeText(decoder, undefined, false, true);
    if (pending) throw new Error("rg 输出未以完整记录结束。");
    const code = await closed;
    signal.throwIfAborted();
    if (spawnError) throw new Error(`无法启动 rg：${spawnError.message}`);
    if (code !== 0 && code !== 1) throw new Error(stderr.trim() || `rg 执行失败，退出码 ${code}。`);
  } finally {
    signal.removeEventListener("abort", abort);
    abort();
    await closed;
  }
}

/** rg 路径转换成可交给 read 的项目相对路径，禁止模型看到宿主绝对路径。 */
export function ripgrepPath(path: string): string {
  const normalized = path.replaceAll("\\", "/");
  return normalized.startsWith("./") ? normalized.slice(2) : normalized;
}

/** 目录枚举遵守忽略规则；glob 查询与正常枚举取交集，不让 --glob 覆盖 .gitignore。 */
export async function* projectFiles(workspace: Workspace, path: string, executable: string, signal: AbortSignal, glob?: string): AsyncGenerator<string> {
  if (path.split("/").some((part) => part.toLowerCase() === ".git")) throw new Error("搜索工具不访问 .git 目录。");
  const target = await resolveWorkspacePath(workspace, path);
  if (!(await stat(target)).isDirectory()) throw new Error("find 的起点必须是项目目录。");
  const enumerate = (pattern?: string) => ripgrepRecords(executable, workspace.rootPath, [
    "--files", "--null", "--hidden", "--no-follow", "--no-require-git", "--sort", "path", "--path-separator", "/",
    ...(pattern === undefined ? [] : [`--glob=${pattern}`]), "--iglob=!.git", "--", path ? `./${path}` : ".",
  ], "\0", signal);
  const eligible = enumerate();
  if (glob === undefined) {
    for await (const file of eligible) yield ripgrepPath(file);
    return;
  }
  const selected = enumerate(glob);
  try {
    let left = await eligible.next();
    let right = await selected.next();
    while (!left.done && !right.done) {
      if (left.value === right.value) {
        yield ripgrepPath(left.value);
        left = await eligible.next(); right = await selected.next();
      } else if (Buffer.compare(Buffer.from(left.value, "utf8"), Buffer.from(right.value, "utf8")) < 0) left = await eligible.next();
      else right = await selected.next();
    }
  } finally { await Promise.all([eligible.return(undefined), selected.return(undefined)]); }
}
