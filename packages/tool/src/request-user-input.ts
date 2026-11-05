import { parseQuestions } from "@tilot/protocol";
import { validateKeys, type Tool, type ToolHost } from "./tool.ts";

export function createQuestionTool(host: ToolHost): Tool {
  return {
    access: "interaction",
    definition: {
      type: "function", name: "request_user_input_async", strict: false,
      description: "向用户异步提问，用于澄清需求、偏好或缺失信息。每组至少一题，题数不限；每题可提供 0–4 个纯文字选项，也始终允许用户自己填写。可用 recommendedIndex 指定一个推荐选项。工具登记问题后立即返回，不等待答案，不代表获得其他工具的执行许可。每个对话只能有一组待回答问题，不要重复提出。之后继续不依赖答案的工作；若后续工作必须依赖答案，则说明并结束本轮，不要空转等待。用户整组提交的答案会作为后续用户输入送达。",
      parameters: {
        type: "object", additionalProperties: false, required: ["questions"], properties: {
          questions: { type: "array", minItems: 1, items: {
            type: "object", additionalProperties: false, required: ["title"], properties: {
              title: { type: "string", description: "完整、自包含的问题正文，使用普通文字。" },
              options: { type: "array", maxItems: 4, items: { type: "string" }, description: "0–4 个选项，每个选项是一段普通文字。不要添加‘其他’，界面始终提供文字输入框。" },
              recommendedIndex: { type: "integer", minimum: 0, maximum: 3, description: "推荐项在 options 中的下标，从 0 开始；不推荐时省略。" },
            },
          } },
        },
      },
    },
    async execute(args, signal, execution) {
      validateKeys(args, ["questions"]);
      const questions = parseQuestions(args.questions);
      signal?.throwIfAborted();
      if (!host.ask || !execution?.executionId) throw new Error("宿主未提供提问入口。");
      const id = await host.ask(questions, execution.executionId);
      return { accepted: true, questionId: id };
    },
  };
}
