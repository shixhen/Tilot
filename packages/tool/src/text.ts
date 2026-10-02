import { TextDecoder } from "node:util";

/** 工具文本输出的统一字节上限，按 UTF-8 计算。 */
export const MAX_OUTPUT_BYTES = 50 * 1024;

/** 有限文本输出的截断原因；null 表示内容完整。 */
export type TruncationReason = "lines" | "bytes" | null;

/** 严格解码 UTF-8 文本，保留换行；分块读取时由调用方保留 decoder。 */
export function decodeText(decoder: TextDecoder, bytes?: Uint8Array, stream = false, allowControls = false): string {
  let text: string;
  try {
    text = decoder.decode(bytes, { stream });
  } catch {
    throw new Error("文件不是有效的 UTF-8 文本，暂不支持该编码。");
  }
  if (!allowControls && /[\x00-\x08\x0e-\x1f\x7f]/.test(text)) {
    throw new Error("文件含有二进制控制字符，不能作为文本读取或编辑。");
  }
  return text;
}

/** 检查下一段文本能否加入输出，先检查行数，再检查字节数。 */
export function truncationReason(lines: number, bytes: number, next: string, maxLines: number): TruncationReason {
  if (lines >= maxLines) return "lines";
  return bytes + Buffer.byteLength(next, "utf8") > MAX_OUTPUT_BYTES ? "bytes" : null;
}

/** 保留 UTF-8 文本尾部，不从多字节字符中间开始。 */
export function truncateTail(text: string): { content: string; truncated: boolean } {
  const bytes = Buffer.from(text, "utf8");
  if (bytes.length <= MAX_OUTPUT_BYTES) return { content: text, truncated: false };
  let start = bytes.length - MAX_OUTPUT_BYTES;
  while (start < bytes.length && (bytes[start]! & 0xc0) === 0x80) start++;
  return { content: bytes.subarray(start).toString("utf8"), truncated: true };
}

