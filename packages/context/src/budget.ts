import type { ResponsesRequest } from "@tilot/responses";
import { DEFAULT_CONTEXT_TOKENS, type AppConfig, type Thread } from "@tilot/protocol";

export function configuredContextCapacity(config: AppConfig, model: Pick<Thread, "providerId" | "model">): number {
  return config.providers.find((provider) => provider.id === model.providerId)?.models
    .find((item) => item.id === model.model)?.contextTokens ?? DEFAULT_CONTEXT_TOKENS;
}

/** 按待发送的内容估算单次请求。服务端重放的网页内容和图片只能近似计入。 */
export function estimateContextTokens(request: Pick<ResponsesRequest, "instructions" | "input" | "tools">): number {
  let extra = 0;
  const text = JSON.stringify(request, (_key, value: unknown) => {
    if (value && typeof value === "object" && "type" in value) {
      if (value.type === "input_image") {
        extra += 1_024;
        return { type: value.type };
      }
      if (value.type === "web_search_call" && "signature" in value) {
        if (!("status" in value) || value.status !== "failed") extra += 1_024;
        const { signature, ...visible } = value;
        return visible;
      }
      if (value.type === "reasoning" && "encrypted_content" in value) {
        const { encrypted_content, ...visible } = value;
        return visible;
      }
    }
    return value;
  });
  const bytes = Buffer.byteLength(text);
  return Math.ceil((2 * bytes - text.length) / 3) + extra;
}

/** 只识别明确的输入上下文错误，普通 400、HTTP 请求体过大与输出截断另行处理。 */
export function isContextOverflow(code: string | null | undefined, message: string): boolean {
  return code === "context_length_exceeded" ||
    /\b(?:context (?:length|window) (?:limit )?exceeded|maximum context length is \d|exceeds? (?:the )?(?:model(?:'s)? )?(?:max(?:imum)? )?context (?:length|window))\b/i.test(message);
}

/** 摘要提供方在生成前明确报告输入超限。 */
export class SummaryContextOverflow extends Error {}
