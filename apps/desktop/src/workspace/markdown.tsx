import { createContext, memo, useContext, useDeferredValue, useMemo, useRef, useState, type ComponentProps } from "react";
import Markdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import rehypeKatex from "rehype-katex";
import { openUrl } from "@tauri-apps/plugin-opener";
import { Check, Copy } from "lucide-react";
import { Button } from "../components/ui/button";
import { useCopyText } from "../hooks/use-copy-text";
import { useStreamLineFade } from "../hooks/use-stream-line-fade";
import { markdownBlockStarts, normalizeMathDelimiters } from "./math";
import { ImageReference } from "./images";

const InsideLink = createContext(false);
const AutoLoadImages = createContext(true);

/** 只允许完整网页地址，阻止模型生成的脚本和本地路径导航。 */
export function webURL(url: string): string {
  return /^https?:\/\//i.test(url) ? url : "";
}

/** 以主题色显示代码块，复制时只读取代码原文。 */
function CodeBlock({ children }: ComponentProps<"pre">) {
  const source = useRef<HTMLPreElement>(null);
  const { status, copy } = useCopyText();

  return <div className="my-4 overflow-hidden rounded-lg border bg-muted/30 shadow-sm">
    <div className="flex items-center justify-between gap-3 border-b bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
      <span role="status">{status || "代码"}</span><Button type="button" variant="ghost" size="xs" className="h-6 hover:bg-background/80" onClick={() => void copy(source.current?.textContent ?? "")}>{status === "已复制" ? <Check className="size-3" /> : <Copy className="size-3" />}复制代码</Button>
    </div>
    <pre ref={source}>{children}</pre>
  </div>;
}

/** 通过系统浏览器打开链接，失败时留在当前对话并展示原因。 */
export function WebLink({ href, children, title, className }: ComponentProps<"a">) {
  const [failed, setFailed] = useState(false);
  if (!href) return <span>{children}</span>;

  /** 打开已经经过协议过滤的链接。 */
  async function open(): Promise<void> {
    try { await openUrl(href!); setFailed(false); }
    catch { setFailed(true); }
  }

  return <><a href={href} title={title ?? href} className={className} onClick={(event) => { event.preventDefault(); void open(); }}><InsideLink.Provider value={true}>{children}</InsideLink.Provider></a>{failed && <span role="status" className="text-destructive">（无法打开链接）</span>}</>;
}

function MarkdownImage({ alt, src }: ComponentProps<"img">) {
  const inLink = useContext(InsideLink);
  const autoLoad = useContext(AutoLoadImages);
  const reference = !inLink && typeof src === "string" ? src : undefined;
  return <ImageReference key={reference} src={reference} alt={alt} autoLoad={autoLoad} />;
}

/** 组件类型保持稳定，流式更新时不重新挂载表格等已有内容。 */
const components: Components = {
  pre: CodeBlock,
  a: WebLink,
  img: MarkdownImage,
  table: ({ children }) => <div className="my-4 overflow-x-auto rounded-lg border"><table>{children}</table></div>,
};

const MarkdownBlock = memo(function MarkdownBlock({ text, separated }: { text: string; separated: boolean }) {
  const markdown = useMemo(() => normalizeMathDelimiters(text), [text]);
  return <>{separated && "\n"}<Markdown skipHtml remarkPlugins={[remarkGfm, remarkMath]}
    rehypePlugins={[[rehypeKatex, { trust: false, strict: false }]]}
    urlTransform={(url, key, node) => key === "src" && node.tagName === "img" ? url : webURL(url)} components={components}>{markdown}</Markdown></>;
});

type MarkdownPrefix = { source: string; blocks: { start: number; text: string }[] };
const emptyPrefix: MarkdownPrefix = { source: "", blocks: [] };

/** 渲染 GFM 和公式。流式追加时，已解析的 Markdown 块由 React 复用。 */
export const MessageMarkdown = memo(function MessageMarkdown({ text, streaming = false, autoLoadImages = true }: { text: string; streaming?: boolean; autoLoadImages?: boolean }) {
  const deferredText = useDeferredValue(text);
  const displayed = streaming ? deferredText : text;
  const content = useStreamLineFade(displayed, streaming);
  const [prefix, setPrefix] = useState(emptyPrefix);
  // 引用和脚注定义可能改写前面的块，存在定义时按全文解析。
  const stable = useMemo(() => {
    if (displayed.includes("]:")) return emptyPrefix;
    const previous = displayed.startsWith(prefix.source) ? prefix : emptyPrefix;
    const base = previous.source.length;
    const starts = streaming ? markdownBlockStarts(displayed.slice(base)) : [];
    if (!starts.length) return previous;
    let offset = base;
    const blocks = starts.map((start) => {
      const next = base + start;
      const block = { start: offset, text: displayed.slice(offset, next) };
      offset = next;
      return block;
    });
    return { source: displayed.slice(0, offset), blocks: [...previous.blocks, ...blocks] };
  }, [displayed, prefix, streaming]);
  if (stable !== prefix) setPrefix(stable);
  const tailStart = stable.source.length;
  return <div ref={content} className="message-prose"><AutoLoadImages.Provider value={autoLoadImages}>
    {[...stable.blocks, { start: tailStart, text: displayed.slice(tailStart) }].map((block) =>
      <MarkdownBlock key={block.start} text={block.text} separated={block.start > 0} />)}
  </AutoLoadImages.Provider></div>;
});
