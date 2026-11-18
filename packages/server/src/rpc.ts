import { isImageRef, isPermissionMode, type AppConfig, type ModelInfo, type Provider, type ReasoningEffort, type RpcRequest, type RpcResponse, type RpcResult } from "@tilot/protocol";
import type { Store } from "@tilot/store";
import { importImage, openWorkspace } from "@tilot/tool";
import { listModels } from "@tilot/responses";
import type { TurnManager } from "./turn-manager.ts";
import { listAttemptViews } from "./history.ts";
import type { QuestionDraft } from "@tilot/protocol";

/** 识别普通对象，供进程通信边界读取字段；数组及 null 不是请求对象。 */
function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 判断是否为支持的思考强度。 */
function isEffort(value: unknown): value is ReasoningEffort {
  return value === "none" || value === "low" || value === "high" || value === "max";
}

/** 判断是否为模型列表中的一项。 */
function isModel(value: unknown): value is ModelInfo {
  return isObject(value) && typeof value.id === "string" && (value.contextTokens === undefined || typeof value.contextTokens === "number");
}

/** 判断是否为服务配置。 */
function isProvider(value: unknown): value is Provider {
  return isObject(value) && typeof value.id === "string" && typeof value.name === "string" &&
    typeof value.baseURL === "string" && Array.isArray(value.models) && value.models.every(isModel);
}

