import type { ResponseInputItem } from "openai/resources/responses/responses";
import type { ResponsesRequest } from "@tilot/responses";
import type { Store } from "@tilot/store";
import type { ImageRef } from "@tilot/protocol";
import { Buffer } from "node:buffer";

type ToolOutput = ResponseInputItem.FunctionCallOutput;
type Request = ResponsesRequest & { input: ResponseInputItem[] };
type OutputParts = Exclude<ToolOutput["output"], string>;
type Candidate = { item: ToolOutput; parts: OutputParts; index: number; savedBytes: number; placeholder: { type: "input_text"; text: string } };

const localImagePrefix = "tilot-image:";
const mib = 1024 * 1024;

/** DeepSeek 的请求体上限为 48 MiB，按已公布的限制为整份 JSON 留少量余量。 */
export function requestBodyLimit(baseURL: string): number {
  return new URL(baseURL).hostname === "api.deepseek.com" ? 47 * mib : Infinity;
}

/** 以 SDK 实际发送的 UTF-8 JSON 为基准，换算图片展开后的字节，不提前读取原图。 */
export function measureRequestImages(request: Request, images: Store["images"]) {
  const candidates: Candidate[] = [];
  const refs = new Map<string, ImageRef>();
  let expandedBytes = 0;
  let hasImages = false;
  function measure(part: { type: string; image_url?: string | null }): { image: ImageRef; bytes: number } | undefined {
    if (part.type !== "input_image") return;
    hasImages = true;
    if (!part.image_url?.startsWith(localImagePrefix)) return;
    const id = part.image_url.slice(localImagePrefix.length);
    let image = refs.get(id);
    if (!image) { image = images.get(id); refs.set(id, image); }
    const bytes = `data:${image.mimeType};base64,`.length + 4 * Math.ceil(image.bytes / 3) - part.image_url.length;
    expandedBytes += bytes;
    return { image, bytes };
  }
  for (const item of request.input) {
    if (item.type === "function_call_output" && Array.isArray(item.output)) {
      const parts = item.output;
      parts.forEach((part, index) => {
        if (part.type !== "input_image") return;
        const measured = measure(part);
        if (!measured) return;
        const { image, bytes } = measured;
        const placeholder = {
          type: "input_text" as const,
          text: `[历史工具图片因请求体大小暂未发送，原图已保存。需要查看时调用 view_image({"imageId":"${image.id}"})。]`,
        };
        candidates.push({ item, parts, index, placeholder, savedBytes: jsonBytes(part) + bytes - jsonBytes(placeholder) });
      });
    } else if ("role" in item && (item.role === "user" || item.role === "developer") && "content" in item && Array.isArray(item.content)) {
      for (const part of item.content) if (part.type === "input_image") measure(part);
    }
  }
  const bytes = hasImages ? jsonBytes({ ...request, stream: true }) + expandedBytes : 0;
  // 保留最后一张工具图，以便模型看到刚回读的图片。
  const removable = candidates.slice(0, -1).filter((candidate) => candidate.savedBytes > 0);
  return { refs, removable, bytes, minimumBytes: bytes - removable.reduce((sum, item) => sum + item.savedBytes, 0) };
}

/** 从旧工具结果开始替换图片，保留调用标识、文字和至少一张最新工具图。 */
export function offloadRequestImages(request: Request, measured: ReturnType<typeof measureRequestImages>, target: number) {
  const outputs = new Map<ToolOutput, OutputParts>();
  let bytes = measured.bytes;
  let omitted = 0;
  for (const { item, parts, index, placeholder, savedBytes } of measured.removable) {
    if (bytes <= target) break;
    let output = outputs.get(item);
    if (!output) {
      output = [...parts];
      outputs.set(item, output);
    }
    output[index] = placeholder;
    bytes -= savedBytes;
    omitted++;
  }
  const input = omitted ? request.input.map((item): ResponseInputItem => {
    if (item.type !== "function_call_output") return item;
    const output = outputs.get(item);
    return output ? { ...item, output } : item;
  }) : request.input;
  return { input, bytes, omitted };
}

/** 413 发生在生成前。为服务未公布的上限腾出空间，只尝试一次且必须减小请求。 */
export function retryImageLimit(measured: ReturnType<typeof measureRequestImages>, sentBytes: number): number | undefined {
  return measured.minimumBytes < sentBytes ? Math.floor(sentBytes / 2) : undefined;
}

function jsonBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value));
}
