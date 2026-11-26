import { APIError, type default as OpenAI } from "openai";
import { compactContext, configuredContextCapacity, isContextOverflow, requestBodyLimit, SummaryContextOverflow } from "@tilot/context";
import type { Thread } from "@tilot/protocol";
import { streamResponse } from "@tilot/responses";
import type { HistoryPosition, Store } from "@tilot/store";

/** Core 提供摘要请求的执行入口，由 Context 决定发送哪些历史。 */
export function compactHistory(
  store: Store, client: OpenAI, thread: Thread, signal?: AbortSignal, through?: HistoryPosition,
  capacity = configuredContextCapacity(store.getConfig(), thread),
) {
  return compactContext(store, thread.id, {
    through, capacity, signal, imageBudget: requestBodyLimit(client.baseURL) / 2,
    summarize: async (instructions, input) => {
      let outputStarted = false;
      try {
        for await (const event of streamResponse(client, {
          model: thread.model, instructions, reasoning: { effort: thread.reasoningEffort }, input: [{ role: "user", content: input }],
        }, signal)) {
          if (event.type === "response.completed") {
            const summary = event.response.output.flatMap((item) => item.type === "message"
              ? item.content.flatMap((part) => part.type === "output_text" ? [part.text] : []) : []).join("\n");
            const usage = event.response.usage;
            return { summary, usage: usage && Number.isFinite(usage.input_tokens) && Number.isFinite(usage.output_tokens)
              ? { inputTokens: usage.input_tokens, outputTokens: usage.output_tokens } : null };
          }
          const failure = event.type === "error" ? event
            : event.type === "response.failed" || event.type === "response.incomplete" ? event.response.error : undefined;
          if ("response" in event && (event.response.output.length || event.response.usage?.output_tokens)) outputStarted = true;
          if (failure) {
            if (!outputStarted && isContextOverflow(failure.code, failure.message)) throw new SummaryContextOverflow(failure.message);
            throw new Error(failure.message);
          }
          if (event.type !== "response.created" && event.type !== "response.queued" && event.type !== "response.in_progress") outputStarted = true;
        }
      } catch (error) {
        if (!signal?.aborted && !outputStarted && error instanceof APIError &&
            (error.status === undefined || error.status === 400 || error.status === 422) && isContextOverflow(error.code, error.message)) {
          throw new SummaryContextOverflow(error.message, { cause: error });
        }
        throw error;
      }
      throw new Error("模型未能完成对话摘要。");
    },
  });
}