/** 校验未知 JSON 的请求结构；业务范围约束仍由 Store 和 Workspace 负责。 */
function parseRequest(value: unknown): RpcRequest {
  if (!isObject(value) || typeof value.id !== "string" || !value.id.trim() || !isObject(value.params)) {
    throw new Error("请求必须包含非空 id、method 和 params 对象。");
  }
  const params = value.params;
  switch (value.method) {
    case "image.import":
      if (Object.keys(params).length === 1 && typeof params.path === "string") return { id: value.id, method: value.method, params: { path: params.path } };
      if (Object.keys(params).length === 1 && typeof params.url === "string") return { id: value.id, method: value.method, params: { url: params.url } };
      if (Object.keys(params).length === 2 && typeof params.base64 === "string" && typeof params.name === "string") return { id: value.id, method: value.method, params: { base64: params.base64, name: params.name } };
      break;
    case "image.read":
      if (typeof params.imageId === "string") return { id: value.id, method: value.method, params: { imageId: params.imageId } };
      break;
    case "input.receipts":
      if ((params.threadId === undefined || typeof params.threadId === "string") && Array.isArray(params.deliveryIds) && params.deliveryIds.every((id) => typeof id === "string")) return { id: value.id, method: value.method, params: { ...(params.threadId === undefined ? {} : { threadId: params.threadId }), deliveryIds: params.deliveryIds } };
      break;
    case "question.pending":
      if (typeof params.threadId === "string") return { id: value.id, method: value.method, params: { threadId: params.threadId } };
      break;
    case "question.close":
      if (typeof params.questionId === "string") return { id: value.id, method: value.method, params: { questionId: params.questionId } };
      break;
    case "question.draft":
    case "question.submit":
      if (typeof params.questionId === "string" && isObject(params.draft)) return { id: value.id, method: value.method, params: { questionId: params.questionId, draft: params.draft as unknown as QuestionDraft } };
      break;
    case "approval.list":
      if (typeof params.threadId === "string") return { id: value.id, method: value.method, params: { threadId: params.threadId } };
      break;
    case "approval.respond":
      if (typeof params.approvalId === "string" && typeof params.allowed === "boolean") {
        return { id: value.id, method: value.method, params: { approvalId: params.approvalId, allowed: params.allowed } };
      }
      break;
    case "thread.permission":
      if (typeof params.threadId === "string" && isPermissionMode(params.permissionMode)) {
        return { id: value.id, method: value.method, params: { threadId: params.threadId, permissionMode: params.permissionMode } };
      }
      break;
    case "turn.list":
      if (typeof params.threadId === "string" &&
          (params.afterSequence === undefined || typeof params.afterSequence === "number") &&
          (params.limit === undefined || typeof params.limit === "number")) {
        return { id: value.id, method: value.method, params: {
          threadId: params.threadId,
          ...(params.afterSequence === undefined ? {} : { afterSequence: params.afterSequence }),
          ...(params.limit === undefined ? {} : { limit: params.limit }),
        } };
      }
      break;
    case "turn.attempts":
      if (typeof params.turnId === "string" &&
          (params.afterSequence === undefined || typeof params.afterSequence === "number") &&
          (params.limit === undefined || typeof params.limit === "number")) {
        return { id: value.id, method: value.method, params: {
          turnId: params.turnId,
          ...(params.afterSequence === undefined ? {} : { afterSequence: params.afterSequence }),
          ...(params.limit === undefined ? {} : { limit: params.limit }),
        } };
      }
      break;
    case "turn.inputs":
      if (typeof params.turnId === "string" &&
          (params.afterId === undefined || typeof params.afterId === "number") &&
          (params.limit === undefined || typeof params.limit === "number")) {
        return { id: value.id, method: value.method, params: {
          turnId: params.turnId,
          ...(params.afterId === undefined ? {} : { afterId: params.afterId }),
          ...(params.limit === undefined ? {} : { limit: params.limit }),
        } };
      }
      break;
    case "turn.start":
      if (typeof params.threadId === "string" && typeof params.input === "string" &&
          (params.deliveryId === undefined || typeof params.deliveryId === "string" && !!params.deliveryId.trim()) &&
          (params.images === undefined || Array.isArray(params.images) && params.images.every(isImageRef))) {
        return { id: value.id, method: value.method, params: { threadId: params.threadId, input: params.input, ...(params.deliveryId === undefined ? {} : { deliveryId: params.deliveryId }), ...(params.images === undefined ? {} : { images: params.images }) } };
      }
      break;
    case "turn.steer":
      if (typeof params.turnId === "string" && typeof params.input === "string" &&
          (params.deliveryId === undefined || typeof params.deliveryId === "string" && !!params.deliveryId.trim()) &&
          (params.images === undefined || Array.isArray(params.images) && params.images.every(isImageRef))) {
        return { id: value.id, method: value.method, params: { turnId: params.turnId, input: params.input, ...(params.deliveryId === undefined ? {} : { deliveryId: params.deliveryId }), ...(params.images === undefined ? {} : { images: params.images }) } };
      }
      break;
    case "turn.read":
    case "turn.resume":
    case "turn.interrupt":
      if (typeof params.turnId === "string") {
        return { id: value.id, method: value.method, params: { turnId: params.turnId } };
      }
      break;
    case "config.get":
    case "credentials.status":
      return { id: value.id, method: value.method, params: {} };
    case "config.set":
      return { id: value.id, method: value.method, params: { config: parseConfig(params.config) } };
    case "credentials.set":
      if (typeof params.providerId === "string" && typeof params.apiKey === "string") {
        return { id: value.id, method: value.method, params: { providerId: params.providerId, apiKey: params.apiKey } };
      }
      break;
    case "models.fetch":
      if (typeof params.providerId === "string" && typeof params.baseURL === "string" && typeof params.apiKey === "string") {
        return { id: value.id, method: value.method, params: { providerId: params.providerId, baseURL: params.baseURL, apiKey: params.apiKey } };
      }
      break;
    case "thread.create":
      if (typeof params.title === "string" &&
          (params.autoTitle === undefined || typeof params.autoTitle === "boolean") &&
          (params.permissionMode === undefined || isPermissionMode(params.permissionMode)) &&
          (params.projectPath === undefined || params.projectPath === null || typeof params.projectPath === "string")) {
        return { id: value.id, method: value.method, params: {
          title: params.title, ...(params.projectPath === undefined ? {} : { projectPath: params.projectPath }),
          ...(params.permissionMode === undefined ? {} : { permissionMode: params.permissionMode }),
          ...(params.autoTitle === undefined ? {} : { autoTitle: params.autoTitle }),
        } };
      }
      break;
    case "thread.read":
    case "thread.delete":
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
    case "thread.update":
      if (typeof params.threadId === "string" && typeof params.providerId === "string" && typeof params.model === "string" && isEffort(params.reasoningEffort)) {
        return { id: value.id, method: value.method, params: {
          threadId: params.threadId, providerId: params.providerId, model: params.model, reasoningEffort: params.reasoningEffort,
        } };
      }
      break;
    default:
      throw new Error("不支持的 RPC 方法。");
  }
  throw new Error("RPC 参数类型不正确。");
}

/** 从未知 JSON 提取完整配置，忽略未声明字段；数值范围由 Store 校验。 */
function parseConfig(value: unknown): AppConfig {
  if (!isObject(value) || typeof value.providerId !== "string" || typeof value.model !== "string" ||
      !isEffort(value.reasoningEffort) || !Array.isArray(value.providers) || !value.providers.every(isProvider) ||
      typeof value.maxAutomaticRetries !== "number" || !isPermissionMode(value.defaultPermissionMode)) {
    throw new Error("配置字段缺失或类型不正确。");
  }
  return {
    providerId: value.providerId, model: value.model, reasoningEffort: value.reasoningEffort,
    providers: value.providers.map((provider) => ({ id: provider.id, name: provider.name, baseURL: provider.baseURL,
      models: provider.models.map((model) => ({ id: model.id, ...(model.contextTokens === undefined ? {} : { contextTokens: model.contextTokens }) })) })),
    maxAutomaticRetries: value.maxAutomaticRetries,
    defaultPermissionMode: value.defaultPermissionMode,
  };
}

