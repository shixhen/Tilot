import TurndownService from "turndown";

/** 只判断明确的隐藏标记和行内样式，不加载或执行外部样式表。 */
function hidden(node: HTMLElement): boolean {
  for (let current: HTMLElement | null = node; current; current = current.parentElement) {
    if (current.hasAttribute("hidden") || current.getAttribute("aria-hidden") === "true" || /(?:display\s*:\s*none|visibility\s*:\s*hidden)/i.test(current.getAttribute("style") ?? "")) return true;
  }
  return false;
}

/** 在纯解析器中转 Markdown；不执行 JS、不加载图片或其他子资源。 */
export function htmlToMarkdown(html: string, finalUrl: string): { content: string; title?: string } {
  const markdown = new TurndownService({ headingStyle: "atx", codeBlockStyle: "fenced", bulletListMarker: "-" });
  let title: string | undefined;
  markdown.addRule("title", { filter: "title", replacement: (_content, node) => {
    title = node.textContent?.trim().slice(0, 500) || undefined;
    return "";
  } });
  markdown.addRule("links", { filter: "a", replacement: (content, node) => {
    const href = node.getAttribute("href");
    if (!href) return content;
    let url: URL;
    try { url = new URL(href, finalUrl); } catch { return content; }
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) return content;
    return `[${content}](${url.href.replace(/[()]/g, "\\$&")})`;
  } });
  markdown.addRule("images", { filter: "img", replacement: (_content, node) => markdown.escape(node.getAttribute("alt") ?? "") });
  markdown.addRule("tables", { filter: "table", replacement: (_content, node) => {
    const rows = Array.from(node.querySelectorAll("tr")).filter((row) => !hidden(row)).map((row) => Array.from(row.children, (cell) => hidden(cell as HTMLElement) ? "" : markdown.turndown(cell.innerHTML).replace(/\n+/g, " ").replace(/\|/g, "\\|")));
    if (!rows.length) return "";
    const width = rows.reduce((width, row) => Math.max(width, row.length), 0);
    if (!width) return "";
    const lines = rows.map((row) => `| ${Array.from({ length: width }, (_, index) => row[index] ?? "").join(" | ")} |`);
    lines.splice(1, 0, `| ${Array(width).fill("---").join(" | ")} |`);
    return `\n\n${lines.join("\n")}\n\n`;
  } });
  markdown.addRule("discard", { filter: (node) => ["SCRIPT", "STYLE", "NOSCRIPT", "IFRAME", "OBJECT", "TEMPLATE", "SVG", "HEAD"].includes(node.nodeName)
    || hidden(node), replacement: () => "" });
  const content = markdown.turndown(html);
  return { content, ...(title ? { title } : {}) };
}
