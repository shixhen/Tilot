import OpenAI from "openai";
import type {
  ResponseCreateParamsStreaming,
  ResponseStreamEvent,
} from "openai/resources/responses/responses";

/** 模型服务的连接配置；省略 baseURL 时使用 DeepSeek 官方地址。 */
export interface ResponsesClientOptions {
  apiKey: string;
  baseURL?: string;
}

/** 复用 SDK 的请求参数；stream 由请求函数统一设为 true，调用方无需填写。 */
export type ResponsesRequest = Omit<ResponseCreateParamsStreaming, "stream">;

/** 根据用户配置创建 Responses 客户端；只检查连接配置，不发送请求。 */
export function createResponsesClient(options: ResponsesClientOptions): OpenAI {
  const key = options.apiKey.trim();
  if (!key) {
    throw new Error("DeepSeek API Key 不能为空。");
  }

  const baseURL = new URL(options.baseURL ?? "https://api.deepseek.com");
  if (baseURL.protocol !== "https:" && baseURL.protocol !== "http:") {
    throw new Error("模型服务地址必须使用 HTTP 或 HTTPS。");
  }
  if (baseURL.username || baseURL.password || baseURL.search || baseURL.hash) {
    throw new Error("模型服务地址不能包含用户名、密码、查询参数或片段。");
  }

  return new OpenAI({
    apiKey: key,
    baseURL: baseURL.href,
    // 由 Agent Core 统一决定是否重试，避免 SDK 和应用重复重试。
    maxRetries: 0,
    // 拒绝 HTTP 重定向，确保请求不会跟随跳转到其他地址。
    fetchOptions: { redirect: "error" },
  });
}

/**
 * 发起一次流式请求，原样传递 SDK 事件，包括推理与工具调用。
 * completed、failed、incomplete 均作为终态交给调用方判断；无终态断流则抛错。
 * 支持 AbortSignal 取消，调用方提前停止遍历时也会关闭请求；此处不执行工具或重试。
 */
export async function* streamResponse(
  client: OpenAI,
  request: ResponsesRequest,
  signal?: AbortSignal,
): AsyncGenerator<ResponseStreamEvent> {
  signal?.throwIfAborted();
  const stream = await client.responses.create({ ...request, stream: true }, { signal });

  try {
    for await (const event of stream) {
      signal?.throwIfAborted();
      yield event;

      if (
        event.type === "response.completed" ||
        event.type === "response.failed" ||
        event.type === "response.incomplete"
      ) {
        return;
      }
    }

    // SDK 可能将取消表现为遍历结束，先检查取消，避免误报为网络断流。
    signal?.throwIfAborted();
    throw new Error("模型响应在收到终态事件前中断。");
  } finally {
    stream.controller.abort();
  }
}
