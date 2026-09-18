import type { Response, ResponseInputItem } from "openai/resources/responses/responses";

/** 一次模型请求的状态；只有 completed 记录可以进入正式模型历史。 */
export type AttemptStatus = "running" | "completed" | "failed" | "incomplete" | "cancelled" | "interrupted";

/** 模型请求的持久记录；inputThroughId 记录本次已纳入上下文的用户输入边界。 */
export interface ModelAttempt {
  id: string;
  turnId: string;
  sequence: number;
  inputThroughId: number;
  status: AttemptStatus;
  response: Response | null;
  error: string | null;
  createdAt: number;
  finishedAt: number | null;
}

/** 结束请求时提交的数据；成功响应须先经 Responses 校验，其余响应仅供诊断。 */
export interface AttemptCompletion {
  status: Exclude<AttemptStatus, "running">;
  response?: Response;
  error?: string;
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
}
