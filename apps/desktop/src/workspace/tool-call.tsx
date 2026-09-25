import { Check, ChevronRight, CircleAlert, FileText, LoaderCircle, Terminal } from "lucide-react";
import type { ToolView } from "@tilot/protocol";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "../components/ui/collapsible";

/** 解析展示用 JSON；无效模型参数保留原文供用户查看。 */
function readObject(text: string | null): Record<string, unknown> {
  if (text === null) return {};
  try {
    const value: unknown = JSON.parse(text);
    return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
  } catch { return {}; }
}

/** 显示工具状态、参数和原始文本结果；不将命令或输出解释为 HTML。 */
export function ToolCall({ tool, active }: { tool: ToolView; active: boolean }) {
  const args = readObject(tool.arguments);
  const result = readObject(tool.output);
  const data = result.data && typeof result.data === "object" ? result.data as Record<string, unknown> : {};
  const running = active && tool.running && tool.output === null;
  let status = running ? "执行中" : active ? "等待结果" : "未取得结果";
  let failed = false;
  if (tool.output !== null) {
    if (result.status === "not_executed") status = "未执行";
    else if (result.status === "cancelled" || data.status === "cancelled") status = "已取消";
    else if (data.status === "timed_out") { status = "已超时"; failed = true; }
    else if (result.status === "error" || (typeof data.exitCode === "number" && data.exitCode !== 0)) { status = "执行失败"; failed = true; }
    else status = "已完成";
  }
  const summary = tool.name === "read" ? args.path : tool.name === "shell" ? args.command : tool.name;
  const output = typeof result.error === "string" ? result.error : typeof data.content === "string" ? data.content : typeof data.output === "string" ? data.output : tool.output;
  return <Collapsible className="min-w-0 rounded-lg border text-sm">
    <CollapsibleTrigger className="group flex w-full min-w-0 items-center gap-2 rounded-lg px-3 py-2 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring">
      {tool.name === "read" ? <FileText className="size-4 shrink-0" /> : <Terminal className="size-4 shrink-0" />}
      <span className="shrink-0">{tool.name === "read" ? "读取文件" : tool.name === "shell" ? "执行命令" : tool.name}</span>
      <span className="min-w-0 flex-1 truncate text-muted-foreground" title={typeof summary === "string" ? summary : undefined}>{typeof summary === "string" ? summary : "参数无效"}</span>
      <span className={`flex shrink-0 items-center gap-1 text-xs ${failed ? "text-destructive" : "text-muted-foreground"}`}>
        {running ? <LoaderCircle className="size-3 animate-spin" /> : failed ? <CircleAlert className="size-3" /> : status === "已完成" ? <Check className="size-3" /> : null}{status}
      </span>
      <ChevronRight className="size-3.5 shrink-0 transition-transform group-data-[state=open]:rotate-90" />
    </CollapsibleTrigger>
    <CollapsibleContent className="min-w-0 space-y-3 border-t p-3">
      <div><p className="mb-1 text-xs text-muted-foreground">参数</p><pre className="max-h-40 overflow-auto whitespace-pre-wrap wrap-anywhere font-mono text-xs">{tool.arguments}</pre></div>
      {output !== null && <div><p className="mb-1 text-xs text-muted-foreground">结果</p><pre className="max-h-72 overflow-auto whitespace-pre-wrap wrap-anywhere font-mono text-xs">{output || "（无输出）"}</pre></div>}
      {typeof data.exitCode === "number" && <p className="text-xs text-muted-foreground">退出码：{data.exitCode}</p>}
      {data.truncated === true && <p className="text-xs text-muted-foreground">输出已截断，仅显示末尾内容。</p>}
      {typeof data.nextOffset === "number" && <p className="text-xs text-muted-foreground">文件尚未读完，可从第 {data.nextOffset} 行继续读取。</p>}
    </CollapsibleContent>
  </Collapsible>;
}
