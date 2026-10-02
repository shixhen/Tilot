import type { FunctionTool } from "openai/resources/responses/responses";
import type { OutputCache } from "./output-cache.ts";
import type { OutputSnapshot } from "./output-accumulator.ts";

/** 宿主提供输出缓存和任务归属，模型不能修改这些值。 */
export interface ToolHost { outputs: OutputCache; threadId: string }

/** 本地调用身份与临时进度回调；进度不作为正式模型结果。 */
export interface ToolExecution { executionId: string; onUpdate?: (snapshot: OutputSnapshot) => void | Promise<void> }

/** 一个工具的模型声明和本地执行函数；参数由工具自己校验。 */
export interface Tool {
  definition: FunctionTool;
  execute: (args: Record<string, unknown>, signal?: AbortSignal, execution?: ToolExecution) => Promise<unknown>;
}

/** 一轮实际开放的工具；声明、预算与执行共享这个集合。 */
export interface ToolSet {
  definitions: FunctionTool[];
  execute: (name: string, argumentsJson: string, signal?: AbortSignal, execution?: ToolExecution) => Promise<string>;
}

/** 拒绝声明之外的字段，避免把未生效的参数误当成已经执行。 */
export function validateKeys(args: Record<string, unknown>, allowed: string[]): void {
  if (Object.keys(args).some((key) => !allowed.includes(key))) throw new Error("工具参数包含未支持的字段。");
}
