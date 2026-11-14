import { memo, useId, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { ChevronRight, CircleAlert, Square } from "lucide-react";
import { Button } from "../components/ui/button";
import type { MessagePart, TextTiming, ToolView, Turn, TurnInput } from "@tilot/protocol";
import type { TurnRecord } from "../conversation";
import { getTurnMetrics, type TurnMetrics } from "../request-metrics";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "../components/ui/collapsible";
import { MessageMarkdown } from "./markdown";
import { ToolCall } from "./tool-call";
import { MessageActions } from "./message-actions";
import { ElapsedTime, formatDuration } from "./elapsed-time";
import { hasSelection, useAutoDisclosure } from "../hooks/use-auto-disclosure";
import { ImageGallery } from "./images";

export { formatDuration } from "./elapsed-time";

/** 一轮对话按显示顺序展开后的条目。 */
type Entry =
  | { kind: "input"; input: TurnInput }
  | { kind: "message"; key: string; parts: MessagePart[]; time: number | null }
  | { kind: "reasoning"; key: string; part: MessagePart }
  | { kind: "tool"; tool: ToolView };

type ProcessEntry = Extract<Entry, { kind: "reasoning" | "tool" }>;
type TranscriptBlock = Exclude<Entry, ProcessEntry> | {
  kind: "process"; key: string; entries: ProcessEntry[];
};

/** 当天只显示时间，一周内显示星期，更早显示日期。 */
export function formatTime(time: number, now = Date.now()): string {
  const date = new Date(time);
  const clock = date.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false });
  if (date.toDateString() === new Date(now).toDateString()) return clock;
  if (now - time < 6 * 24 * 3600 * 1000) return `${date.toLocaleDateString("zh-CN", { weekday: "long" })} ${clock}`;
  return `${date.getMonth() + 1}月${date.getDate()}日 ${clock}`;
}

/** 思考默认紧凑预览，手动展开可滚动回看全文，离开底部后停止跟随增量。 */
function Reasoning({ text, live, timing }: { text: string; live: boolean; timing?: TextTiming | undefined }) {
  const { open, onOpenChange, content } = useAutoDisclosure(live);
  const [compact, setCompact] = useState(live);
  const box = useRef<HTMLDivElement>(null);
  const follow = useRef(true);
  useLayoutEffect(() => {
    const node = box.current;
    const prose = node?.firstElementChild;
    if (!live || !open || !node || !prose) return;
    // Markdown 可能延后一帧提交，只在实际高度变化时跟随。
    const observer = new ResizeObserver(() => {
      if (!follow.current || hasSelection(node)) return;
      const bottom = node.scrollHeight - node.clientHeight;
      if (bottom - node.scrollTop > 1) node.scrollTop = bottom;
    });
    observer.observe(prose);
    observer.observe(node);
    return () => observer.disconnect();
  }, [live, open]);
  return <Collapsible open={open} onOpenChange={(value) => {
    onOpenChange(value);
    if (value) setCompact(false);
  }} className="text-sm text-muted-foreground">
    <CollapsibleTrigger className="group flex items-center gap-1 rounded-sm outline-none transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring">
      <span className={live ? "shimmer-text" : undefined}>{live ? "正在思考" : "思考"}</span>
      <ElapsedTime startedAt={timing?.startedAt} durationMs={timing?.durationMs} running={live} />
      <ChevronRight className="disclosure-icon size-3.5 transition-transform group-data-[state=open]:rotate-90" />
    </CollapsibleTrigger>
    <CollapsibleContent ref={content}>
      {/* 生成中顶部渐隐，提示上方还有被推走的内容。 */}
      <div ref={box} onScroll={(event) => {
        const node = event.currentTarget;
        follow.current = node.scrollHeight - node.scrollTop - node.clientHeight < 16;
      }} className={`mt-2 border-l-2 pl-4 ${compact ? "max-h-36 overflow-hidden mask-t-from-75%" : "max-h-72 overflow-auto"}`}>
        <MessageMarkdown text={text} streaming={live && open} autoLoadImages={false} />
      </div>
    </CollapsibleContent>
  </Collapsible>;
}

