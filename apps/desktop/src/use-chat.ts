import { useEffect, useMemo, useRef, useState } from "react";
import type { AppConfig, ImageRef, PermissionMode, ReasoningEffort, ServerEvent, Thread, ToolApproval } from "@tilot/protocol";
import { BackendConnection } from "./backend";
import { createClient, type Request } from "./client";
import { applyEvent, loadConversation, mergeHistory, type TurnRecord } from "./conversation";
import { InputQueue, type QueueView } from "./input-queue";
import { StreamEvents } from "./stream-events";
import { QuestionSession, type QuestionState } from "./questions";
import type { QuestionDraft } from "@tilot/protocol";

/** 管理连接、任务历史和实时事件；每个任务单独保存界面数据，切换不会串流。 */
export function useChat() {
  const client = useRef<Request | null>(null);
  const mounted = useRef(false);
  const loading = useRef(new Map<string, number>());
  const threadsRevision = useRef(0);
  const deletedThreads = useRef(new Set<string>());
  const submitting = useRef(false);
  const [connected, setConnected] = useState(false);
  const [threads, setThreads] = useState<Thread[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [newProjectPath, setNewProjectPath] = useState<string | null>(null);
  const [newPermissionMode, setNewPermissionMode] = useState<PermissionMode | null>(null);
  const [permissionBusy, setPermissionBusy] = useState(false);
  const [approvals, setApprovals] = useState<ToolApproval[]>([]);
  const approvalRevisions = useRef(new Map<string, number>());
  const [approvalBusy, setApprovalBusy] = useState(false);
  const [conversations, setConversations] = useState<Record<string, TurnRecord[]>>({});
  const [config, setConfig] = useState<AppConfig | null>(null);
  // 已配置密钥的服务 id。
  const [configured, setConfigured] = useState<string[]>([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [historyLoading, setHistoryLoading] = useState<Record<string, boolean>>({});
  const [queues, setQueues] = useState<Record<string, QueueView>>({});
  const queue = useRef<InputQueue | null>(null);
  const [questions, setQuestions] = useState<Record<string, QuestionState | null>>({});
  const questionSession = useRef<QuestionSession | null>(null);

  /** 使用当前服务连接，连接中断后拒绝新操作。 */
  const request: Request = (method, params) => {
    if (!client.current) return Promise.reject(new Error("本地服务未连接。"));
    return client.current(method, params);
  };

  /** 只将仍在显示的应用错误写入状态。 */
  function report(error: unknown): void {
    if (mounted.current) setError(error instanceof Error ? error.message : String(error));
  }

  if (!queue.current) queue.current = new InputQueue({
    start: async (threadId, input, images, deliveryId) => {
      const turn = await request("turn.start", { threadId, input, images, deliveryId });
      if (mounted.current) {
        setConversations((state) => ({ ...state, [threadId]: applyEvent(state[threadId] ?? [], { event: "turn.started", turn, seq: 0 }) }));
        void refreshHistory(threadId).catch(report);
      }
      return turn;
    },
    steer: (turnId, input, images, deliveryId) => request("turn.steer", { turnId, input, images, deliveryId }),
    receipts: (threadId, deliveryIds) => request("input.receipts", { threadId, deliveryIds }),
    changed: (threadId, view) => { if (mounted.current && !deletedThreads.current.has(threadId)) setQueues((state) => ({ ...state, [threadId]: view })); },
    error: report,
  }, localStorage);
  if (!questionSession.current) questionSession.current = new QuestionSession(request, localStorage,
    (threadId, state) => { if (mounted.current && !deletedThreads.current.has(threadId)) setQuestions((current) => ({ ...current, [threadId]: state })); },
    async (threadId, action) => {
      await queue.current!.withPriority(threadId, async () => {
        const delivery = await action();
        queue.current!.observe(delivery.turn);
        await refreshHistory(threadId);
      });
    });

  /** 读完任务列表；固定分页大小，不遗漏第 100 条以后的任务。 */
  async function refreshThreads(): Promise<void> {
    const revision = ++threadsRevision.current;
    const result: Thread[] = [];
    while (true) {
      const page = await request("thread.list", { offset: result.length, limit: 100 });
      result.push(...page);
      if (page.length < 100) break;
    }
    if (mounted.current && revision === threadsRevision.current) setThreads(result.filter((thread) => !deletedThreads.current.has(thread.id)));
  }

  /** 最新查询才可提交结果；历史与期间收到的事件合并，避免刷新覆盖流式内容。 */
  async function refreshHistory(threadId: string): Promise<void> {
    const version = (loading.current.get(threadId) ?? 0) + 1;
    loading.current.set(threadId, version);
    setHistoryLoading((state) => ({ ...state, [threadId]: true }));
    try {
      const history = await loadConversation(request, threadId);
      if (mounted.current && loading.current.get(threadId) === version) {
        setConversations((state) => ({ ...state, [threadId]: mergeHistory(state[threadId] ?? [], history) }));
        const latest = history.at(-1)?.turn;
        if (latest) queue.current!.observe(latest);
      }
    } catch (error) {
      if (!deletedThreads.current.has(threadId)) throw error;
    } finally {
      if (mounted.current && loading.current.get(threadId) === version) setHistoryLoading((state) => ({ ...state, [threadId]: false }));
    }
  }

  /** 刷新界面后接回服务中的审批；期间收到的新事件优先于旧查询。 */
  async function refreshApprovals(threadId: string): Promise<void> {
    const revision = approvalRevisions.current.get(threadId) ?? 0;
    const pending = await request("approval.list", { threadId });
    if (mounted.current && !deletedThreads.current.has(threadId) && (approvalRevisions.current.get(threadId) ?? 0) === revision) {
      setApprovals((current) => [...current.filter((item) => item.threadId !== threadId), ...pending]);
    }
  }

  /** 一批增量只更新一次会话状态，审批及轮次事件仍立即处理。 */
  function receive(incoming: ServerEvent[]): void {
    if (!mounted.current) return;
    const events = incoming.filter((event) => {
      const threadId = "turn" in event ? event.turn.threadId : "approval" in event ? event.approval.threadId : event.threadId;
      return !deletedThreads.current.has(threadId);
    });
    const updates = events.filter((event) => event.event !== "approval.requested" && event.event !== "approval.resolved" && event.event !== "question.updated" && event.event !== "thread.title");
    if (updates.length) setConversations((state) => {
      const next = { ...state };
      for (const event of updates) {
        const threadId = "turn" in event ? event.turn.threadId : event.threadId;
        next[threadId] = applyEvent(next[threadId] ?? [], event);
      }
      return next;
    });
    for (const event of events) {
      if (event.event === "question.updated") { questionSession.current!.receive(event.threadId, event.question); continue; }
      if (event.event === "approval.requested") {
        const threadId = event.approval.threadId;
        approvalRevisions.current.set(threadId, (approvalRevisions.current.get(threadId) ?? 0) + 1);
        setApprovals((current) => [...current.filter((item) => item.id !== event.approval.id), event.approval]);
        continue;
      }
      if (event.event === "approval.resolved") {
        approvalRevisions.current.set(event.threadId, (approvalRevisions.current.get(event.threadId) ?? 0) + 1);
        setApprovals((current) => current.filter((item) => item.id !== event.approvalId));
        continue;
      }
      if ("turn" in event) queue.current!.observe(event.turn);
      if (event.event === "turn.started" || event.event === "thread.title") void refreshThreads().catch(report);
      if (event.event === "turn.finished") {
        void Promise.all([refreshHistory(event.turn.threadId), refreshThreads()]).catch(report);
      }
    }
  }

  useEffect(() => {
    mounted.current = true;
    let connection: BackendConnection | undefined;
    const stream = new StreamEvents(receive);
    void BackendConnection.connect((event) => stream.push(event), (error) => {
      stream.flush();
      client.current = null;
      queue.current!.setConnected(false);
      questionSession.current!.setConnected(false);
      setConnected(false);
      setApprovals([]);
      report(error);
    }).then(async (backend) => {
      connection = backend;
      if (!mounted.current) { backend.dispose(); return; }
      client.current = createClient(backend);
      await queue.current!.restore();
      if (!mounted.current) return;
      setConnected(true);
      queue.current!.setConnected(true);
      questionSession.current!.setConnected(true);
      const [config, status] = await Promise.all([request("config.get", {}), request("credentials.status", {}), refreshThreads()]);
      if (mounted.current) { setConfig(config); setConfigured(status.configured); }
    }).catch(report);
    return () => { mounted.current = false; stream.dispose(); queue.current!.setConnected(false); questionSession.current!.dispose(); client.current = null; connection?.dispose(); };
  }, []);

  useEffect(() => { if (connected && selected) void questionSession.current!.refresh(selected).catch(report); }, [connected, selected]);

  /** 切换或新建空白会话；已存在任务按需读取最新历史。 */
  function select(threadId: string | null, projectPath: string | null = null): void {
    setSelected(threadId);
    if (threadId === null) { setNewProjectPath(projectPath); setNewPermissionMode(null); }
    setError("");
    if (threadId) void Promise.all([refreshHistory(threadId), refreshApprovals(threadId)]).catch(report);
  }

  /** 和在途投递串行，服务确认删除后再移除界面记录与本地等待消息。 */
  async function deleteThread(thread: Thread): Promise<void> {
    const threadId = thread.id;
    await queue.current!.withPriority(threadId, async () => {
      const questionIds = await request("thread.delete", { threadId });
      deletedThreads.current.add(threadId);
      loading.current.delete(threadId);
      approvalRevisions.current.delete(threadId);
      setThreads((current) => current.filter((item) => item.id !== threadId));
      setConversations(({ [threadId]: removed, ...current }) => current);
      setHistoryLoading(({ [threadId]: removed, ...current }) => current);
      setQueues(({ [threadId]: removed, ...current }) => current);
      setQuestions(({ [threadId]: removed, ...current }) => current);
      setApprovals((current) => current.filter((approval) => approval.threadId !== threadId));
      if (selected === threadId) select(null, thread.projectPath);
      queue.current!.discardThread(threadId);
      try { questionSession.current!.discardThread(threadId, questionIds); }
      catch { report(new Error("对话已删除，本机答题草稿清理失败。")); }
    });
  }

  /** 首次发送时创建任务；所有消息先可靠入队，再由相同投递身份提交服务。 */
  async function send(input: string, images: ImageRef[] = [], deliveryId?: string): Promise<{ accepted: boolean; threadId: string | null }> {
    let threadId = selected;
    if (threadId && queue.current!.hasActivity(threadId)) {
      return { accepted: queue.current!.enqueue(threadId, input, images, deliveryId), threadId };
    }
    if (submitting.current) return { accepted: false, threadId };
    submitting.current = true;
    setBusy(true);
    setError("");
    try {
      if (!threadId) {
        const thread = await request("thread.create", { title: input.trim().slice(0, 36) || images[0]?.name || "图片对话", projectPath: newProjectPath, autoTitle: true,
          ...(newPermissionMode === null ? {} : { permissionMode: newPermissionMode }) });
        threadId = thread.id;
        setThreads((threads) => [thread, ...threads]);
        setSelected(threadId);
      }
      queue.current!.resume(threadId);
      return { accepted: queue.current!.enqueue(threadId, input, images, deliveryId), threadId };
    } catch (error) {
      report(error);
      if (threadId) void refreshThreads().catch(report);
      return { accepted: false, threadId };
    }
    finally { submitting.current = false; if (mounted.current) setBusy(false); }
  }

  /** 从中断轮次创建后续轮次，并刷新历史；由服务端检查能否继续。 */
  async function resume(turnId: string): Promise<void> {
    if (submitting.current) return;
    submitting.current = true;
    setBusy(true);
    setError("");
    try {
      const turn = await request("turn.resume", { turnId });
      setConversations((state) => ({ ...state, [turn.threadId]: applyEvent(state[turn.threadId] ?? [], { event: "turn.started", turn, seq: 0 }) }));
      await refreshHistory(turn.threadId);
    } catch (error) { report(error); }
    finally { submitting.current = false; if (mounted.current) setBusy(false); }
  }

  /** 请求停止执行；按钮状态以服务最终事件为准，不提前伪造取消。 */
  async function stop(turnId: string): Promise<void> {
    const thread = Object.entries(conversations).find(([, records]) => records.some((record) => record.turn.id === turnId));
    if (thread) queue.current!.pause(thread[0]);
    try { await request("turn.interrupt", { turnId }); }
    catch (error) { report(error); }
  }

  /** 修改已有任务的服务、模型和思考强度，以服务返回的任务记录为准。 */
  async function updateThread(threadId: string, providerId: string, model: string, reasoningEffort: ReasoningEffort): Promise<void> {
    try {
      const thread = await request("thread.update", { threadId, providerId, model, reasoningEffort });
      setThreads((threads) => threads.map((item) => item.id === thread.id ? thread : item));
    } catch (error) { report(error); }
  }

  /** 修改新任务使用的默认服务、模型和思考强度。 */
  async function updateDefaults(providerId: string, model: string, reasoningEffort: ReasoningEffort): Promise<void> {
    try { setConfig(await request("config.set", { config: { ...config!, providerId, model, reasoningEffort } })); }
    catch (error) { report(error); }
  }

  /** 新对话仅调整首次发送的选择，已有对话由服务检查锁定规则。 */
  async function choosePermission(permissionMode: PermissionMode): Promise<void> {
    if (!selected) { setNewPermissionMode(permissionMode); return; }
    setPermissionBusy(true);
    try {
      const thread = await request("thread.permission", { threadId: selected, permissionMode });
      setThreads((current) => current.map((item) => item.id === thread.id ? thread : item));
    } catch (error) { report(error); }
    finally { setPermissionBusy(false); }
  }

  async function respondApproval(approvalId: string, allowed: boolean): Promise<void> {
    setApprovalBusy(true);
    try { await request("approval.respond", { approvalId, allowed }); }
    catch (error) { report(error); }
    finally { setApprovalBusy(false); }
  }

  /** 设置保存或删除凭据后重新读取状态，确保页面反映服务实际数据。 */
  async function refreshConfig(): Promise<void> {
    const [config, status] = await Promise.all([request("config.get", {}), request("credentials.status", {})]);
    setConfig(config);
    setConfigured(status.configured);
  }

  const questionActions = useMemo(() => ({
    editQuestion: (draft: QuestionDraft) => { if (selected) questionSession.current!.edit(selected, draft); },
    submitQuestion: () => { if (selected) void questionSession.current!.submit(selected); },
    closeQuestion: () => { if (selected) void questionSession.current!.close(selected); },
    retryQuestion: () => { if (selected) questionSession.current!.retry(selected); },
  }), [selected]);

  return { connected, threads, selected, newProjectPath, records: selected ? conversations[selected] ?? [] : [], config, configured,
    ...questionActions, question: selected ? questions[selected] ?? null : null,
    newPermissionMode, permissionBusy, approvals: approvals.filter((item) => item.threadId === selected), approvalBusy, choosePermission, respondApproval,
    queue: selected ? queues[selected] ?? { messages: [], paused: false, busy: false } : { messages: [], paused: false, busy: false },
    steer: (id: string) => selected ? queue.current!.steer(selected, id) : Promise.resolve(),
    removeQueued: (id: string) => { if (selected) queue.current!.remove(selected, id); },
    resumeQueue: () => { if (selected) queue.current!.resume(selected); },
    error, busy, historyLoading: selected ? historyLoading[selected] ?? false : false,
    knownDeliveries: async (deliveryIds: string[]) => [...queue.current!.pendingDeliveryIds(), ...await request("input.receipts", { deliveryIds })],
    request, select, deleteThread, send, resume, stop, updateThread, updateDefaults, refreshConfig };
}
