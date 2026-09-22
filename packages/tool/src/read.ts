import { open } from "node:fs/promises";
import { TextDecoder } from "node:util";
import { resolveWorkspacePath, type Workspace } from "./workspace.ts";

/** 读取项目文本文件的参数；offset 从 1 开始，limit 默认且最多为 200 行。 */
export interface ReadInput {
  path: string;
  offset?: number;
  limit?: number;
}

/** 一段原始文本及行范围；nextOffset 非空表示还有内容，可以从该行继续读取。 */
export interface ReadResult {
  path: string;
  content: string;
  offset: number;
  lineCount: number;
  nextOffset: number | null;
}

/** 解码一个 UTF-8 数据块；保留换行，拒绝无效编码和常见二进制控制字符。 */
function decodeText(decoder: TextDecoder, bytes?: Uint8Array): string {
  let text: string;
  try {
    text = decoder.decode(bytes, { stream: bytes !== undefined });
  } catch {
    throw new Error("文件不是有效的 UTF-8 文本，暂不支持该编码。");
  }
  if (/[\x00-\x08\x0e-\x1f\x7f]/.test(text)) {
    throw new Error("文件含有二进制控制字符，不能作为文本读取。");
  }
  return text;
}

/** 分块读取项目文件，返回至多 200 行、50 KiB 原文；不将整个文件载入内存。 */
export async function readProjectFile(
  workspace: Workspace,
  input: ReadInput,
  signal?: AbortSignal,
): Promise<ReadResult> {
  const { path, offset = 1, limit = 200 } = input;
  if (typeof path !== "string" || path === "") throw new Error("path 必须是项目内的文件路径。");
  if (!Number.isSafeInteger(offset) || offset < 1) throw new Error("offset 必须是从 1 开始的整数。");
  if (!Number.isInteger(limit) || limit < 1 || limit > 200) throw new Error("limit 必须是 1 到 200 的整数。");
  signal?.throwIfAborted();
  const target = await resolveWorkspacePath(workspace, path);
  const file = await open(target, "r");
  try {
    if (!(await file.stat()).isFile()) throw new Error("只能读取普通文件，不能读取目录或设备。");
    const result: ReadResult = { path, content: "", offset, lineCount: 0, nextOffset: null };
    const decoder = new TextDecoder("utf-8", { fatal: true });
    const buffer = Buffer.alloc(16 * 1024);
    const maxBytes = 50 * 1024;
    let outputBytes = 0;
    let lineNumber = 1;
    let pending = "";

    /** 接收完整的一行，保留行尾；达到上限时记录下一行，避免返回无法续读的半行。 */
    function appendLine(line: string): boolean {
      if (lineNumber < offset) {
        lineNumber++;
        return true;
      }
      const bytes = Buffer.byteLength(line, "utf8");
      if (result.lineCount === limit || outputBytes + bytes > maxBytes) {
        if (result.lineCount === 0) throw new Error(`第 ${lineNumber} 行超过 50 KiB，请使用 shell 定向查看。`);
        result.nextOffset = lineNumber;
        return false;
      }
      result.content += line;
      result.lineCount++;
      outputBytes += bytes;
      lineNumber++;
      return true;
    }

    while (true) {
      signal?.throwIfAborted();
      const { bytesRead } = await file.read(buffer, 0, buffer.length, null);
      pending += decodeText(decoder, bytesRead ? buffer.subarray(0, bytesRead) : undefined);
      let newline = pending.indexOf("\n");
      while (newline !== -1) {
        if (!appendLine(pending.slice(0, newline + 1))) return result;
        pending = pending.slice(newline + 1);
        newline = pending.indexOf("\n");
      }
      if (bytesRead === 0) {
        if (pending !== "" && !appendLine(pending)) return result;
        if (offset > 1 && result.lineCount === 0) throw new Error("offset 超出文件行数。");
        return result;
      }
      if (lineNumber < offset) {
        // 跳过目标之前的超长行，不让未选中的内容占用内存。
        pending = "";
      } else if (pending !== "" && (result.lineCount === limit ||
        outputBytes + Buffer.byteLength(pending, "utf8") > maxBytes)) {
        if (result.lineCount === 0) throw new Error(`第 ${lineNumber} 行超过 50 KiB，请使用 shell 定向查看。`);
        result.nextOffset = lineNumber;
        return result;
      }
    }
  } finally {
    await file.close();
  }
}
