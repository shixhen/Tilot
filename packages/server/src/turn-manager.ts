import { compactHistory, runTurn, type TurnEvent } from "@tilot/agent-core";
import { createResponsesClient } from "@tilot/responses";
import type { Store, Turn, TurnInput } from "@tilot/store";
import type { CompactionView, ImageRef, ServerEvent, Thread, ToolView, TurnNotification } from "@tilot/protocol";
import type { QuestionDelivery, QuestionDraft } from "@tilot/protocol";
import { listAttemptViews, projectMessages } from "./history.ts";
import { coversNewHistory, readPrompt } from "@tilot/context";
import { ApprovalManager } from "./approvals.ts";
import { McpManager } from "@tilot/tool";
import { projectWebTool } from "./web-tools.ts";

export interface TurnManagerOptions {
  mcp?: McpManager;
  globalSkillsDirectory?: string;
}

/** 当前进程持有的执行句柄，关闭连接时取消并等待 Core 完成落库。 */
interface ActiveTurn {
  threadId: string;
  controller: AbortController;
  done: Promise<void>;
}

/** 管理服务连接中的运行轮次、取消信号与展示事件，不承担 Agent 业务循环。 */
export class TurnManager {
  readonly approvals: ApprovalManager;
  private readonly mcp: McpManager;
  private readonly globalSkillsDirectory: string | undefined;
  private readonly store: Store;
  private readonly send: (event: ServerEvent) => Promise<void>;
  private readonly onFatal: (error: Error) => void;
  private readonly active = new Map<string, ActiveTurn>();
  private readonly compacting = new Map<string, Pick<ActiveTurn, "controller" | "done">>();
  private sequence = 0;
  private closed = false;

  /** 绑定存储和事件出口；无法保存状态或交付事件时由连接负责人关闭服务。 */
  constructor(store: Store, send: (event: ServerEvent) => Promise<void>, onFatal: (error: Error) => void, options: TurnManagerOptions = {}) {
    this.store = store;
    this.send = send;
    this.onFatal = onFatal;
    this.mcp = options.mcp ?? new McpManager();
    this.globalSkillsDirectory = options.globalSkillsDirectory;
    this.approvals = new ApprovalManager((event) => this.emit(event));
  }

  /** 使用任务所选服务的地址和密钥启动轮次，取得轮次标识即返回，不等待模型完成。 */
  start(threadId: string, input: string, images: ImageRef[] = [], deliveryId?: string): Promise<Turn> {
    if (this.closed) throw new Error("服务正在关闭，不能开始新轮次。");
    const attachments = this.store.images.references(images);
    const delivered = this.store.findInputDelivery(threadId, deliveryId, input, attachments);
    if (delivered) return Promise.resolve(this.store.getTurn(delivered.turnId)!);
    this.requireNotCompacting(threadId);
    if (!input.trim() && !attachments.length) throw new Error("用户输入不能为空。");
    return this.launch(threadId, input, this.createClient(this.store.lockThreadPermissions(threadId)), undefined, attachments, deliveryId);
  }

  private createClient(thread: Thread) {
    const provider = this.store.getConfig().providers.find((item) => item.id === thread.providerId);
    if (!provider) throw new Error("对话使用的服务已不存在，请重新选择模型。");
    const apiKey = this.store.credentials.getApiKey(provider.id, provider.baseURL);
    if (!apiKey) throw new Error(`${provider.name} 尚未配置 API Key。`);
    return createResponsesClient({ apiKey, baseURL: provider.baseURL });
  }

