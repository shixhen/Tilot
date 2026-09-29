import type { FunctionTool } from "openai/resources/responses/responses";
import type { AppConfig } from "@tilot/store";
import type { ModelContext } from "./context.ts";

/** 请求前的保守预算估算，不等同于模型返回的实际 token 用量。 */
export interface ContextBudget {
  estimatedInputTokens: number;
  availableInputTokens: number;
}

/** 用序列化输入的 UTF-8 字节数保守估算，覆盖指令、历史及工具声明；上限取 config.providerId 服务中 config.model 的最大上下文，不裁剪内容。 */
export function checkContextBudget(context: ModelContext, tools: FunctionTool[], config: AppConfig): ContextBudget {
  const model = config.providers.find((provider) => provider.id === config.providerId)?.models.find((item) => item.id === config.model);
  if (!model) {
    throw new Error(`当前服务的模型列表中没有 ${config.model}，请在输入框重新选择模型。`);
  }
  const estimatedInputTokens = Buffer.byteLength(JSON.stringify({ instructions: context.instructions, input: context.input, tools }), "utf8");
  const availableInputTokens = model.contextTokens - config.maxOutputTokens - config.reserveTokens;
  if (estimatedInputTokens > availableInputTokens) {
    throw new Error(`上下文超出预算：保守估算输入 ${estimatedInputTokens} token，可用 ${availableInputTokens} token（已预留输出与安全余量）。未启用摘要或历史裁剪，请新建对话或在设置中调大该模型的最大上下文。`);
  }
  return { estimatedInputTokens, availableInputTokens };
}
