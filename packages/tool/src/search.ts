import { MAX_OUTPUT_BYTES } from "./text.ts";
import { pathSegments } from "./workspace.ts";

/** 搜索结果的上限；逐条加入，整个 JSON 正文不超过文本工具的字节预算。 */
export class SearchBuffer<T> {
  readonly items: T[] = [];
  truncatedBy: "items" | "bytes" | null = null;
  private readonly limit: number;
  private bytes: number;

  constructor(limit: number, path: string) {
    this.limit = limit;
    this.bytes = Buffer.byteLength(JSON.stringify({ path }), "utf8") + 128;
    if (this.bytes > MAX_OUTPUT_BYTES) throw new Error("搜索路径过长，超过输出上限。");
  }

  /** 只在发现额外结果时标记截断，刚好达到上限不伪报不完整。 */
  add(item: T): boolean {
    const bytes = Buffer.byteLength(JSON.stringify(item), "utf8") + 1;
    if (this.items.length >= this.limit) this.truncatedBy = "items";
    else if (this.bytes + bytes > MAX_OUTPUT_BYTES) this.truncatedBy = "bytes";
    else { this.items.push(item); this.bytes += bytes; return true; }
    return false;
  }

  get state() { return { truncated: this.truncatedBy !== null, truncatedBy: this.truncatedBy }; }
}

/** 搜索起点使用项目相对路径；省略或空字符串表示根目录。 */
export function searchPath(value: unknown): string {
  if (value === undefined) return "";
  if (typeof value !== "string") throw new Error("path 必须是项目相对路径字符串。");
  pathSegments(value);
  return value;
}

/** 默认值和最大值由各工具声明决定，不能忽略错误类型或越界参数。 */
export function searchLimit(value: unknown, fallback: number, maximum: number): number {
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > maximum) throw new Error(`limit 必须是 1 到 ${maximum} 的整数。`);
  return value;
}

/** 单行模式与 glob 都作为程序参数传递；拒绝无效 Unicode 和过长模式。 */
export function searchPattern(value: unknown, name = "pattern", glob = false): string {
  if (typeof value !== "string" || !value || !value.isWellFormed() || /[\0\r\n]/.test(value) || Buffer.byteLength(value, "utf8") > 2048) throw new Error(`${name} 必须是非空单行字符串，最多 2 KiB，使用有效 Unicode。`);
  if (glob && (/[\\:]/.test(value) || value.startsWith("/") || value.split("/").some((part) => part === ".."))) throw new Error(`${name} 的 glob 使用 / 和项目相对路径，不能包含 ..、绝对路径或反斜杠。`);
  return value;
}

/** 文件搜索有统一时限；用户取消仍保留原 AbortError，超时清楚说明如何缩小范围。 */
export async function withSearchTimeout<T>(signal: AbortSignal | undefined, operation: (signal: AbortSignal) => Promise<T>): Promise<T> {
  signal?.throwIfAborted();
  const deadline = AbortSignal.timeout(30000);
  const combined = signal ? AbortSignal.any([signal, deadline]) : deadline;
  try { const result = await operation(combined); combined.throwIfAborted(); return result; }
  catch (error) {
    if (deadline.aborted && !signal?.aborted) throw new Error("搜索超过 30 秒，请缩小 path 或 pattern 的范围。");
    throw error;
  }
}
