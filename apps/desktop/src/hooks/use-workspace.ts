import { useState, type FormEvent } from "react";
import type { ReasoningEffort } from "@tilot/protocol";
import { open } from "@tauri-apps/plugin-dialog";
import { useChat } from "../use-chat";

/** 连接任务数据、项目选择和独立草稿，不包含页面布局。 */
export function useWorkspace() {
  const chat = useChat();
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [picking, setPicking] = useState(false);
  const [projectError, setProjectError] = useState("");
  const thread = chat.threads.find((item) => item.id === chat.selected);
  const projectPath = thread?.projectPath ?? (chat.selected ? null : chat.newProjectPath);
  const draftKey = chat.selected ?? `new:${projectPath ?? ""}`;
  const draft = drafts[draftKey] ?? "";
  const running = chat.records.find((record) => record.turn.status === "running");
  const busy = chat.busy || picking;
  // 已有任务用它自己的服务，新对话用默认服务；该服务配置了密钥才能发送。
  const choice = thread ?? chat.config;
  const configured = !!choice && chat.configured.includes(choice.providerId);
  const canSend = chat.connected && configured && !busy && !chat.historyLoading && !running && !!draft.trim();

  /** 更新当前任务草稿，其他任务草稿保持独立。 */
  function editDraft(value: string): void {
    setDrafts((current) => ({ ...current, [draftKey]: value }));
  }

  /** 切换任务或待选项目，首次发送前不创建空任务。 */
  function select(id: string | null, path: string | null = null): void {
    setProjectError("");
    chat.select(id, path);
  }

  /** 已有任务只修改该任务；尚未发送的新对话修改默认值，发送时创建的任务会沿用。 */
  function chooseModel(providerId: string, model: string, reasoningEffort: ReasoningEffort): void {
    if (thread) void chat.updateThread(thread.id, providerId, model, reasoningEffort);
    else void chat.updateDefaults(providerId, model, reasoningEffort);
  }

  /** 选择项目目录，取消时不改变任务和草稿。 */
  async function chooseProject(): Promise<void> {
    setPicking(true);
    setProjectError("");
    try {
      const path = await open({ directory: true, multiple: false, title: "选择项目目录" });
      if (path !== null) select(null, path);
    } catch (error) { setProjectError(String(error)); }
    finally { setPicking(false); }
  }

  /** 服务接受消息后清空草稿，失败时将草稿留在对应任务。 */
  async function submit(event: FormEvent): Promise<void> {
    event.preventDefault();
    if (!canSend) return;
    const result = await chat.send(draft);
    setDrafts((current) => ({ ...current, [draftKey]: "", [result.threadId ?? draftKey]: result.accepted ? "" : draft }));
  }

  return { chat, thread, choice, configured, projectPath, draft, running, busy, canSend, projectError, settingsOpen,
    setSettingsOpen, editDraft, select, chooseModel, chooseProject, submit };
}

/** 页面与子组件共用的工作区状态。 */
export type WorkspaceState = ReturnType<typeof useWorkspace>;
