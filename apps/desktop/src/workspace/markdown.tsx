import { useRef, useState, type ComponentProps } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { openUrl } from "@tauri-apps/plugin-opener";
import { Check, Copy } from "lucide-react";
import { Button } from "../components/ui/button";

/** 只允许完整网页地址，阻止模型生成的脚本和本地路径导航。 */
export function webURL(url: string): string {
  return /^https?:\/\//i.test(url) ? url : "";
}

/** 以主题色显示代码块，复制时只读取代码原文。 */
function CodeBlock({ children }: ComponentProps<"pre">) {
  const source = useRef<HTMLPreElement>(null);
  const [status, setStatus] = useState("");

  /** 将代码写入剪贴板，并报告成功或失败。 */
  async function copy(): Promise<void> {
    try { await navigator.clipboard.writeText(source.current?.textContent ?? ""); setStatus("已复制"); }
    catch { setStatus("复制失败，请手动选择代码"); }
  }

  return <div className="my-4 overflow-hidden rounded-lg border bg-muted/40">
    <div className="flex items-center justify-between gap-3 border-b px-3 py-1.5 text-xs text-muted-foreground">
      <span role="status">{status || "代码"}</span><Button type="button" variant="ghost" size="xs" onClick={() => void copy()}>{status === "已复制" ? <Check /> : <Copy />}复制代码</Button>
    </div>
    <pre ref={source}>{children}</pre>
  </div>;
}

/** 通过系统浏览器打开链接，失败时留在当前对话并展示原因。 */
function WebLink({ href, children, title }: ComponentProps<"a">) {
  const [failed, setFailed] = useState(false);
  if (!href) return <span>{children}</span>;

  /** 打开已经经过协议过滤的链接。 */
  async function open(): Promise<void> {
    try { await openUrl(href!); setFailed(false); }
    catch { setFailed(true); }
  }

  return <><a href={href} title={title ?? href} onClick={(event) => { event.preventDefault(); void open(); }}>{children}</a>{failed && <span role="status" className="text-destructive">（无法打开链接）</span>}</>;
}

/** 渲染 GFM 正文，禁用 HTML 和自动图片请求，宽表格单独滚动。 */
export function MessageMarkdown({ text }: { text: string }) {
  return <div className="message-prose"><Markdown skipHtml remarkPlugins={[remarkGfm]} urlTransform={webURL} components={{
    pre: CodeBlock,
    a: WebLink,
    img: ({ alt }) => <span className="text-muted-foreground">[图片：{alt || "未提供说明"}]</span>,
    table: ({ children }) => <div className="my-4 overflow-x-auto rounded-lg border"><table>{children}</table></div>,
  }}>{text}</Markdown></div>;
}
