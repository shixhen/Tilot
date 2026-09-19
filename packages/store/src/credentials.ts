import { randomUUID } from "node:crypto";
import { closeSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** 本地文件中的单组连接凭据；地址绑定防止切换服务后误用旧密钥。 */
interface ApiCredentials {
  baseURL: string;
  apiKey: string;
}

/** 按用户选择以明文 JSON 文件保存凭据，不写入普通配置或对话数据库。 */
export class CredentialStore {
  private readonly path: string;

  /** 使用 Store 已创建的应用数据目录，固定保存到 credentials.json。 */
  constructor(dataDirectory: string) {
    this.path = join(dataDirectory, "credentials.json");
  }

  /** 仅向匹配的服务地址返回密钥；文件不存在或地址不同返回 undefined，损坏文件直接报错。 */
  getApiKey(baseURL: string): string | undefined {
    const endpoint = normalizeBaseURL(baseURL);
    let content: string;
    try {
      content = readFileSync(this.path, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
    let value: unknown;
    try {
      value = JSON.parse(content);
    } catch {
      throw new Error("凭据文件不是有效的 JSON。");
    }
    if (!value || typeof value !== "object" || !("baseURL" in value) || !("apiKey" in value) ||
        typeof value.baseURL !== "string" || typeof value.apiKey !== "string" || !value.apiKey.trim()) {
      throw new Error("凭据文件格式不正确。");
    }
    return normalizeBaseURL(value.baseURL) === endpoint ? value.apiKey : undefined;
  }

  /** 原子替换本地凭据文件；无效地址或空密钥不会覆盖现有凭据。 */
  saveApiKey(baseURL: string, apiKey: string): void {
    const credentials: ApiCredentials = { baseURL: normalizeBaseURL(baseURL), apiKey: apiKey.trim() };
    if (!credentials.apiKey) throw new Error("API Key 不能为空。");
    const temporary = `${this.path}.${randomUUID()}.tmp`;
    const descriptor = openSync(temporary, "wx", 0o600);
    try {
      try {
        writeFileSync(descriptor, JSON.stringify(credentials), "utf8");
      } finally {
        closeSync(descriptor);
      }
      renameSync(temporary, this.path);
    } finally {
      rmSync(temporary, { force: true });
    }
  }

  /** 删除本地保存的密钥；文件已不存在时视为完成。 */
  deleteApiKey(): void {
    rmSync(this.path, { force: true });
  }
}

/** 校验并规范化服务地址，用于配置检查和凭据的精确匹配，保留路径前缀差异。 */
export function normalizeBaseURL(baseURL: string): string {
  const url = new URL(baseURL);
  if ((url.protocol !== "http:" && url.protocol !== "https:") || url.username || url.password || url.search || url.hash) {
    throw new Error("模型服务地址必须使用 HTTP/HTTPS，且不能包含凭据、查询参数或片段。");
  }
  return url.href;
}
