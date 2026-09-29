import { useEffect, useState, type RefObject } from "react";
import type { TurnRecord } from "../conversation";
import { Tooltip, TooltipContent, TooltipTrigger } from "../components/ui/tooltip";

/** 取最新一条正文作为悬停摘要，排除推理与工具输出；没有正文时显示轮次状态。 */
function answerPreview(record: TurnRecord): string {
  const messages = [...record.attempts.flatMap((attempt) => attempt.messages), ...record.previews];
  const answer = messages.findLast((message) => message.parts.some((part) => part.kind === "text"));
  if (answer) return answer.parts.filter((part) => part.kind === "text").map((part) => part.text).join(" ").slice(0, 240);
  const labels = { running: "正在生成…", completed: "本轮已完成", failed: "生成失败", cancelled: "已停止", interrupted: "运行已中断" };
  return labels[record.turn.status];
}

/** 左侧时间轴：每轮对话一条刻度，可见的轮次高亮，点击跳转到该轮。对话区窄于 880px 时正文会贴近刻度，直接隐藏。 */
export function Timeline({ records, scroll }: { records: TurnRecord[]; scroll: RefObject<HTMLDivElement | null> }) {
  const [visible, setVisible] = useState<Set<string>>(new Set());

  useEffect(() => {
    const root = scroll.current;
    if (!root) return;
    // IntersectionObserver 在元素进入或离开滚动区域时回调，用来判断哪些轮次正在显示。
    const observer = new IntersectionObserver((changes) => setVisible((current) => {
      const next = new Set(current);
      for (const change of changes) {
        const id = (change.target as HTMLElement).dataset.turn!;
        if (change.isIntersecting) next.add(id);
        else next.delete(id);
      }
      return next;
    }), { root });
    for (const node of root.querySelectorAll("[data-turn]")) observer.observe(node);
    return () => observer.disconnect();
  }, [scroll, records.length, records[0]?.turn.id]);

  if (records.length < 2) return null;
  return <nav aria-label="对话时间轴" className="absolute top-1/2 left-4 z-10 hidden max-h-[80%] -translate-y-1/2 flex-col overflow-hidden @min-[820px]:flex">
    {records.map((record) => <Tooltip key={record.turn.id} delayDuration={120}>
      <TooltipTrigger asChild><button type="button" aria-label={`跳转到：${record.inputs[0]?.content.slice(0, 60) ?? "此轮对话"}`}
      className="group/tick flex h-2.5 w-6 shrink-0 items-center outline-none"
      onClick={() => scroll.current?.querySelector(`[data-turn="${record.turn.id}"]`)?.scrollIntoView({ behavior: "smooth", block: "start" })}>
      <span className={`h-0.5 w-1.5 rounded-full transition-[width,background-color] group-hover/tick:w-6 group-hover/tick:bg-foreground group-focus-visible/tick:w-6 group-focus-visible/tick:bg-foreground group-data-[state=delayed-open]/tick:w-6 ${visible.has(record.turn.id) ? "bg-[#a3a3a3]" : "bg-[#464646]"}`} />
    </button></TooltipTrigger>
      <TooltipContent side="right" sideOffset={12} collisionPadding={16} showArrow={false}
        className="w-80 max-w-[calc(100vw-32px)] rounded-2xl border bg-popover px-3 py-2.5 text-left text-sm text-pretty text-popover-foreground shadow-lg">
        <p className="line-clamp-1 font-semibold wrap-anywhere">{record.inputs[0]?.content ?? "此轮对话"}</p>
        <p className="mt-1 line-clamp-2 leading-6 wrap-anywhere text-muted-foreground">{answerPreview(record)}</p>
      </TooltipContent>
    </Tooltip>)}
  </nav>;
}
