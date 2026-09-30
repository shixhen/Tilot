import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { ChevronRight, CircleAlert, Square } from "lucide-react";
import { Button } from "../components/ui/button";
import type { MessagePart, ResponseMetrics, ToolView, TurnInput } from "@tilot/protocol";
import type { TurnRecord } from "../conversation";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "../components/ui/collapsible";
import { MessageMarkdown } from "./markdown";
import { ToolCall } from "./tool-call";
import { MessageActions } from "./message-actions";

/** 一轮对话按显示顺序展开后的条目：用户输入、模型消息或工具调用。 */
type Entry =
  | { kind: "input"; input: TurnInput }
  | { kind: "message"; key: string; parts: MessagePart[]; time: number | null; metrics?: ResponseMetrics | undefined }
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

/** 思考过程：正在生成时展开并限制高度，新内容把旧内容向上推；生成结束自动收起，之后可手动展开全文。 */
function Reasoning({ text, live }: { text: string; live: boolean }) {
  const [open, setOpen] = useState(live);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => setOpen(live), [live]);
  useLayoutEffect(() => {
    if (live && box.current) box.current.scrollTop = box.current.scrollHeight;
  }, [live, text]);
  return <Collapsible open={open} onOpenChange={setOpen} className="text-sm text-muted-foreground">
    <CollapsibleTrigger className="group flex items-center gap-1 rounded-sm outline-none transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring">
      <span className={live ? "shimmer-text" : undefined}>{live ? "正在思考" : "思考"}</span>
      <ChevronRight className="disclosure-icon size-3.5 transition-transform group-data-[state=open]:rotate-90" />
    </CollapsibleTrigger>
    <CollapsibleContent>
      {/* 生成中顶部渐隐，提示上方还有被推走的内容。 */}
      <div ref={box} className={`mt-2 border-l-2 pl-4 ${live ? "max-h-36 overflow-hidden mask-t-from-75%" : ""}`}><MessageMarkdown text={text} streaming={live} /></div>
    </CollapsibleContent>
  </Collapsible>;
}

/** 渲染同一条回答的推理、正文和拒绝信息；live 表示这条消息正在生成，只有最后一段处于生成中。 */
function MessageParts({ parts, live }: { parts: MessagePart[]; live: boolean }) {
  return <div className="grid min-w-0 grid-cols-1 gap-4">{parts.map((part, index) => part.kind === "reasoning"
    ? <Reasoning key={index} text={part.text} live={live && index === parts.length - 1} />
    : <div key={index} className={part.kind === "refusal" ? "text-muted-foreground" : undefined}><MessageMarkdown text={part.text} streaming={live && index === parts.length - 1} /></div>)}</div>;
}

/** 用户消息使用深蓝色气泡，靠右显示。 */
function UserMessage({ input, onEdit, disabled }: { input: TurnInput; onEdit?: ((text: string) => void) | undefined; disabled: boolean }) {
  return <div className="group/message ml-auto min-w-0 max-w-[75%]">
    <div className="ml-auto w-fit max-w-full rounded-[18px] bg-bubble px-4 py-2.5 text-[15px] leading-[1.6] whitespace-pre-wrap wrap-anywhere text-white/95">{input.content}</div>
    <MessageActions user text={input.content} time={input.createdAt} onEdit={onEdit} disabled={disabled} />
  </div>;
}

/** 渲染单个条目；live 表示它是运行中轮次的最新条目。 */
function EntryView({ entry, active, live, onEdit, editDisabled }: { entry: Entry; active: boolean; live: boolean; onEdit?: ((text: string) => void) | undefined; editDisabled: boolean }) {
  if (entry.kind === "input") return <UserMessage input={entry.input} onEdit={onEdit} disabled={editDisabled} />;
  if (entry.kind === "tool") return <ToolCall tool={entry.tool} active={active} />;
  const text = entry.parts.filter((part) => part.kind !== "reasoning").map((part) => part.text).join("\n\n");
  return <article className="group/message min-w-0 max-w-full"><MessageParts parts={entry.parts} live={live} />
    {text && <MessageActions text={text} time={entry.time} metrics={entry.metrics} />}
  </article>;
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
      entries.push("parts" in item ? { kind: "message", key: item.itemId, parts: item.parts, time: attempt.finishedAt, metrics: attempt.metrics } : { kind: "tool", tool: item });
    }
  }
  for (const input of record.inputs) if (input.id > throughId) entries.push({ kind: "input", input });
  for (const preview of record.previews) entries.push({ kind: "message", key: preview.itemId, parts: preview.parts, time: record.turn.finishedAt });
  return entries;
}

