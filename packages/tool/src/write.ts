import { prepareTarget, replaceFile, withFileMutation, type WriteResult } from "./file-write.ts";
import { validateKeys, type Tool } from "./tool.ts";
import type { Workspace } from "./workspace.ts";

/** 创建或覆盖文件的参数；内容以 UTF-8 原样保存。 */
export interface WriteInput { path: string; content: string }

/** 创建 write 声明与执行函数，固定宿主选择的项目。 */
export function createWriteTool(workspace: Workspace): Tool {
  return {
    definition: {
      type: "function", name: "write", strict: false,
      description: "以 UTF-8 创建或完整覆盖项目文件，自动创建父目录。覆盖已有文件前先读取。路径使用 /，不允许绝对路径和内部链接。",
      parameters: { type: "object", additionalProperties: false, required: ["path", "content"], properties: {
        path: { type: "string", description: "项目相对文件路径，使用 / 分隔。" },
        content: { type: "string", description: "完整文件内容，以 UTF-8 原样保存；空字符串会清空文件。" },
      } },
    },
    async execute(args, signal) {
      validateKeys(args, ["path", "content"]);
      if (typeof args.path !== "string" || typeof args.content !== "string") throw new Error("path 和 content 必须是字符串。");
      return writeProjectFile(workspace, { path: args.path, content: args.content }, signal);
    },
  };
}

/** 创建或覆盖项目内文件，自动创建缺少的父目录；同文件修改串行。 */
export async function writeProjectFile(workspace: Workspace, input: WriteInput, signal?: AbortSignal): Promise<WriteResult> {
  signal?.throwIfAborted();
  if (typeof input.path !== "string" || typeof input.content !== "string") throw new Error("path 和 content 必须是字符串。");
  return withFileMutation(workspace, input.path, signal, async () => {
    const target = await prepareTarget(workspace, input.path, signal);
    return replaceFile(workspace, input.path, target, input.content, signal);
  });
}
