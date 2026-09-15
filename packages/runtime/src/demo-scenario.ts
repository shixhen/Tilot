import type { JsonValue, ModelRequest, ModelTurn, ToolCall } from "@tilot/agent-core";
import { FakeProvider } from "./providers/fake-provider.js";
import { DEMO_PROJECT_ID } from "./tools/memory-tools.js";

function call(name: string, args: JsonValue, suffix: string): ToolCall {
  return { name, argumentsJson: JSON.stringify(args), itemId: `item-${suffix}`, callId: `call-${suffix}` };
}
function turn(text: string, toolCalls: readonly ToolCall[], step: number): ModelTurn {
  return { text, toolCalls, providerState: { protocol: "fake", schemaVersion: 1, step, output: [{ text }] } };
}
function lastData(request: ModelRequest, name: string): Record<string, JsonValue> {
  const group = request.history.at(-1);
  const model = request.history.at(-2);
  if (model?.type !== "model" || group?.type !== "tool_results" || model.intents[0]?.call.name !== name) throw new Error(`缺少 ${name} 的调用与结果`);
  const outcome = group.results[0];
  if (!outcome || outcome.callId !== model.intents[0].call.callId || outcome.result.status !== "ok" || !outcome.result.data) throw new Error(`${name} 未成功完成`);
  return outcome.result.data as Record<string, JsonValue>;
}
export function createDemoProvider(): FakeProvider {
  return new FakeProvider([
    async function* () {
      yield { type: "text_delta", delta: "先查看示例项目中的文件。" };
      yield { type: "completed", turn: turn("先列举文件。", [call("list_files", { projectId: DEMO_PROJECT_ID }, "list")], 1) };
    },
    async function* (request) {
      const paths = lastData(request, "list_files").paths;
      if (!Array.isArray(paths) || typeof paths[0] !== "string") throw new Error("文件列表无有效路径");
      yield { type: "completed", turn: turn("读取找到的代码。", [call("read_file", { projectId: DEMO_PROJECT_ID, path: paths[0] }, "read")], 2) };
    },
    async function* (request) {
      const data = lastData(request, "read_file");
      if (typeof data.content !== "string" || !data.content.includes("export function greet") || typeof data.path !== "string" || !Array.isArray(data.lines)) throw new Error("未读取到预期代码");
      const answer = `${data.path}:1 定义了 greet(name)，第 2 行把姓名放进中文问候语并返回，例如：你好，小明！`;
      yield { type: "text_delta", delta: answer };
      yield { type: "completed", turn: turn(answer, [], 3) };
    },
  ]);
}