/** 处理一条 JSON 请求并返回对应结果；输入错误不会终止服务或回显原始内容。 */
export async function handleRpcLine(store: Store, line: string, turns: TurnManager, signal?: AbortSignal): Promise<RpcResponse> {
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
      case "image.import": {
        const source = request.params;
        result = "base64" in source ? await store.images.importBase64(source.base64, source.name, signal) : await importImage({ images: store.images }, source, signal);
        break;
      }
      case "image.read": result = { image: store.images.get(request.params.imageId), dataUrl: await store.images.dataUrl(request.params.imageId, signal) }; break;
      case "input.receipts": result = store.inputReceipts(request.params.threadId, request.params.deliveryIds); break;
      case "question.pending": result = store.questions.pending(request.params.threadId); break;
      case "question.draft": result = store.questions.saveDraft(request.params.questionId, request.params.draft); break;
      case "question.submit": result = await turns.answer(request.params.questionId, request.params.draft); break;
      case "question.close": result = await turns.closeQuestion(request.params.questionId); break;
      case "approval.list":
        result = turns.approvals.list(request.params.threadId);
        break;
      case "approval.respond":
        turns.approvals.respond(request.params.approvalId, request.params.allowed);
        result = null;
        break;
      case "thread.permission":
        result = store.updateThreadPermission(request.params.threadId, request.params.permissionMode);
        break;
      case "turn.list":
        result = store.listTurns(request.params.threadId, request.params.afterSequence, request.params.limit);
        break;
      case "turn.read":
        result = store.getTurn(request.params.turnId) ?? null;
        break;
      case "turn.inputs":
        result = store.listTurnInputs(request.params.turnId, request.params.afterId, request.params.limit);
        break;
      case "turn.attempts":
        result = listAttemptViews(store, request.params.turnId, request.params.afterSequence, request.params.limit);
        break;
      case "turn.start":
        result = await turns.start(request.params.threadId, request.params.input, request.params.images, request.params.deliveryId);
        break;
      case "turn.steer":
        result = await turns.steer(request.params.turnId, request.params.input, request.params.images, request.params.deliveryId);
        break;
      case "turn.resume":
        result = await turns.resume(request.params.turnId);
        break;
      case "turn.interrupt":
        result = { interrupted: turns.interrupt(request.params.turnId) };
        break;
      case "config.get":
        result = store.getConfig();
        break;
      case "config.set": {
        store.saveConfig(request.params.config);
        const config = store.getConfig();
        // 删除的服务连同密钥一起删除。
        store.credentials.retain(config.providers.map((provider) => provider.id));
        result = config;
        break;
      }
      case "credentials.status":
        result = { configured: store.getConfig().providers
          .filter((provider) => store.credentials.getApiKey(provider.id, provider.baseURL) !== undefined).map((provider) => provider.id) };
        break;
      case "credentials.set": {
        const provider = store.getConfig().providers.find((item) => item.id === request.params.providerId);
        if (!provider) throw new Error("服务不存在，请先保存配置。");
        store.credentials.saveApiKey(provider.id, provider.baseURL, request.params.apiKey);
        result = null;
        break;
      }
      case "models.fetch": {
        // 未填写密钥时使用该服务已保存的密钥（地址须一致），便于只修改上下文设置时重新加载。
        const apiKey = request.params.apiKey.trim() || store.credentials.getApiKey(request.params.providerId, request.params.baseURL);
        if (!apiKey) throw new Error("请填写 API Key。");
        result = await listModels({ apiKey, baseURL: request.params.baseURL });
        break;
      }
      case "thread.create": {
        const path = request.params.projectPath;
        const projectPath = path == null ? null : (await openWorkspace(path)).rootPath;
        result = store.createThread(request.params.title, projectPath, request.params.permissionMode, request.params.autoTitle);
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
      case "thread.delete":
        result = turns.deleteThread(request.params.threadId);
        break;
      case "thread.update":
        result = store.updateThreadModel(request.params.threadId, request.params.providerId, request.params.model, request.params.reasoningEffort);
        break;
    }
    return { id: request.id, success: true, result };
  } catch (error) {
    return { id: request.id, success: false, error: {
      code: "operation_failed", message: error instanceof Error ? error.message : "操作失败。",
    } };
  }
}
