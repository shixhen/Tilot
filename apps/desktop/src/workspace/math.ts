import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import type { Root, RootContent } from "mdast";

const parser = unified().use(remarkParse).use(remarkGfm).use(remarkMath);

/** 将 LaTeX 的括号分隔符转为 Markdown 数学语法，代码、链接和已有公式保持原文。 */
export function normalizeMathDelimiters(text: string): string {
  if (!text.includes("\\(") && !text.includes("\\[")) return text;
  const protectedRanges: { start: number; end: number }[] = [];

  /** 由 Markdown 解析器识别不能改写的区域，避免自行判断代码围栏及链接语法。 */
  function collect(node: Root | RootContent): void {
    if (["code", "inlineCode", "html", "link", "image", "definition", "math", "inlineMath"].includes(node.type)) {
      protectedRanges.push({ start: node.position!.start.offset!, end: node.position!.end.offset! });
      return;
    }
    if ("children" in node) for (const child of node.children) collect(child);
  }

  collect(parser.parse(text));
  return text.replace(/\\\(([\s\S]*?)\\\)|\\\[([\s\S]*?)\\\]/g, (matched: string, inline: string | undefined, display: string | undefined, offset: number) => {
    if (protectedRanges.some((range) => offset >= range.start && offset < range.end)) return matched;
    let escapes = 0;
    for (let index = offset - 1; index >= 0 && text[index] === "\\"; index--) escapes++;
    if (escapes % 2) return matched;
    const formula = inline ?? display!;
    if (!formula.trim()) return matched;
    // 分隔符长于正文中的美元符号，保留 \text{\$5} 等合法 LaTeX。
    let delimiter = inline !== undefined ? "$" : "$$";
    for (const dollars of formula.match(/\$+/g) ?? []) if (dollars.length >= delimiter.length) delimiter = dollars + "$";
    if (inline !== undefined) return delimiter + formula + delimiter;

    const lineStart = text.lastIndexOf("\n", offset - 1) + 1;
    const prefix = text.slice(lineStart, offset);
    const lineEnd = text.indexOf("\n", offset + matched.length);
    const suffix = text.slice(offset + matched.length, lineEnd < 0 ? text.length : lineEnd);
    // 独占一段的公式沿用引用或列表缩进，不能把公式移出原 Markdown 容器。
    if (/^(?:[ \t]*>[ \t]*)*[ \t]*$/.test(prefix) && !suffix.trim()) {
      const content = formula.split(/\r?\n/).map((line) => line.startsWith(prefix) ? line.slice(prefix.length) : line).join("\n").trim();
      return delimiter + "\n" + content.split("\n").map((line) => prefix + line).join("\n") + "\n" + prefix + delimiter;
    }
    return "\n\n" + delimiter + "\n" + formula.trim() + "\n" + delimiter + "\n\n";
  });
}
