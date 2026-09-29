import { useRef, useState, type ComponentProps } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { Element, Root } from "hast";
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

  return <div className="my-4 overflow-hidden rounded-lg border bg-muted/30 shadow-sm">
    <div className="flex items-center justify-between gap-3 border-b bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
      <span role="status">{status || "代码"}</span><Button type="button" variant="ghost" size="xs" className="h-6 hover:bg-background/80" onClick={() => void copy()}>{status === "已复制" ? <Check className="size-3" /> : <Copy className="size-3" />}复制代码</Button>
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

/** 按词切分文字（中文按词语，英文按单词）。 */
const segmenter = new Intl.Segmenter("zh", { granularity: "word" });

/**
 * 流式输出时把文字切成带淡入动画的小片段。片段按顺序追加在末尾，已显示片段的位置和 key 不变，
 * React 复用原有节点，动画不会重播；只有新出现的片段从透明渐变到不透明。
 * 纯空白文本保持原样，避免在表格行之间插入非法的 span。
 */
function rehypeFadeIn() {
  return (tree: Root) => {
    const split = (node: Root | Element): void => {
      node.children = node.children.flatMap((child) => {
        if (child.type === "element") split(child);
        if (child.type !== "text" || !child.value.trim()) return [child];
        return Array.from(segmenter.segment(child.value), ({ segment }): Element =>
          ({ type: "element", tagName: "span", properties: { className: ["fade-in"] }, children: [{ type: "text", value: segment }] }));
      }) as Root["children"];
    };
    split(tree);
  };
}

/** 渲染 GFM 正文，禁用 HTML 和自动图片请求，宽表格单独滚动；streaming 时新文字淡入。 */
export function MessageMarkdown({ text, streaming = false }: { text: string; streaming?: boolean }) {
  return <div className="message-prose"><Markdown skipHtml remarkPlugins={[remarkGfm]} rehypePlugins={streaming ? [rehypeFadeIn] : []} urlTransform={webURL} components={{
    pre: CodeBlock,
    a: WebLink,
    img: ({ alt }) => <span className="text-muted-foreground">[图片：{alt || "未提供说明"}]</span>,
    table: ({ children }) => <div className="my-4 overflow-x-auto rounded-lg border"><table>{children}</table></div>,
  }}>{text}</Markdown></div>;
}
