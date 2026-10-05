import assert from "node:assert/strict";
import dns from "node:dns";
import http from "node:http";
import { once } from "node:events";
import { randomBytes } from "node:crypto";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { brotliCompressSync, deflateSync, gzipSync } from "node:zlib";
import { createToolSet, OutputCache, readOutputLog, webFetch } from "../src/index.ts";
import { fetchHttpText, parseFetchUrl } from "../src/web-http.ts";
import { htmlToMarkdown } from "../src/web-markdown.ts";
import { temporaryDirectory } from "./helpers.ts";
import { httpFixture } from "./http-fixture.ts";

test("匿名抓取重定向后的 HTML，保留来源、标题与 Markdown，分页和重开不重新联网", async (context) => {
  let version = "原正文";
  const fixture = await httpFixture(context, (request, response) => {
    assert.equal(request.headers.cookie, undefined);
    assert.equal(request.headers.authorization, undefined);
    assert.equal(request.headers["x-api-key"], undefined);
    assert.equal(request.headers.host, request.url === "/start" ? "first.example" : "second.example");
    if (request.url === "/start") { response.writeHead(302, { location: "https://second.example/docs/page" }); response.end(); return; }
    response.writeHead(200, { "content-type": "text/html; charset=utf-8", "content-encoding": "gzip" });
    response.end(gzipSync(`<html><head><title>标题 &amp; 中文</title></head><body><h1>你好</h1><p>${version}</p><a href="../guide">来源</a><img src="/never-requested" alt="图片说明"><script>throw new Error('不执行');</script></body></html>`));
  });
  const data = await temporaryDirectory(context);
  const host = { outputs: new OutputCache(data), threadId: "web" };
  const first = await webFetch(host, { url: "http://first.example/start#unused", limit: 2 });
  assert.equal(first.url, "http://first.example/start");
  assert.equal(first.finalUrl, "https://second.example/docs/page");
  assert.equal(first.title, "标题 & 中文");
  assert.ok(first.fetchedAt > 0);
  assert.ok("nextOffset" in first && first.nextOffset !== null);
  assert.equal(fixture.calls.length, 2);
  version = "变化后的正文";
  const next = await webFetch({ ...host, outputs: new OutputCache(data) }, { outputId: first.outputId, offset: first.nextOffset! });
  assert.equal(first.fetchedAt, next.fetchedAt);
  assert.match(first.content + next.content, /原正文/);
  assert.match(next.content, /\[来源\]\(https:\/\/second.example\/guide\)/);
  assert.match(next.content, /图片说明/);
  assert.doesNotMatch(next.content, /变化|不执行|never-requested|<script>/);
  assert.equal(fixture.calls.length, 2);
});

test("URL 保留 HTTP(S) 与凭据校验，允许本机、私网、Fake-IP 和本地域名", async (context) => {
  const fixture = await httpFixture(context, (_request, response) => { response.writeHead(200, { "content-type": "text/plain" }); response.end("ok"); });
  for (const url of ["file:///etc/passwd", "ftp://example.com", "https://user:pass@example.com", "https://example.com/a b", "http://example.com/\n", "bad", "https://example.com/" + "x".repeat(4096), "https://example.com/" + "中".repeat(500)]) assert.throws(() => parseFetchUrl(url));
  const urls = ["http://127.1", "http://2130706433", "http://0x7f000001", "http://[::1]", "http://[::ffff:127.0.0.1]", "http://192.168.1.1", "http://10.0.0.1", "http://198.18.0.54", "http://localhost", "http://printer.local", "http://metadata.google.internal", "http://printer"];
  for (const url of urls) assert.equal((await fetchHttpText(url, new AbortController().signal)).content, "ok");
  assert.equal(fixture.calls.length, urls.length);
});

