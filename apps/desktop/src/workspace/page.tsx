import { useEffect, useRef, useState } from "react";
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

/** 对话区与输入框共用的居中列宽，正文宽度约 736px。 */
const column = "mx-auto w-full min-w-0 max-w-[784px] px-6";

/** 相邻两轮间隔超过 30 分钟时，在轮次上方显示时间。 */
const TIME_GAP = 30 * 60 * 1000;

/** 侧栏 + 可滚动对话 + 底部输入框的整体布局。 */
export function WorkspacePage() {
  const state = useWorkspace();
  const scroll = useRef<HTMLDivElement>(null);
  const follow = useRef(true);
  const [atBottom, setAtBottom] = useState(true);
  const records = state.chat.records;
  useEffect(() => { follow.current = true; }, [state.chat.selected]);
  useEffect(() => {
    if (follow.current && scroll.current) scroll.current.scrollTop = scroll.current.scrollHeight;
  }, [records, state.chat.selected]);

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
      <div className="relative min-h-0 flex-1">
        <Timeline records={records} scroll={scroll} />
        <div ref={scroll} className="h-full overflow-y-auto" onScroll={(event) => {
          const node = event.currentTarget;
          const distance = node.scrollHeight - node.scrollTop - node.clientHeight;
          follow.current = distance < 80;
          setAtBottom(distance < 80);
        }}>
          <div className={`${column} grid grid-cols-1 gap-8 pt-4 pb-10`}>
            {!state.chat.selected && <div className="flex min-h-[50vh] flex-col items-center justify-center gap-2 text-center">
              <h2 className="text-[28px] font-semibold tracking-tight">{state.projectPath ? `要在 ${projectName(state.projectPath)} 中做什么？` : "有什么可以帮忙的？"}</h2>
              <p className="text-sm text-muted-foreground">{state.projectPath ? "讨论、探索并直接修改项目代码。" : "提出问题，或在左侧打开项目一起编写代码。"}</p>
            </div>}
            {state.chat.historyLoading && records.length === 0 && <p className="flex items-center gap-2 text-sm text-muted-foreground"><LoaderCircle className="size-4 animate-spin" />正在读取对话…</p>}
            {state.chat.selected && !state.chat.historyLoading && records.length === 0 && <p className="text-sm text-muted-foreground">还没有消息，开始这段对话吧。</p>}
            {records.map((record, index) => {
              const previous = records[index - 1];
              const showTime = !previous || record.turn.createdAt - previous.turn.createdAt > TIME_GAP;
              return <TurnMessages key={record.turn.id} record={record} time={showTime ? record.turn.createdAt : undefined} />;
            })}
          </div>
        </div>
        {!atBottom && <Button variant="outline" size="icon-sm" aria-label="滚动到底部" title="滚动到底部"
          className="absolute bottom-3 left-1/2 z-10 -translate-x-1/2 rounded-full bg-background! shadow-md hover:bg-muted!"
          onClick={() => scroll.current?.scrollTo({ top: scroll.current.scrollHeight, behavior: "smooth" })}><ArrowDown /></Button>}
      </div>
      <div className={`${column} grid shrink-0 grid-cols-1 gap-3 pt-1 pb-5`}>
        {(state.chat.error || state.projectError) && <p role="alert" className="rounded-2xl border border-destructive/30 bg-destructive/10 px-4 py-2.5 text-sm text-destructive">{state.projectError || state.chat.error}</p>}
        {state.chat.config && !state.chat.configured && <div className="flex items-center justify-between gap-3 rounded-2xl bg-card/60 px-4 py-2.5 text-sm"><span className="text-muted-foreground">先配置模型连接，即可开始对话。</span><Button variant="secondary" size="sm" className="rounded-full" onClick={() => state.setSettingsOpen(true)}>配置连接</Button></div>}
        <Composer state={state} />
      </div>
    </SidebarInset>
    </div>
    {state.settingsOpen && state.chat.config && <SettingsDialog config={state.chat.config} configured={state.chat.configured} request={state.chat.request} onSaved={state.chat.refreshConfig} onClose={() => state.setSettingsOpen(false)} />}
  </SidebarProvider>;
}
