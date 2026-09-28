import { useEffect, useState, type RefObject } from "react";
import type { TurnRecord } from "../conversation";

/** 左侧时间轴：每轮对话一条刻度，可见的轮次高亮，点击跳转到该轮。 */
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
  return <nav aria-label="对话时间轴" className="absolute top-1/2 left-4 z-10 hidden max-h-[80%] -translate-y-1/2 flex-col overflow-hidden md:flex">
    {records.map((record) => <button key={record.turn.id} type="button" title={record.inputs[0]?.content.slice(0, 60)} aria-label="跳转到此轮对话"
      className="group/tick flex h-2.5 w-6 shrink-0 items-center outline-none"
      onClick={() => scroll.current?.querySelector(`[data-turn="${record.turn.id}"]`)?.scrollIntoView({ behavior: "smooth", block: "start" })}>
      <span className={`h-0.5 w-1.5 rounded-full transition-[width,background-color] group-hover/tick:w-3 group-hover/tick:bg-foreground group-focus-visible/tick:bg-foreground ${visible.has(record.turn.id) ? "bg-[#a3a3a3]" : "bg-[#464646]"}`} />
    </button>)}
  </nav>;
}
