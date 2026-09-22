import { useEffect, useRef, useState, type FormEvent } from "react";
import { Settings } from "./settings";
import { TurnMessages } from "./messages";
import { useChat } from "./use-chat";
import { open } from "@tauri-apps/plugin-dialog";
import { AppSidebar } from "./components/app-sidebar";
import { SidebarInset, SidebarProvider, SidebarTrigger } from "./components/ui/sidebar";
import { projectName } from "./projects";
import { Folder, MessageSquare, SquarePen } from "lucide-react";
import { Button } from "./components/ui/button";
import { ChatComposer } from "./components/chat-composer";


/** 桌面主界面：任务侧栏、历史和流式对话、底部输入框与连接设置。 */
export function App() {
  const chat = useChat();
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [picking, setPicking] = useState(false);
  const [projectError, setProjectError] = useState("");
  const scroll = useRef<HTMLDivElement>(null);
  const follow = useRef(true);
  const draftKey = chat.selected ?? `new:${chat.newProjectPath ?? ""}`;
  const draft = drafts[draftKey] ?? "";
  const thread = chat.threads.find((thread) => thread.id === chat.selected);
  const projectPath = chat.selected ? thread?.projectPath ?? null : chat.newProjectPath;
  const busy = chat.busy || picking;
  const running = chat.records.find((record) => record.turn.status === "running");
  const canSend = chat.connected && chat.configured && !busy && !chat.historyLoading && !running && draft.trim().length > 0;

  /** 切换新对话的待选项目，不修改任何已有任务。 */
  function newConversation(path: string | null): void {
    setProjectError("");
    chat.select(null, path);
  }

  /** 使用系统单目录选择器，取消时保留当前任务与草稿，不创建空任务。 */
  async function chooseProject(): Promise<void> {
    setPicking(true);
    setProjectError("");
    try {
      const path = await open({ directory: true, multiple: false, title: "选择项目目录" });
      if (path !== null) newConversation(path);
    } catch (error) { setProjectError(`无法选择项目：${String(error)}`); }
    finally { setPicking(false); }
  }

  useEffect(() => { follow.current = true; }, [chat.selected]);
  useEffect(() => {
    if (follow.current && scroll.current) scroll.current.scrollTop = scroll.current.scrollHeight;
  }, [chat.records, chat.selected]);

  /** 保留各任务草稿；服务接受请求后才清空，提交期间禁止切换任务。 */
  async function submit(event: FormEvent): Promise<void> {
    event.preventDefault();
    if (!canSend) return;
    follow.current = true;
    const result = await chat.send(draft);
    const target = result.threadId ?? draftKey;
    setDrafts((drafts) => ({ ...drafts, [draftKey]: "", [target]: result.accepted ? "" : draft }));
  }

  return <SidebarProvider className="desktop-shell h-dvh min-h-0 overflow-hidden">
    <AppSidebar threads={chat.threads} selected={chat.selected} busy={busy} connected={chat.connected} canConfigure={!!chat.config}
      onSelect={(id) => { setProjectError(""); chat.select(id); }} onNew={newConversation} onChooseProject={() => void chooseProject()} onSettings={() => setSettingsOpen(true)} />
    <SidebarInset className="workspace min-h-0 min-w-0 overflow-hidden">
      <header className="thread-header">
        <div className="flex min-w-0 items-center gap-3">
          <SidebarTrigger aria-label="切换侧栏" className="header-sidebar-trigger text-muted-foreground" />
          {projectPath ? <Folder className="size-5 shrink-0 text-muted-foreground" /> : <MessageSquare className="size-5 shrink-0 text-muted-foreground" />}
          <h1 className="truncate text-base font-semibold">{thread?.title ?? "新对话"}</h1>
        </div>
        <Button variant="ghost" size="sm" aria-label="新建对话" disabled={busy} onClick={() => newConversation(projectPath)}><SquarePen /><span className="hidden sm:inline">新对话</span></Button>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto" ref={scroll} onScroll={() => { const node = scroll.current!; follow.current = node.scrollHeight - node.scrollTop - node.clientHeight < 80; }}>
        <div className="conversation-column">
          {!chat.selected && <div className="welcome"><h2>{projectPath ? "一起把想法变成代码" : "今天想做些什么？"}</h2><p>{projectPath ? `在 ${projectName(projectPath)} 中开始一个新任务` : "选择一个项目，或直接开始对话"}</p></div>}
          {chat.historyLoading && chat.records.length === 0 && <p className="py-8 text-sm text-muted-foreground">正在读取对话…</p>}
          {chat.selected && !chat.historyLoading && chat.records.length === 0 && <p className="py-8 text-sm text-muted-foreground">还没有消息，开始这段对话吧。</p>}
          {chat.records.map((record) => <TurnMessages key={record.turn.id} record={record} />)}
        </div>
      </div>
      <div className="composer-column">
        {chat.error && <p role="alert" className="mb-3 text-sm text-destructive">{chat.error}</p>}
        {projectError && <p role="alert" className="mb-3 text-sm text-destructive">{projectError}</p>}
        {chat.config && !chat.configured && <div className="mb-3 flex items-center justify-between gap-2 text-xs text-muted-foreground">开始前，请配置模型连接。<Button variant="link" size="sm" onClick={() => setSettingsOpen(true)}>打开设置</Button></div>}
        <ChatComposer value={draft} model={chat.config?.model} projectPath={projectPath} hasTask={!!chat.selected} connected={chat.connected}
          busy={busy} running={!!running} canSend={canSend} onChange={(value) => setDrafts({ ...drafts, [draftKey]: value })}
          onSubmit={(event) => void submit(event)} onNew={() => newConversation(projectPath)} onChooseProject={() => void chooseProject()}
          onClearProject={() => newConversation(null)} onSettings={() => setSettingsOpen(true)} onStop={() => { if (running) void chat.stop(running.turn.id); }} />
        {!chat.connected && <p className="mt-2 text-center text-xs text-muted-foreground">服务未连接</p>}
      </div>
    </SidebarInset>
    {settingsOpen && chat.config && <Settings config={chat.config} configured={chat.configured} request={chat.request} onSaved={chat.refreshConfig} onClose={() => setSettingsOpen(false)} />}
  </SidebarProvider>;
}

