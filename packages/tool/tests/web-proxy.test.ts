import assert from "node:assert/strict";
import dns from "node:dns/promises";
import http from "node:http";
import { once } from "node:events";
import type { Socket } from "node:net";
import { test, type TestContext } from "node:test";
import { OutputCache, webFetch } from "../src/index.ts";
import { temporaryDirectory } from "./helpers.ts";

/** 每次测试使用本地真实代理；不继承开发机的代理或绕过规则。 */
async function proxyServer(context: TestContext, server: http.Server) {
  const sockets = new Set<Socket>();
  server.on("connection", (socket) => { sockets.add(socket); socket.once("close", () => sockets.delete(socket)); });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  context.after(async () => { for (const socket of sockets) socket.destroy(); await new Promise<void>((resolve) => server.close(() => resolve())); });
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  context.mock.property(process, "env", { ...process.env, HTTP_PROXY: url, HTTPS_PROXY: url, ALL_PROXY: "", http_proxy: "", https_proxy: "", all_proxy: "", NO_PROXY: "", no_proxy: "" });
  context.mock.method(dns, "lookup", async () => { throw new Error("代理目标不应使用本机 Fake-IP DNS"); });
  return url;
}

test("环境代理读取匿名网页并处理重定向，代理凭据只交给代理，NO_PROXY 改为直连检查", async (context) => {
  const calls: string[] = [];
  const server = http.createServer((request, response) => {
    calls.push(request.url!);
    assert.equal(request.headers["proxy-authorization"], `Basic ${Buffer.from("proxy-user:proxy-pass").toString("base64")}`);
    assert.equal(request.headers.authorization, undefined);
    assert.equal(request.headers.cookie, undefined);
    if (request.url!.endsWith("/start")) response.writeHead(302, { location: "http://other.example/page" });
    else if (request.url!.endsWith("/private")) response.writeHead(302, { location: "http://127.0.0.1/secret" });
    else { response.writeHead(200, { "content-type": "text/plain" }); response.write("代理正文"); }
    response.end();
  });
  const proxy = await proxyServer(context, server);
  process.env.http_proxy = proxy.replace("http://", "http://proxy-user:proxy-pass@");
  process.env.HTTP_PROXY = "http://127.0.0.1:1"; // 小写环境变量优先。
  const host = { outputs: new OutputCache(await temporaryDirectory(context)), threadId: "web" };
  const result = await webFetch(host, { url: "http://public.example/start" });
  assert.equal(result.content, "代理正文");
  assert.equal(result.finalUrl, "http://other.example/page");
  assert.deepEqual(calls, ["http://public.example/start", "http://other.example/page"]);
  assert.equal((await webFetch(host, { outputId: result.outputId })).content, result.content);
  await assert.rejects(webFetch(host, { url: "http://public.example/private" }), /公开地址/);
  for (const url of ["http://localhost", "http://printer.local", "http://metadata.google.internal", "http://198.18.0.1"]) await assert.rejects(webFetch(host, { url }), /公开地址/);
  assert.equal(calls.length, 3);
  process.env.no_proxy = "public.example";
  context.mock.method(dns, "lookup", async () => [{ address: "198.18.0.1", family: 4 }]);
  await assert.rejects(webFetch(host, { url: "http://public.example/start" }), /公开地址/);
  assert.equal(calls.length, 3);
  process.env.no_proxy = ""; process.env.http_proxy = "socks5://127.0.0.1:1080";
  await assert.rejects(webFetch(host, { url: "http://public.example" }), /HTTP\/HTTPS/);
});

test("HTTPS 经代理发送 CONNECT，拒绝响应明确失败且不保存正文或泄漏代理密钥", async (context) => {
  const server = http.createServer();
  const proxy = await proxyServer(context, server);
  process.env.https_proxy = proxy.replace("http://", "http://proxy-user:proxy-pass@");
  let connected = false;
  server.on("connect", (request, socket) => {
    connected = true;
    assert.equal(request.url, "public.example:443");
    assert.equal(request.headers.authorization, undefined);
    assert.equal(request.headers["proxy-authorization"], `Basic ${Buffer.from("proxy-user:proxy-pass").toString("base64")}`);
    socket.end("HTTP/1.1 407 Proxy Authentication Required\r\nContent-Length: 0\r\n\r\n");
  });
  const host = { outputs: new OutputCache(await temporaryDirectory(context)), threadId: "web" };
  await assert.rejects(webFetch(host, { url: "https://public.example/page" }), (error: Error) => {
    assert.match(error.message, /407/);
    assert.doesNotMatch(error.message, /proxy-user|proxy-pass/);
    return true;
  });
  assert.equal(connected, true);
});

test("取消 HTTPS 代理建连会关闭尚未登记到 Agent 的 CONNECT 连接", { timeout: 5000 }, async (context) => {
  const server = http.createServer();
  await proxyServer(context, server);
  const controller = new AbortController();
  const closed = new Promise<void>((resolve) => server.on("connect", (_request, socket) => {
    socket.once("close", resolve);
    socket.once("end", () => socket.end());
    socket.resume();
    controller.abort();
  }));
  const host = { outputs: new OutputCache(await temporaryDirectory(context)), threadId: "web" };
  await assert.rejects(webFetch(host, { url: "https://public.example/page" }, controller.signal), { name: "AbortError" });
  await closed;
});
