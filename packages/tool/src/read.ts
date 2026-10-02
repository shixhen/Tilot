import { open } from "node:fs/promises";
import { TextDecoder } from "node:util";
import { decodeText, MAX_OUTPUT_BYTES, truncationReason, type TruncationReason } from "./text.ts";
import { validateKeys, type Tool, type ToolHost } from "./tool.ts";
import { resolveWorkspacePath, type Workspace } from "./workspace.ts";

export const DEFAULT_READ_LINES = 200;
export const MAX_READ_LINES = 2000;

/** 文件按行读取；日志另支持 byteOffset 从 UTF-8 字符边界续读长行。 */
export interface ReadInput { path: string; offset?: number; limit?: number }
export interface LogReadInput { outputId: string; offset?: number; limit?: number; byteOffset?: number }

interface ReadPage {
  content: string;
  offset: number;
  lineCount: number;
  nextOffset: number | null;
  truncatedBy: TruncationReason;
  nextByteOffset?: number;
  partialLine?: boolean;
}
export interface ReadResult extends ReadPage { path: string }
export interface LogReadResult extends ReadPage { outputId: string; artifactTruncated: boolean }
export interface LogByteResult { outputId: string; content: string; byteOffset: number; nextByteOffset: number | null; artifactTruncated: boolean }

/** 创建 read 声明；缓存目录与任务归属只由宿主提供。 */
export function createReadTool(workspace: Workspace, host?: ToolHost): Tool {
  return {
    definition: {
      type: "function", name: "read", strict: false,
      description: `读取项目 UTF-8 文件或 shell 的已保存日志，path 与 outputId 必须恰好指定一个。文件路径使用 /，不允许绝对路径和内部链接。默认 ${DEFAULT_READ_LINES} 行，可请求最多 ${MAX_READ_LINES} 行，正文最多 ${MAX_OUTPUT_BYTES / 1024} KiB。用 nextOffset 按行续读；日志遇到超长行会返回 partialLine 和 nextByteOffset，随后只传 outputId、byteOffset 继续读，直到 nextByteOffset 为 null。byteOffset 仅用于日志，不与 offset/limit 同用。日志只属于当前任务，可能过期；artifactTruncated 为 true 表示缓存本身不完整。`,
      parameters: {
        type: "object", additionalProperties: false, oneOf: [{ required: ["path"] }, { required: ["outputId"] }], properties: {
          path: { type: "string", minLength: 1, description: "项目相对文件路径，使用 / 分隔；不能与 outputId 同用。" },
          outputId: { type: "string", description: "shell 返回的当前任务日志标识；不能使用宿主文件路径。" },
          offset: { type: "integer", minimum: 1, description: "按行读取的起始行，从 1 开始；默认 1。" },
          limit: { type: "integer", minimum: 1, maximum: MAX_READ_LINES, description: `按行读取的最多行数；默认 ${DEFAULT_READ_LINES}。` },
          byteOffset: { type: "integer", minimum: 0, description: "仅用于日志，复制 nextByteOffset 以继续读长行；最多返回 50 KiB，不与 offset/limit 同用。" },
        },
      },
    },
    async execute(args, signal) {
      validateKeys(args, ["path", "outputId", "offset", "limit", "byteOffset"]);
      if ((args.path !== undefined) === (args.outputId !== undefined)) throw new Error("path 与 outputId 必须恰好指定一个。");
      for (const key of ["offset", "limit", "byteOffset"]) if (args[key] !== undefined && typeof args[key] !== "number") throw new Error(`${key} 必须是数字。`);
      const page = { ...(args.offset === undefined ? {} : { offset: args.offset as number }), ...(args.limit === undefined ? {} : { limit: args.limit as number }) };
      if (args.path !== undefined) {
        if (typeof args.path !== "string" || args.byteOffset !== undefined) throw new Error("path 必须是字符串，文件读取不支持 byteOffset。");
        return readProjectFile(workspace, { path: args.path, ...page }, signal);
      }
      if (!host) throw new Error("宿主未配置输出日志缓存。");
      if (typeof args.outputId !== "string") throw new Error("outputId 必须是字符串。");
      return readOutputLog(host, { outputId: args.outputId, ...page, ...(args.byteOffset === undefined ? {} : { byteOffset: args.byteOffset as number }) }, signal);
    },
  };
}

/** 继续按项目相对路径读取文件，不放宽路径边界来访问日志。 */
export async function readProjectFile(workspace: Workspace, input: ReadInput, signal?: AbortSignal): Promise<ReadResult> {
  if (typeof input.path !== "string" || input.path === "") throw new Error("path 必须是项目内的文件路径。");
  signal?.throwIfAborted();
  const target = await resolveWorkspacePath(workspace, input.path);
  return { path: input.path, ...await readTextFile(target, input, signal, false) };
}