  /** 先预留对话，再停止当前轮次。旧轮次和摘要在后台收尾，行协议无需等待。 */
  compact(threadId: string): CompactionView {
    if (this.closed) throw new Error("服务正在关闭，不能开始压缩。");
    this.requireNotCompacting(threadId);
    const thread = this.store.getThread(threadId);
    const latest = this.store.getLatestTurn(threadId);
    if (!thread || !latest) throw new Error("当前对话还没有可压缩的历史。");
    if (!coversNewHistory({ throughSequence: latest.sequence }, this.store.compactions.checkpoint(threadId))) {
      throw new Error("上次压缩后没有新的对话内容。");
    }
    const active = this.active.get(latest.id);
    if (latest.status === "running" && !active) throw new Error("当前轮次还未收尾，暂不能压缩。");
    const client = this.createClient(thread);
    const job = this.store.compactions.start(threadId, !!active);
    const execution = { controller: new AbortController(), done: Promise.resolve() };
    this.compacting.set(threadId, execution);
    if (active && latest.status === "running") active.controller.abort();
    const signal = execution.controller.signal;
    const publish = (compaction: CompactionView) => this.emit({ event: "compaction.updated", threadId, compaction });
    execution.done = (async () => {
      await publish(job);
      if (active) {
        await active.done;
        if (!signal.aborted) await publish(this.store.compactions.begin(job.id));
      }
      let result: Parameters<Store["compactions"]["finish"]>[1];
      try {
        result = await compactHistory(this.store, client, thread, signal);
      } catch (error) {
        result = signal.aborted ? { status: "interrupted", error: "应用退出，压缩未完成。" }
          : { status: "failed", error: error instanceof Error ? error.message : String(error) };
      }
      const finished = this.store.compactions.finish(job.id, result);
      this.compacting.delete(threadId);
      await publish(finished);
    })().catch((error: unknown) => {
      this.onFatal(error instanceof Error ? error : new Error("压缩状态保存或事件交付失败。"));
    }).finally(() => {
      if (this.compacting.get(threadId) === execution) this.compacting.delete(threadId);
    });
    return job;
  }

  private requireNotCompacting(threadId: string): void {
    if (this.compacting.has(threadId)) throw new Error("正在压缩对话，请等待压缩结束。");
  }