/** 正文和拒绝信息独立展示；思考另放在过程块里。 */
function MessageParts({ parts, live }: { parts: MessagePart[]; live: boolean }) {
  return <div className="grid min-w-0 grid-cols-1 gap-4">{parts.map((part, index) =>
    <div key={index} className={part.kind === "refusal" ? "text-muted-foreground" : undefined}><MessageMarkdown text={part.text} streaming={live && index === parts.length - 1} /></div>)}</div>;
}

/** 连续思考和工具共用一个折叠块；更新内容不覆盖手动开关，离开当前块时收起。 */
function ProcessBlock({ block, live, children }: { block: Extract<TranscriptBlock, { kind: "process" }>; live: boolean; children: ReactNode }) {
  const { open, onOpenChange, content } = useAutoDisclosure(live);
  const thoughts = block.entries.filter((entry) => entry.kind === "reasoning").length;
  const tools = block.entries.length - thoughts;
  return <Collapsible open={open} onOpenChange={onOpenChange} className="group/process min-w-0" data-process={block.key}>
    <CollapsibleTrigger className="flex items-end gap-1.5 rounded-sm text-sm text-muted-foreground outline-none transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring">
      <span className={live ? "shimmer-text" : undefined}>{live ? "正在思考" : tools > 0 ? "已运行命令" : "已完成思考"}</span>
      {tools > 0 && <span className="text-xs">{thoughts > 0 && `${thoughts} 次思考 · `}{tools} 次工具调用</span>}
      <ChevronRight className="disclosure-icon size-3.5 self-center transition-transform group-data-[state=open]/process:rotate-90" />
    </CollapsibleTrigger>
    <CollapsibleContent ref={content} className="grid min-w-0 grid-cols-1 gap-2 border-l pl-3 pt-2">{children}</CollapsibleContent>
  </Collapsible>;
}

/** 图片和文字按同一条用户消息展示，纯图片不额外补正文。 */
function UserMessage({ input, onEdit, disabled }: { input: TurnInput; onEdit?: ((text: string) => void) | undefined; disabled: boolean }) {
  const text = input.questionId ? input.content.slice(input.content.indexOf("\n\n") + 2) : input.content;
  return <div className="group/message ml-auto min-w-0 max-w-[75%]">
    {input.images?.length ? <div className="mb-2"><ImageGallery images={input.images} /></div> : null}
    {text && <div className="ml-auto w-fit max-w-full rounded-[18px] bg-bubble px-4 py-2.5 text-[15px] leading-[1.6] whitespace-pre-wrap wrap-anywhere text-white/95">{text}</div>}
    <MessageActions user text={text} time={input.createdAt} onEdit={onEdit} disabled={disabled} />
  </div>;
}

/** 渲染单个条目；live 表示它是运行中轮次的最新条目。 */
function EntryView({ entry, active, live, showActions, metrics, onEdit, editDisabled }: { entry: Entry; active: boolean; live: boolean; showActions: boolean; metrics: TurnMetrics; onEdit?: ((text: string) => void) | undefined; editDisabled: boolean }) {
  if (entry.kind === "input") return <UserMessage input={entry.input} onEdit={onEdit} disabled={editDisabled} />;
  if (entry.kind === "tool") return <ToolCall tool={entry.tool} active={active} />;
  if (entry.kind === "reasoning") return <Reasoning text={entry.part.text} timing={entry.part.timing} live={live && entry.part.timing?.durationMs == null} />;
  const text = entry.parts.map((part) => part.text).join("\n\n");
  return <article className="group/message min-w-0 max-w-full"><MessageParts parts={entry.parts} live={live} />
    {text && showActions && <MessageActions text={text} time={entry.time} metrics={metrics} running={active} />}
  </article>;
}

