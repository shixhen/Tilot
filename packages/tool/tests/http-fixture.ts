import assert from "node:assert/strict";
import dns from "node:dns/promises";
import http, { type IncomingMessage, type RequestOptions, type ServerResponse } from "node:http";
import https from "node:https";
import type { TestContext } from "node:test";

/** 保留真实 HTTP 流、压缩和断连，只把已验证的公开目标转到隔离的本地测试服务。 */
export async function httpFixture(context: TestContext, handle: (request: IncomingMessage, response: ServerResponse) => void) {
  // 单元测试不受开发机真实代理影响；代理行为另用真实代理服务验证。
  context.mock.property(process, "env", { ...process.env, HTTP_PROXY: "", HTTPS_PROXY: "", ALL_PROXY: "", http_proxy: "", https_proxy: "", all_proxy: "", NO_PROXY: "*", no_proxy: "*" });
  const server = http.createServer(handle);
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  context.after(async () => { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); });
  const port = (server.address() as { port: number }).port;
  const calls: { url: string; pinned: string }[] = [];
  context.mock.method(dns, "lookup", async () => [{ address: "8.8.8.8", family: 4 }]);
  const originalRequest = http.request.bind(http);
  const request = (url: URL, options: RequestOptions, callback: (response: IncomingMessage) => void) => {
    assert.equal(options.agent, false);
    let pinned = "";
    options.lookup!(url.hostname, { family: options.family }, (_error, address) => { pinned = typeof address === "string" ? address : address[0]!.address; });
    assert.ok(pinned);
    calls.push({ url: url.href, pinned });
    const { lookup: _lookup, family: _family, ...localOptions } = options;
    return originalRequest(new URL(url.pathname + url.search, `http://127.0.0.1:${port}`), {
      ...localOptions, headers: { ...options.headers, host: url.host },
    }, callback);
  };
  context.mock.method(http, "request", request);
  context.mock.method(https, "request", request);
  return { calls };
}
