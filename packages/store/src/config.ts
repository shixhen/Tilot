import { DEFAULT_CONTEXT_TOKENS, type AppConfig } from "@tilot/protocol";

export type { AppConfig } from "@tilot/protocol";

/** 首次创建数据库时使用的默认配置；已有配置不会被默认值覆盖。 */
export const DEFAULT_CONFIG: Readonly<AppConfig> = {
  providerId: "default",
  model: "deepseek-flash",
  reasoningEffort: "high",
  providers: [{ id: "default", name: "api.deepseek.com", baseURL: "https://api.deepseek.com",
    models: [{ id: "deepseek-flash", contextTokens: DEFAULT_CONTEXT_TOKENS }] }],
  maxOutputTokens: 16384,
  reserveTokens: 4096,
  maxStepsPerRun: 30,
  maxAutomaticRetries: 2,
};
