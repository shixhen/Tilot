import type { Turn, TurnInput } from "@tilot/protocol";

/** 等待消息只属于当前应用会话，进入模型前可移除或选择引导。 */
export interface QueuedInput { id: string; content: string; status: "waiting" | "sending" | "steering" }
export interface QueueView { messages: QueuedInput[]; paused: boolean; busy: boolean }
interface QueueState extends QueueView { turn: Turn | null }
interface QueueActions {
  start: (threadId: string, input: string) => Promise<Turn>;
  steer: (turnId: string, input: string) => Promise<TurnInput | null>;
  changed: (threadId: string, view: QueueView) => void;
  error: (error: unknown) => void;
}

/** 按任务串行发送等待输入；事件可以先于请求应答到达，不受当前页面选择影响。 */
export class InputQueue {
  private readonly states = new Map<string, QueueState>();
  private connected = false;
  private readonly actions: QueueActions;

  constructor(actions: QueueActions) { this.actions = actions; }

  /** 返回独立快照，防止在途操作修改 React 已渲染的数据。 */
  view(threadId: string): QueueView {
    const state = this.state(threadId);
    return { messages: state.messages.map((message) => ({ ...message })), paused: state.paused, busy: state.busy };
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

  /** 运行中或已有等待消息时，发送按钮只将输入加入当前任务的等待区。 */
  enqueue(threadId: string, content: string): void {
    if (!content.trim()) return;
    this.state(threadId).messages.push({ id: crypto.randomUUID(), content, status: "waiting" });
    this.changed(threadId);
    void this.drain(threadId);
  }

  /** 当前任务有在途执行或等待输入时，新草稿应排队，不能越过较早的消息。 */
  hasActivity(threadId: string): boolean {
    const state = this.state(threadId);
    return state.busy || state.turn?.status === "running" || state.messages.length > 0;
  }

  /** 只允许删除尚未发送的消息，不能撤回已提交的引导或输入。 */
  remove(threadId: string, id: string): void {
    const state = this.state(threadId);
    state.messages = state.messages.filter((message) => message.id !== id || message.status !== "waiting");
    this.changed(threadId);
  }

  /** 用户主动停止时先暂停队列，避免完成事件与停止请求交错时又启动下一轮。 */
  pause(threadId: string): void { this.state(threadId).paused = true; this.changed(threadId); }

  /** 用户确认继续后，从等待区第一条开始重新串行发送。 */
  resume(threadId: string): void {
    this.state(threadId).paused = false;
    this.changed(threadId);
    void this.drain(threadId);
  }

  /** 指定等待消息追加到当前轮次；服务确认前保留，已结束或失败时还原为等待。 */
  async steer(threadId: string, id: string): Promise<void> {
    const state = this.state(threadId);
    const message = state.messages.find((message) => message.id === id);
    if (!this.connected || state.busy || state.turn?.status !== "running" || message?.status !== "waiting") return;
    state.busy = true;
    message.status = "steering";
    this.changed(threadId);
    try {
      const input = await this.actions.steer(state.turn.id, message.content);
      if (input) state.messages = state.messages.filter((item) => item.id !== id);
    } catch (error) { state.paused = true; this.actions.error(error); }
    finally {
      message.status = "waiting";
      state.busy = false;
      this.changed(threadId);
      void this.drain(threadId);
    }
  }

  /** 同一任务只允许一个启动请求；确认接收后才移除消息，失败时保留并暂停。 */
  private async drain(threadId: string): Promise<void> {
    const state = this.state(threadId);
    const message = state.messages[0];
    if (!this.connected || state.paused || state.busy || state.turn?.status === "running" || !message) return;
    state.busy = true;
    message.status = "sending";
    this.changed(threadId);
    try {
      const turn = await this.actions.start(threadId, message.content);
      state.messages = state.messages.filter((item) => item.id !== message.id);
      this.observe(turn);
    } catch (error) { state.paused = true; this.actions.error(error); }
    finally {
      message.status = "waiting";
      state.busy = false;
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
  private changed(threadId: string): void { this.actions.changed(threadId, this.view(threadId)); }
}
