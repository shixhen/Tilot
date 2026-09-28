import { ChevronRight, CircleAlert, Square } from "lucide-react";
import type { MessagePart, ToolView, TurnInput } from "@tilot/protocol";
import type { TurnRecord } from "../conversation";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "../components/ui/collapsible";
import { MessageMarkdown } from "./markdown";
import { ToolCall } from "./tool-call";

/** 一轮对话按显示顺序展开后的条目：用户输入、模型消息或工具调用。 */
type Entry =
  | { kind: "input"; input: TurnInput }
  | { kind: "message"; key: string; parts: MessagePart[] }
  | { kind: "tool"; tool: ToolView };

/** 将耗时格式化为 Codex 式短文本，例如 9m 46s。 */
export function formatDuration(ms: number): string {
  const seconds = Math.max(1, Math.round(ms / 1000));
  const h = Math.floor(seconds / 3600), m = Math.floor(seconds / 60) % 60, s = seconds % 60;
  if (h > 0) return `${h}h ${m}m`;
  return m > 0 ? `${m}m ${s}s` : `${s}s`;
}

/** 当天只显示时间，一周内显示星期，更早显示日期。 */
export function formatTime(time: number, now = Date.now()): string {
  const date = new Date(time);
  const clock = date.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false });
  if (date.toDateString() === new Date(now).toDateString()) return clock;
  if (now - time < 6 * 24 * 3600 * 1000) return `${date.toLocaleDateString("zh-CN", { weekday: "long" })} ${clock}`;
  return `${date.getMonth() + 1}月${date.getDate()}日 ${clock}`;
}

/** 渲染同一条回答的推理、正文和拒绝信息；推理默认折叠为一行灰字。 */
function MessageParts({ parts }: { parts: MessagePart[] }) {
  return <div className="grid gap-4">{parts.map((part, index) => part.kind === "reasoning"
    ? <Collapsible key={index} className="text-sm text-muted-foreground">
      <CollapsibleTrigger className="group flex items-center gap-1 rounded-sm outline-none transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring">
        思考<ChevronRight className="size-3.5 transition-transform group-data-[state=open]:rotate-90" />
      </CollapsibleTrigger>
      <CollapsibleContent className="mt-2 border-l-2 pl-4"><MessageMarkdown text={part.text} /></CollapsibleContent>
    </Collapsible>
    : <div key={index} className={part.kind === "refusal" ? "text-muted-foreground" : undefined}><MessageMarkdown text={part.text} /></div>)}</div>;
}

/** 用户消息使用深蓝色气泡，靠右显示。 */
function UserMessage({ text }: { text: string }) {
  return <div className="ml-auto max-w-[75%] rounded-[18px] bg-bubble px-4 py-2.5 text-[15px] leading-[1.6] whitespace-pre-wrap wrap-anywhere text-white/95">{text}</div>;
}

/** 渲染单个条目。 */
function EntryView({ entry, active }: { entry: Entry; active: boolean }) {
  if (entry.kind === "input") return <UserMessage text={entry.input.content} />;
  if (entry.kind === "tool") return <ToolCall tool={entry.tool} active={active} />;
  return <article className="max-w-full"><MessageParts parts={entry.parts} /></article>;
}

/** 按模型请求的输入边界合并正式历史与实时预览，保持原始顺序。 */
function listEntries(record: TurnRecord): Entry[] {
  const entries: Entry[] = [];
  let throughId = 0;
  for (const attempt of record.attempts) {
    for (const input of record.inputs) {
      if (input.id > throughId && input.id <= attempt.inputThroughId) entries.push({ kind: "input", input });
    }
    throughId = attempt.inputThroughId;
    for (const item of [...attempt.messages, ...attempt.tools].sort((a, b) => a.outputIndex - b.outputIndex)) {
      entries.push("parts" in item ? { kind: "message", key: item.itemId, parts: item.parts } : { kind: "tool", tool: item });
    }
  }
  for (const input of record.inputs) if (input.id > throughId) entries.push({ kind: "input", input });
  for (const preview of record.previews) entries.push({ kind: "message", key: preview.itemId, parts: preview.parts });
  return entries;
}

/** 条目的稳定 key。 */
function entryKey(entry: Entry): string {
  return entry.kind === "input" ? `input-${entry.input.id}` : entry.kind === "tool" ? `tool-${entry.tool.id}` : entry.key;
}

/** 一轮对话；完成后把最终回答之前的思考和工具调用折叠为“用时”一行。 */
export function TurnMessages({ record, time }: { record: TurnRecord; time?: number | undefined }) {
  const { turn } = record;
  const active = turn.status === "running";
  const entries = listEntries(record);
  const lastInput = entries.findLastIndex((entry) => entry.kind === "input");
  const answer = entries.findLastIndex((entry) => entry.kind === "message" && entry.parts.some((part) => part.kind === "text"));
  const collapse = turn.status === "completed" && answer > lastInput + 1;
  const render = (list: Entry[]) => list.map((entry) => <EntryView key={entryKey(entry)} entry={entry} active={active} />);
  const labels = { cancelled: "已停止", interrupted: "运行已中断", failed: "生成失败" };

  return <section aria-label="对话轮次" data-turn={turn.id} className="grid scroll-mt-6 gap-6">
    {time !== undefined && <p className="pt-2 text-center text-[13px] text-muted-foreground">{formatTime(time)}</p>}
    {collapse ? <>
      {render(entries.slice(0, lastInput + 1))}
      <Collapsible className="group/work border-b pb-2">
        <CollapsibleTrigger className="flex items-center gap-1 rounded-sm text-sm text-muted-foreground outline-none transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring">
          用时 {formatDuration((turn.finishedAt ?? turn.createdAt) - turn.createdAt)}
          <ChevronRight className="size-4 transition-transform group-data-[state=open]/work:rotate-90" />
        </CollapsibleTrigger>
        <CollapsibleContent className="grid gap-4 pt-4 pb-2">{render(entries.slice(lastInput + 1, answer))}</CollapsibleContent>
      </Collapsible>
      {render(entries.slice(answer))}
    </> : render(entries)}
    {!active && record.previews.some((preview) => !preview.complete) && <p className="text-xs text-muted-foreground">未保存的生成片段仅作临时预览。</p>}
    {active && <p role="status" className="shimmer-text w-fit text-sm">正在思考</p>}
    {turn.status !== "running" && turn.status !== "completed" && <p role="status" className={`flex items-center gap-2 text-sm ${turn.status === "failed" ? "text-destructive" : "text-muted-foreground"}`}>
      {turn.status === "cancelled" ? <Square className="size-3" /> : <CircleAlert className="size-3.5" />}
      {labels[turn.status]}{turn.error && ` · ${turn.error}`}
    </p>}
  </section>;
}
