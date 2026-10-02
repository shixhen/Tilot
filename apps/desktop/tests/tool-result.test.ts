import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ToolCall } from "../src/workspace/tool-call.tsx";
import { ToolResult } from "../src/workspace/tool-result.tsx";

/** 直接渲染工具结果，与工具卡片展开后使用同一组件。 */
function render(name: string, result: Record<string, unknown>): string {
  return renderToStaticMarkup(createElement(ToolResult, { name, result, output: JSON.stringify(result) }));
}

test("edit 展示已保存的差异、替换数和首行，新增删除区分颜色并转义 HTML", () => {
  const result = { status: "ok", data: { path: "code.ts", bytesWritten: 20, replacements: 2, firstChangedLine: 4,
    diff: '--- a/code.ts\n+++ b/code.ts\n@@ -1,1 +1,2 @@\n-旧\r\n+<script>alert("x")</script>\r\n+++ 内容\n', diffTruncated: false,
  } };
  const html = render("edit", result);
  assert.match(html, /完成 2 处替换/);
  assert.match(html, /首个变更在第 4 行/);
  assert.match(html, /文件修改差异/);
  assert.match(html, /text-diff-added/);
  assert.match(html, /text-diff-removed/);
  assert.match(html, /text-diff-added[^>]*>\+\+\+ 内容/);
  assert.match(html, /&lt;script&gt;/);
  assert.doesNotMatch(html, /<script>|bytesWritten|差异已截断|\r/);
});

test("截断差异标出不完整，完整差异不显示截断提示", () => {
  const data = { diff: "--- a/code.ts\n+++ b/code.ts\n@@ -1 +1 @@\n+部分", diffTruncated: true };
  assert.match(render("edit", { status: "ok", data }), /差异已截断.*不能作为完整补丁应用/);
  assert.doesNotMatch(render("edit", { status: "ok", data: { ...data, diffTruncated: false } }), /截断/);
});

test("旧 edit 历史显示路径、状态和原始结果，错误优先显示，其他工具文本继续转义", () => {
  const result = { status: "ok", data: { path: "old.ts", bytesWritten: 12 } };
  assert.match(render("edit", result), /bytesWritten/);
  assert.doesNotMatch(render("edit", result), /文件修改差异/);
  const argumentsJson = JSON.stringify({ path: "old.ts", oldText: "旧", newText: "新" });
  const html = renderToStaticMarkup(createElement(ToolCall, { active: false, tool: {
    id: "old", outputIndex: 0, name: "edit", arguments: argumentsJson, output: JSON.stringify(result), running: false,
  } }));
  assert.match(html, /编辑文件/);
  assert.match(html, /old.ts/);
  assert.match(html, /已完成/);
  const failed = render("edit", { status: "error", error: "重新读取文件", data: { diff: "无效差异" } });
  assert.match(failed, /重新读取文件/);
  assert.doesNotMatch(failed, /无效差异/);
  assert.match(render("read", { status: "ok", data: { content: "<img src=x>" } }), /&lt;img src=x&gt;/);
  assert.match(render("shell", { status: "ok", data: { output: "shell 内容" } }), /shell 内容/);
});

test("命令卡片预览实时输出并转义 HTML，日志读取和日志失败有明确状态", () => {
  const tool = { id: "shell", outputIndex: 0, name: "shell", arguments: '{"command":"检查"}', output: null, running: true,
    preview: { output: "<script>测试</script>", truncated: true, partialLine: true },
  };
  const preview = renderToStaticMarkup(createElement(ToolCall, { active: true, tool }));
  assert.match(preview, /命令临时输出/);
  assert.match(preview, /&lt;script&gt;测试&lt;\/script&gt;/);
  assert.match(preview, /执行结果尚未保存/);
  assert.match(preview, /仅显示末尾内容.*首行仅保留部分内容/);
  assert.doesNotMatch(preview, /<script>/);
  const saved = renderToStaticMarkup(createElement(ToolCall, { active: false, tool: { ...tool, running: false,
    output: JSON.stringify({ status: "ok", data: { status: "completed", exitCode: 0, output: "实际输出", logError: "写入失败" } }),
  } }));
  assert.match(saved, /命令完成，日志保存失败/);
  assert.doesNotMatch(saved, /命令临时输出/);
  const logRead = renderToStaticMarkup(createElement(ToolCall, { active: false, tool: { id: "read", outputIndex: 1,
    name: "read", arguments: '{"outputId":"test-id"}', running: false, output: '{"status":"ok"}',
  } }));
  assert.match(logRead, /命令日志/);
  assert.doesNotMatch(logRead, /参数无效/);
});