/** 条目的稳定 key。 */
function entryKey(entry: Entry): string {
  return entry.kind === "input" ? `input-${entry.input.id}` : entry.kind === "tool" ? `tool-${entry.tool.id}` : entry.key;
}

/** 一轮对话；完成后把最终回答之前的思考和工具调用折叠为“用时”一行。 */
export function TurnMessages({ record, time, onResume, resumeDisabled, onEdit, editDisabled = false }: { record: TurnRecord; time?: number | undefined; onResume?: (() => void) | undefined; resumeDisabled?: boolean; onEdit?: ((text: string) => void) | undefined; editDisabled?: boolean }) {
  const { turn } = record;
  const active = turn.status === "running";
  const entries = listEntries(record);
  const lastInput = entries.findLastIndex((entry) => entry.kind === "input");
  const answer = entries.findLastIndex((entry) => entry.kind === "message" && entry.parts.some((part) => part.kind === "text"));
  const collapse = turn.status === "completed" && answer > lastInput + 1;
  const last = entries.at(-1);
  const render = (list: Entry[]) => list.map((entry) => <EntryView key={entryKey(entry)} entry={entry} active={active} live={active && entry === last} onEdit={onEdit} editDisabled={editDisabled} />);
  // 最新条目是用户输入或已结束的工具时，模型尚未开始输出，在末尾提示正在思考。
  const waiting = active && (!last || last.kind === "input" || (last.kind === "tool" && last.tool.output !== null));
  const labels = { cancelled: "已停止", interrupted: "运行已中断", failed: "生成失败" };

  // 单列使用可缩小到 0 的网格轨道，避免长代码的固有宽度撑开消息列。
  return <section aria-label="对话轮次" data-turn={turn.id} className="grid min-w-0 grid-cols-1 scroll-mt-6 gap-6">
    {time !== undefined && <p className="pt-2 text-center text-[13px] text-muted-foreground">{formatTime(time)}</p>}
    {collapse ? <>
      {render(entries.slice(0, lastInput + 1))}
      <Collapsible className="group/work border-b pb-2">
        <CollapsibleTrigger className="flex items-center gap-1 rounded-sm text-sm text-muted-foreground outline-none transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring">
          用时 {formatDuration((turn.finishedAt ?? turn.createdAt) - turn.createdAt)}
          <ChevronRight className="disclosure-icon size-4 transition-transform group-data-[state=open]/work:rotate-90" />
        </CollapsibleTrigger>
        <CollapsibleContent className="grid min-w-0 grid-cols-1 gap-4 pt-4 pb-2">{render(entries.slice(lastInput + 1, answer))}</CollapsibleContent>
      </Collapsible>
      {render(entries.slice(answer))}
    </> : render(entries)}
    {!active && record.previews.some((preview) => !preview.complete) && <p className="text-xs text-muted-foreground">未保存的生成片段仅作临时预览。</p>}
    {waiting && <p role="status" className="shimmer-text w-fit text-sm">正在思考</p>}
    {turn.status !== "running" && turn.status !== "completed" && <p role="status" className={`flex items-center gap-2 text-sm ${turn.status === "failed" ? "text-destructive" : "text-muted-foreground"}`}>
      {turn.status === "cancelled" ? <Square className="size-3" /> : <CircleAlert className="size-3.5" />}
      {labels[turn.status]}{turn.error && ` · ${turn.error}`}
    </p>}
    {turn.status === "interrupted" && onResume && <div className="flex items-center gap-3 text-sm">
      <Button variant="outline" size="sm" disabled={resumeDisabled} onClick={onResume}>继续任务</Button>
      <span className="text-muted-foreground">将先核实已有结果，再继续任务。</span>
    </div>}
  </section>;
}
