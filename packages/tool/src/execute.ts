import { TOOL_DESCRIPTIONS, READ_OFFSET_DESCRIPTION } from "@tilot/prompts";
import type { FunctionTool } from "openai/resources/responses/responses";
import { readProjectFile } from "./read.ts";
import { runShell } from "./shell.ts";
import { editProjectFile, writeProjectFile } from "./write.ts";
import type { Workspace } from "./workspace.ts";

/** 当前已实现的模型工具声明；项目根目录由宿主绑定，不允许模型指定。 */
export const projectTools: FunctionTool[] = [
  {
    type: "function", name: "write", strict: false,
    description: TOOL_DESCRIPTIONS.write,
    parameters: { type: "object", additionalProperties: false, required: ["path", "content"], properties: {
      path: { type: "string" }, content: { type: "string" },
    } },
  },
  {
    type: "function", name: "edit", strict: false,
    description: TOOL_DESCRIPTIONS.edit,
    parameters: { type: "object", additionalProperties: false, required: ["path", "oldText", "newText"], properties: {
      path: { type: "string" }, oldText: { type: "string", minLength: 1 }, newText: { type: "string" },
    } },
  },
  {
    type: "function", name: "read", strict: false,
    description: TOOL_DESCRIPTIONS.read,
    parameters: {
      type: "object", additionalProperties: false, required: ["path"],
      properties: {
        path: { type: "string" },
        offset: { type: "integer", minimum: 1, description: READ_OFFSET_DESCRIPTION },
        limit: { type: "integer", minimum: 1, maximum: 200 },
      },
    },
  },
  {
    type: "function", name: "shell", strict: false,
    description: TOOL_DESCRIPTIONS.shell,
    parameters: {
      type: "object", additionalProperties: false, required: ["command"],
      properties: {
        command: { type: "string" },
        timeoutSeconds: { type: "integer", minimum: 1, maximum: 600 },
      },
    },
  },
];

/** 执行一个已登记的调用，返回可持久化的 JSON；参数错误和工具错误也作为结果回传模型。 */
export async function executeTool(workspace: Workspace, name: string, argumentsJson: string, signal?: AbortSignal): Promise<string> {
  try {
    signal?.throwIfAborted();
    const args: unknown = JSON.parse(argumentsJson);
    if (!args || typeof args !== "object" || Array.isArray(args)) throw new Error("工具参数必须是 JSON 对象。");
    const values = args as Record<string, unknown>;
    let data;
    if (name === "write") {
      validateKeys(values, ["path", "content"]);
      if (typeof values.path !== "string" || typeof values.content !== "string") throw new Error("path 和 content 必须是字符串。");
      data = await writeProjectFile(workspace, { path: values.path, content: values.content }, signal);
    } else if (name === "edit") {
      validateKeys(values, ["path", "oldText", "newText"]);
      if (typeof values.path !== "string" || typeof values.oldText !== "string" || typeof values.newText !== "string") throw new Error("path、oldText 和 newText 必须是字符串。");
      data = await editProjectFile(workspace, { path: values.path, oldText: values.oldText, newText: values.newText }, signal);
    } else if (name === "read") {
      validateKeys(values, ["path", "offset", "limit"]);
      if (typeof values.path !== "string") throw new Error("path 必须是字符串。");
      if (values.offset !== undefined && typeof values.offset !== "number") throw new Error("offset 必须是数字。");
      if (values.limit !== undefined && typeof values.limit !== "number") throw new Error("limit 必须是数字。");
      data = await readProjectFile(workspace, {
        path: values.path,
        ...(values.offset === undefined ? {} : { offset: values.offset }),
        ...(values.limit === undefined ? {} : { limit: values.limit }),
      }, signal);
    } else if (name === "shell") {
      validateKeys(values, ["command", "timeoutSeconds"]);
      if (typeof values.command !== "string") throw new Error("command 必须是字符串。");
      if (values.timeoutSeconds !== undefined && typeof values.timeoutSeconds !== "number") throw new Error("timeoutSeconds 必须是数字。");
      data = await runShell(workspace, {
        command: values.command,
        ...(values.timeoutSeconds === undefined ? {} : { timeoutSeconds: values.timeoutSeconds }),
      }, signal);
    } else {
      throw new Error(`未知工具：${name}`);
    }
    return JSON.stringify({ status: "ok", data });
  } catch (error) {
    return JSON.stringify({
      status: error instanceof Error && error.name === "AbortError" ? "cancelled" : "error",
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/** 拒绝声明之外的参数，避免模型以为传入的项目路径或选项已经生效。 */
function validateKeys(values: Record<string, unknown>, allowed: string[]): void {
  if (Object.keys(values).some((key) => !allowed.includes(key))) throw new Error("工具参数包含未支持的字段。");
}
