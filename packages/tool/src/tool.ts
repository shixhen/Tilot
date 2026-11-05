import type { FunctionTool, ResponseInputItem } from "openai/resources/responses/responses";
import type { OutputCache } from "./output-cache.ts";
import type { OutputSnapshot } from "./output-accumulator.ts";
import type { PermissionMode } from "@tilot/protocol";
import type { UserQuestion } from "@tilot/protocol";
import { imageContent, type ImageRef } from "@tilot/protocol";

/** 宿主提供输出缓存和任务归属，模型不能修改这些值。 */
export interface ToolHost { outputs: OutputCache; threadId: string; images?: ImageHost; ask?: (questions: UserQuestion[], toolId: string) => Promise<string> }
export interface ImageHost {
  importFile: (path: string, signal?: AbortSignal) => Promise<ImageRef>;
  importBase64: (data: string, name: string, signal?: AbortSignal) => Promise<ImageRef>;
  save: (bytes: Uint8Array, name: string, signal?: AbortSignal) => Promise<ImageRef>;
}

export type ToolOutput = ResponseInputItem.FunctionCallOutput["output"];

/** 图片引用与文本元数据一起保存，发请求前再展开为真实图片内容。 */
export class ImageToolResult {
  readonly data: Record<string, unknown>;
  readonly images: ImageRef[];
  constructor(data: Record<string, unknown>, images: ImageRef[]) { this.data = { ...data, images }; this.images = images; }
}

export function toolOutput(status: string, data?: unknown, error?: string): ToolOutput {
  const media = data instanceof ImageToolResult ? data : undefined;
  const text = JSON.stringify({ status, ...(data === undefined ? {} : { data: media ? media.data : data }), ...(error ? { error } : {}) });
  return media?.images.length ? [{ type: "input_text", text }, ...media.images.map(imageContent)] : text;
}

/** 本地执行上下文；审批时必须提供调用身份，进度不作为正式模型结果。 */
export interface ToolExecution {
  executionId?: string;
  writeTarget?: string;
  onStart?: () => void | Promise<void>;
  onUpdate?: (snapshot: OutputSnapshot) => void | Promise<void>;
}

export interface ApprovalInput { toolId: string; name: string; arguments: string; resolvedPath?: string }
export interface ToolPermissions {
  mode: PermissionMode;
  approve?: (input: ApprovalInput, signal?: AbortSignal) => Promise<boolean>;
}

/** 一个工具的模型声明和本地执行函数；参数由工具自己校验。 */
export interface Tool {
  access: "read" | "write" | "shell" | "mcp" | "interaction";
  definition: FunctionTool;
  execute: (args: Record<string, unknown>, signal?: AbortSignal, execution?: ToolExecution) => Promise<unknown>;
}

/** 一轮实际开放的工具；声明、预算与执行共享这个集合。 */
export interface ToolSet {
  definitions: FunctionTool[];
  execute: (name: string, argumentsJson: string, signal?: AbortSignal, execution?: ToolExecution) => Promise<ToolOutput>;
}

/** 工具已返回的业务失败；保留输出正文和缓存续读信息。 */
export class ToolFailure extends Error {
  readonly data: unknown;
  constructor(message: string, data: unknown) { super(message); this.data = data; }
}

/** 拒绝声明之外的字段，避免把未生效的参数误当成已经执行。 */
export function validateKeys(args: Record<string, unknown>, allowed: string[]): void {
  if (Object.keys(args).some((key) => !allowed.includes(key))) throw new Error("工具参数包含未支持的字段。");
}
