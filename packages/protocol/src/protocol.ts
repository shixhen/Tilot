/** 桌面与服务共用的任务数据；项目为空表示普通对话，时间均为 Unix 毫秒。 */
export interface Thread {
  id: string;
  title: string;
  projectPath: string | null;
  createdAt: number;
  updatedAt: number;
}

/** 当前已实现的任务、配置和凭据 RPC；请求 id 由调用方生成，用于对应返回结果。 */
export type RpcRequest =
  | { id: string; method: "turn.list"; params: { threadId: string; afterSequence?: number; limit?: number } }
  | { id: string; method: "turn.read"; params: { turnId: string } }
  | { id: string; method: "turn.inputs"; params: { turnId: string; afterId?: number; limit?: number } }
  | { id: string; method: "turn.attempts"; params: { turnId: string; afterSequence?: number; limit?: number } }
  | { id: string; method: "turn.start"; params: { threadId: string; input: string; instructions: string } }
  | { id: string; method: "turn.interrupt"; params: { turnId: string } }
  | { id: string; method: "config.get"; params: Record<string, never> }
  | { id: string; method: "config.set"; params: { config: AppConfig } }
  | { id: string; method: "credentials.status"; params: Record<string, never> }
  | { id: string; method: "credentials.set"; params: { baseURL: string; apiKey: string } }
  | { id: string; method: "credentials.delete"; params: Record<string, never> }
  | { id: string; method: "thread.create"; params: { title: string; projectPath?: string | null } }
  | { id: string; method: "thread.read"; params: { threadId: string } }
  | { id: string; method: "thread.list"; params: { limit?: number; offset?: number } }
  | { id: string; method: "thread.rename"; params: { threadId: string; title: string } };

/** RPC 错误分类；消息仅描述失败，不回传原始请求。 */
export interface RpcError {
  code: "invalid_request" | "operation_failed";
  message: string;
}

/** 请求返回值；无法识别请求标识时错误响应的 id 为 null。 */
export type RpcResponse =
  | { id: string; success: true; result: RpcResult }
  | { id: string | null; success: false; error: RpcError };

/** 已实现方法的返回数据；凭据只返回是否配置，不返回原文。 */
export type RpcResult =
  | Thread | Thread[] | Turn | Turn[] | TurnInput[] | AttemptView[] | AppConfig
  | { configured: boolean } | { interrupted: boolean } | null;

/** 轮次的结束状态；interrupted 表示旧执行进程退出，区别于用户主动取消。 */
export type TurnFinalStatus = "completed" | "failed" | "cancelled" | "interrupted";

/** 一次执行轮次的共享记录；sequence 是任务内的顺序，时间为 Unix 毫秒。 */
export interface Turn {
  id: string;
  threadId: string;
  sequence: number;
  status: "running" | TurnFinalStatus;
  createdAt: number;
  finishedAt: number | null;
  error: string | null;
}

/** 用于显示的文本种类，正文、推理与拒绝信息分别展示。 */
export type TextKind = "text" | "reasoning" | "refusal";

/** 界面文本块；完整内容用于替换增量预览，不再次追加。 */
export interface MessagePart {
  kind: TextKind;
  text: string;
}

/** 已保存的用户输入，首条与补充输入都保留原文，id 用于分页和上下文边界。 */
export interface TurnInput {
  id: number;
  turnId: string;
  content: string;
  createdAt: number;
}

/** 一次模型请求的状态，与所属轮次状态区分，例如截断请求属于失败轮次。 */
export type AttemptStatus = "running" | "completed" | "failed" | "incomplete" | "cancelled" | "interrupted";

/** 成功响应的单个展示项；itemId 与实时事件相同，outputIndex 保留原始输出位置。 */
export interface MessageView {
  itemId: string;
  outputIndex: number;
  parts: MessagePart[];
}

/** 模型请求的历史展示；只有成功请求有正式消息，不包含 SDK 原始响应与失败片段。 */
export interface AttemptView {
  id: string;
  turnId: string;
  sequence: number;
  inputThroughId: number;
  status: AttemptStatus;
  error: string | null;
  createdAt: number;
  finishedAt: number | null;
  messages: MessageView[];
}

/** 服务推送数据；不向界面传递 SDK 响应对象或模型请求参数。 */
export type TurnNotification =
  | { event: "turn.started" | "turn.finished"; turn: Turn }
  | { event: "message.delta"; threadId: string; turnId: string; itemId: string; contentIndex: number; kind: TextKind; delta: string }
  | { event: "message.completed"; threadId: string; turnId: string; itemId: string; outputIndex: number; parts: MessagePart[] };

/** 当前服务连接内的顺序事件；seq 从 1 递增，重启后重新计数，不提供断线重放。 */
export type ServerEvent = TurnNotification & { seq: number };

/** 标准输出的一条消息，可通过 event 或 success 字段区分事件和请求应答。 */
export type ServerMessage = RpcResponse | ServerEvent;

/** 桌面与服务共用的普通配置，不包含凭据。 */
export interface AppConfig {
  baseURL: string;
  model: string;
  reasoningEffort: "none" | "low" | "high" | "max";
  contextBudgetTokens: number;
  maxOutputTokens: number;
  reserveTokens: number;
  maxStepsPerRun: number;
  maxAutomaticRetries: number;
}
