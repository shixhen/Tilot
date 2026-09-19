import type { AppConfig } from "@tilot/protocol";

export type { AppConfig } from "@tilot/protocol";

/** 首次创建数据库时使用的默认配置；已有配置不会被默认值覆盖。 */
export const DEFAULT_CONFIG: Readonly<AppConfig> = {
  baseURL: "https://api.deepseek.com",
  model: "deepseek-flash",
  reasoningEffort: "high",
  contextBudgetTokens: 65536,
  maxOutputTokens: 16384,
  reserveTokens: 4096,
  maxStepsPerRun: 30,
  maxAutomaticRetries: 2,
};
