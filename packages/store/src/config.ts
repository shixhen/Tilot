import type { AppConfig } from "@tilot/protocol";

export type { AppConfig } from "@tilot/protocol";

/** 首次创建数据库时使用的默认配置；已有配置不会被默认值覆盖。 */
export const DEFAULT_CONFIG: Readonly<AppConfig> = {
  providerId: "default",
  model: "deepseek-flash",
  reasoningEffort: "high",
  providers: [{ id: "default", name: "api.deepseek.com", baseURL: "https://api.deepseek.com",
    models: [{ id: "deepseek-flash" }] }],
  maxAutomaticRetries: 2,
  defaultPermissionMode: "workspace-write",
};
