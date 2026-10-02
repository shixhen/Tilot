import { createEditTool } from "./edit.ts";
import { createFindTool } from "./find.ts";
import { createGrepTool } from "./grep.ts";
import { createLsTool } from "./ls.ts";
import { createReadTool } from "./read.ts";
import { createShellTool } from "./shell.ts";
import { createWriteTool } from "./write.ts";
import { createWebFetchTool } from "./web-fetch.ts";
import type { ToolExecution, ToolHost, ToolSet } from "./tool.ts";
import type { Workspace } from "./workspace.ts";

/** 创建一轮工具集合；项目根目录由宿主绑定，普通对话不开启项目工具。 */
export function createToolSet(workspace?: Workspace, host?: ToolHost): ToolSet {
  const tools = workspace ? [createWriteTool(workspace), createEditTool(workspace), createReadTool(workspace, host), createShellTool(workspace, host),
    createLsTool(workspace), createFindTool(workspace), createGrepTool(workspace)] : [];
  if (host) tools.push(createWebFetchTool(host));
  const byName = new Map(tools.map((tool) => [tool.definition.name, tool]));
  return {
    definitions: tools.map((tool) => tool.definition),
    async execute(name, argumentsJson, signal, execution) {
      let updateError: unknown;
      const context: ToolExecution | undefined = execution ? { executionId: execution.executionId,
        ...(execution.onUpdate ? { onUpdate: async (snapshot) => {
          try { await execution.onUpdate!(snapshot); }
          catch (error) { updateError = error; throw error; }
        } } : {}),
      } : undefined;
      try {
        signal?.throwIfAborted();
        const tool = byName.get(name);
        if (!tool) throw new Error(`未声明的工具：${name}`);
        const args: unknown = JSON.parse(argumentsJson);
        if (!args || typeof args !== "object" || Array.isArray(args)) throw new Error("工具参数必须是 JSON 对象。");
        const data = await tool.execute(args as Record<string, unknown>, signal, context);
        return JSON.stringify({ status: "ok", data });
      } catch (error) {
        // 事件交付失败是执行流程错误；命令已停止后仍向宿主传播，不能包装成参数错误。
        if (updateError !== undefined) throw updateError;
        return JSON.stringify({
          status: error instanceof Error && error.name === "AbortError" ? "cancelled" : "error",
          error: error instanceof Error ? error.message : String(error),
        });
      }
    },
  };
}
