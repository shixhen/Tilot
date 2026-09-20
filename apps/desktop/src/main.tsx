import { useEffect, useRef, useState, type FormEvent } from "react";
import { createRoot } from "react-dom/client";
import { Settings } from "./settings";
import { TurnMessages } from "./messages";
import { useChat } from "./use-chat";
import { open } from "@tauri-apps/plugin-dialog";
import { TaskList } from "./task-list";
import { projectName } from "./projects";
import "./style.css";

/** 少量线条图标，与按钮文字共同说明实际可用的操作。 */
function Icon({ name }: { name: "new" | "settings" | "sidebar" | "chat" | "arrow" | "folder" }) {
  const paths = {
    new: "M12 4H5a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2h13a2 2 0 0 0 2-2v-7 M16 3l5 5 M10 14l2-6 7-7 5 5-7 7-7 1Z",
    settings: "M4 7h16 M4 17h16 M8 4v6 M16 14v6",
    sidebar: "M9 3v18 M5 3h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2Z",
    chat: "M5 4h14a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2H8l-5 3V6a2 2 0 0 1 2-2Z",
    arrow: "M12 19V5 M5 12l7-7 7 7",
    folder: "M3 7V5a2 2 0 0 1 2-2h5l3 3h6a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7Z M3 10h18",
  };
  return <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={paths[name]} /></svg>;
}

/** 桌面主界面：任务侧栏、历史和流式对话、底部输入框与连接设置。 */
function App() {
  const chat = useChat();
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(true);
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

  return <div className={`app ${sidebarOpen ? "" : "sidebar-hidden"}`}>
    <aside className="sidebar" aria-label="任务侧栏">
      <div className="brand"><span>Tilot</span><button className="icon-button" aria-label="收起侧栏" onClick={() => setSidebarOpen(false)}><Icon name="sidebar" /></button></div>
      <button className="nav-button" disabled={busy} onClick={() => newConversation(null)}><Icon name="new" />新对话</button>
      <button className="nav-button" disabled={busy || !chat.connected} onClick={() => void chooseProject()}><Icon name="folder" />{picking ? "正在选择…" : "选择项目"}</button>
      <div className="sidebar-heading">任务 <span>{chat.threads.length}</span></div>
      <TaskList threads={chat.threads} selected={chat.selected} disabled={busy} onSelect={(id) => { setProjectError(""); chat.select(id); }} onNew={newConversation} />
      <button className="nav-button settings-button" disabled={!chat.config} onClick={() => setSettingsOpen(true)}><Icon name="settings" /><span>连接设置</span><span className={`connection-dot ${chat.connected ? "online" : ""}`} title={chat.connected ? "服务已连接" : "服务未连接"} /></button>
    </aside>
    <main className="workspace">
      <header className="topbar"><div>{!sidebarOpen && <button className="icon-button" aria-label="展开侧栏" onClick={() => setSidebarOpen(true)}><Icon name="sidebar" /></button>}<Icon name="chat" /><h1>{thread?.title ?? "新对话"}</h1></div><span className="muted">{chat.connected ? "本地工作区" : "服务未连接"}</span></header>
      <div className="conversation-scroll" ref={scroll} onScroll={() => { const node = scroll.current!; follow.current = node.scrollHeight - node.scrollTop - node.clientHeight < 80; }}>
        <div className="conversation">
          {!chat.selected && <div className="welcome"><div className="welcome-mark">T</div><h2>从一个想法开始</h2><p>一起读懂问题，写好代码。</p></div>}
          {chat.historyLoading && chat.records.length === 0 && <p className="muted loading">正在读取对话…</p>}
          {chat.selected && !chat.historyLoading && chat.records.length === 0 && <p className="muted loading">还没有消息，开始这段对话吧。</p>}
          {chat.records.map((record) => <TurnMessages key={record.turn.id} record={record} />)}
        </div>
      </div>
      <div className="composer-area">
        {chat.error && <p role="alert" className="error banner">{chat.error}</p>}
        {projectError && <p role="alert" className="error banner">{projectError}</p>}
        {projectPath && <div className="project-context"><div><strong>{projectName(projectPath)}</strong><span title={projectPath}>{projectPath}</span></div>
          <button disabled={busy} onClick={() => newConversation(chat.selected ? projectPath : null)}>{chat.selected ? "在此项目新建对话" : "取消选择"}</button>
          <p>已选择项目目录，文件读取与搜索尚未接入。</p>
        </div>}
        {chat.config && !chat.configured && <div className="setup-hint">开始前，请配置模型连接。<button onClick={() => setSettingsOpen(true)}>打开设置</button></div>}
        <form className="composer" onSubmit={(event) => void submit(event)}>
          <textarea aria-label="消息" placeholder="描述你的问题，或想一起完成的事情" value={draft} disabled={busy}
            onChange={(event) => setDrafts({ ...drafts, [draftKey]: event.target.value })}
            onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing && event.keyCode !== 229) { event.preventDefault(); event.currentTarget.form?.requestSubmit(); } }} />
          <div className="composer-toolbar"><span className="muted" title={projectPath ?? "普通对话"}>{projectName(projectPath)}</span><div>
            <button type="button" className="model-button" disabled={!chat.config} onClick={() => setSettingsOpen(true)}>{chat.config?.model ?? "连接中…"}<span>⌄</span></button>
            {running ? <button type="button" className="send-button" aria-label="停止生成" disabled={!chat.connected} onClick={() => void chat.stop(running.turn.id)}><span className="stop-square" /></button>
              : <button className="send-button" aria-label="发送消息" disabled={!canSend}><Icon name="arrow" /></button>}
          </div></div>
        </form>
        <p className="composer-note">Enter 发送 · Shift + Enter 换行</p>
      </div>
    </main>
    {settingsOpen && chat.config && <Settings config={chat.config} configured={chat.configured} request={chat.request} onSaved={chat.refreshConfig} onClose={() => setSettingsOpen(false)} />}
  </div>;
}

createRoot(document.getElementById("root")!).render(<App />);
