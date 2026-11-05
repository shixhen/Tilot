import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

/** 独立协议服务：测试走真实子进程或 HTTP，不替换 MCP 客户端。 */
export function fixture() {
  const calls = [];
  const resources = [];
  const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=";
  const cancelled = [];
  const cancellation = Promise.withResolvers();
  let revision = "1";
  let capabilities = { tools: {} };
  async function handle(request) {
    const { id, method, params } = request;
    if (method === "notifications/cancelled") { cancelled.push(params.requestId); cancellation.resolve(); }
    if (id === undefined) return null;
    const respond = (result) => ({ jsonrpc: "2.0", id, result });
    if (method === "initialize") return respond({ protocolVersion: "2025-11-25", capabilities, serverInfo: { name: "tilot-fixture", version: "1" } });
    if (method === "tools/list") return respond({ tools: [{ name: "inspect", description: `检查 ${revision}`, inputSchema: { type: "object", properties: { kind: { type: "string" }, value: { type: "string" }, delay: { type: "number" } } } }] });
    if (method === "resources/read") {
      resources.push(params.uri);
      if (params.uri === "fixture://good.png") return respond({ contents: [{ uri: params.uri, mimeType: "image/png", blob: png }] });
      return { jsonrpc: "2.0", id, error: { code: -32002, message: "图片资源丢失" } };
    }
    if (method === "tools/call" && params.name === "inspect") {
      calls.push(params.arguments);
      const args = params.arguments ?? {};
      if (args.kind === "wait") await new Promise((resolve) => setTimeout(resolve, args.delay ?? 100));
      if (args.kind === "structured") return respond({ content: [{ type: "text", text: '{"value":"中文"}' }], structuredContent: { value: "中文" } });
      if (args.kind === "image") return respond({ content: [{ type: "image", data: "aGVsbG8=", mimeType: "image/png" }] });
      if (args.kind === "pictures") return respond({ content: [
        { type: "text", text: "远端操作已经完成" },
        { type: "image", data: png, mimeType: "image/png" },
        { type: "resource", resource: { uri: "fixture://embedded.png", mimeType: "image/png", blob: png } },
        { type: "resource_link", uri: "fixture://good.png", name: "资源图片", mimeType: "image/png" },
        { type: "resource_link", uri: "fixture://missing.png", name: "丢失图片", mimeType: "image/png" },
      ], structuredContent: { actual: "已完成", sideEffects: true } });
      return respond({ content: [{ type: "text", text: args.kind === "long" ? "长行🙂".repeat(18000) : args.kind === "fail" ? "远端执行失败" : JSON.stringify({ pid: process.pid, cwd: process.cwd(), value: args.value, version: process.env.TILOT_MCP_VERSION }) }], ...(args.kind === "fail" ? { isError: true } : {}) });
    }
    return { jsonrpc: "2.0", id, error: { code: -32601, message: "Method not found" } };
  }
  return { handle, calls, resources, cancelled, cancellation: cancellation.promise, setRevision(value) { revision = value; }, setCapabilities(value) { capabilities = value; } };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const server = fixture();
  createInterface({ input: process.stdin }).on("line", async (line) => {
    const response = await server.handle(JSON.parse(line));
    if (response) process.stdout.write(JSON.stringify(response) + "\n");
  });
}
