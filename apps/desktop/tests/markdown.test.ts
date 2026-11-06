import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MessageMarkdown, webURL } from "../src/workspace/markdown.tsx";
import { normalizeMathDelimiters } from "../src/workspace/math.ts";

// 检查流式未闭合围栏及完整代码、表格和任务列表的真实组件输出。
test("Markdown 保留代码缩进并支持未闭合代码块、表格和任务列表", () => {
  const partial = renderToStaticMarkup(createElement(MessageMarkdown, { text: "```ts\n  const answer = 42;" }));
  assert.match(partial, /<pre><code class="language-ts">  const answer = 42;/);
  assert.match(partial, /复制代码/);
  const html = renderToStaticMarkup(createElement(MessageMarkdown, { text: "## 标题\n\n- [x] 完成\n\n| 名称 | 状态 |\n| --- | --- |\n| Tilot | 已连接 |" }));
  assert.match(html, /<h2>标题<\/h2>/);
  assert.match(html, /type="checkbox"[^>]*disabled/);
  assert.match(html, /<table>/);
});

// 独立渲染 Markdown 时保留图片说明，图片加载由应用的预览组件负责。
test("Markdown 拒绝可执行内容与非网页链接，独立渲染时保留图片说明", () => {
  const html = renderToStaticMarkup(createElement(MessageMarkdown, { text: '<script>alert(1)</script>\n\n[脚本](javascript:alert%281%29) [文件](file:///C:/secret) [网页](https://example.com)\n\n![说明](https://example.com/tracker.png)' }));
  assert.doesNotMatch(html, /<script|<img|src=|href="(?:javascript|file):/);
  assert.match(html, /href="https:\/\/example.com"/);
  assert.match(html, /\[图片：说明\]/);
  for (const url of ["/relative", "//example.com", "mailto:user@example.com", "data:text/html,test"]) assert.equal(webURL(url), "");
});

// 尾部窗口跨 Markdown 节点共用，不影响表格结构，结束后完整显示。
test("流式 Markdown 仅末尾八个字符渐变，推进后旧字恢复不透明", () => {
  const text = "你好 world\n\n| 名称 | 状态 |\n| --- | --- |\n| Tilot | 已连接 |";
  const streaming = renderToStaticMarkup(createElement(MessageMarkdown, { text, streaming: true }));
  assert.equal((streaming.match(/class="stream-tail"/g) ?? []).length, 8);
  assert.match(streaming, /你好 world/);
  assert.doesNotMatch(streaming, /<(?:table|thead|tbody|tr)>\s*<span/);
  assert.doesNotMatch(renderToStaticMarkup(createElement(MessageMarkdown, { text })), /stream-tail/);
  const initial = renderToStaticMarkup(createElement(MessageMarkdown, { text: "甲乙丙丁戊己庚辛", streaming: true }));
  assert.match(initial, /style="--stream-opacity:0">辛<\/span>/);
  const advanced = renderToStaticMarkup(createElement(MessageMarkdown, { text: "甲乙丙丁戊己庚辛壬癸子丑寅卯辰巳", streaming: true }));
  assert.match(advanced, /甲乙丙丁戊己庚辛<span/);
  const emoji = renderToStaticMarkup(createElement(MessageMarkdown, { text: "👨‍👩‍👧‍👦", streaming: true }));
  assert.equal((emoji.match(/class="stream-tail"/g) ?? []).length, 1);
});

test("长段落只为末尾八个完整字符生成渐变，组合音标和 emoji 不拆开", () => {
  const tail = ["e\u0301", "👩‍💻", "🇨🇳", "👍🏽", "👨‍👩‍👧‍👦", "甲", "乙", "丙"];
  const prefix = "较长的推理内容".repeat(3000);
  const html = renderToStaticMarkup(createElement(MessageMarkdown, { text: prefix + tail.join(""), streaming: true }));
  assert.equal((html.match(/class="stream-tail"/g) ?? []).length, 8);
  assert.ok(html.includes(prefix));
  for (const character of tail) assert.ok(html.includes(`>${character}</span>`));
});

// 截图中的反斜杠分隔符必须在 Markdown 吞掉转义前识别，求和上下标交给 KaTeX。
test("截图中的行内及独立求和公式渲染为数学内容，兼容美元分隔符", () => {
  const text = "先看 \\(\\sum d\\)。\n\n对于原串 \\(s\\)，如果 \\(s_i\\ne s_{i+1}\\)，变化被包含在 \\(i(n-i)\\) 个子串中。\n\n所以：\n\n\\[\n\\sum d=\\sum_{i=1}^{n-1}[s_i\\ne s_{i+1}]\\cdot i(n-i)\n\\]\n\n再看 \\(\\sum(d\\bmod 2)\\)。";
  const html = renderToStaticMarkup(createElement(MessageMarkdown, { text }));
  assert.equal((html.match(/class="katex"/g) ?? []).length, 6);
  assert.equal((html.match(/class="katex-display"/g) ?? []).length, 1);
  assert.match(html, /<math xmlns="http:\/\/www.w3.org\/1998\/Math\/MathML"/);
  assert.match(html, /<munderover><mo>∑<\/mo>/);
  assert.doesNotMatch(html, /katex-error/);
  const dollars = renderToStaticMarkup(createElement(MessageMarkdown, { text: "$x_i^2+\\frac{1}{2}$\n\n$$\n\\sqrt{n}+\\sum_{i=1}^{n}i\n$$" }));
  assert.equal((dollars.match(/class="katex"/g) ?? []).length, 2);
  assert.match(dollars, /class="katex-display"/);
  assert.doesNotMatch(dollars, /katex-error/);
});

// 普通代码仍可复制原文，已有公式内的括号与链接地址不参与二次转换。
test("公式识别不改写行内代码、代码围栏、链接或已有公式", () => {
  const text = "行内 `\\(x\\) $y$`"
    + "\n\n~~~latex\n\\[\\sum i\\]\n$x$\n~~~\n\n[网页](https://example.com/\\(literal\\))\n\n正文 \\(x+1\\)";
  const normalized = normalizeMathDelimiters(text);
  assert.ok(normalized.includes("\\(x\\) $y$"));
  assert.ok(normalized.includes("\\[\\sum i\\]\n$x$"));
  assert.ok(normalized.includes("https://example.com/\\(literal\\)"));
  assert.equal(normalizeMathDelimiters("$\\text{\\(literal\\)}$"), "$\\text{\\(literal\\)}$");
  assert.equal(normalizeMathDelimiters("\\\\(literal\\\\)"), "\\\\(literal\\\\)");
  const html = renderToStaticMarkup(createElement(MessageMarkdown, { text }));
  assert.equal((html.match(/class="katex"/g) ?? []).length, 1);
  assert.match(html, /<code class="language-latex">/);
  assert.ok(html.includes("\\[\\sum i\\]"));
  assert.match(html, /复制代码/);
});

// 引用和列表中的公式沿用原层级；LaTeX 内的美元字符不能关闭 Markdown 数学区域。
test("公式保留引用及列表层级，也可显示正文中的美元字符", () => {
  const text = "> \\[\n> x^2+1\n> \\]\n\n- 推导：\n\n  \\[\n  y=\\frac{1}{2}\n  \\]\n\n\\(\\text{price \\$5}\\)";
  const html = renderToStaticMarkup(createElement(MessageMarkdown, { text }));
  assert.match(html, /<blockquote>\s*<span class="katex-display"/);
  assert.match(html, /<li>[\s\S]*class="katex-display"[\s\S]*<\/li>/);
  assert.equal((html.match(/class="katex"/g) ?? []).length, 3);
  assert.doesNotMatch(html, /katex-error/);
});

// 流式未完成或错误公式不让整条消息崩溃，渐变不得拆开数学字形与无障碍标记。
test("流式及无效公式可继续阅读，数学内容不插入渐变 span", () => {
  const partial = renderToStaticMarkup(createElement(MessageMarkdown, { text: "正在生成 \\(\\frac{1}{", streaming: true }));
  assert.match(partial, /正在生成/);
  const broken = renderToStaticMarkup(createElement(MessageMarkdown, { text: "\\(\\frac{1}{\\) 后续文字 $x+1$" }));
  assert.match(broken, /katex-error/);
  assert.match(broken, /后续文字/);
  assert.match(broken, /class="katex"/);
  const streamed = renderToStaticMarkup(createElement(MessageMarkdown, { text: "先看 \\(\\sum d\\)", streaming: true }));
  assert.match(streamed, /class="katex"/);
  assert.doesNotMatch(streamed, /stream-tail/);
});

// 数学命令仍不能请求远程图片、注入 HTML 或创建脚本与本地文件链接。
test("LaTeX 渲染不开放远程资源或可执行内容", () => {
  const text = "$\\includegraphics{https://example.com/tracker.png}$\n\n$\\href{javascript:alert(1)}{点击}$\n\n$\\href{file:///C:/secret}{文件}$\n\n$\\htmlClass{injected}{内容}$";
  const html = renderToStaticMarkup(createElement(MessageMarkdown, { text }));
  assert.doesNotMatch(html, /<img|<script|class="injected"|href="(?:javascript|file):/);
});
