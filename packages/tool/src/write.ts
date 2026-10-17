import { prepareTarget, replaceFile, withFileMutation, type WriteResult } from "./file-write.ts";
import { validateKeys, type Tool } from "./tool.ts";
import type { Workspace } from "./workspace.ts";
import { localWriteLocation } from "./local-path.ts";

/** 创建或覆盖文件的参数；内容以 UTF-8 原样保存。 */
export interface WriteInput { path: string; content: string }

/** 创建 write 声明与执行函数，固定宿主选择的项目。 */
export function createWriteTool(workspace: Workspace): Tool {
  return {
    access: "write",
    definition: {
      type: "function", name: "write", strict: false,
      description: "以 UTF-8 创建或完整覆盖文件，自动创建父目录。覆盖已有文件前先读取。支持相对路径和绝对路径，相对路径从对话工作目录开始。能否修改及是否需要审批由宿主权限决定。",
      parameters: { type: "object", additionalProperties: false, required: ["path", "content"], properties: {
        path: { type: "string", description: "相对文件路径或绝对路径。" },
        content: { type: "string", description: "完整文件内容，以 UTF-8 原样保存；空字符串会清空文件。" },
      } },
    },
    async execute(args, signal, execution) {
      validateKeys(args, ["path", "content"]);
      if (typeof args.path !== "string" || typeof args.content !== "string") throw new Error("path 和 content 必须是字符串。");
      return writeProjectFile(workspace, { path: args.path, content: args.content }, signal, execution?.writeTarget);
    },
  };
}

/** 创建或覆盖文件，自动创建缺少的父目录；同文件修改串行。 */
export async function writeProjectFile(workspace: Workspace, input: WriteInput, signal?: AbortSignal, expectedTarget?: string): Promise<WriteResult> {
  signal?.throwIfAborted();
  if (typeof input.path !== "string" || typeof input.content !== "string") throw new Error("path 和 content 必须是字符串。");
  const location = await localWriteLocation(workspace, input.path, expectedTarget);
  return withFileMutation(location.workspace, location.path, signal, async () => {
    const target = await prepareTarget(location.workspace, location.path, signal);
    const result = await replaceFile(location.workspace, location.path, target, input.content, signal);
    return { ...result, path: input.path };
  });
}
