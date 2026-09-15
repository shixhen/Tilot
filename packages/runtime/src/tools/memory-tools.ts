import { snapshot } from "@tilot/agent-core";
import type {
  Cancellation, JsonValue, ToolDefinition, ToolExecution, ToolExecutor, ToolResult, ValidationResult,
} from "@tilot/agent-core";

export const DEMO_PROJECT_ID = "memory-demo";
export const DEMO_FILES: Readonly<Record<string, string>> = Object.freeze({
  "示例 项目/问候.ts": 'export function greet(name: string): string {\n  return `你好，${name}！`;\n}\n',
});

export class MemoryTools implements ToolExecutor {
  readonly definitions: readonly ToolDefinition[] = snapshot([
    {
      name: "list_files", description: "列出固定内存项目中的文件", effect: "read",
      parameters: {
        type: "object", properties: { projectId: { type: "string" } },
        required: ["projectId"], additionalProperties: false,
      },
    },
    {
      name: "read_file", description: "读取固定内存项目中的文本和行号", effect: "read",
      parameters: {
        type: "object", properties: { projectId: { type: "string" }, path: { type: "string" } },
        required: ["projectId", "path"], additionalProperties: false,
      },
    },
  ]);
  #files: Readonly<Record<string, string>>;
  constructor(files: Readonly<Record<string, string>> = DEMO_FILES) { this.#files = snapshot(files); }
  async validate(name: string, args: JsonValue): Promise<ValidationResult> {
    if (!args || typeof args !== "object" || Array.isArray(args)) return this.invalid("参数必须是对象");
    const values = args as Record<string, JsonValue>;
    const keys = name === "list_files" ? ["projectId"] : ["projectId", "path"];
    if (!["list_files", "read_file"].includes(name) || Object.keys(values).some(key => !keys.includes(key)) || keys.some(key => typeof values[key] !== "string")) return this.invalid("参数名称或类型不合法");
    if (values.projectId !== DEMO_PROJECT_ID) return this.invalid("只能访问固定内存项目");
    return { ok: true, arguments: snapshot(args) };
  }
  private invalid(message: string): ValidationResult { return { ok: false, error: { code: "INVALID_ARGUMENTS", message } }; }
  async execute(input: ToolExecution, cancellation: Cancellation): Promise<ToolResult> {
    if (cancellation.cancelled) return { status: "cancelled", summary: "已取消内存读取" };
    // Recheck at the executor boundary as well; Core validation is not authorization.
    const checked = await this.validate(input.name, input.arguments);
    if (!checked.ok) return { status: "error", summary: checked.error.message, error: checked.error };
    if (cancellation.cancelled) return { status: "cancelled", summary: "已取消内存读取" };
    if (input.name === "list_files") return { status: "ok", summary: "已列出内存文件", data: { paths: Object.keys(this.#files).sort() } };
    const path = (checked.arguments as Record<string, JsonValue>).path as string;
    if (!Object.hasOwn(this.#files, path)) return { status: "error", summary: "内存文件不存在", error: { code: "NOT_FOUND", message: "内存文件不存在" } };
    const content = this.#files[path]!;
    const lines = content.split("\n");
    if (lines.at(-1) === "") lines.pop();
    return { status: "ok", summary: `已读取 ${path}`, data: { path, content, lines: lines.map((text, i) => ({ line: i + 1, text })) } };
  }
}
