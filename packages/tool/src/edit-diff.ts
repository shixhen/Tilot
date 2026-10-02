import { FILE_HEADERS_ONLY, formatPatch, structuredPatch } from "diff";
import { MAX_OUTPUT_BYTES } from "./text.ts";

/** 一项唯一文本替换；空 newText 表示删除。 */
export interface TextEdit { oldText: string; newText: string }

/** 只统一 CRLF 的匹配视图，单独的 CR 和其他字符保持严格匹配。 */
function normalizeNewlines(text: string): string {
  return text.replace(/\r\n/g, "\n");
}

/** 把匹配视图的边界映射回原文；边界前每个 CRLF 多占一个字符。 */
function originalOffset(content: string, offset: number): number {
  let removed = 0;
  let start = 0;
  while (true) {
    const crlf = content.indexOf("\r\n", start);
    if (crlf < 0 || crlf - removed >= offset) return offset + removed;
    removed++;
    start = crlf + 2;
  }
}

/** 先在同一原文校验所有位置，再从后向前修改，保留未修改字符和 BOM。 */
export function applyEdits(content: string, edits: TextEdit[]): string {
  const bom = content.startsWith("\ufeff") ? "\ufeff" : "";
  const original = content.slice(bom.length);
  const matching = normalizeNewlines(original);
  const fileNewline = original.match(/\r?\n/)?.[0] ?? "\n";
  const matches = edits.map((edit, index) => {
    const oldText = normalizeNewlines(edit.oldText);
    const start = matching.indexOf(oldText);
    if (start < 0) throw new Error(`第 ${index + 1} 项未找到 oldText，请重新读取文件并核对原文。`);
    if (matching.indexOf(oldText, start + 1) !== -1) throw new Error(`第 ${index + 1} 项 oldText 匹配多处，请提供更多上下文以唯一定位。`);
    const rawStart = originalOffset(original, start);
    const rawEnd = originalOffset(original, start + oldText.length);
    const newline = original.slice(rawStart, rawEnd).match(/\r?\n/)?.[0] ?? fileNewline;
    const newText = normalizeNewlines(edit.newText).replace(/\n/g, newline);
    return { start: rawStart, end: rawEnd, newText };
  }).sort((left, right) => left.start - right.start);
  for (let index = 1; index < matches.length; index++) {
    if (matches[index]!.start < matches[index - 1]!.end) throw new Error("edits 中的替换范围重叠，请合并这些修改后重试。");
  }
  let updated = original;
  for (const match of matches.reverse()) updated = updated.slice(0, match.start) + match.newText + updated.slice(match.end);
  updated = bom + updated;
  if (updated === content) throw new Error("新旧文本相同，没有需要修改的内容。");
  return updated;
}

/** 计算实际文本的 unified diff，保留三行上下文并按 UTF-8 字节限制输出。 */
export function createEditDiff(path: string, original: string, updated: string): {
  firstChangedLine: number; diff: string; diffTruncated: boolean;
} {
  const patch = structuredPatch(`a/${path}`, `b/${path}`, original, updated, undefined, undefined, { context: 3 });
  const first = patch.hunks[0]!;
  let firstChangedLine = first.newStart;
  for (const line of first.lines) {
    if (line.startsWith("+") || line.startsWith("-")) break;
    if (line.startsWith(" ")) firstChangedLine++;
  }
  const diff = formatPatch(patch, FILE_HEADERS_ONLY);
  const bytes = Buffer.from(diff, "utf8");
  if (bytes.length <= MAX_OUTPUT_BYTES) return { firstChangedLine, diff, diffTruncated: false };
  let end = MAX_OUTPUT_BYTES;
  while ((bytes[end]! & 0xc0) === 0x80) end--;
  return { firstChangedLine, diff: bytes.subarray(0, end).toString("utf8"), diffTruncated: true };
}
