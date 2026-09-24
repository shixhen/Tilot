import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MessageMarkdown, webURL } from "../src/workspace/markdown.tsx";

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

// 模型内容不得执行 HTML、加载远程图片或把文件/脚本链接交给系统打开。
test("Markdown 拒绝可执行内容与非网页链接，不生成图片请求", () => {
  const html = renderToStaticMarkup(createElement(MessageMarkdown, { text: '<script>alert(1)</script>\n\n[脚本](javascript:alert%281%29) [文件](file:///C:/secret) [网页](https://example.com)\n\n![说明](https://example.com/tracker.png)' }));
  assert.doesNotMatch(html, /<script|<img|src=|href="(?:javascript|file):/);
  assert.match(html, /href="https:\/\/example.com"/);
  assert.match(html, /\[图片：说明\]/);
  for (const url of ["/relative", "//example.com", "mailto:user@example.com", "data:text/html,test"]) assert.equal(webURL(url), "");
});
