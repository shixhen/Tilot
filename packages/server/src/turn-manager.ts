import { runTurn, type TurnEvent } from "@tilot/agent-core";
import { createResponsesClient } from "@tilot/responses";
import type { Store, Turn } from "@tilot/store";
import type { ServerEvent, TurnNotification } from "@tilot/protocol";
import { listAttemptViews, projectMessages } from "./history.ts";

/** 当前进程持有的执行句柄，关闭连接时取消并等待 Core 完成落库。 */
interface ActiveTurn {
  controller: AbortController;
  done: Promise<void>;
}

/** 管理服务连接中的运行轮次、取消信号与展示事件，不承担 Agent 业务循环。 */
export class TurnManager {
  private readonly store: Store;
  private readonly send: (event: ServerEvent) => Promise<void>;
  private readonly onFatal: (error: Error) => void;
  private readonly active = new Map<string, ActiveTurn>();
  private sequence = 0;
  private closed = false;

  /** 绑定存储和事件出口；无法保存状态或交付事件时由连接负责人关闭服务。 */
  constructor(store: Store, send: (event: ServerEvent) => Promise<void>, onFatal: (error: Error) => void) {
    this.store = store;
    this.send = send;
    this.onFatal = onFatal;
  }

  /** 使用当前地址对应的本地密钥启动轮次，取得轮次标识即返回，不等待模型完成。 */
  start(threadId: string, input: string, instructions: string): Promise<Turn> {
    if (this.closed) throw new Error("服务正在关闭，不能开始新轮次。");
    const config = this.store.getConfig();
    const apiKey = this.store.credentials.getApiKey(config.baseURL);
    if (!apiKey) throw new Error("当前服务地址尚未配置 API Key。");
    const client = createResponsesClient({ apiKey, baseURL: config.baseURL });
    const started = Promise.withResolvers<Turn>();
    const execution: ActiveTurn = { controller: new AbortController(), done: Promise.resolve() };
    let current: Turn | undefined;
    execution.done = runTurn(this.store, client, {
      threadId, input, instructions, signal: execution.controller.signal,
      onEvent: async (event) => {
        if (event.type === "turn.started") {
          current = event.turn;
          this.active.set(current.id, execution);
          started.resolve(current);
          await this.emit({ event: "turn.started", turn: current });
        } else if (event.type === "tool.updated") {
          const saved = this.store.history.getAttempt(event.attemptId)!;
          const attempt = listAttemptViews(this.store, event.turnId, saved.sequence - 1, 1)[0]!;
          for (const tool of attempt.tools) tool.running = tool.id === event.runningToolId;
          await this.emit({ event: "attempt.updated", threadId, turnId: event.turnId, attempt });
        } else {
          for (const notification of projectResponseEvent(threadId, event)) await this.emit(notification);
        }
      },
    }).then(async (turn) => {
      // 在 started 通知前失败时，Core 仍可能已保存失败轮次，不能让启动请求一直等待。
      started.resolve(turn);
      await this.emit({ event: "turn.finished", turn });
    }).catch((error: unknown) => {
      if (!current) started.reject(error);
      else this.onFatal(error instanceof Error ? error : new Error("轮次状态保存或事件交付失败。"));
    }).finally(() => {
      if (current) this.active.delete(current.id);
    });
    return started.promise;
  }

  /** 请求取消当前连接拥有的轮次；不存在或已结束返回 false，不改写历史。 */
  interrupt(turnId: string): boolean {
    const execution = this.active.get(turnId);
    if (!execution || this.store.getTurn(turnId)?.status !== "running") return false;
    execution.controller.abort();
    return true;
  }

  /** 停止接收新执行，取消所有活动轮次并等待保存终态，之后才能关闭数据库。 */
  async close(): Promise<void> {
    this.closed = true;
    const running = [...this.active.values()];
    for (const execution of running) execution.controller.abort();
    await Promise.all(running.map((execution) => execution.done));
  }

  /** 分配连接内事件序号，再等待传输层完成写入。 */
  private emit(notification: TurnNotification): Promise<void> {
    return this.send({ ...notification, seq: ++this.sequence });
  }
}

/** 将已校验的 SDK 事件转换为展示数据；完整文本只在成功响应落库后用于替换预览。 */
function projectResponseEvent(threadId: string, notification: Extract<TurnEvent, { type: "response.event" }>): TurnNotification[] {
  const { event, turnId } = notification;
  if (event.type === "response.output_text.delta" || event.type === "response.reasoning_text.delta" || event.type === "response.refusal.delta") {
    return [{
      event: "message.delta", threadId, turnId, itemId: event.item_id, contentIndex: event.content_index,
      kind: event.type === "response.reasoning_text.delta" ? "reasoning" : event.type === "response.refusal.delta" ? "refusal" : "text",
      delta: event.delta,
    }];
  }
  if (event.type !== "response.completed") return [];
  return projectMessages(event.response).map((message) => ({ event: "message.completed", threadId, turnId, ...message }));
}
