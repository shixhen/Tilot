import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import { Client, SdkHttpError, StreamableHTTPClientTransport, type Tool as McpTool } from "@modelcontextprotocol/client";
import { StdioClientTransport, getDefaultEnvironment } from "@modelcontextprotocol/client/stdio";
import { loadMcpConfig, type McpServerConfig } from "./mcp-config.ts";
import { MAX_OUTPUT_BYTES } from "./text.ts";
import { ImageToolResult, ToolFailure, type Tool, type ToolHost } from "./tool.ts";
import { mcpImageContent } from "./mcp-images.ts";

interface Connection { client: Client; ready: Promise<void>; references: number; closed: boolean }
export interface McpSnapshot { tools: Tool[]; warnings: string[]; release: () => Promise<void> }

/** 名称在模型限制内保持稳定；有歧义的分隔符、特殊字符及过长名称用原名摘要区分。 */
export function mcpToolName(server: string, tool: string): string {
  const name = `mcp__${server}__${tool}`;
  if (/^[A-Za-z0-9_-]{1,64}$/.test(name) && !server.includes("__") && !tool.includes("__") &&
      !server.endsWith("_") && !tool.startsWith("_")) return name;
  const hash = createHash("sha256").update(JSON.stringify([server, tool])).digest("hex").slice(0, 12);
  return `${name.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 51)}_${hash}`;
}

/** 停止一个等待者不会关闭共享连接，也不会取消其他对话的请求。 */
async function waitFor<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  signal?.throwIfAborted();
  if (!signal) return promise;
  let cancel!: () => void;
  try {
    return await Promise.race([promise, new Promise<never>((_resolve, reject) => {
      cancel = () => reject(signal.reason);
      signal.addEventListener("abort", cancel, { once: true });
    })]);
  } finally { signal.removeEventListener("abort", cancel); }
}

function safeError(error: unknown, config: McpServerConfig): string {
  let message = error instanceof Error ? error.message : "MCP 请求失败。";
  const secrets = [...Object.values(config.env), ...Object.values(config.headers), ...Object.values(config.headers).map((value) => value.replace(/^Bearer\s+/i, ""))];
  for (const secret of secrets) if (secret) message = message.split(secret).join("[已隐藏]");
  return message.slice(0, 1000);
}

/** 明确失效的 HTTP 会话在下一轮重新初始化，当前调用不重试。 */
async function closeExpiredSession(client: Client, error: unknown): Promise<void> {
  if (error instanceof SdkHttpError && error.status === 404) await client.close();
}

/** 宿主共用连接；每轮单独冻结声明和配置，旧配置等最后一个使用者结束后关闭。 */
export class McpManager {
  private readonly path: string;
  private readonly connections = new Map<string, Connection>();
  private desired = new Set<string>();
  private readonly shutdown = new AbortController();

  constructor(path = join(homedir(), ".tilot", "mcp.json")) { this.path = path; }

  async snapshot(host: ToolHost, signal?: AbortSignal): Promise<McpSnapshot> {
    signal?.throwIfAborted();
    this.shutdown.signal.throwIfAborted();
    const { servers, warnings } = await loadMcpConfig(this.path);
    signal?.throwIfAborted();
    this.shutdown.signal.throwIfAborted();
    const entries = servers.map((config) => ({ config, key: createHash("sha256").update(JSON.stringify(config)).digest("hex") }));
    this.desired = new Set(entries.map((entry) => entry.key));
    const held: Connection[] = [];
    let released = false;
    const release = async () => {
      if (released) return;
      released = true;
      for (const connection of held) connection.references--;
      await this.prune();
    };
    try {
      const groups = await Promise.all(entries.map(async ({ config, key }) => {
        let connection = this.connections.get(key);
        if (!connection || connection.closed) {
          const client = new Client({ name: "Tilot", version: "0.1.0" }, { versionNegotiation: { mode: "auto", probe: { timeoutMs: 3000 } } });
          connection = { client, ready: Promise.resolve(), references: 0, closed: false };
          const entry = connection;
          client.onclose = () => { entry.closed = true; };
          const transport = config.command !== undefined
            ? new StdioClientTransport({ command: config.command, args: config.args, env: { ...getDefaultEnvironment(), ...config.env }, cwd: homedir(), stderr: "ignore" })
            : new StreamableHTTPClientTransport(new URL(config.url!), { requestInit: { headers: config.headers },
              reconnectionOptions: { maxRetries: 0, initialReconnectionDelay: 1000, maxReconnectionDelay: 1000, reconnectionDelayGrowFactor: 1 } });
          connection.ready = client.connect(transport, { signal: this.shutdown.signal, timeout: 30_000 }).catch(async (error) => {
            entry.closed = true;
            await client.close();
            throw error;
          });
          this.connections.set(key, connection);
        }
        connection.references++;
        held.push(connection);
        try {
          await waitFor(connection.ready, signal);
          signal?.throwIfAborted();
          if (connection.closed) throw new Error("连接已关闭；下一轮会重新连接。");
          // SDK 对不提供 tools 的服务会打印调试信息；stdout 只用于宿主 JSON Lines 协议。
          if (!connection.client.getServerCapabilities()?.tools) return [];
          const { tools } = await connection.client.listTools({}, { ...(signal ? { signal } : {}), timeout: 30_000, cacheMode: "bypass" });
          const client = connection.client;
          return tools.sort((a, b) => a.name.localeCompare(b.name)).map((tool) => this.tool(client, config, tool, host));
        } catch (error) {
          signal?.throwIfAborted();
          await closeExpiredSession(connection.client, error);
          warnings.push(`MCP ${config.name}：${safeError(error, config)}`);
          return [];
        }
      }));
      const tools: Tool[] = [];
      const names = new Set<string>();
      for (const tool of groups.flat()) {
        if (names.has(tool.definition.name)) { warnings.push(`MCP 工具名称冲突：${tool.definition.name}，已跳过重复项。`); continue; }
        names.add(tool.definition.name);
        tools.push(tool);
      }
      await this.prune();
      return { tools, warnings, release };
    } catch (error) { await release(); throw error; }
  }

