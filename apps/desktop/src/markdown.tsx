import { useRef, useState, type ComponentProps } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { openUrl } from "@tauri-apps/plugin-opener";

/** Markdown 链接只接受完整 HTTP(S) 地址，不将相对文件路径当作网页导航。 */
export function webURL(url: string): string {
  return /^https?:\/\//i.test(url) ? url : "";
}

/** 代码块保留原文，横向滚动并提供复制；复制失败明确展示，允许再次尝试。 */
function CodeBlock({ children }: ComponentProps<"pre">) {
  const content = useRef<HTMLPreElement>(null);
  const [status, setStatus] = useState("");

  /** 从代码节点读取原文，避免把按钮文字一同复制。 */
  async function copy(): Promise<void> {
    try {
      await navigator.clipboard.writeText(content.current?.textContent ?? "");
      setStatus("已复制");
    } catch { setStatus("复制失败，请手动选择代码"); }
  }

  return <div className="code-block"><div className="code-toolbar"><span aria-live="polite">{status || "代码"}</span><button type="button" onClick={() => void copy()}>复制代码</button></div><pre ref={content}>{children}</pre></div>;
}

/** 点击网页链接时交给系统浏览器，保持当前对话窗口不发生导航。 */
function WebLink({ href, children, title }: ComponentProps<"a">) {
  const [error, setError] = useState(false);
  if (!href) return <span>{children}</span>;

  /** 打开经过协议过滤的地址，失败时显示状态供用户处理。 */
  async function open(): Promise<void> {
    setError(false);
    try { await openUrl(href!); }
    catch { setError(true); }
  }

  return <><a href={href} title={title ?? href} onClick={(event) => { event.preventDefault(); void open(); }}>{children}</a>{error && <span role="status" className="error">（无法打开链接）</span>}</>;
}

/** 渲染模型 Markdown：支持表格和列表，不执行 HTML，也不自动加载模型提供的图片。 */
export function MessageMarkdown({ text }: { text: string }) {
  return <div className="markdown"><Markdown remarkPlugins={[remarkGfm]} skipHtml urlTransform={webURL}
    components={{ pre: CodeBlock, a: WebLink, img: ({ alt }) => <span className="muted">[图片：{alt || "未提供说明"}]</span>,
      table: ({ children }) => <div className="table-scroll"><table>{children}</table></div> }}>{text}</Markdown></div>;
}
