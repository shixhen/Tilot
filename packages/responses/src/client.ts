import OpenAI from "openai";
import { ResponseStreamValidator } from "./stream-validator.ts";
import type {
  ResponseCreateParamsStreaming,
  ResponseStreamEvent,
  Tool,
} from "openai/resources/responses/responses";

/** 模型服务的连接配置；省略 baseURL 时使用 DeepSeek 官方地址。 */
export interface ResponsesClientOptions {
  apiKey: string;
  baseURL?: string;
}

type DeepSeekWebTool = { type: "deepseek_web_search" | "deepseek_read_url" };

/** 复用 SDK 的请求参数，并补充 DeepSeek 的扩展字段。 */
export type ResponsesRequest = Omit<ResponseCreateParamsStreaming, "stream" | "tools"> & {
  title?: { enabled: true };
  tools?: (Tool | DeepSeekWebTool)[];
};

export const deepSeekWebTools: readonly DeepSeekWebTool[] = [
  { type: "deepseek_web_search" }, { type: "deepseek_read_url" },
];

/** DeepSeek 在启用会话标题时保留 find 给服务端工具。 */
export const DEEPSEEK_FIND_NAME = "find_files";

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

/** 读取服务提供的模型名称（GET /models），按服务返回顺序；15 秒无响应视为失败。 */
export async function listModels(options: ResponsesClientOptions): Promise<string[]> {
  const ids: string[] = [];
  for await (const model of createResponsesClient(options).models.list({ timeout: 15_000 })) ids.push(model.id);
  return ids;
}

/**
 * 发起一次流式请求，校验并传递 SDK 事件，包括推理与工具调用；完全相同的重复事件只传递一次。
 * completed、failed、incomplete 均作为终态交给调用方判断；无终态断流则抛错。
 * 支持 AbortSignal 取消，调用方提前停止遍历时也会关闭请求；此处不执行工具或重试。
 */
export async function* streamResponse(
  client: OpenAI,
  request: ResponsesRequest,
  signal?: AbortSignal,
): AsyncGenerator<ResponseStreamEvent> {
  signal?.throwIfAborted();
  // SDK 原样序列化请求体，工具类型声明尚未包含 DeepSeek 官方扩展。
  const stream = await client.responses.create({ ...request, stream: true } as ResponseCreateParamsStreaming, { signal });
  const validator = new ResponseStreamValidator();

  try {
    for await (const event of stream) {
      signal?.throwIfAborted();
      if (!validator.accept(event)) {
        continue;
      }
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
