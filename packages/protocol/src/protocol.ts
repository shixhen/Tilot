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
export type RpcResult = Thread | Thread[] | AppConfig | { configured: boolean } | null;

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