  async close(): Promise<void> {
    this.shutdown.abort();
    await Promise.all([...this.connections.values()].map((connection) => connection.client.close()));
    this.connections.clear();
  }

  private async prune(): Promise<void> {
    await Promise.all([...this.connections].map(async ([key, connection]) => {
      if (connection.references || (!connection.closed && this.desired.has(key))) return;
      this.connections.delete(key);
      await connection.client.close();
    }));
  }

  private tool(client: Client, config: McpServerConfig, tool: McpTool, host: ToolHost): Tool {
    return {
      access: "mcp",
      definition: { type: "function", name: mcpToolName(config.name, tool.name), description: tool.description ?? `${config.name} / ${tool.name}`, parameters: tool.inputSchema, strict: false },
      async execute(args, signal, execution) {
        const deadline = AbortSignal.timeout(config.timeoutMs);
        signal = signal ? AbortSignal.any([signal, deadline]) : deadline;
        let result;
        try { result = await client.callTool({ name: tool.name, arguments: args }, { ...(signal ? { signal } : {}), timeout: config.timeoutMs, maxTotalTimeout: config.timeoutMs, toolDefinition: tool }); }
        catch (error) {
          signal?.throwIfAborted();
          await closeExpiredSession(client, error);
          throw new Error(safeError(error, config));
        }
        const { parts, images } = host.images
          ? await mcpImageContent(client, result.content, host, config.timeoutMs, signal, (error) => safeError(error, config))
          : { parts: result.content.map((block) => block.type === "text" ? block.text : `[暂不支持 MCP 返回的 ${block.type} 内容]`), images: [] };
        if (result.structuredContent !== undefined) {
          const structured = JSON.stringify(result.structuredContent, null, 2);
          const duplicate = parts.some((text) => { try { return JSON.stringify(JSON.parse(text)) === JSON.stringify(result.structuredContent); } catch { return false; } });
          if (!duplicate) parts.push(structured);
        }
        const full = parts.join("\n\n");
        const bytes = Buffer.from(full, "utf8");
        let end = Math.min(bytes.length, MAX_OUTPUT_BYTES);
        while (end < bytes.length && end > 0 && (bytes[end]! & 0xc0) === 0x80) end--;
        const data: Record<string, unknown> = { output: bytes.subarray(0, end).toString("utf8") };
        if (end < bytes.length) {
          data.outputTruncated = true;
          let log;
          const saveError = (error: unknown) => { data.logError ??= `输出缓存保存失败，远端调用已经结束，请勿据此重跑：${safeError(error, config)}`; };
          try {
            log = await host.outputs.create(host.threadId, execution?.executionId, undefined, "mcp");
            await log.append(full);
            Object.assign(data, await log.finish(), { nextByteOffset: end });
          } catch (error) { saveError(error); }
          finally { try { await log?.discard(); } catch (error) { saveError(error); } }
        }
        const output = images.length ? new ImageToolResult(data, images) : data;
        if (result.isError) throw new ToolFailure(String(data.output) || "MCP 工具返回执行失败。", output);
        return output;
      },
    };
  }
}
