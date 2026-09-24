import { useEffect, useRef } from "react";
import { Folder, LoaderCircle, MessageSquare, SquarePen, Terminal } from "lucide-react";
import { useWorkspace } from "../hooks/use-workspace";
import { projectName } from "../projects";
import { SidebarInset, SidebarProvider, SidebarTrigger } from "../components/ui/sidebar";
import { Separator } from "../components/ui/separator";
import { Button } from "../components/ui/button";
import { WorkspaceNavigation } from "./navigation";
import { Composer } from "./composer";
import { SettingsDialog } from "./settings-dialog";
import { TurnMessages } from "./transcript";

/** 以 sidebar-07 Page 为骨架，主内容替换为可滚动对话与固定输入区。 */
export function WorkspacePage() {
  const state = useWorkspace();
  const scroll = useRef<HTMLDivElement>(null);
  const follow = useRef(true);
  useEffect(() => { follow.current = true; }, [state.chat.selected]);
  useEffect(() => {
    if (follow.current && scroll.current) scroll.current.scrollTop = scroll.current.scrollHeight;
  }, [state.chat.records, state.chat.selected]);

  return <SidebarProvider className="h-dvh min-h-0 overflow-hidden">
    <WorkspaceNavigation state={state} />
    <SidebarInset className="min-h-0 min-w-0 overflow-hidden">
      <header className="flex h-16 shrink-0 items-center justify-between gap-4 border-b px-4">
        <div className="flex min-w-0 items-center gap-2">
          <SidebarTrigger className="-ml-1" /><Separator orientation="vertical" className="mr-2 h-4!" />
          <span className="hidden shrink-0 text-sm text-muted-foreground md:block">{projectName(state.projectPath)}</span>
          <span className="hidden text-muted-foreground md:block">/</span>
          <h1 className="truncate text-sm font-medium">{state.thread?.title ?? "新对话"}</h1>
        </div>
        <Button variant="ghost" size="icon-sm" aria-label="新建对话" title="新建对话" disabled={state.busy} onClick={() => state.select(null, state.projectPath)}><SquarePen /></Button>
      </header>
      <div ref={scroll} className="min-h-0 flex-1 overflow-y-auto" onScroll={(event) => {
        const node = event.currentTarget;
        follow.current = node.scrollHeight - node.scrollTop - node.clientHeight < 80;
      }}>
        <div className="mx-auto grid w-full max-w-3xl gap-10 px-6 py-8">
          {!state.chat.selected && <div className="flex min-h-[45vh] flex-col items-center justify-center gap-4 text-center">
            <div className="flex size-12 items-center justify-center rounded-xl border bg-muted"><Terminal className="size-6" /></div>
            <div className="space-y-2"><h2 className="text-2xl font-semibold tracking-tight">开始一个新任务</h2><p className="text-sm text-muted-foreground">{state.projectPath ? `在 ${projectName(state.projectPath)} 中讨论、探索和编写代码` : "提出问题，或打开项目一起编写代码。"}</p></div>
            <div className="flex gap-2">
              <Button variant="outline" size="sm" disabled={state.busy || !state.chat.connected} onClick={() => void state.chooseProject()}><Folder />打开项目</Button>
              <Button variant="ghost" size="sm" onClick={() => document.getElementById("workspace-composer")?.querySelector("textarea")?.focus()}><MessageSquare />开始对话</Button>
            </div>
          </div>}
          {state.chat.historyLoading && state.chat.records.length === 0 && <p className="flex items-center gap-2 text-sm text-muted-foreground"><LoaderCircle className="size-4 animate-spin" />正在读取对话…</p>}
          {state.chat.selected && !state.chat.historyLoading && state.chat.records.length === 0 && <p className="text-sm text-muted-foreground">还没有消息，开始这段对话吧。</p>}
          {state.chat.records.map((record) => <TurnMessages key={record.turn.id} record={record} />)}
        </div>
      </div>
      <div id="workspace-composer" className="mx-auto grid w-full max-w-3xl shrink-0 gap-3 px-4 pb-4 pt-2 sm:px-6">
        {(state.chat.error || state.projectError) && <p role="alert" className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">{state.projectError || state.chat.error}</p>}
        {state.chat.config && !state.chat.configured && <div className="flex items-center justify-between gap-3 rounded-lg border px-3 py-2 text-sm"><span className="text-muted-foreground">先配置模型连接，即可开始对话。</span><Button variant="outline" size="sm" onClick={() => state.setSettingsOpen(true)}>配置连接</Button></div>}
        <Composer state={state} />
      </div>
    </SidebarInset>
    {state.settingsOpen && state.chat.config && <SettingsDialog config={state.chat.config} configured={state.chat.configured} request={state.chat.request} onSaved={state.chat.refreshConfig} onClose={() => state.setSettingsOpen(false)} />}
  </SidebarProvider>;
}
