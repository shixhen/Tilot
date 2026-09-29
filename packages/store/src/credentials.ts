import { randomUUID } from "node:crypto";
import { closeSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** 一个服务的凭据；记录保存时的地址，服务改了地址后旧密钥不会被发往新地址。 */
interface ApiCredential {
  baseURL: string;
  apiKey: string;
}

/** 按服务 id 保存的全部凭据。 */
type ApiCredentials = Record<string, ApiCredential>;

/** 判断是否为有效的单条凭据。 */
function isCredential(value: unknown): value is ApiCredential {
  return !!value && typeof value === "object" && "baseURL" in value && "apiKey" in value &&
    typeof value.baseURL === "string" && typeof value.apiKey === "string" && !!value.apiKey.trim();
}

/** 按用户选择以明文 JSON 文件保存凭据，不写入普通配置或对话数据库。 */
export class CredentialStore {
  private readonly path: string;

  /** 使用 Store 已创建的应用数据目录，固定保存到 credentials.json。 */
  constructor(dataDirectory: string) {
    this.path = join(dataDirectory, "credentials.json");
  }

  /** 返回服务的密钥；未保存或保存时的地址与当前地址不同返回 undefined，损坏文件直接报错。 */
  getApiKey(providerId: string, baseURL: string): string | undefined {
    const credential = this.read()[providerId];
    return credential && normalizeBaseURL(credential.baseURL) === normalizeBaseURL(baseURL) ? credential.apiKey : undefined;
  }

  /** 保存或替换一个服务的密钥；无效地址或空密钥不会覆盖现有凭据。 */
  saveApiKey(providerId: string, baseURL: string, apiKey: string): void {
    const credential: ApiCredential = { baseURL: normalizeBaseURL(baseURL), apiKey: apiKey.trim() };
    if (!credential.apiKey) throw new Error("API Key 不能为空。");
    this.write({ ...this.read(), [providerId]: credential });
  }

  /** 只保留仍存在的服务的密钥，删除服务时一并删除它的密钥。 */
  retain(providerIds: string[]): void {
    const credentials = this.read();
    const kept = Object.fromEntries(Object.entries(credentials).filter(([id]) => providerIds.includes(id)));
    if (Object.keys(kept).length !== Object.keys(credentials).length) this.write(kept);
  }

  /** 读取全部凭据；旧版文件只有一组 { baseURL, apiKey }，视为数据库升级时生成的 default 服务的密钥。 */
  private read(): ApiCredentials {
    let content: string;
    try {
      content = readFileSync(this.path, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
      throw error;
    }
    let value: unknown;
    try {
      value = JSON.parse(content);
    } catch {
      throw new Error("凭据文件不是有效的 JSON。");
    }
    if (isCredential(value)) return { default: value };
    if (!value || typeof value !== "object" || Array.isArray(value) || !Object.values(value).every(isCredential)) {
      throw new Error("凭据文件格式不正确。");
    }
    return value as ApiCredentials;
  }

  /** 原子替换凭据文件：先写临时文件再重命名，写入中途失败不会留下半个文件。 */
  private write(credentials: ApiCredentials): void {
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
}

/** 校验并规范化服务地址，用于配置检查和凭据的精确匹配，保留路径前缀差异。 */
export function normalizeBaseURL(baseURL: string): string {
  const url = new URL(baseURL);
  if ((url.protocol !== "http:" && url.protocol !== "https:") || url.username || url.password || url.search || url.hash) {
    throw new Error("模型服务地址必须使用 HTTP/HTTPS，且不能包含凭据、查询参数或片段。");
  }
  return url.href;
}
