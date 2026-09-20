import { useEffect, useRef, useState } from "react";
import type { AppConfig, ServerEvent, Thread } from "@tilot/protocol";
import { BackendConnection } from "./backend";
import { createClient, type Request } from "./client";
import { applyEvent, loadConversation, mergeHistory, type TurnRecord } from "./conversation";

/** 管理连接、任务历史和实时事件；每个任务单独保存界面数据，切换不会串流。 */
export function useChat() {
  const client = useRef<Request | null>(null);
  const mounted = useRef(false);
  const loading = useRef(new Map<string, number>());
  const submitting = useRef(false);
  const [connected, setConnected] = useState(false);
  const [threads, setThreads] = useState<Thread[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [newProjectPath, setNewProjectPath] = useState<string | null>(null);
  const [conversations, setConversations] = useState<Record<string, TurnRecord[]>>({});
  const [config, setConfig] = useState<AppConfig | null>(null);
  const [configured, setConfigured] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [historyLoading, setHistoryLoading] = useState<Record<string, boolean>>({});

  /** 使用当前服务连接，连接中断后拒绝新操作。 */
  const request: Request = (method, params) => {
    if (!client.current) return Promise.reject(new Error("本地服务未连接。"));
    return client.current(method, params);
  };

  /** 只将仍在显示的应用错误写入状态。 */
  function report(error: unknown): void {
    if (mounted.current) setError(error instanceof Error ? error.message : String(error));
  }

  /** 读完任务列表；固定分页大小，不遗漏第 100 条以后的任务。 */
  async function refreshThreads(): Promise<void> {
    const result: Thread[] = [];
    while (true) {
      const page = await request("thread.list", { offset: result.length, limit: 100 });
      result.push(...page);
      if (page.length < 100) break;
    }
    if (mounted.current) setThreads(result);
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
      }
    } finally {
      if (mounted.current && loading.current.get(threadId) === version) setHistoryLoading((state) => ({ ...state, [threadId]: false }));
    }
  }

  /** 更新指定任务；轮次结束后从数据库重新取得正式消息。 */
  function receive(event: ServerEvent): void {
    const threadId = "turn" in event ? event.turn.threadId : event.threadId;
    setConversations((state) => ({ ...state, [threadId]: applyEvent(state[threadId] ?? [], event) }));
    if (event.event === "turn.finished") {
      void Promise.all([refreshHistory(threadId), refreshThreads()]).catch(report);
    }
  }

  useEffect(() => {
    mounted.current = true;
    let connection: BackendConnection | undefined;
    void BackendConnection.connect(receive, (error) => {
      client.current = null;
      setConnected(false);
      report(error);
    }).then(async (backend) => {
      connection = backend;
      if (!mounted.current) { backend.dispose(); return; }
      client.current = createClient(backend);
      setConnected(true);
      const [config, status] = await Promise.all([request("config.get", {}), request("credentials.status", {}), refreshThreads()]);
      if (mounted.current) { setConfig(config); setConfigured(status.configured); }
    }).catch(report);
    return () => { mounted.current = false; client.current = null; connection?.dispose(); };
  }, []);

  /** 切换或新建空白会话；已存在任务按需读取最新历史。 */
  function select(threadId: string | null, projectPath: string | null = null): void {
    setSelected(threadId);
    if (threadId === null) setNewProjectPath(projectPath);
    setError("");
    if (threadId) void refreshHistory(threadId).catch(report);
  }

  /** 首次发送时创建任务，输入经服务确认后清空；已结束状态不会被启动应答覆盖。 */
  async function send(input: string): Promise<{ accepted: boolean; threadId: string | null }> {
    let threadId = selected;
    if (submitting.current) return { accepted: false, threadId };
    submitting.current = true;
    setBusy(true);
    setError("");
    try {
      if (!threadId) {
        const thread = await request("thread.create", { title: input.trim().slice(0, 36), projectPath: newProjectPath });
        threadId = thread.id;
        setThreads((threads) => [thread, ...threads]);
        setSelected(threadId);
      }
      const turn = await request("turn.start", { threadId, input, instructions: "你是 Tilot，一个帮助用户理解和编写代码的助手。请使用用户的语言回答。" });
      setConversations((state) => ({ ...state, [turn.threadId]: applyEvent(state[turn.threadId] ?? [], { event: "turn.started", turn, seq: 0 }) }));
      void refreshHistory(threadId).catch(report);
      return { accepted: true, threadId };
    } catch (error) { report(error); return { accepted: false, threadId }; }
    finally { submitting.current = false; if (mounted.current) setBusy(false); }
  }

  /** 请求停止执行；按钮状态以服务最终事件为准，不提前伪造取消。 */
  async function stop(turnId: string): Promise<void> {
    try { await request("turn.interrupt", { turnId }); }
    catch (error) { report(error); }
  }

  /** 设置保存或删除凭据后重新读取状态，确保页面反映服务实际数据。 */
  async function refreshConfig(): Promise<void> {
    const [config, status] = await Promise.all([request("config.get", {}), request("credentials.status", {})]);
    setConfig(config);
    setConfigured(status.configured);
  }

  return { connected, threads, selected, newProjectPath, records: selected ? conversations[selected] ?? [] : [], config, configured,
    error, busy, historyLoading: selected ? historyLoading[selected] ?? false : false,
    request, select, send, stop, refreshConfig };
}
