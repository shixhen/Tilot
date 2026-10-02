import dns from "node:dns/promises";
import http, { type IncomingMessage, type RequestOptions } from "node:http";
import https from "node:https";
import { isIP } from "node:net";
import { PassThrough, type Duplex } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createBrotliDecompress, createGunzip, createInflate } from "node:zlib";
import ipaddr from "ipaddr.js";
import { getProxyForUrl } from "proxy-from-env";

const MAX_DOWNLOAD_BYTES = 2 * 1024 * 1024;
const MAX_REDIRECTS = 5;

/** 传输层只返回有界文本和来源，不执行网页代码或解释网页指令。 */
export interface HttpText { url: string; finalUrl: string; fetchedAt: number; html: boolean; content: string }

/** 仅接受完整的匿名 HTTP(S) URL，片段不发送到服务器。 */
export function parseFetchUrl(value: unknown): URL {
  if (typeof value !== "string" || !value.isWellFormed() || /[\x00-\x20\x7f]/.test(value) || Buffer.byteLength(value) > 4096) throw new Error("url 必须是完整的 HTTP(S) 地址，最多 4 KiB，不能包含空白或控制字符。");
  let url: URL;
  try { url = new URL(value); } catch { throw new Error("url 必须是完整的 HTTP(S) 地址。"); }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) throw new Error("只读取匿名 HTTP(S) 网页，URL 不能包含用户名或密码。");
  url.hash = "";
  if (Buffer.byteLength(url.href) > 4096) throw new Error("url 编码后的地址超过 4 KiB 上限。");
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if ((isIP(host) && !isPublicAddress(host)) || /(?:^|\.)(?:localhost|local|internal)\.?$/i.test(host) || !isIP(host) && !host.includes(".")) throw new Error("web_fetch 只访问公开地址，不能读取本机、私网或保留地址。");
  return url;
}

/** IPv4 映射地址按其 IPv4 检查；私网、保留地址及转换地址均不作为公开目标。 */
export function isPublicAddress(address: string): boolean {
  return isIP(address) !== 0 && ipaddr.process(address).range() === "unicast";
}

/** DNS 无取消接口，取消只停止等待；已发起的系统查询随后完成也不再发请求。 */
async function abortable<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    operation.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}

/** RFC 6052 中 IPv4 字节绕过第 8 字节的保留位，支持六种标准前缀长度。 */
function embeddedIpv4(bytes: number[], length: number): string | undefined {
  if (length === 96) return bytes.slice(12).join(".");
  if (bytes[8] !== 0) return;
  const start = length / 8;
  return [...bytes.slice(start, 8), ...bytes.slice(9, 9 + start - 4)].join(".");
}

/** 检查完整 DNS 答案并固定一个地址；DNS64 私网映射也不能绕过检查。 */
export async function resolvePublicAddress(hostname: string, signal: AbortSignal): Promise<{ address: string; family: 4 | 6 }> {
  signal.throwIfAborted();
  const host = hostname.replace(/^\[|\]$/g, "");
  const family = isIP(host);
  const addresses = family ? [{ address: host, family }] : await abortable(dns.lookup(host, { all: true, order: "verbatim" }), signal);
  if (addresses.length === 0) throw new Error("网页域名没有可用地址。");
  for (const entry of addresses) {
    if (isIP(entry.address) !== entry.family || !isPublicAddress(entry.address)) throw new Error("web_fetch 只访问公开地址，不能读取本机、私网或保留地址。");
  }
  if (addresses.some((entry) => entry.family === 6)) {
    // RFC 7050 的固定发现域名只用于识别当前网络的 DNS64 前缀，不连接它。
    const discovery = await abortable(dns.lookup("ipv4only.arpa", { all: true, order: "verbatim" }), signal);
    for (const entry of discovery) {
      if (isIP(entry.address) !== 6) continue;
      const bytes = ipaddr.parse(entry.address).toByteArray();
      for (const length of [32, 40, 48, 56, 64, 96]) {
        if (!["192.0.0.170", "192.0.0.171"].includes(embeddedIpv4(bytes, length) ?? "")) continue;
        for (const candidate of addresses.filter((item) => item.family === 6)) {
          const target = ipaddr.parse(candidate.address).toByteArray();
          if (bytes.slice(0, length / 8).every((byte, index) => target[index] === byte) && !isPublicAddress(embeddedIpv4(target, length) ?? "")) throw new Error("网页地址经 DNS64 映射到非公开 IPv4 地址，不能读取。");
        }
      }
    }
  }
  signal.throwIfAborted();
  const selected = addresses.find((entry) => entry.family === 4) ?? addresses[0]!;
  return { address: selected.address, family: selected.family as 4 | 6 };
}