/** 按模型请求的输入边界合并正式历史与实时预览，保持原始顺序。 */
function listEntries(record: TurnRecord): Entry[] {
  const entries: Entry[] = [];
  // 同一消息也可能混合思考和正文，按内容顺序分开，正文不会被过程折叠隐藏。
  function appendMessage(key: string, parts: MessagePart[], time: number | null): void {
    let message: Extract<Entry, { kind: "message" }> | undefined;
    parts.forEach((part, index) => {
      if (!part.text) return;
      if (part.kind === "reasoning") {
        entries.push({ kind: "reasoning", key: `${key}-reasoning-${index}`, part });
        message = undefined;
      } else {
        if (!message) {
          message = { kind: "message", key: `${key}-text-${index}`, parts: [], time };
          entries.push(message);
        }
        message.parts.push(part);
      }
    });
  }
  let throughId = 0;
  for (const attempt of record.attempts) {
    for (const input of record.inputs) {
      if (input.id > throughId && input.id <= attempt.inputThroughId) entries.push({ kind: "input", input });
    }
    throughId = attempt.inputThroughId;
    for (const item of [...attempt.messages, ...attempt.tools].sort((a, b) => a.outputIndex - b.outputIndex)) {
      if ("parts" in item) appendMessage(item.itemId, item.parts, attempt.finishedAt);
      else entries.push({ kind: "tool", tool: item });
    }
  }
  for (const input of record.inputs) if (input.id > throughId) entries.push({ kind: "input", input });
  for (const preview of record.previews) appendMessage(preview.itemId, preview.parts, record.turn.finishedAt);
  return entries;
}

/** 条目的稳定 key。 */
function entryKey(entry: Entry): string {
  return entry.kind === "input" ? `input-${entry.input.id}` : entry.kind === "tool" ? `tool-${entry.tool.id}` : entry.key;
}

/** 按正文及用户输入分隔过程块，跨模型请求合并，key 不随流式内容或工具状态变化。 */
export function listTranscriptBlocks(record: TurnRecord): TranscriptBlock[] {
  const entries = listEntries(record);
  const blocks: TranscriptBlock[] = [];
  function processBlock(): Extract<TranscriptBlock, { kind: "process" }> {
    const previous = blocks.at(-1);
    if (previous?.kind === "process") return previous;
    const block: Extract<TranscriptBlock, { kind: "process" }> = {
      kind: "process", key: `process-${previous ? entryKey(previous) : "start"}`, entries: [],
    };
    blocks.push(block);
    return block;
  }
  for (const entry of entries) {
    if (entry.kind === "tool" || entry.kind === "reasoning") processBlock().entries.push(entry);
    else blocks.push(entry);
  }
  const last = entries.at(-1);
  if (record.turn.status === "running" && (!last || last.kind === "input")) processBlock();
  return blocks;
}

/** 整轮总开关：保留用户输入及最终正文，其余过程一起折叠，内部仍可独立开关。 */
function TurnProcess({ turn, blocks, answer, renderBlock }: {
  turn: Turn; blocks: TranscriptBlock[]; answer: TranscriptBlock | undefined; renderBlock: (block: TranscriptBlock) => ReactNode;
}) {
  const contentId = useId();
  const sections: { key: string; visible: boolean; blocks: TranscriptBlock[] }[] = [];
  for (const block of blocks) {
    const visible = block.kind === "input" || block === answer;
    const previous = sections.at(-1);
    if (!visible && previous && !previous.visible) previous.blocks.push(block);
    else sections.push({ key: block.kind === "process" ? block.key : entryKey(block), visible, blocks: [block] });
  }
  const foldable = !!answer && sections.some((section) => !section.visible);
  // 以可见消息为界，每段连续过程共用一个动画容器。
  const controls = sections.flatMap((section, index) => section.visible ? [] : [`${contentId}-${index}`]).join(" ");
  // 成功后恢复原有的默认收起；未完成或异常结束时保留过程供用户查看。
  const { open, onOpenChange, content } = useAutoDisclosure(turn.status !== "completed" || !foldable);
  return <Collapsible ref={content} open={open} onOpenChange={onOpenChange} className="group/work min-w-0" data-turn-process={turn.id}>
    {foldable && <CollapsibleTrigger aria-controls={controls} className="flex items-center gap-1 rounded-sm text-sm text-muted-foreground outline-none transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring">
      <span>{turn.status === "running" ? "执行过程" : `用时 ${formatDuration((turn.finishedAt ?? turn.createdAt) - turn.createdAt)}`}</span>
      <ChevronRight className="disclosure-icon size-3.5 transition-transform group-data-[state=open]/work:rotate-90" />
    </CollapsibleTrigger>}
    {sections.map((section, index) => {
      const spacing = foldable || index > 0 ? "pt-5" : undefined;
      const children = <div className="grid min-w-0 grid-cols-1 gap-5">{section.blocks.map(renderBlock)}</div>;
      return section.visible
        ? <div key={section.key} className={spacing}>{children}</div>
        : <CollapsibleContent key={section.key} id={`${contentId}-${index}`} className={spacing}>{children}</CollapsibleContent>;
    })}
  </Collapsible>;
}

