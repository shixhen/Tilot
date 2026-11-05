import { readFile } from "node:fs/promises";

export interface McpServerConfig {
  name: string;
  timeoutMs: number;
  command?: string;
  args: string[];
  env: Record<string, string>;
  url?: string;
  headers: Record<string, string>;
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("必须是 JSON 对象。");
  return value as Record<string, unknown>;
}

function expand(value: string): string {
  return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_match, name: string) => {
    const resolved = process.env[name];
    if (resolved === undefined) throw new Error(`环境变量 ${name} 未设置。`);
    return resolved;
  });
}

function strings(value: unknown): Record<string, string> {
  return Object.fromEntries(Object.entries(object(value ?? {})).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => {
    if (typeof item !== "string") throw new Error("env 和 headers 的值必须是字符串。");
    return [key, expand(item)];
  }));
}

/** 只读取用户明确填写的全局配置；单个服务配置错误不影响其他服务。 */
export async function loadMcpConfig(path: string): Promise<{ servers: McpServerConfig[]; warnings: string[] }> {
  let content: string;
  try { content = await readFile(path, "utf8"); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { servers: [], warnings: [] };
    return { servers: [], warnings: ["无法读取 ~/.tilot/mcp.json，请检查文件权限。"] };
  }
  let entries: Record<string, unknown>;
  try {
    const config = object(JSON.parse(content.replace(/^\uFEFF/, "")));
    if (Object.keys(config).some((key) => key !== "mcpServers")) throw new Error();
    entries = object(config.mcpServers);
  } catch { return { servers: [], warnings: ["~/.tilot/mcp.json 格式无效，需要包含 mcpServers 对象。"] }; }
  const servers: McpServerConfig[] = [];
  const warnings: string[] = [];
  for (const [name, value] of Object.entries(entries).sort(([a], [b]) => a.localeCompare(b))) {
    try {
      if (!name.trim()) throw new Error("服务名不能为空。");
      const input = object(value);
      if (Object.keys(input).some((key) => !["command", "args", "env", "url", "headers", "timeoutMs", "enabled"].includes(key))) throw new Error("配置包含不支持的字段。");
      if (input.enabled !== undefined && typeof input.enabled !== "boolean") throw new Error("enabled 必须是布尔值。");
      if (input.enabled === false) continue;
      if ((input.command === undefined) === (input.url === undefined)) throw new Error("command 与 url 必须恰好指定一个。");
      const timeoutMs = input.timeoutMs ?? 120_000;
      if (!Number.isSafeInteger(timeoutMs) || Number(timeoutMs) <= 0 || Number(timeoutMs) > 2_147_483_647) throw new Error("timeoutMs 必须是有效的正整数毫秒数。");
      const config: McpServerConfig = { name, timeoutMs: Number(timeoutMs), args: [], env: {}, headers: {} };
      if (input.command !== undefined) {
        if (typeof input.command !== "string" || !input.command.trim()) throw new Error("command 必须是非空字符串。");
        if (input.args !== undefined && (!Array.isArray(input.args) || !input.args.every((arg) => typeof arg === "string"))) throw new Error("args 必须是字符串数组。");
        if (input.headers !== undefined) throw new Error("本地服务不支持 headers。");
        config.command = expand(input.command);
        config.args = ((input.args as string[] | undefined) ?? []).map(expand);
        config.env = strings(input.env);
      } else {
        if (typeof input.url !== "string") throw new Error("url 必须是 HTTP 或 HTTPS 网址。");
        let url: URL;
        try { url = new URL(expand(input.url)); } catch { throw new Error("url 必须是有效网址。"); }
        if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.hash) throw new Error("url 必须使用 HTTP/HTTPS，且不能包含用户信息或片段。");
        if (input.args !== undefined || input.env !== undefined) throw new Error("远程服务不支持 args/env，请使用 headers。");
        config.url = url.href;
        config.headers = strings(input.headers);
        try { new Headers(config.headers); } catch { throw new Error("headers 包含无效的名称或值。"); }
      }
      servers.push(config);
    } catch (error) { warnings.push(`MCP ${name}：${error instanceof Error ? error.message : "配置无效。"}`); }
  }
  return { servers, warnings };
}