test("目录和文件搜索显示相对路径、类型、空结果与不完整提示", () => {
  const html = render("ls", { status: "ok", data: { entries: [
    { path: "src", type: "directory" }, { path: "外部目录", type: "link" }, { path: "<img>.ts", type: "file" },
  ], truncated: true } });
  assert.match(html, /显示 3 个目录项/);
  assert.match(html, /src\/.*外部目录（链接）.*&lt;img&gt;.ts/s);
  assert.match(html, /结果已截断，请缩小/);
  assert.doesNotMatch(html, /末尾内容|<img>|&quot;entries&quot;/);
  assert.match(render("find", { status: "ok", data: { files: ["src/你好.ts"], truncated: false } }), /显示 1 个文件.*src\/你好.ts/s);
  assert.match(render("ls", { status: "ok", data: { entries: [] } }), /空目录/);
  assert.match(render("find", { status: "ok", data: { files: [] } }), /没有匹配文件/);
  for (const [name, label, args] of [
    ["ls", "列出目录", {}], ["find", "查找文件", { pattern: "*.ts" }], ["grep", "搜索代码", { pattern: "needle" }],
  ] as const) {
    const card = renderToStaticMarkup(createElement(ToolCall, { active: false, tool: {
      id: name, outputIndex: 0, name, arguments: JSON.stringify(args), output: '{"status":"ok"}', running: false,
    } }));
    assert.match(card, new RegExp(label));
    assert.ok(card.includes(name === "ls" ? "项目根目录" : args.pattern));
  }
});

test("代码搜索展示匹配和上下文行号并转义文本，无效历史结构回到原文", () => {
  const html = render("grep", { status: "ok", data: { matches: [
    { path: "src/你好.ts", line: 2, text: "<script>内容</script>", textTruncated: true,
      before: [{ line: 1, text: "前文", textTruncated: false }], after: [{ line: 3, text: "后文", textTruncated: false }] },
  ], truncated: true } });
  assert.match(html, /显示 1 条匹配行/);
  assert.match(html, /src\/你好.ts-1- 前文/);
  assert.match(html, /src\/你好.ts:2: &lt;script&gt;内容&lt;\/script&gt;（行已截断）/);
  assert.match(html, /src\/你好.ts-3- 后文/);
  assert.match(html, /结果已截断/);
  assert.doesNotMatch(html, /<script>|末尾内容/);
  assert.match(render("grep", { status: "ok", data: { matches: [] } }), /没有匹配内容/);
  assert.match(render("grep", { status: "error", error: "无效正则", data: { matches: [] } }), /无效正则/);
  assert.match(render("grep", { status: "ok", data: { matches: [null] } }), /&quot;matches&quot;/);
});

test("网页结果显示标题、来源和时间，正文仅作为文本，缓存续读沿用网页名称", () => {
  const data = { title: "网页标题", url: "https://example.com", finalUrl: "https://example.com/docs", fetchedAt: 1790900000000,
    content: '<script>alert("x")</script>\n![图片](https://example.com/image)', outputId: "web-id", nextByteOffset: 51200,
  };
  const html = render("web_fetch", { status: "ok", data });
  assert.match(html, /网页标题/);
  assert.match(html, /来源：.*href="https:\/\/example.com\/docs"/);
  assert.match(html, /抓取时间：/);
  assert.match(html, /网页正文/);
  assert.match(html, /&lt;script&gt;/);
  assert.doesNotMatch(html, /<script>|<img/);
  assert.match(render("web_fetch", { status: "ok", data: { ...data, finalUrl: "javascript:alert(1)" } }), /网页正文/);
  assert.doesNotMatch(render("web_fetch", { status: "ok", data: { ...data, finalUrl: "javascript:alert(1)" } }), /href=|javascript:/);
  const card = renderToStaticMarkup(createElement(ToolCall, { active: false, tool: {
    id: "web", outputIndex: 0, name: "web_fetch", arguments: '{"outputId":"web-id"}', output: JSON.stringify({ status: "ok", data }), running: false,
  } }));
  assert.match(card, /读取网页.*https:\/\/example.com\/docs/s);
  assert.doesNotMatch(card, /执行命令|命令日志/);
  assert.match(render("web_fetch", { status: "error", error: "HTTP 403" }), /HTTP 403/);
});
