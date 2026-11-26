import type { Response, ResponseInputItem, ResponseOutputItem } from "openai/resources/responses/responses";
import type { AttemptStatus, ReasoningTiming } from "@tilot/protocol";

export type { AttemptStatus } from "@tilot/protocol";

/** 经过流式完成确认的原始输出项；保留稀疏位置，不将增量拼成正式消息。 */
export interface CompletedOutput { outputIndex: number; item: ResponseOutputItem }

/** 模型请求的持久记录；inputThroughId 记录本次已纳入上下文的用户输入边界。 */
export interface ModelAttempt {
  id: string;
  turnId: string;
  sequence: number;
  inputThroughId: number;
  status: AttemptStatus;
  response: Response | null;
  completedOutputs: CompletedOutput[];
  error: string | null;
  createdAt: number;
  finishedAt: number | null;
  /** 发起请求至首个非空内容增量的毫秒数；未采集时为空。 */
  firstTokenMs: number | null;
  /** 请求开始至流结束的毫秒数，不包含工具执行。 */
  durationMs: number | null;
  reasoningTimings: ReasoningTiming[];
  estimatedInputTokens: number | null;
}

/** 结束请求时提交的数据；原始非成功响应用于诊断，已确认输出独立保存。 */
export interface AttemptCompletion {
  status: Exclude<AttemptStatus, "running">;
  response?: Response;
  error?: string;
  firstTokenMs?: number | null;
  durationMs?: number;
  reasoningTimings?: ReasoningTiming[];
}

/** 直接复用 SDK 的函数工具结果，保留原始 call_id 和 output。 */
export type ToolResult = ResponseInputItem.FunctionCallOutput;

/** 本地工具调用记录；id 是执行标识，callId 是模型标识；缺少结果不代表可安全重跑。 */
export interface StoredToolCall {
  id: string;
  attemptId: string;
  outputIndex: number;
  callId: string;
  result: ToolResult | null;
  createdAt: number;
  finishedAt: number | null;
  /** 实际开始执行的时间，未执行或旧记录为空。 */
  startedAt: number | null;
  /** 实际执行耗时，不包含排队或模型生成工具参数的时间。 */
  durationMs: number | null;
}
