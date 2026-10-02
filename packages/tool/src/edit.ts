import { lstat, readFile } from "node:fs/promises";
import { TextDecoder } from "node:util";
import { applyEdits, createEditDiff, type TextEdit } from "./edit-diff.ts";
import { replaceFile, withFileMutation, type WriteResult } from "./file-write.ts";
import { decodeText } from "./text.ts";
import { validateKeys, type Tool } from "./tool.ts";
import { resolveWorkspacePath, type Workspace } from "./workspace.ts";

/** 所有替换针对同一份原文件；一项失败则整个调用不写入。 */
export interface EditInput { path: string; edits: TextEdit[] }

/** 保存实际写入的差异，模型和桌面共享这一份结果。 */
export interface EditResult extends WriteResult {
  replacements: number;
  firstChangedLine: number;
  diff: string;
  diffTruncated: boolean;
}

const MAX_EDITS = 20;

/** 校验新调用的结构，不将旧字段、字符串数组或多余字段自动修复。 */
function parseInput(args: Record<string, unknown>): EditInput {
  validateKeys(args, ["path", "edits"]);
  if (typeof args.path !== "string") throw new Error("path 必须是字符串。");
  if (!Array.isArray(args.edits) || args.edits.length < 1 || args.edits.length > MAX_EDITS) {
    throw new Error(`edits 必须是包含 1–${MAX_EDITS} 项的数组。`);
  }
  const edits = args.edits.map((value: unknown, index) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`edits 第 ${index + 1} 项必须是对象。`);
    const edit = value as Record<string, unknown>;
    validateKeys(edit, ["oldText", "newText"]);
    if (typeof edit.oldText !== "string" || !edit.oldText || typeof edit.newText !== "string") {
      throw new Error(`edits 第 ${index + 1} 项的 oldText 必须是非空字符串，newText 必须是字符串。`);
    }
    if (!edit.newText.isWellFormed()) throw new Error(`edits 第 ${index + 1} 项的 newText 含有无效的 Unicode 字符。`);
    return { oldText: edit.oldText, newText: edit.newText };
  });
  return { path: args.path, edits };
}

/** 创建 edit 声明与执行函数，匹配和换行规则直接提供给模型。 */
export function createEditTool(workspace: Workspace): Tool {
  return {
    definition: {
      type: "function", name: "edit", strict: false,
      description: "精确替换 UTF-8 项目文件中的 1–20 处文本。先读取文件；各项 oldText 必须在同一份原文件中非空、唯一匹配且互不重叠。只兼容 LF/CRLF，空格、引号和 Unicode 仍严格匹配。任一项失败则全部不写入。保留 BOM 和未修改内容；插入文本沿用目标片段首次出现的换行，无换行时沿用文件换行，否则用 LF。写入前检查外部修改；无变化时报错。返回实际差异，diffTruncated 为 true 时差异不完整，不能作为补丁应用。",
      parameters: { type: "object", additionalProperties: false, required: ["path", "edits"], properties: {
        path: { type: "string", description: "项目相对文件路径，使用 / 分隔。" },
        edits: { type: "array", minItems: 1, maxItems: MAX_EDITS, description: "针对原文件的替换列表；不能引用其他项新插入的内容。", items: {
          type: "object", additionalProperties: false, required: ["oldText", "newText"], properties: {
            oldText: { type: "string", minLength: 1, description: "原文中唯一匹配的非空片段，提供足够上下文；仅 LF/CRLF 可不同。" },
            newText: { type: "string", description: "替换内容；空字符串表示删除这个片段。" },
          },
        } },
      } },
    },
    async execute(args, signal) {
      return editProjectFile(workspace, parseInput(args), signal);
    },
  };
}

/** 队列内读取、验证和提交，并在替换前检查目标字节是否仍与读取时相同。 */
export async function editProjectFile(workspace: Workspace, input: EditInput, signal?: AbortSignal): Promise<EditResult> {
  signal?.throwIfAborted();
  const { path, edits } = parseInput({ ...input });
  return withFileMutation(workspace, path, signal, async () => {
    const target = await resolveWorkspacePath(workspace, path);
    if (!(await lstat(target)).isFile()) throw new Error("目标必须是普通文件。");
    const bytes = await readFile(target);
    signal?.throwIfAborted();
    const content = decodeText(new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }), bytes);
    const updated = applyEdits(content, edits);
    const difference = createEditDiff(path, content, updated);
    const written = await replaceFile(workspace, path, target, updated, signal, bytes);
    return { ...written, replacements: edits.length, ...difference };
  });
}
