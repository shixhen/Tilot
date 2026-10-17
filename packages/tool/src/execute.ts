import { createEditTool } from "./edit.ts";
import { createFindTool } from "./find.ts";
import { createGrepTool } from "./grep.ts";
import { createLsTool } from "./ls.ts";
import { createReadTool } from "./read.ts";
import { createShellTool } from "./shell.ts";
import { createWriteTool } from "./write.ts";
import { createWebFetchTool } from "./web-fetch.ts";
import type { ToolExecution, ToolHost, ToolPermissions, ToolSet } from "./tool.ts";
import { isWithinWorkspace, localWriteLocation } from "./local-path.ts";
import { openWorkspace, type Workspace } from "./workspace.ts";

/** 每轮固定工具声明及权限快照；审批只能放行一个精确调用，不能扩展只读模式。 */
export function createToolSet(workspace?: Workspace, host?: ToolHost, permissions: ToolPermissions = { mode: "read-only" }): ToolSet {
  const { mode, approve } = permissions;
  const tools = workspace ? [createWriteTool(workspace), createEditTool(workspace), createReadTool(workspace, host), createShellTool(workspace, host),
    createLsTool(workspace), createFindTool(workspace), createGrepTool(workspace)] : [];
  if (host) tools.push(createWebFetchTool(host));
  const byName = new Map(tools.map((tool) => [tool.definition.name, tool]));
  return {
    definitions: tools.filter((tool) => mode !== "read-only" || tool.access === "read").map((tool) => tool.definition),
    async execute(name, argumentsJson, signal, execution) {
      let updateError: unknown;
      const context: ToolExecution = { ...execution };
      const onUpdate = execution?.onUpdate;
      if (onUpdate) {
        context.onUpdate = async (snapshot) => {
          try { await onUpdate(snapshot); }
          catch (error) { updateError = error; throw error; }
        };
      }
      try {
        signal?.throwIfAborted();
        const tool = byName.get(name);
        if (!tool) throw new Error(`未声明的工具：${name}`);
        const args: unknown = JSON.parse(argumentsJson);
        if (!args || typeof args !== "object" || Array.isArray(args)) throw new Error("工具参数必须是 JSON 对象。");
        const input = args as Record<string, unknown>;
        if (mode === "read-only" && tool.access !== "read") throw new Error("只读模式禁止修改文件和执行 shell，不能申请单次放行。");
        let target: string | undefined;
        let needsApproval = mode === "workspace-write" && tool.access === "shell";
        if (tool.access === "write") {
          if (!workspace || typeof input.path !== "string") throw new Error("path 必须是文件路径字符串。");
          target = (await localWriteLocation(workspace, input.path)).target;
          // 重新核对根目录，不能通过替换原项目目录把外部目标算作项目内。
          const root = await openWorkspace(workspace.rootPath);
          if (root.rootPath !== workspace.rootPath) throw new Error("项目根目录已发生变化。");
          needsApproval = mode === "workspace-write" && !isWithinWorkspace(root, target);
        }
        if (needsApproval) {
          if (!approve || !execution?.executionId) throw new Error("此调用需要用户审批，宿主未提供审批入口。");
          const allowed = await approve({ toolId: execution.executionId, name, arguments: argumentsJson,
            ...(target === undefined ? {} : { resolvedPath: target }) }, signal);
          signal?.throwIfAborted();
          if (!allowed) throw new Error("用户拒绝了此工具调用，未执行。请调整方案，不要重复请求同一操作。");
        }
        // 写入入口再次解析原始路径并核对目标，不修改模型输入，也不重复预先解析。
        if (target !== undefined) context.writeTarget = target;
        signal?.throwIfAborted();
        try { await execution?.onStart?.(); }
        catch (error) { updateError = error; throw error; }
        const data = await tool.execute(input, signal, context);
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
