import { stat } from "node:fs/promises";
import { TextDecoder } from "node:util";
import { projectFiles, resolveRipgrep, ripgrepPath, ripgrepRecords } from "./ripgrep.ts";
import { SearchBuffer, searchLimit, searchPath, searchPattern, withSearchTimeout } from "./search.ts";
import { decodeText } from "./text.ts";
import { validateKeys, type Tool } from "./tool.ts";
import { resolveWorkspacePath, type Workspace } from "./workspace.ts";

const DEFAULT_MATCHES = 100;
const MAX_MATCHES = 1000;
const MAX_LINE_BYTES = 1024;

/** grep 返回匹配行和有界上下文；行号可以直接用于 read 的 offset。 */
export interface GrepInput { pattern: string; path?: string; glob?: string; ignoreCase?: boolean; literal?: boolean; context?: number; limit?: number }
export interface GrepLine { line: number; text: string; textTruncated: boolean }
export interface GrepMatch extends GrepLine { path: string; before: GrepLine[]; after: GrepLine[] }
interface RgText { text?: string; bytes?: string }
interface RgEvent { type: string; data: { path?: RgText; lines?: RgText; line_number?: number } }

/** 文件名筛选和内容搜索共用 rg，避免 PowerShell 引号及额外搜索后端。 */
export function createGrepTool(workspace: Workspace): Tool {
  return { definition: { type: "function", name: "grep", strict: false,
    description: `搜索项目 UTF-8 文本，默认使用 rg 单行正则，literal=true 改为字面匹配，ignoreCase 默认 false。path 可为目录或文件，省略或空字符串表示根目录。目录搜索包含隐藏文件，遵守 .gitignore/.ignore/.rgignore，排除 .git，不跟随内部链接。显式指定文件时搜索该文件，即使被忽略。glob 只用于目录，含 / 时相对项目根目录，否则匹配各层文件名。默认 ${DEFAULT_MATCHES} 条匹配行，最多 ${MAX_MATCHES} 条，JSON 正文最多 50 KiB。context 默认 0、最多 10；每行最多 ${MAX_LINE_BYTES} UTF-8 字节，textTruncated 表示行不完整。结果包含项目相对路径及从 1 开始的行号，可交给 read。truncated 时缩小范围；单条 rg 记录超过 1 MiB 会报错。搜索最多 30 秒，宿主必须提供 rg。`,
    parameters: { type: "object", additionalProperties: false, required: ["pattern"], properties: {
      pattern: { type: "string", description: "单行正则或字面文本，最多 2 KiB；不支持跨行正则。" },
      path: { type: "string", description: "项目相对文件或目录，使用 /；省略或空字符串表示根目录。" },
      glob: { type: "string", description: "目录搜索的 rg glob，例如 *.ts 或 src/**/*.ts，最多 2 KiB；不覆盖忽略规则。" },
      ignoreCase: { type: "boolean", description: "忽略内容大小写，默认 false。" },
      literal: { type: "boolean", description: "将 pattern 当作字面文本，默认 false 使用 rg 正则。" },
      context: { type: "integer", minimum: 0, maximum: 10, description: "每条匹配前后的上下文行数，默认 0，最多 10。" },
      limit: { type: "integer", minimum: 1, maximum: MAX_MATCHES, description: `最多返回匹配行数，默认 ${DEFAULT_MATCHES}。` },
    } },
  }, async execute(args, signal) {
    validateKeys(args, ["pattern", "path", "glob", "ignoreCase", "literal", "context", "limit"]);
    return grepProject(workspace, args as unknown as GrepInput, signal);
  } };
}

