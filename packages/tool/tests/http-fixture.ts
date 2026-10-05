import assert from "node:assert/strict";
import http, { type IncomingMessage, type RequestOptions, type ServerResponse } from "node:http";
import https from "node:https";
import type { TestContext } from "node:test";

/** 保留真实 HTTP 流、压缩和断连，将测试 URL 转到隔离的本地服务。 */
export async function httpFixture(context: TestContext, handle: (request: IncomingMessage, response: ServerResponse) => void) {
  // 单元测试不受开发机真实代理影响；代理行为另用真实代理服务验证。
  context.mock.property(process, "env", { ...process.env, HTTP_PROXY: "", HTTPS_PROXY: "", ALL_PROXY: "", http_proxy: "", https_proxy: "", all_proxy: "", NO_PROXY: "*", no_proxy: "*" });
  const server = http.createServer(handle);
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  context.after(async () => { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); });
  const port = (server.address() as { port: number }).port;
  const calls: { url: string }[] = [];
  const originalRequest = http.request.bind(http);
  const request = (url: URL, options: RequestOptions, callback: (response: IncomingMessage) => void) => {
    assert.equal(options.agent, false);
    assert.equal(options.lookup, undefined);
    calls.push({ url: url.href });
    return originalRequest(new URL(url.pathname + url.search, `http://127.0.0.1:${port}`), {
      ...options, headers: { ...options.headers, host: url.host },
    }, callback);
  };
  context.mock.method(http, "request", request);
  context.mock.method(https, "request", request);
  return { calls };
}
