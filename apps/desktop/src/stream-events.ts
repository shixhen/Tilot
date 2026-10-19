import type { ServerEvent } from "@tilot/protocol";

/** 首段即时显示，其后按 50ms 合并增量；边界事件立即带上剩余文字提交。 */
export class StreamEvents {
  private readonly deliver: (events: ServerEvent[]) => void;
  private pending: ServerEvent[] = [];
  private timer: ReturnType<typeof setTimeout> | undefined;
  private disposed = false;

  constructor(deliver: (events: ServerEvent[]) => void) { this.deliver = deliver; }

  push(event: ServerEvent): void {
    if (this.disposed) return;
    const previous = this.pending.at(-1);
    if (event.event === "message.delta" && previous?.event === "message.delta"
      && event.threadId === previous.threadId && event.turnId === previous.turnId && event.itemId === previous.itemId
      && event.contentIndex === previous.contentIndex && event.kind === previous.kind) {
      this.pending[this.pending.length - 1] = { ...event, delta: previous.delta + event.delta };
    } else this.pending.push(event);
    if (event.event !== "message.delta") this.flush();
    else if (this.timer === undefined) { this.drain(); this.schedule(); }
  }

  /** 停止、结束或断连时不等待下一个刷新窗口。 */
  flush(): void {
    clearTimeout(this.timer);
    this.timer = undefined;
    this.drain();
  }

  /** 页面卸载后不再提交状态，也不保留定时器。 */
  dispose(): void {
    this.disposed = true;
    clearTimeout(this.timer);
    this.timer = undefined;
    this.pending = [];
  }

  private drain(): void {
    const events = this.pending;
    this.pending = [];
    if (events.length) this.deliver(events);
  }

  private schedule(): void {
    this.timer = setTimeout(() => {
      this.timer = undefined;
      if (this.pending.length) { this.drain(); this.schedule(); }
    }, 50);
  }
}
