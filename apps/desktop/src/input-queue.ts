import { isImageRef, type ImageRef, type Turn, type TurnInput } from "@tilot/protocol";

/** 投递标识跨重启保持不变，进入模型前可移除或选择引导。 */
export interface QueuedInput { id: string; content: string; images?: ImageRef[]; status: "waiting" | "sending" | "steering" }
export interface QueueView { messages: QueuedInput[]; paused: boolean; busy: boolean }
interface QueueState extends QueueView { turn: Turn | null; directId?: string; priority?: boolean; checking?: boolean; idle?: () => void }
interface QueueActions {
  start: (threadId: string, input: string, images: ImageRef[], deliveryId: string) => Promise<Turn>;
  steer: (turnId: string, input: string, images: ImageRef[], deliveryId: string) => Promise<TurnInput | null>;
  receipts?: (threadId: string, deliveryIds: string[]) => Promise<string[]>;
  changed: (threadId: string, view: QueueView) => void;
  error: (error: unknown) => void;
}

/** 按任务串行发送等待输入；事件可以先于请求应答到达，不受当前页面选择影响。 */
export class InputQueue {
  private readonly states = new Map<string, QueueState>();
  private connected = false;
  private readonly actions: QueueActions;
  private readonly storage: Pick<Storage, "getItem" | "setItem"> | undefined;
  private restored = false;

  constructor(actions: QueueActions, storage?: Pick<Storage, "getItem" | "setItem">) { this.actions = actions; this.storage = storage; }

  /** 恢复只读本地引用；不自动发消息，先核对上次退出前服务是否已接收。 */
  async restore(): Promise<void> {
    if (!this.storage || this.restored) return;
    this.restored = true;
    const saved = this.storage.getItem("tilot.input-queues.v1");
    const queues: unknown = saved ? JSON.parse(saved) : {};
    if (!queues || typeof queues !== "object" || Array.isArray(queues)) throw new Error("等待消息存档损坏。");
    for (const [threadId, values] of Object.entries(queues)) {
      if (!Array.isArray(values) || !values.every((message) => message && typeof message.id === "string" && typeof message.content === "string" && (message.images === undefined || Array.isArray(message.images) && message.images.every(isImageRef)))) throw new Error("等待消息存档损坏。");
      const state = this.state(threadId);
      state.messages = values.map((message) => ({ ...message, status: "waiting" }));
      state.paused = true; state.checking = true;
      this.actions.changed(threadId, this.view(threadId));
    }
    for (const [threadId, state] of this.states) {
      try {
        const received = new Set(await this.actions.receipts?.(threadId, state.messages.map((message) => message.id)));
        state.messages = state.messages.filter((message) => !received.has(message.id));
      } catch (error) { this.actions.error(error); }
      finally { state.checking = false; this.changed(threadId); }
    }
  }

  /** 返回独立快照，防止在途操作修改 React 已渲染的数据。 */
  view(threadId: string): QueueView {
    const state = this.state(threadId);
    // 空闲时直接投递的消息仍可靠存档，只有暂停或失败后才进入可见等待区。
    return { messages: state.messages.filter((message) => message.id !== state.directId || state.paused)
      .map((message) => ({ ...message })), paused: state.paused, busy: state.busy || !!state.checking };
  }

  /** 断连暂停等待消息；重新连接后仍需用户手动继续。 */
  setConnected(connected: boolean): void {
    this.connected = connected;
    if (!connected) for (const [threadId, state] of this.states) { state.paused = true; this.changed(threadId); }
  }

  /** 接受已保存的轮次状态；重复或迟到事件不能重发消息、把结束状态改回运行中。 */
  observe(turn: Turn): void {
    const state = this.state(turn.threadId);
    const previous = state.turn;
    if (previous && (turn.sequence < previous.sequence ||
      (turn.id === previous.id && previous.status !== "running"))) return;
    state.turn = turn;
    if (turn.status !== "running" && turn.status !== "completed") state.paused = true;
    this.changed(turn.threadId);
    void this.drain(turn.threadId);
  }

  /** 所有消息先可靠存档；空闲时立即投递，其余输入留在等待区。 */
  enqueue(threadId: string, content: string, images: ImageRef[] = [], id: string = crypto.randomUUID()): boolean {
    if (!content.trim() && !images.length) return false;
    const state = this.state(threadId);
    if (this.connected && !state.paused && !state.busy && !state.checking && !state.priority && state.turn?.status !== "running" && !state.messages.length) state.directId = id;
    state.messages.push({ id, content, ...(images.length ? { images: [...images] } : {}), status: "waiting" });
    if (!this.changed(threadId)) {
      state.messages.pop();
      if (state.directId === id) delete state.directId;
      this.actions.changed(threadId, this.view(threadId));
      return false;
    }
    void this.drain(threadId);
    return true;
  }