  private launch(threadId: string, input: string, client: ReturnType<typeof createResponsesClient>, turn?: Turn, images: ImageRef[] = [], deliveryId?: string): Promise<Turn> {
    const started = Promise.withResolvers<Turn>();
    const execution: ActiveTurn = { threadId, controller: new AbortController(), done: Promise.resolve() };
    let current: Turn | undefined;
    const pendingWeb = new Map<string, ToolView>();
    execution.done = runTurn(this.store, client, {
      threadId, input, images, signal: execution.controller.signal, mcp: this.mcp,
      ...(this.globalSkillsDirectory ? { globalSkillsDirectory: this.globalSkillsDirectory } : {}),
      ...(turn ? { turn } : {}),
      ...(deliveryId ? { deliveryId } : {}),
      onApproval: (request, signal) => this.approvals.request({ ...request, threadId }, signal),
      onEvent: async (event) => {
        if (event.type === "question.updated") {
          await this.emit({ event: "question.updated", threadId, question: event.question });
        } else if (event.type === "turn.started") {
          current = event.turn;
          this.active.set(current.id, execution);
          started.resolve(current);
          await this.emit({ event: "turn.started", turn: current });
        } else if (event.type === "turn.notice") {
          await this.emit({ event: "turn.notice", threadId, turnId: event.turnId, message: event.message });
        } else if (event.type === "reasoning.updated") {
          await this.emit({ event: "message.timing", threadId, turnId: event.turnId, timing: event.timing });
        } else if (event.type === "tool.progress") {
          await this.emit({ event: "tool.progress", threadId, turnId: event.turnId, attemptId: event.attemptId, toolId: event.toolId,
            output: event.snapshot.output, truncated: event.snapshot.truncated, partialLine: event.snapshot.partialLine });
        } else if (event.type === "tool.updated") {
          const saved = this.store.history.getAttempt(event.attemptId)!;
          const attempt = listAttemptViews(this.store, event.turnId, saved.sequence - 1, 1)[0]!;
          for (const tool of attempt.tools) tool.running = tool.id === event.runningToolId;
          await this.emit({ event: "attempt.updated", threadId, turnId: event.turnId, attempt });
        } else {
          const response = event.event;
          const webStarted = response.type === "response.output_item.added" && response.item.type === "web_search_call"
            ? projectWebTool(response.item, response.output_index) : undefined;
          if (response.type === "response.created" || response.type === "response.completed" ||
              response.type === "response.failed" || response.type === "response.incomplete" || response.type === "error") pendingWeb.clear();
          else if (webStarted) pendingWeb.set(webStarted.id, webStarted);
          else if (response.type === "response.output_item.done") pendingWeb.delete(response.item.id!);
          if (event.titleUpdated) await this.emit({ event: "thread.title", threadId });
          if (webStarted || ["response.created", "response.output_item.done", "response.completed", "response.failed", "response.incomplete", "error"].includes(response.type)) {
            const saved = this.store.history.getAttempt(event.attemptId)!;
            const attempt = listAttemptViews(this.store, event.turnId, saved.sequence - 1, 1)[0]!;
            attempt.tools.push(...pendingWeb.values());
            await this.emit({ event: "attempt.updated", threadId, turnId: event.turnId, attempt });
          }
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

  /** 仅允许从最新中断轮次创建后续轮次；旧调用及其记录不重跑、不改写。 */
  resume(turnId: string): Promise<Turn> {
    const turn = this.store.getTurn(turnId);
    if (!turn || turn.status !== "interrupted") throw new Error("只能继续已中断的轮次。");
    if (this.store.listTurns(turn.threadId, turn.sequence, 1).length) throw new Error("该任务已经有后续轮次，请继续最新对话。");
    return this.start(turn.threadId, readPrompt("resume"));
  }

  /** 将引导保存到当前轮次，不取消模型或工具；已结束时返回 null，供界面保留等待消息。 */
  async steer(turnId: string, content: string, images: ImageRef[] = [], deliveryId?: string): Promise<TurnInput | null> {
    const attachments = this.store.images.references(images);
    if (!content.trim() && !attachments.length) throw new Error("引导消息不能为空。");
    const execution = this.active.get(turnId);
    const turn = this.store.getTurn(turnId);
    const delivered = turn ? this.store.findInputDelivery(turn.threadId, deliveryId, content, attachments) : undefined;
    if (delivered) return delivered;
    if (this.closed || !execution || execution.controller.signal.aborted || turn?.status !== "running") return null;
    const input = this.store.appendTurnInput(turnId, content, attachments, deliveryId);
    await this.emit({ event: "turn.input", threadId: turn.threadId, turnId, input });
    return input;
  }

  /** 同步登记答案后才异步通知界面；重复 RPC 从数据库取原投递，不重跑模型。 */
  async answer(questionId: string, draft: QuestionDraft): Promise<QuestionDelivery> {
    if (this.closed) throw new Error("服务正在关闭，不能提交答案。");
    const question = this.store.questions.get(questionId);
    if (!question) throw new Error("问题不存在。");
    if (question.status === "answered") return this.store.answerQuestion(questionId, draft);
    if (question.status !== "pending") throw new Error("该组问题已关闭。");
    this.requireNotCompacting(question.threadId);
    const running = this.store.getRunningTurn(question.threadId);
    if (running && (!this.active.has(running.id) || this.active.get(running.id)!.controller.signal.aborted)) throw new Error("当前轮次正在停止，请稍后再次提交。答案仍保留。");
    const client = running ? undefined : this.createClient(this.store.lockThreadPermissions(question.threadId));
    const delivery = this.store.answerQuestion(questionId, draft, running?.id);
    if (client) await this.launch(question.threadId, delivery.input.content, client, delivery.turn);
    else await this.emit({ event: "turn.input", threadId: question.threadId, turnId: delivery.turn.id, input: delivery.input });
    await this.emit({ event: "question.updated", threadId: question.threadId, question: delivery.question });
    return delivery;
  }

  async closeQuestion(id: string) {
    const question = this.store.questions.close(id);
    await this.emit({ event: "question.updated", threadId: question.threadId, question });
    return question;
  }

  /** 请求取消当前连接拥有的轮次；不存在或已结束返回 false，不改写历史。 */
  interrupt(turnId: string): boolean {
    const execution = this.active.get(turnId);
    if (!execution || this.store.getTurn(turnId)?.status !== "running") return false;
    execution.controller.abort();
    return true;
  }

  /** 等执行及终态通知完全收尾后，才能删除对话历史。 */
  deleteThread(threadId: string): string[] {
    this.requireNotCompacting(threadId);
    if ([...this.active.values()].some((execution) => execution.threadId === threadId)) {
      throw new Error("对话正在运行或收尾，请稍后再删除。");
    }
    return this.store.deleteThread(threadId);
  }

  /** 停止接收新执行，取消所有活动轮次并等待保存终态，之后才能关闭数据库。 */
  async close(): Promise<void> {
    this.closed = true;
    const running = [...this.active.values(), ...this.compacting.values()];
    for (const execution of running) execution.controller.abort();
    await Promise.all(running.map((execution) => execution.done));
    await this.mcp.close();
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
