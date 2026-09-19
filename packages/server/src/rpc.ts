import type { AppConfig, RpcRequest, RpcResponse, RpcResult } from "@tilot/protocol";
import type { Store } from "@tilot/store";
import { openWorkspace } from "./workspace.ts";

/** 识别普通对象，供进程通信边界读取字段；数组及 null 不是请求对象。 */
function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 校验未知 JSON 的请求结构；业务范围约束仍由 Store 和 Workspace 负责。 */
function parseRequest(value: unknown): RpcRequest {
  if (!isObject(value) || typeof value.id !== "string" || !value.id.trim() || !isObject(value.params)) {
    throw new Error("请求必须包含非空 id、method 和 params 对象。");
  }
  const params = value.params;
  switch (value.method) {
    case "config.get":
    case "credentials.status":
    case "credentials.delete":
      return { id: value.id, method: value.method, params: {} };
    case "config.set":
      return { id: value.id, method: value.method, params: { config: parseConfig(params.config) } };
    case "credentials.set":
      if (typeof params.baseURL === "string" && typeof params.apiKey === "string") {
        return { id: value.id, method: value.method, params: { baseURL: params.baseURL, apiKey: params.apiKey } };
      }
      break;
    case "thread.create":
      if (typeof params.title === "string" &&
          (params.projectPath === undefined || params.projectPath === null || typeof params.projectPath === "string")) {
        return { id: value.id, method: value.method, params: {
          title: params.title, ...(params.projectPath === undefined ? {} : { projectPath: params.projectPath }),
        } };
      }
      break;
    case "thread.read":
      if (typeof params.threadId === "string") {
        return { id: value.id, method: value.method, params: { threadId: params.threadId } };
      }
      break;
    case "thread.list":
      if ((params.limit === undefined || typeof params.limit === "number") &&
          (params.offset === undefined || typeof params.offset === "number")) {
        return { id: value.id, method: value.method, params: {
          ...(params.limit === undefined ? {} : { limit: params.limit }),
          ...(params.offset === undefined ? {} : { offset: params.offset }),
        } };
      }
      break;
    case "thread.rename":
      if (typeof params.threadId === "string" && typeof params.title === "string") {
        return { id: value.id, method: value.method, params: { threadId: params.threadId, title: params.title } };
      }
      break;
    default:
      throw new Error("不支持的 RPC 方法。");
  }
  throw new Error("RPC 参数类型不正确。");
}

/** 从未知 JSON 提取完整配置，忽略未声明字段；数值范围和预算关系由 Store 校验。 */
function parseConfig(value: unknown): AppConfig {
  if (!isObject(value) || typeof value.baseURL !== "string" || typeof value.model !== "string" ||
      (value.reasoningEffort !== "none" && value.reasoningEffort !== "low" && value.reasoningEffort !== "high" && value.reasoningEffort !== "max") ||
      typeof value.contextBudgetTokens !== "number" || typeof value.maxOutputTokens !== "number" ||
      typeof value.reserveTokens !== "number" || typeof value.maxStepsPerRun !== "number" ||
      typeof value.maxAutomaticRetries !== "number") {
    throw new Error("配置字段缺失或类型不正确。");
  }
  return {
    baseURL: value.baseURL, model: value.model, reasoningEffort: value.reasoningEffort,
    contextBudgetTokens: value.contextBudgetTokens, maxOutputTokens: value.maxOutputTokens,
    reserveTokens: value.reserveTokens, maxStepsPerRun: value.maxStepsPerRun,
    maxAutomaticRetries: value.maxAutomaticRetries,
  };
}

/** 处理一条 JSON 请求并返回对应结果；输入错误不会终止服务或回显原始内容。 */
export async function handleRpcLine(store: Store, line: string): Promise<RpcResponse> {
  let id: string | null = null;
  let request: RpcRequest;
  try {
    const value: unknown = JSON.parse(line);
    if (isObject(value) && typeof value.id === "string" && value.id.trim()) id = value.id;
    request = parseRequest(value);
  } catch (error) {
    return { id, success: false, error: {
      code: "invalid_request", message: error instanceof SyntaxError ? "请求不是有效的 JSON。" : (error as Error).message,
    } };
  }
  try {
    let result: RpcResult;
    switch (request.method) {
      case "config.get":
        result = store.getConfig();
        break;
      case "config.set":
        store.saveConfig(request.params.config);
        result = store.getConfig();
        break;
      case "credentials.status":
        result = { configured: store.credentials.getApiKey(store.getConfig().baseURL) !== undefined };
        break;
      case "credentials.set":
        store.credentials.saveApiKey(request.params.baseURL, request.params.apiKey);
        result = null;
        break;
      case "credentials.delete":
        store.credentials.deleteApiKey();
        result = null;
        break;
      case "thread.create": {
        const path = request.params.projectPath;
        const projectPath = path == null ? null : (await openWorkspace(path)).rootPath;
        result = store.createThread(request.params.title, projectPath);
        break;
      }
      case "thread.read":
        result = store.getThread(request.params.threadId) ?? null;
        break;
      case "thread.list":
        result = store.listThreads(request.params.limit, request.params.offset);
        break;
      case "thread.rename":
        result = store.renameThread(request.params.threadId, request.params.title);
        break;
    }
    return { id: request.id, success: true, result };
  } catch (error) {
    return { id: request.id, success: false, error: {
      code: "operation_failed", message: error instanceof Error ? error.message : "操作失败。",
    } };
  }
}