  /** 当前任务有在途执行或等待输入时，新草稿应排队，不能越过较早的消息。 */
  hasActivity(threadId: string): boolean {
    const state = this.state(threadId);
    return state.busy || state.turn?.status === "running" || state.messages.length > 0;
  }

  pendingDeliveryIds(): string[] { return [...this.states.values()].flatMap((state) => state.messages.map((message) => message.id)); }

  /** 只允许删除尚未发送的消息，不能撤回已提交的引导或输入。 */
  remove(threadId: string, id: string): void {
    const state = this.state(threadId);
    if (state.checking) return;
    const previous = state.messages;
    state.messages = state.messages.filter((message) => message.id !== id || message.status !== "waiting");
    if (!this.changed(threadId)) { state.messages = previous; this.actions.changed(threadId, this.view(threadId)); }
  }

  /** 用户主动停止时先暂停队列，避免完成事件与停止请求交错时又启动下一轮。 */
  pause(threadId: string): void { this.state(threadId).paused = true; this.changed(threadId); }

  /** 用户确认继续后，从等待区第一条开始重新串行发送。 */
  resume(threadId: string): void {
    this.state(threadId).paused = false;
    this.changed(threadId);
    void this.drain(threadId);
  }

  /** 优先投递答案，等在途启动收尾，保持普通队列的暂停状态。 */
  async withPriority<T>(threadId: string, action: () => Promise<T>): Promise<T> {
    const state = this.state(threadId);
    if (state.priority) throw new Error("答案正在提交，请稍候。");
    state.priority = true;
    try {
      if (state.busy) await new Promise<void>((resolve) => { state.idle = resolve; });
      state.busy = true; this.changed(threadId);
      return await action();
    } finally {
      state.busy = false;
      state.idle?.(); delete state.idle; state.priority = false; this.changed(threadId); void this.drain(threadId);
    }
  }

  /** 指定等待消息追加到当前轮次；服务确认前保留，已结束或失败时还原为等待。 */
  async steer(threadId: string, id: string): Promise<void> {
    const state = this.state(threadId);
    const message = state.messages.find((message) => message.id === id);
    if (!this.connected || state.busy || state.checking || state.priority || state.turn?.status !== "running" || message?.status !== "waiting") return;
    state.busy = true;
    message.status = "steering";
    if (!this.changed(threadId)) { message.status = "waiting"; state.busy = false; this.actions.changed(threadId, this.view(threadId)); return; }
    try {
      const input = await this.actions.steer(state.turn.id, message.content, message.images ?? [], message.id);
      if (input) state.messages = state.messages.filter((item) => item.id !== id);
    } catch (error) { state.paused = true; this.actions.error(error); }
    finally {
      message.status = "waiting";
      state.busy = false;
      state.idle?.(); delete state.idle;
      this.changed(threadId);
      void this.drain(threadId);
    }
  }

  /** 同一任务只允许一个启动请求；确认接收后才移除消息，失败时保留并暂停。 */
  private async drain(threadId: string): Promise<void> {
    const state = this.state(threadId);
    const message = state.messages[0];
    if (!this.connected || state.paused || state.busy || state.checking || state.priority || state.turn?.status === "running" || !message) return;
    state.busy = true;
    message.status = "sending";
    if (!this.changed(threadId)) {
      message.status = "waiting"; state.busy = false; delete state.directId;
      this.actions.changed(threadId, this.view(threadId));
      return;
    }
    try {
      const turn = await this.actions.start(threadId, message.content, message.images ?? [], message.id);
      state.messages = state.messages.filter((item) => item.id !== message.id);
      this.observe(turn);
    } catch (error) { state.paused = true; this.actions.error(error); }
    finally {
      message.status = "waiting";
      state.busy = false;
      state.idle?.(); delete state.idle;
      delete state.directId;
      this.changed(threadId);
      // 可能在启动应答前就收到完成事件，仍继续下一条而不会再次发送本条。
      void this.drain(threadId);
    }
  }

  /** 每个任务独立维护轮次和队列，切换页面不改变发送归属。 */
  private state(threadId: string): QueueState {
    let state = this.states.get(threadId);
    if (!state) { state = { messages: [], paused: false, busy: false, turn: null }; this.states.set(threadId, state); }
    return state;
  }

  /** 将当前快照交给界面。 */
  private changed(threadId: string): boolean {
    let saved = true;
    try {
      const queues = Object.fromEntries([...this.states].filter(([, state]) => state.messages.length).map(([id, state]) =>
        [id, state.messages.map(({ id, content, images }) => ({ id, content, ...(images ? { images } : {}) }))]));
      this.storage?.setItem("tilot.input-queues.v1", JSON.stringify(queues));
    } catch (error) { saved = false; this.state(threadId).paused = true; this.actions.error(new Error("等待消息保存失败，已暂停发送。", { cause: error })); }
    this.actions.changed(threadId, this.view(threadId));
    return saved;
  }
}