/** 日志归属检查由缓存完成，按行或按字节读取的结果不暴露真实路径。 */
export async function readOutputLog(host: ToolHost, input: LogReadInput, signal?: AbortSignal): Promise<LogReadResult | LogByteResult> {
  signal?.throwIfAborted();
  return host.outputs.read(host.threadId, input.outputId, async (path, artifact) => ({
    outputId: input.outputId, artifactTruncated: artifact.artifactTruncated, ...await readCachedPage(path, input, signal),
  }));
}

/** 缓存正文共用行分页与长行字节续读；归属及缓存类型仍由各工具检查。 */
export async function readCachedPage(path: string, input: { offset?: number; limit?: number; byteOffset?: number }, signal?: AbortSignal) {
  signal?.throwIfAborted();
  if (input.byteOffset !== undefined && (input.offset !== undefined || input.limit !== undefined)) throw new Error("byteOffset 不能与 offset/limit 同用。");
  if (input.byteOffset === undefined) return readTextFile(path, input, signal, true);
  const byteOffset = input.byteOffset;
  if (!Number.isSafeInteger(byteOffset) || byteOffset < 0) throw new Error("byteOffset 必须是从 0 开始的整数。");
  const file = await open(path, "r");
  try {
    const size = (await file.stat()).size;
    if (byteOffset > size) throw new Error("byteOffset 超出缓存正文长度。");
    const buffer = Buffer.alloc(MAX_OUTPUT_BYTES + 4);
    signal?.throwIfAborted();
    const { bytesRead } = await file.read(buffer, 0, buffer.length, byteOffset);
    if (bytesRead > 0 && (buffer[0]! & 0xc0) === 0x80) throw new Error("byteOffset 必须位于 UTF-8 字符边界，请使用 nextByteOffset。");
    let end = Math.min(bytesRead, MAX_OUTPUT_BYTES);
    while (end < bytesRead && end > 0 && (buffer[end]! & 0xc0) === 0x80) end--;
    const content = decodeText(new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }), buffer.subarray(0, end), false, true);
    return { content, byteOffset, nextByteOffset: byteOffset + end < size ? byteOffset + end : null };
  } finally { await file.close(); }
}

/** 分块读取，项目文件只返回完整行；日志长行可返回有界片段和字节续读位置。 */
async function readTextFile(target: string, input: { offset?: number; limit?: number }, signal: AbortSignal | undefined, isLog: boolean): Promise<ReadPage> {
  const { offset = 1, limit = DEFAULT_READ_LINES } = input;
  if (!Number.isSafeInteger(offset) || offset < 1) throw new Error("offset 必须是从 1 开始的整数。");
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_READ_LINES) throw new Error(`limit 必须是 1 到 ${MAX_READ_LINES} 的整数。`);
  const file = await open(target, "r");
  try {
    if (!(await file.stat()).isFile()) throw new Error("只能读取普通文件，不能读取目录或设备。");
    const result: ReadPage = { content: "", offset, lineCount: 0, nextOffset: null, truncatedBy: null };
    const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: isLog });
    const buffer = Buffer.alloc(16 * 1024);
    let outputBytes = 0;
    let consumedBytes = 0;
    let lineNumber = 1;
    let pending = "";

    function appendLine(line: string): boolean {
      const bytes = Buffer.byteLength(line, "utf8");
      if (lineNumber < offset) { lineNumber++; consumedBytes += bytes; return true; }
      const reason = truncationReason(result.lineCount, outputBytes, line, limit);
      if (reason) {
        if (result.lineCount === 0) {
          if (!isLog) throw new Error(`第 ${lineNumber} 行超过 ${MAX_OUTPUT_BYTES / 1024} KiB，请使用 shell 定向查看。`);
          const raw = Buffer.from(line, "utf8");
          let end = MAX_OUTPUT_BYTES;
          while ((raw[end]! & 0xc0) === 0x80) end--;
          result.content = raw.subarray(0, end).toString("utf8");
          result.lineCount = 1;
          result.nextByteOffset = consumedBytes + end;
          result.partialLine = true;
        } else result.nextOffset = lineNumber;
        result.truncatedBy = reason;
        return false;
      }
      result.content += line;
      result.lineCount++;
      outputBytes += bytes;
      consumedBytes += bytes;
      lineNumber++;
      return true;
    }

    while (true) {
      signal?.throwIfAborted();
      const { bytesRead } = await file.read(buffer, 0, buffer.length, null);
      pending += decodeText(decoder, bytesRead ? buffer.subarray(0, bytesRead) : undefined, bytesRead > 0, isLog);
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
        consumedBytes += Buffer.byteLength(pending, "utf8");
        pending = "";
      } else if (pending !== "" && truncationReason(result.lineCount, outputBytes, pending, limit)) {
        appendLine(pending);
        return result;
      }
    }
  } finally { await file.close(); }
}
