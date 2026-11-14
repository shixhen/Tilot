import { useCallback, useEffect, useRef, useState, useSyncExternalStore, type FormEvent } from "react";
import { DEFAULT_CONTEXT_TOKENS, type ReasoningEffort, type Thread } from "@tilot/protocol";
import { open } from "@tauri-apps/plugin-dialog";
import { useChat } from "../use-chat";
import { ImageDrafts, type ImageSource } from "../image-drafts";

/** 连接任务数据、项目选择和独立草稿，不包含页面布局。 */
export function useWorkspace() {
  const chat = useChat();
  const [drafts] = useState(() => new ImageDrafts(chat.request, localStorage));
  // 草稿内容只更新输入区，工作区只在保存错误变化时刷新。
  const draftError = useSyncExternalStore(drafts.subscribe, drafts.getError);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [picking, setPicking] = useState(false);
  const [projectError, setProjectError] = useState("");
  const [restoring, setRestoring] = useState(true);
  const sending = useRef(false);
  useEffect(() => {
    if (!chat.connected) return;
    let active = true; setRestoring(true);
    void drafts.recover(chat.knownDeliveries).then(() => { if (active) setRestoring(false); })
      .catch((error: Error) => { if (active) setProjectError(`核对草稿投递状态失败：${error.message}`); });
    return () => { active = false; };
  }, [chat.connected]);
  const thread = chat.threads.find((item) => item.id === chat.selected);
  const projectPath = thread?.projectPath ?? (chat.selected ? null : chat.newProjectPath);
  const draftKey = chat.selected ?? `new:${projectPath ?? ""}`;
  const running = chat.records.find((record) => record.turn.status === "running");
  const busy = chat.busy || picking || chat.permissionBusy;
  const permissionMode = thread?.permissionMode ?? chat.newPermissionMode ?? (projectPath ? chat.config?.defaultPermissionMode ?? "workspace-write" : "read-only");
  // 已有任务用它自己的服务，新对话用默认服务；该服务配置了密钥才能发送。
  const choice = thread ?? chat.config;
  const contextCapacity = chat.config?.providers.find((provider) => provider.id === choice?.providerId)?.models
    .find((model) => model.id === choice?.model)?.contextTokens ?? DEFAULT_CONTEXT_TOKENS;
  const configured = !!choice && chat.configured.includes(choice.providerId);
  const canSubmit = chat.connected && configured && !busy && !restoring && !chat.historyLoading;

  /** 更新当前任务草稿，其他任务草稿保持独立。 */
  const editDraft = useCallback((value: string): void => {
    drafts.edit(draftKey, value);
  }, [drafts, draftKey]);

  /** 切换任务或待选项目，首次发送前不创建空任务。 */
  function select(id: string | null, path: string | null = null): void {
    setProjectError("");
    chat.select(id, path);
  }

  async function deleteThread(target: Thread): Promise<void> {
    await chat.deleteThread(target);
    drafts.discard(target.id);
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

  function addImages(sources: ImageSource[]): void { drafts.add(draftKey, sources); }
  async function chooseImages(): Promise<void> {
    setPicking(true); setProjectError("");
    try {
      const paths = await open({ multiple: true, title: "添加图片", filters: [{ name: "图片", extensions: ["png", "jpg", "jpeg", "webp"] }] });
      if (paths) addImages((Array.isArray(paths) ? paths : [paths]).map((path) => ({ path })));
    } catch (error) { setProjectError(String(error)); }
    finally { setPicking(false); }
  }

  /** 可靠交给等待队列后清空实际发送部分，失败附件和未接受内容仍留在草稿。 */
  async function submit(event: FormEvent): Promise<void> {
    event.preventDefault();
    if (!canSubmit || sending.current) return;
    const snapshot = drafts.view(draftKey);
    const readyImages = snapshot.attachments.flatMap((attachment) => attachment.image ? [attachment.image] : []);
    if (!snapshot.text.trim() && !readyImages.length) return;
    const deliveryId = drafts.prepare(draftKey, snapshot);
    if (!deliveryId) return;
    sending.current = true;
    try {
      const result = await chat.send(snapshot.text, readyImages, deliveryId);
      drafts.settle(draftKey, result.threadId ?? draftKey, snapshot, result.accepted);
    } finally { sending.current = false; }
  }

  return { chat, thread, choice, contextCapacity, configured, projectPath, permissionMode, drafts, draftKey, running, busy, canSubmit, projectError: projectError || draftError, settingsOpen,
    addImages, chooseImages, retryImage: (id: string) => void drafts.retry(id), removeImage: (id: string) => drafts.remove(draftKey, id),
    setSettingsOpen, editDraft, select, deleteThread, chooseModel, chooseProject, submit };
}

/** 页面与子组件共用的工作区状态。 */
export type WorkspaceState = ReturnType<typeof useWorkspace>;
