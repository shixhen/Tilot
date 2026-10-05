import { useEffect, useState } from "react";
import { Check, ChevronRight, CircleAlert, FileText, Folder, Globe, LoaderCircle, Search, Terminal } from "lucide-react";
import type { ToolView } from "@tilot/protocol";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "../components/ui/collapsible";
import { ToolResult } from "./tool-result";
import { ElapsedTime } from "./elapsed-time";

/** 解析展示用 JSON；无效模型参数保留原文供用户查看。 */
function readObject(text: string | null): Record<string, unknown> {
  if (text === null) return {};
  try {
    const value: unknown = JSON.parse(text);
    return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
  } catch { return {}; }
}

/** 显示工具状态、参数及结果；执行中自动展开，执行结束自动收起。 */
export function ToolCall({ tool, active }: { tool: ToolView; active: boolean }) {
  const args = readObject(tool.arguments);
  const result = readObject(tool.output);
  const data = result.data && typeof result.data === "object" ? result.data as Record<string, unknown> : {};
  const running = active && tool.running && tool.output === null;
  const [open, setOpen] = useState(running);
  const [compact, setCompact] = useState(running);
  useEffect(() => setOpen(running), [running]);
  let status = running ? "执行中" : active ? "等待结果" : "执行结果未知";
  let failed = false;
  if (tool.output !== null) {
    if (result.status === "not_executed") status = "未执行";
    else if (result.status === "cancelled" || data.status === "cancelled") status = "已取消";
    else if (data.status === "timed_out") { status = "已超时"; failed = true; }
    else if (result.status === "error" || (typeof data.exitCode === "number" && data.exitCode !== 0)) { status = "执行失败"; failed = true; }
    else if (typeof data.logError === "string") { status = "命令完成，日志保存失败"; failed = true; }
    else status = "已完成";
  }
  const fileTool = ["read", "write", "edit"].includes(tool.name);
  const searchTool = ["find", "grep"].includes(tool.name);
  const webTool = tool.name === "web_fetch";
  const labels: Record<string, string> = { read: "读取文件", write: "写入文件", edit: "编辑文件", shell: "执行命令", ls: "列出目录", find: "查找文件", grep: "搜索代码", web_fetch: "读取网页" };
  const summary = fileTool ? args.path ?? (typeof args.outputId === "string" ? "命令日志" : undefined)
    : tool.name === "shell" ? args.command : tool.name === "ls" ? args.path || "项目根目录" : searchTool ? args.pattern : webTool ? args.url ?? "网页缓存" : tool.name;
  // 执行中只预览开头几行，超出部分以省略号结尾；手动展开时显示全文并可滚动。
  const box = compact ? "line-clamp-4 overflow-hidden" : "max-h-40 overflow-auto";
  return <Collapsible open={open} onOpenChange={(value) => { setOpen(value); if (value && !running) setCompact(false); }} className="group/tool min-w-0 text-sm">
    <CollapsibleTrigger className="flex max-w-full min-w-0 items-center gap-2 rounded-sm text-left text-muted-foreground outline-none transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring">
      {running ? <LoaderCircle className="size-3.5 shrink-0 animate-spin" /> : fileTool ? <FileText className="size-3.5 shrink-0" />
        : tool.name === "ls" ? <Folder className="size-3.5 shrink-0" /> : searchTool ? <Search className="size-3.5 shrink-0" /> : webTool ? <Globe className="size-3.5 shrink-0" /> : <Terminal className="size-3.5 shrink-0" />}
      <span className={`shrink-0 ${running ? "shimmer-text" : ""}`}>{labels[tool.name] ?? tool.name}</span>
      <code className="min-w-0 truncate font-mono text-[13px]" title={typeof summary === "string" ? summary : undefined}>{typeof summary === "string" ? summary : "参数无效"}</code>
      {failed ? <span className="flex shrink-0 items-center gap-1 text-xs text-destructive"><CircleAlert className="size-3" />{status}</span>
        : !running && <span className="flex shrink-0 items-center gap-1 text-xs">{status === "已完成" && <Check className="size-3" />}{status}</span>}
      {result.status !== "not_executed" && <ElapsedTime startedAt={tool.startedAt} durationMs={tool.durationMs} running={running} />}
      <ChevronRight className="disclosure-icon size-3.5 opacity-0 transition-[opacity,rotate] group-hover/tool:opacity-100 group-data-[state=open]/tool:rotate-90 group-data-[state=open]/tool:opacity-100" />
    </CollapsibleTrigger>
    <CollapsibleContent className="mt-2 min-w-0 overflow-hidden rounded-lg border bg-black/20">
      <pre aria-label="工具输入" className={`${box} border-b px-3 py-2 font-mono text-xs leading-relaxed whitespace-pre-wrap wrap-anywhere text-muted-foreground`}>{tool.arguments}</pre>
      {tool.output !== null && <ToolResult name={tool.name} result={result} output={tool.output} />}
      {tool.output === null && tool.preview && <>
        <pre aria-label="命令临时输出" className="max-h-72 overflow-auto px-3 py-2 font-mono text-xs leading-relaxed whitespace-pre-wrap wrap-anywhere">{tool.preview.output || "（无输出）"}</pre>
      </>}
    </CollapsibleContent>
  </Collapsible>;
}