test("真实本机网页和重定向可读取，域名解析交给 Node 网络层", async (context) => {
  context.mock.property(process, "env", { ...process.env, HTTP_PROXY: "", HTTPS_PROXY: "", ALL_PROXY: "", http_proxy: "", https_proxy: "", all_proxy: "", NO_PROXY: "*", no_proxy: "*" });
  const server = http.createServer((request, response) => {
    if (request.url === "/start") response.writeHead(302, { location: `http://local.example:${port}/page` });
    else { assert.equal(request.headers.host, `local.example:${port}`); response.writeHead(200, { "content-type": "text/plain" }); response.write("本机正文"); }
    response.end();
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  context.after(async () => { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); });
  const port = (server.address() as { port: number }).port;
  const lookup = context.mock.method(dns, "lookup", (host: string, options: dns.LookupOptions, callback: (error: null, address: dns.LookupAddress[] | string, family?: number) => void) => {
    assert.equal(host, "local.example");
    callback(null, options.all ? [{ address: "127.0.0.1", family: 4 }] : "127.0.0.1", 4);
  });
  const result = await fetchHttpText(`http://127.0.0.1:${port}/start`, new AbortController().signal);
  assert.equal(result.content, "本机正文");
  assert.equal(result.finalUrl, `http://local.example:${port}/page`);
  assert.equal(lookup.mock.callCount(), 1);
});

test("每跳重定向检查协议与凭据，缺少 Location、循环、HTTP 错误和不支持内容明确失败", async (context) => {
  const fixture = await httpFixture(context, (request, response) => {
    if (request.url === "/file") response.writeHead(302, { location: "file:///secret" });
    else if (request.url === "/credential") response.writeHead(302, { location: "https://user:pass@example.com" });
    else if (request.url === "/missing") response.writeHead(302);
    else if (request.url === "/loop") response.writeHead(302, { location: "/loop" });
    else if (request.url?.startsWith("/status/")) response.writeHead(Number(request.url.split("/").at(-1)));
    else response.writeHead(200, { "content-type": "application/pdf" });
    response.end();
  });
  const host = { outputs: new OutputCache(await temporaryDirectory(context)), threadId: "web" };
  for (const [path, error] of [["file", /HTTP\(S\)/], ["credential", /用户名或密码/], ["missing", /Location/], ["loop", /5 次/], ["pdf", /内容类型/]] as const) await assert.rejects(webFetch(host, { url: `https://public.example/${path}` }), error);
  for (const status of [401, 403, 404, 429, 503]) await assert.rejects(webFetch(host, { url: `https://public.example/status/${status}` }), new RegExp(`HTTP ${status}`));
  assert.ok(!fixture.calls.some((call) => call.url.includes("file:") || call.url.includes("user:pass")));
  assert.equal(fixture.calls.filter((call) => call.url.endsWith("/loop")).length, 6);
});

test("gzip/deflate/br 与声明编码可读取，编码错误、压缩错误及下载/解压超限不保存正文", async (context) => {
  const fixture = await httpFixture(context, (request, response) => {
    const mode = request.url!.split("/").at(-1)!;
    let content = Buffer.from("中文🙂\r\ntext", "utf8");
    const headers: Record<string, string> = { "content-type": "text/plain; charset=utf-8" };
    if (mode === "gbk") { headers["content-type"] = "text/plain; charset=gb18030"; content = Buffer.from([0xc4, 0xe3, 0xba, 0xc3]); }
    if (mode === "invalid") content = Buffer.from([0xff]);
    if (mode === "charset") headers["content-type"] = "text/plain; charset=no-such-encoding";
    if (mode === "declared") headers["content-length"] = String(3 * 1024 * 1024);
    if (mode === "streamed") content = Buffer.alloc(3 * 1024 * 1024, 0x61);
    if (mode === "bomb") { headers["content-encoding"] = "gzip"; content = gzipSync(Buffer.alloc(3 * 1024 * 1024, 0x61)); }
    if (mode === "wire") { headers["content-encoding"] = "gzip"; content = gzipSync(randomBytes(2 * 1024 * 1024 + 100)); }
    if (mode === "gzip") { headers["content-encoding"] = "gzip"; content = gzipSync(content); }
    if (mode === "deflate") { headers["content-encoding"] = "deflate"; content = deflateSync(content); }
    if (mode === "br") { headers["content-encoding"] = "br"; content = brotliCompressSync(content); }
    if (mode === "broken") headers["content-encoding"] = "gzip";
    if (mode === "markdown") { headers["content-type"] = "text/html"; content = Buffer.from('<a href="next">链接</a>'.repeat(1000), "utf8"); }
    response.writeHead(200, headers);
    response.write(mode === "declared" ? "" : content); response.end();
  });
  const data = await temporaryDirectory(context);
  const host = { outputs: new OutputCache(data), threadId: "web" };
  for (const [path, error] of [["invalid", /字符编码/], ["charset", /字符编码/], ["declared", /2 MiB/], ["streamed", /2 MiB/], ["bomb", /解压.*2 MiB/], ["wire", /下载.*2 MiB/], ["broken", /header|压缩|incorrect/]] as const) await assert.rejects(webFetch(host, { url: `http://public.example/${path}` }), error);
  await assert.rejects(webFetch(host, { url: `http://public.example/${"x".repeat(3500)}/markdown` }), /转换.*2 MiB/);
  assert.deepEqual(await readdir(data), []);
  for (const mode of ["gzip", "deflate", "br"]) assert.equal((await webFetch(host, { url: `http://public.example/${mode}` })).content, "中文🙂\r\ntext");
  assert.equal((await webFetch(host, { url: "http://public.example/gbk" })).content, "你好");
  assert.ok(fixture.calls.length > 0);
});

test("网页长行按字符边界续读完整内容，缓存按任务、类型和过期隔离，旧日志仍可读", async (context) => {
  const body = "前文\n" + "中文🙂".repeat(15000) + "\r\n尾行";
  const fixture = await httpFixture(context, (_request, response) => { response.writeHead(200, { "content-type": "text/plain" }); response.end(body); });
  const data = await temporaryDirectory(context);
  const host = { outputs: new OutputCache(data), threadId: "web" };
  const first = await webFetch(host, { url: "https://public.example", limit: 1 });
  const long = await webFetch(host, { outputId: first.outputId, offset: 2 });
  assert.ok("partialLine" in long && long.partialLine);
  let content = first.content + long.content;
  let byteOffset: number | undefined = long.nextByteOffset;
  while (byteOffset !== undefined) {
    const page = await webFetch(host, { outputId: first.outputId, byteOffset });
    assert.ok("nextByteOffset" in page && "byteOffset" in page);
    assert.ok(Buffer.byteLength(page.content) <= 50 * 1024);
    assert.ok(!page.content.includes("\ufffd"));
    content += page.content;
    byteOffset = page.nextByteOffset ?? undefined;
  }
  assert.equal(content, body);
  assert.equal(fixture.calls.length, 1);
  await assert.rejects(webFetch(host, { outputId: first.outputId, byteOffset: 1 }), /UTF-8/);
  await assert.rejects(webFetch({ ...host, threadId: "another" }, { outputId: first.outputId }), /其他任务/);
  await assert.rejects(readOutputLog(host, { outputId: first.outputId }), /过期或不存在/);
  const log = await host.outputs.create(host.threadId); await log.append("旧日志"); await log.finish();
  await assert.rejects(webFetch(host, { outputId: log.outputId }), /网页正文/);
  const logPath = join(data, "outputs", `${log.outputId}.json`);
  const legacy = JSON.parse(await readFile(logPath, "utf8")); delete legacy.kind;
  await writeFile(logPath, JSON.stringify(legacy), "utf8");
  assert.equal((await readOutputLog(host, { outputId: log.outputId })).content, "旧日志");
  const path = join(data, "outputs", `${first.outputId}.json`);
  const metadata = JSON.parse(await readFile(path, "utf8")); metadata.finishedAt = 0;
  await writeFile(path, JSON.stringify(metadata), "utf8");
  await assert.rejects(webFetch(host, { outputId: first.outputId }), /过期/);
});

test("网页声明与参数在两种任务共用，非法参数和预先取消不发请求", async (context) => {
  const fixture = await httpFixture(context, (_request, response) => { response.writeHead(200, { "content-type": "application/json" }); response.end('{"text":"<script>"}'); });
  const host = { outputs: new OutputCache(await temporaryDirectory(context)), threadId: "web" };
  const tools = createToolSet(undefined, host);
  assert.deepEqual(tools.definitions.map((tool) => tool.name), ["web_fetch"]);
  for (const args of [{}, { url: null }, { url: "https://public.example", outputId: "x" }, { url: "https://public.example", limit: null },
    { url: "https://public.example", offset: 0 }, { url: "https://public.example", limit: 2001 }, { url: "https://public.example", byteOffset: 0 },
    { outputId: "x", byteOffset: 0, limit: 1 }, { outputId: "x", byteOffset: -1 }, { outputId: 1 }, { url: "https://public.example", extra: true }]) assert.equal(JSON.parse(await tools.execute("web_fetch", JSON.stringify(args))).status, "error");
  assert.equal(JSON.parse(await tools.execute("web_fetch", '{"url":"https://public.example"}', AbortSignal.abort())).status, "cancelled");
  assert.equal(fixture.calls.length, 0);
  const result = JSON.parse(await tools.execute("web_fetch", '{"url":"https://public.example"}'));
  assert.equal(result.data.content, '{"text":"<script>"}');
});

test("取消中止 HTTP 流并关闭连接，不保存部分网页", async (context) => {
  const controller = new AbortController();
  let closed!: Promise<void>;
  await httpFixture(context, (request, response) => {
    closed = new Promise((resolve) => request.socket.once("close", resolve));
    response.writeHead(200, { "content-type": "text/plain" }); response.write("partial");
    controller.abort();
  });
  const data = await temporaryDirectory(context);
  const host = { outputs: new OutputCache(data), threadId: "web" };
  await assert.rejects(webFetch(host, { url: "http://public.example" }, controller.signal), { name: "AbortError" });
  await closed;
  assert.deepEqual(await readdir(data), []);
});

test("总超时在系统 DNS 等待时也可取消，不保存部分网页", async (context) => {
  context.mock.property(process, "env", { ...process.env, HTTP_PROXY: "", HTTPS_PROXY: "", ALL_PROXY: "", http_proxy: "", https_proxy: "", all_proxy: "", NO_PROXY: "*", no_proxy: "*" });
  let started!: () => void;
  const gate = new Promise<void>((resolve) => { started = resolve; });
  let finishDns!: () => void;
  context.mock.method(dns, "lookup", (_host: string, options: dns.LookupOptions, callback: (error: null, address: dns.LookupAddress[] | string, family?: number) => void) => {
    finishDns = () => callback(null, options.all ? [{ address: "127.0.0.1", family: 4 }] : "127.0.0.1", 4);
    started();
  });
  const deadline = new AbortController();
  context.mock.method(AbortSignal, "timeout", (ms: number) => { assert.equal(ms, 30000); return deadline.signal; });
  const data = await temporaryDirectory(context);
  const host = { outputs: new OutputCache(data), threadId: "web" };
  const waiting = webFetch(host, { url: "https://waiting.example" });
  await gate; deadline.abort(new DOMException("deadline", "TimeoutError"));
  await assert.rejects(waiting, /30 秒/);
  finishDns();
  assert.deepEqual(await readdir(data), []);
});

test("HTML 保留列表、代码和表格，隐藏内容、脚本与不安全链接不进入 Markdown", () => {
  const result = htmlToMarkdown('<h1>标题</h1><ul><li>项目</li></ul><pre><code class="language-ts">const x = 1;</code></pre><table><tr><th>名称</th><th>值</th></tr><tr><td>A</td><td>中文</td></tr><tr hidden><td>隐藏行</td></tr><tr><td hidden>隐藏格</td><td>显示格</td></tr></table><div style="display:none">隐藏样式</div><script>脚本</script><iframe src="/frame">框架</iframe><a href="javascript:alert(1)">链接文本</a><img alt="图片说明" src="/image">', "https://public.example/docs");
  assert.match(result.content, /# 标题/);
  assert.match(result.content, /-\s+项目/);
  assert.match(result.content, /```ts\nconst x = 1;/);
  assert.match(result.content, /\| 名称 \| 值 \|/);
  assert.match(result.content, /\| A \| 中文 \|/);
  assert.match(result.content, /显示格/);
  assert.match(result.content, /链接文本.*图片说明/s);
  assert.doesNotMatch(result.content, /隐藏|脚本|框架|javascript:|src=|<table>/);
});