/** 一轮对话：整轮总开关包住中间正文及过程块，最终正文始终独立显示。 */
export const TurnMessages = memo(function TurnMessages({ record, time, onResume, resumeDisabled, onEdit, editDisabled = false }: { record: TurnRecord; time?: number | undefined; onResume?: (() => void) | undefined; resumeDisabled?: boolean; onEdit?: ((text: string) => void) | undefined; editDisabled?: boolean }) {
  const { turn } = record;
  const active = turn.status === "running";
  const blocks = listTranscriptBlocks(record);
  const metrics = getTurnMetrics(record);
  const lastBlock = blocks.at(-1);
  const last = lastBlock?.kind === "process" ? lastBlock.entries.at(-1) : lastBlock;
  const answer = blocks.findLast((block) => block.kind === "message");
  // 正文后还有运行中的过程时，它已经是中间消息，不再预留操作栏高度。
  const render = (entry: Entry) => <EntryView key={entryKey(entry)} entry={entry} active={active} live={active && entry === last} showActions={entry === answer && (!active || entry === last)} metrics={metrics} onEdit={onEdit} editDisabled={editDisabled} />;
  const renderBlock = (block: TranscriptBlock) => block.kind === "process"
    ? <ProcessBlock key={block.key} block={block} live={active && block === lastBlock}>{block.entries.map(render)}</ProcessBlock>
    : render(block);
  const firstProcess = blocks.findIndex((block) => block.kind !== "input");
  const inputs = firstProcess < 0 ? blocks : blocks.slice(0, firstProcess);
  const process = firstProcess < 0 ? [] : blocks.slice(firstProcess);
  const labels = { cancelled: "已停止", interrupted: "运行已中断", failed: "生成失败" };

  // 单列使用可缩小到 0 的网格轨道，避免长代码的固有宽度撑开消息列。
  return <section aria-label="对话轮次" data-turn={turn.id} className="grid min-w-0 grid-cols-1 scroll-mt-6 gap-6">
    {time !== undefined && <p className="pt-2 text-center text-[13px] text-muted-foreground">{formatTime(time)}</p>}
    {inputs.map(renderBlock)}
    {record.notices?.map((notice, index) => <p key={index} role="status" className="break-all text-xs text-muted-foreground">{notice}</p>)}
    {process.length > 0 && <TurnProcess turn={turn} blocks={process} answer={answer} renderBlock={renderBlock} />}
    {!active && record.previews.some((preview) => !preview.complete) && <p className="text-xs text-muted-foreground">未保存的生成片段仅作临时预览。</p>}
    {turn.status !== "running" && turn.status !== "completed" && <p role="status" className={`flex items-center gap-2 text-sm ${turn.status === "failed" ? "text-destructive" : "text-muted-foreground"}`}>
      {turn.status === "cancelled" ? <Square className="size-3" /> : <CircleAlert className="size-3.5" />}
      {labels[turn.status]}{turn.error && ` · ${turn.error}`}
    </p>}
    {turn.status === "interrupted" && onResume && <div className="flex items-center gap-3 text-sm">
      <Button variant="outline" size="sm" disabled={resumeDisabled} onClick={onResume}>继续任务</Button>
      <span className="text-muted-foreground">将先核实已有结果，再继续任务。</span>
    </div>}
  </section>;
});
