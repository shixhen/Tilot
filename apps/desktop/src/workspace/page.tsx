import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { ArrowDown, LoaderCircle, SquarePen } from "lucide-react";
import { useWorkspace } from "../hooks/use-workspace";
import { projectName } from "../projects";
import { SidebarInset, SidebarProvider } from "../components/ui/sidebar";
import { Button } from "../components/ui/button";
import { WorkspaceNavigation } from "./navigation";
import { Composer } from "./composer";
import { SettingsDialog } from "./settings-dialog";
import { TurnMessages } from "./transcript";
import { Timeline } from "./timeline";
import { WorkspaceTitlebar } from "./titlebar";

/** 正文与输入框共用此宽度并同步伸缩：最大 720px，两侧各留 16px。 */
const column = "mx-auto w-full min-w-0 max-w-[752px] px-4";

/** 相邻两轮间隔超过 30 分钟时，在轮次上方显示时间。 */
const TIME_GAP = 30 * 60 * 1000;

/** 侧栏 + 可滚动对话 + 底部输入框的整体布局。 */
export function WorkspacePage() {
  const state = useWorkspace();
  const scroll = useRef<HTMLDivElement>(null);
  const follow = useRef(true);
  const dock = useRef<HTMLDivElement>(null);
  const [atBottom, setAtBottom] = useState(true);
  const records = state.chat.records;
  /** 正在跟随最新内容时滚到底部。 */
  function followBottom(): void {
    if (follow.current && scroll.current) scroll.current.scrollTop = scroll.current.scrollHeight;
  }
  // 输入框变高（多行输入、出现提示）时，同样保持最新内容在输入框上方可见。
  useLayoutEffect(() => {
    const observer = new ResizeObserver(followBottom);
    observer.observe(dock.current!);
    return () => observer.disconnect();
  }, []);
  useEffect(() => { follow.current = true; }, [state.chat.selected]);
  useEffect(followBottom, [records, state.chat.selected]);

  return <SidebarProvider className="h-dvh min-h-0 flex-col overflow-hidden">
    <WorkspaceTitlebar />
    <div className="relative flex min-h-0 min-w-0 flex-1">
    <WorkspaceNavigation state={state} />
    <SidebarInset className="min-h-0 min-w-0 overflow-hidden">
      <header className="flex h-12 shrink-0 items-center justify-between gap-4 px-5">
        <h1 className="flex min-w-0 items-center gap-2 text-[15px] font-semibold">
          <span className="truncate">{state.thread?.title ?? "新对话"}</span>
          {state.projectPath && <span className="hidden shrink-0 font-normal text-muted-foreground md:block">{projectName(state.projectPath)}</span>}
        </h1>
        <Button variant="ghost" size="icon-sm" className="text-muted-foreground" aria-label="新建对话" title="新建对话" disabled={state.busy} onClick={() => state.select(null, state.projectPath)}><SquarePen /></Button>
      </header>
      {/* @container 让时间轴按对话区自身宽度（而非窗口宽度）决定是否显示。 */}
      <div className="@container relative min-h-0 flex-1">
        <Timeline records={records} scroll={scroll} />
        {/* 输入区放在滚动容器内部并用 sticky 固定在底部：它只占内容区，不会盖住滚动条，滚动条仍覆盖整个对话区。 */}
        <div ref={scroll} className="flex h-full flex-col overflow-y-auto [scrollbar-gutter:stable_both-edges]" onScroll={(event) => {
          const node = event.currentTarget;
          const distance = node.scrollHeight - node.scrollTop - node.clientHeight;
          follow.current = distance < 80;
          setAtBottom(distance < 80);
        }}>
          <div className={`${column} grid flex-1 grid-cols-1 content-start gap-8 pt-4 pb-8`}>
            {!state.chat.selected && <div className="flex min-h-[50vh] flex-col items-center justify-center gap-2 text-center">
              <h2 className="text-[28px] font-semibold tracking-tight">{state.projectPath ? `要在 ${projectName(state.projectPath)} 中做什么？` : "有什么可以帮忙的？"}</h2>
              <p className="text-sm text-muted-foreground">{state.projectPath ? "讨论、探索并直接修改项目代码。" : "提出问题，或在左侧打开项目一起编写代码。"}</p>
            </div>}
            {state.chat.historyLoading && records.length === 0 && <p className="flex items-center gap-2 text-sm text-muted-foreground"><LoaderCircle className="size-4 animate-spin" />正在读取对话…</p>}
            {state.chat.selected && !state.chat.historyLoading && records.length === 0 && <p className="text-sm text-muted-foreground">还没有消息，开始这段对话吧。</p>}
            {records.map((record, index) => {
              const previous = records[index - 1];
              const showTime = !previous || record.turn.createdAt - previous.turn.createdAt > TIME_GAP;
              return <TurnMessages key={record.turn.id} record={record} time={showTime ? record.turn.createdAt : undefined}
                onResume={index === records.length - 1 ? () => void state.chat.resume(record.turn.id) : undefined}
                onEdit={(text) => { state.editDraft(text); dock.current?.querySelector("textarea")?.focus(); }} editDisabled={state.busy}
                resumeDisabled={state.busy || !state.chat.connected} />;
            })}
          </div>
          {/* 顶部渐变让滚到下面的文字自然淡出；渐变区域不拦截点击，只有其中的控件可以点击。 */}
          <div ref={dock} className={`${column} pointer-events-none sticky bottom-0 z-10 grid grid-cols-1 gap-3 *:pointer-events-auto bg-[linear-gradient(to_bottom,transparent,var(--background)_1.5rem)] pt-6 pb-5`}>
        {!atBottom && <Button variant="outline" size="icon-sm" aria-label="滚动到底部" title="滚动到底部"
          className="absolute bottom-full left-1/2 -translate-x-1/2 rounded-full bg-background! shadow-md hover:bg-muted!"
          onClick={() => scroll.current?.scrollTo({ top: scroll.current.scrollHeight, behavior: "smooth" })}><ArrowDown /></Button>}
        {(state.chat.error || state.projectError) && <p role="alert" className="rounded-2xl border border-destructive/30 bg-destructive/10 px-4 py-2.5 text-sm text-destructive">{state.projectError || state.chat.error}</p>}
        {state.chat.config && !state.configured && <div className="flex items-center justify-between gap-3 rounded-2xl bg-card/60 px-4 py-2.5 text-sm"><span className="text-muted-foreground">{state.chat.configured.length ? "当前模型所在的服务还没有 API Key。" : "先配置模型连接，即可开始对话。"}</span><Button variant="secondary" size="sm" className="rounded-full" onClick={() => state.setSettingsOpen(true)}>配置连接</Button></div>}
        <Composer state={state} />
          </div>
        </div>
      </div>
    </SidebarInset>
    </div>
    {state.settingsOpen && state.chat.config && <SettingsDialog config={state.chat.config} configured={state.chat.configured} used={state.chat.threads.map((thread) => thread.providerId)} request={state.chat.request} onSaved={state.chat.refreshConfig} onClose={() => state.setSettingsOpen(false)} />}
  </SidebarProvider>;
}
