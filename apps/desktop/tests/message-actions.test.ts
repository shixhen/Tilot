import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MetricsDetails } from "../src/workspace/message-actions.tsx";

// 缺失统计不能显示为零；真实的零缓存命中仍应正常显示。
test("统计浮层显示本轮请求与整数缓存命中率，区分未知值和零值", () => {
  const missing = renderToStaticMarkup(createElement(MetricsDetails, {}));
  assert.equal((missing.match(/暂无数据/g) ?? []).length, 6);
  const html = renderToStaticMarkup(createElement(MetricsDetails, { metrics: {
    firstTokenMs: 1250, tokensPerSecond: 24.56, inputTokens: 100, cachedTokens: 0, outputTokens: 50,
  } }));
  assert.match(html, /1.25 s/);
  assert.match(html, /24.6 token\/s/);
  assert.match(html, />0<\/dd>/);
  assert.match(html, /缓存未命中<\/dt><dd[^>]*>100<\/dd>/);
  assert.match(html, /本轮模型请求/);
  assert.match(html, /缓存命中率<\/dt><dd[^>]*>0%<\/dd>/);
  assert.doesNotMatch(html, /总 token|本次模型请求|输入 token|缓存命中包含在输入中/);
  const cached = renderToStaticMarkup(createElement(MetricsDetails, { metrics: {
    firstTokenMs: null, tokensPerSecond: null, inputTokens: 100, cachedTokens: 60, outputTokens: 50,
  } }));
  assert.match(cached, /缓存未命中<\/dt><dd[^>]*>40<\/dd>/);
  assert.match(cached, /缓存命中率<\/dt><dd[^>]*>60%<\/dd>/);
  assert.doesNotMatch(html, /暂无数据/);
  const metrics = { firstTokenMs: null, tokensPerSecond: null, inputTokens: 3, cachedTokens: 2, outputTokens: null };
  const rounded = renderToStaticMarkup(createElement(MetricsDetails, { metrics }));
  assert.match(rounded, /缓存命中率<\/dt><dd[^>]*>67%<\/dd>/);
  for (const inputTokens of [0, null]) {
    const unknown = renderToStaticMarkup(createElement(MetricsDetails, { metrics: { ...metrics, inputTokens, cachedTokens: 0 } }));
    assert.match(unknown, /缓存命中率<\/dt><dd[^>]*>暂无数据<\/dd>/);
    assert.doesNotMatch(unknown, /NaN|Infinity|>0%/);
  }
});
