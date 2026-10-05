import http, { type IncomingMessage, type RequestOptions } from "node:http";
import https from "node:https";
import { PassThrough, type Duplex } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createBrotliDecompress, createGunzip, createInflate } from "node:zlib";
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
  return url;
}

/** 显式代理由代理解析目标；其余请求使用系统 DNS 和路由，兼容 TUN/Fake-IP。 */
async function requestPage(url: URL, signal: AbortSignal): Promise<IncomingMessage> {
  signal.throwIfAborted();
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

/** 各次重定向重新验证 HTTP(S) URL，始终使用匿名请求；错误响应不作为正文保存。 */
export async function fetchHttpText(value: string, signal: AbortSignal): Promise<HttpText> {
  const original = parseFetchUrl(value);
  let current = original;
  for (let redirects = 0; ; redirects++) {
    signal.throwIfAborted();
    const response = await requestPage(current, signal);
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