/** 环境指定代理时由代理解析目标；直连固定已检查地址，两种方式都保留 Host/TLS 名称。 */
async function requestPinned(url: URL, signal: AbortSignal): Promise<IncomingMessage> {
  const protocol = url.protocol === "https:" ? https : http;
  const proxy = getProxyForUrl(url.href);
  let agent: http.Agent | undefined;
  let connecting: Duplex | null | undefined;
  const options: RequestOptions = { method: "GET", signal, agent: false,
    headers: { "user-agent": "Tilot/0.1 web_fetch", accept: "text/html,application/xhtml+xml,text/*,application/json", "accept-encoding": "gzip,deflate,br" },
  };
  if (proxy) {
    let proxyUrl: URL;
    try { proxyUrl = new URL(proxy); } catch { throw new Error("宿主代理地址无效，请检查代理环境变量。"); }
    if (!["http:", "https:"].includes(proxyUrl.protocol)) throw new Error("宿主代理仅支持 HTTP/HTTPS。");
    agent = new protocol.Agent({ keepAlive: false, proxyEnv: { HTTP_PROXY: proxyUrl.href, HTTPS_PROXY: proxyUrl.href } });
    // HTTPS 的 CONNECT 尚未完成时，原生 Agent 还未登记连接，需要单独保留以取消。
    const createConnection = agent.createConnection.bind(agent);
    agent.createConnection = (connectionOptions, callback) => {
      connecting = createConnection(connectionOptions, callback);
      return connecting;
    };
    options.agent = agent;
  } else {
    const pinned = await resolvePublicAddress(url.hostname, signal);
    options.family = pinned.family;
    options.lookup = (_host, lookupOptions, callback) => lookupOptions.all ? callback(null, [pinned]) : callback(null, pinned.address, pinned.family);
  }
  return new Promise((resolve, reject) => {
    const close = () => { connecting?.destroy(); agent?.destroy(); };
    const abort = () => {
      connecting?.destroy(signal.reason instanceof Error ? signal.reason : new Error("网页读取已取消。"));
      agent?.destroy();
      reject(signal.reason);
    };
    signal.addEventListener("abort", abort, { once: true });
    const release = () => { signal.removeEventListener("abort", abort); close(); };
    const request = protocol.request(url, options, (response) => { response.once("close", release); resolve(response); });
    request.once("error", (error: NodeJS.ErrnoException & { statusCode?: number }) => {
      release();
      // 原生代理错误可能带完整代理 URL，不能把其中的宿主凭据送入结果或模型历史。
      reject(proxy && !signal.aborted ? new Error(`网页代理连接失败（${error.statusCode ? `HTTP ${error.statusCode}` : error.code ?? "连接错误"}）。`) : error);
    });
    request.end();
  });
}

/** 同时限制压缩前下载量和解压后正文，不能仅信 Content-Length。 */
async function readBody(response: IncomingMessage, signal: AbortSignal): Promise<Buffer> {
  if (Number(response.headers["content-length"]) > MAX_DOWNLOAD_BYTES) throw new Error("网页下载超过 2 MiB 上限。");
  const encoding = (response.headers["content-encoding"] ?? "identity").toLowerCase().trim();
  const decoder = encoding === "gzip" ? createGunzip() : encoding === "deflate" ? createInflate()
    : encoding === "br" ? createBrotliDecompress() : encoding === "identity" ? new PassThrough() : undefined;
  if (!decoder) throw new Error(`不支持网页压缩格式：${encoding}。`);
  return pipeline(response, async function* (source) {
    let bytes = 0;
    for await (const chunk of source) {
      bytes += chunk.length;
      if (bytes > MAX_DOWNLOAD_BYTES) throw new Error("网页下载超过 2 MiB 上限。");
      yield chunk;
    }
  }, decoder, async (source) => {
    const chunks: Buffer[] = [];
    let bytes = 0;
    for await (const chunk of source) {
      bytes += chunk.length;
      if (bytes > MAX_DOWNLOAD_BYTES) throw new Error("网页解压后的正文超过 2 MiB 上限。");
      chunks.push(chunk);
    }
    return Buffer.concat(chunks);
  }, { signal });
}

/** 各次重定向重新验证公开地址，始终使用匿名请求；错误响应不作为正文保存。 */
export async function fetchPublicText(value: string, signal: AbortSignal): Promise<HttpText> {
  const original = parseFetchUrl(value);
  let current = original;
  for (let redirects = 0; ; redirects++) {
    signal.throwIfAborted();
    const response = await requestPinned(current, signal);
    try {
      const status = response.statusCode!;
      if ([301, 302, 303, 307, 308].includes(status)) {
        if (redirects >= MAX_REDIRECTS) throw new Error("网页重定向超过 5 次上限。");
        if (!response.headers.location) throw new Error("网页重定向缺少 Location 地址。");
        current = parseFetchUrl(new URL(response.headers.location, current).href);
        continue;
      }
      if (status < 200 || status >= 300) throw new Error(`网页请求失败，HTTP ${status}。`);
      const contentType = response.headers["content-type"] ?? "";
      const mime = contentType.split(";")[0]!.trim().toLowerCase();
      const html = ["text/html", "application/xhtml+xml"].includes(mime);
      if (!html && !mime.startsWith("text/") && mime !== "application/json") throw new Error(`不支持网页内容类型：${mime || "未提供"}。仅支持 HTML、文本和 JSON。`);
      const charset = /charset\s*=\s*(?:"([^"]+)"|'([^']+)'|([^;\s]+))/i.exec(contentType);
      let decoder: TextDecoder;
      try { decoder = new TextDecoder(charset?.[1] ?? charset?.[2] ?? charset?.[3] ?? "utf-8", { fatal: true }); }
      catch { throw new Error("不支持网页声明的字符编码。"); }
      const bytes = await readBody(response, signal);
      let content: string;
      try { content = decoder.decode(bytes); } catch { throw new Error("网页正文不符合声明的字符编码。"); }
      if (/[\x00-\x08\x0e-\x1f\x7f]/.test(content)) throw new Error("网页含有二进制控制字符，不能作为文本读取。");
      return { url: original.href, finalUrl: current.href, fetchedAt: Date.now(), html, content };
    } finally { response.destroy(); }
  }
}