/** 按已验证文件分批启动 rg，避免 Windows 命令行长度限制及全项目路径缓存。 */
export async function grepProject(workspace: Workspace, input: GrepInput, signal?: AbortSignal) {
  const path = searchPath(input.path);
  const pattern = searchPattern(input.pattern);
  const glob = input.glob === undefined ? undefined : searchPattern(input.glob, "glob", true);
  const context = input.context === undefined ? 0 : input.context;
  if (!Number.isInteger(context) || context < 0 || context > 10) throw new Error("context 必须是 0 到 10 的整数。");
  for (const key of ["ignoreCase", "literal"] as const) if (input[key] !== undefined && typeof input[key] !== "boolean") throw new Error(`${key} 必须是布尔值。`);
  if (path.split("/").some((part) => part.toLowerCase() === ".git")) throw new Error("搜索工具不访问 .git 目录。");
  const result = new SearchBuffer<GrepMatch>(searchLimit(input.limit, DEFAULT_MATCHES, MAX_MATCHES), path);
  return withSearchTimeout(signal, async (signal) => {
    const target = await resolveWorkspacePath(workspace, path);
    const isFile = (await stat(target)).isFile();
    if (isFile && glob !== undefined) throw new Error("path 指向文件时不使用 glob，请省略 glob。");
    const executable = await resolveRipgrep();
    /** 仅使用已经枚举及验证的文件；上下文直接来自 rg，不重新读整份文件。 */
    async function searchBatch(files: string[]): Promise<boolean> {
      for (const file of files) await resolveWorkspacePath(workspace, file);
      const allowed = new Set(files);
      let pending: GrepMatch | undefined;
      let history: GrepLine[] = [];
      let currentPath = "";
      const args = ["--json", "--line-number", "--color=never", "--no-follow", "--encoding", "none", "--context", String(context),
        ...(input.ignoreCase ? ["--ignore-case"] : []), ...(input.literal ? ["--fixed-strings"] : []), "--", pattern,
        // ./ 保证名为 - 的文件不被 rg 当成标准输入。
        ...(files.length ? files.map((file) => `./${file}`) : ["-"]),
      ];
      for await (const record of ripgrepRecords(executable, workspace.rootPath, args, "\n", signal)) {
        const event = JSON.parse(record) as RgEvent;
        if (event.type === "begin") {
          currentPath = ripgrepPath(rgText(event.data.path));
          if (!allowed.has(currentPath)) throw new Error("rg 返回了搜索范围外的文件。");
          history = [];
        } else if (event.type === "match" || event.type === "context") {
          const line = grepLine(event.data);
          if (pending && line.line > pending.line && line.line <= pending.line + context) pending.after.push(line);
          if (event.type === "match") {
            if (pending && !result.add(pending)) return false;
            pending = { path: currentPath, ...line, before: history.filter((entry) => entry.line >= line.line - context), after: [] };
          }
          if (context > 0) history = [...history.filter((entry) => entry.line > line.line - context), line];
        } else if (event.type === "end") {
          if (pending && !result.add(pending)) return false;
          pending = undefined;
        }
      }
      return true;
    }
    // 显式搜索空 stdin 验证正则；没有候选文件时也不能把无效正则当成无匹配。
    await searchBatch([]);
    if (isFile) await searchBatch([path]);
    else {
      let batch: string[] = [];
      let characters = 0;
      let stopped = false;
      for await (const file of projectFiles(workspace, path, executable, signal, glob)) {
        if (file.length + 5 > 12000) throw new Error("文件路径超过单次搜索参数上限。");
        if (batch.length >= 100 || characters + file.length + 5 > 12000) {
          if (!await searchBatch(batch)) { stopped = true; break; }
          batch = []; characters = 0;
        }
        batch.push(file); characters += file.length + 5;
      }
      if (!stopped && batch.length) await searchBatch(batch);
    }
    return { path, matches: result.items, ...result.state };
  });
}

/** rg 用 text 或 base64 表示原文；两种形式均严格验证 UTF-8。 */
function rgText(value: RgText | undefined): string {
  if (typeof value?.text === "string") return value.text;
  if (typeof value?.bytes === "string") return decodeText(new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }), Buffer.from(value.bytes, "base64"));
  throw new Error("rg 记录缺少文本或路径。");
}

/** 只移除行末 LF/CRLF，保留其他字符；超长行保留完整 UTF-8 前缀。 */
function grepLine(data: RgEvent["data"]): GrepLine {
  const line = data.line_number;
  if (typeof line !== "number" || !Number.isSafeInteger(line) || line < 1) throw new Error("rg 返回了无效行号。");
  let text = rgText(data.lines).replace(/\r?\n$/, "");
  if (line === 1 && text.startsWith("\ufeff")) text = text.slice(1);
  const bytes = Buffer.from(text, "utf8");
  decodeText(new TextDecoder("utf-8", { fatal: true }), bytes);
  let end = Math.min(bytes.length, MAX_LINE_BYTES);
  while (end < bytes.length && (bytes[end]! & 0xc0) === 0x80) end--;
  return { line, text: bytes.subarray(0, end).toString("utf8"), textTruncated: end < bytes.length };
}
