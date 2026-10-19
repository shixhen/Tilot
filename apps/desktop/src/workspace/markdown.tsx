import { memo, useEffect, useMemo, useRef, useState, type ComponentProps } from "react";
import Markdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import rehypeKatex from "rehype-katex";
import type { Element, Root } from "hast";
import { openUrl } from "@tauri-apps/plugin-opener";
import { Check, Copy } from "lucide-react";
import { Button } from "../components/ui/button";
import { useCopyText } from "../hooks/use-copy-text";
import { normalizeMathDelimiters } from "./math";

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

  return <><a href={href} title={title ?? href} className={className} onClick={(event) => { event.preventDefault(); void open(); }}>{children}</a>{failed && <span role="status" className="text-destructive">（无法打开链接）</span>}</>;
}

/** 组件类型保持稳定，流式更新时不重新挂载表格等已有内容。 */
const components: Components = {
  pre: CodeBlock,
  a: WebLink,
  img: ({ alt }) => <span className="text-muted-foreground">[图片：{alt || "未提供说明"}]</span>,
  table: ({ children }) => <div className="my-4 overflow-x-auto rounded-lg border"><table>{children}</table></div>,
};

/** 按可见字符切分，不拆开组合字符或 emoji。 */
const segmenter = new Intl.Segmenter("zh", { granularity: "grapheme" });

/** 仅末尾 8 个非空白字符参与渐变，透明度随后续文字推进。 */
const STREAM_TAIL_LENGTH = 8;

/**
 * 从 Markdown 末尾向前分配渐变，跨段落共用一个尾部窗口。
 * 旧文字保持普通文本，最多生成 8 个 span；结构间空白不包装，保留合法表格结构。
 */
function rehypeStreamTail() {
  return (tree: Root) => {
    let remaining = STREAM_TAIL_LENGTH;
    /** 逆序处理子节点，再按原顺序放回字符，不改变正文及复制内容。 */
    const split = (node: Root | Element): void => {
      for (let index = node.children.length - 1; index >= 0 && remaining > 0; index--) {
        const child = node.children[index]!;
        if (child.type === "element") {
          // 公式作为完整内容显示，不能在 KaTeX 的字形或 MathML 内插入渐变 span。
          if (Array.isArray(child.properties.className) && child.properties.className.includes("katex")) {
            remaining = 0;
            continue;
          }
          split(child);
        }
        if (child.type !== "text" || !child.value.trim()) continue;
        const characters = segmenter.segment(child.value);
        const tail: Element["children"] = [];
        let start = child.value.length;
        // 从末尾按字符边界回退，只处理渐变窗口，不枚举整段文字。
        while (start > 0 && remaining > 0) {
          const { segment, index: offset } = characters.containing(start - 1)!;
          start = offset;
          if (!segment.trim()) {
            tail.unshift({ type: "text", value: segment });
            continue;
          }
          tail.unshift({ type: "element", tagName: "span", properties: {
            className: ["stream-tail"], style: `--stream-opacity:${(STREAM_TAIL_LENGTH - remaining) / STREAM_TAIL_LENGTH}`,
          }, children: [{ type: "text", value: segment }] });
          remaining--;
        }
        if (start > 0) tail.unshift({ type: "text", value: child.value.slice(0, start) });
        node.children.splice(index, 1, ...tail);
      }
    };
    split(tree);
  };
}

/** 渲染 GFM 与数学公式，禁用 HTML 和自动图片请求；streaming 时普通新文字淡入。 */
export const MessageMarkdown = memo(function MessageMarkdown({ text, streaming = false }: { text: string; streaming?: boolean }) {
  const [settledText, setSettledText] = useState<string | null>(null);
  const markdown = useMemo(() => normalizeMathDelimiters(text), [text]);
  // 输出暂停时显示完整末尾，避免等待网络或工具期间最后几个字一直透明。
  useEffect(() => {
    if (!streaming) return;
    const timer = setTimeout(() => setSettledText(text), 240);
    return () => clearTimeout(timer);
  }, [text, streaming]);
  return <div className="message-prose"><Markdown skipHtml remarkPlugins={[remarkGfm, remarkMath]}
    rehypePlugins={[[rehypeKatex, { trust: false, strict: false }], ...(streaming && settledText !== text ? [rehypeStreamTail] : [])]} urlTransform={webURL} components={components}>{markdown}</Markdown></div>;
});
