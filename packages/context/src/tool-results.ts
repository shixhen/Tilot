import type { ResponseInputItem } from "openai/resources/responses/responses";

/** UTF-8 首尾预览，用于只发给模型的内容。 */
export function previewText(text: string, maxBytes: number): string {
  const bytes = Buffer.from(text);
  if (bytes.length <= maxBytes) return text;
  if (maxBytes <= 0) return "";
  let end = Math.ceil(maxBytes / 2);
  let start = bytes.length - Math.floor(maxBytes / 2);
  while ((bytes[end]! & 0xc0) === 0x80) end--;
  while (start < bytes.length && (bytes[start]! & 0xc0) === 0x80) start++;
  return `${bytes.subarray(0, end).toString()}\n…\n${bytes.subarray(start).toString()}`;
}

function shortenText(text: string, maxBytes: number): string {
  const size = Buffer.byteLength(text);
  if (size <= maxBytes) return text;
  const metadata: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(text);
    if (typeof parsed?.status === "string" && parsed.status.length <= 32) metadata.status = parsed.status;
    for (const key of ["outputId", "path", "url", "finalUrl", "offset", "byteOffset", "nextOffset", "nextByteOffset", "exitCode", "artifactTruncated"]) {
      const value: unknown = parsed?.data?.[key];
      if (typeof value === "number" || typeof value === "boolean" || typeof value === "string" && value.length <= 4096) metadata[key] = value;
    }
  } catch { /* 工具也可以返回普通文本。 */ }
  const shortened = JSON.stringify({
    ...metadata, contextTruncated: true, originalBytes: size,
    ...(maxBytes > 0 ? { preview: previewText(text, maxBytes) } : {}),
    notice: "已保存的工具结果仅在本次上下文中裁短。需要更多内容时定向续读，避免重跑工具。",
  });
  return Buffer.byteLength(shortened) < size ? shortened : text;
}

/** 只改动工具输出文字，保留原调用标识、图片和用户输入。 */
export function shortenToolResult(item: ResponseInputItem, maxBytes: number): ResponseInputItem {
  if (item.type !== "function_call_output") return item;
  if (typeof item.output === "string") {
    const output = shortenText(item.output, maxBytes);
    return output === item.output ? item : { ...item, output };
  }
  const output = item.output.map((part) => {
    if (part.type !== "input_text") return part;
    const text = shortenText(part.text, maxBytes);
    return text === part.text ? part : { ...part, text };
  });
  return output.every((part, index) => part === item.output[index]) ? item : { ...item, output };
}
