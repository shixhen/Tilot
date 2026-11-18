import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MetricsDetails } from "../src/workspace/message-actions.tsx";

// 缺失统计不能显示为零；真实的零缓存命中仍应正常显示。
test("统计浮层显示本轮累计与整数缓存命中率，区分未知值和零值", () => {
  const counts = { requestCount: 3, finishedRequestCount: 3, missingUsageCount: 0 };
  const missing = renderToStaticMarkup(createElement(MetricsDetails, {}));
  assert.equal((missing.match(/暂无数据/g) ?? []).length, 9);
  const html = renderToStaticMarkup(createElement(MetricsDetails, { metrics: {
    firstTokenMs: 1250, tokensPerSecond: 24.56, inputTokens: 100, cachedTokens: 0, outputTokens: 50,
    ...counts,
  } }));
  assert.match(html, /1.25 s/);
  assert.match(html, /24.6 token\/s/);
  assert.match(html, />0<\/dd>/);
  assert.match(html, /缓存未命中<\/dt><dd[^>]*>100<\/dd>/);
  assert.match(html, /本轮模型请求/);
  assert.match(html, /模型请求次数<\/dt><dd[^>]*>3<\/dd>/);
  assert.match(html, /缓存命中率<\/dt><dd[^>]*>0%<\/dd>/);
  assert.doesNotMatch(html, /总 token|本次模型请求|输入 token|缓存命中包含在输入中/);
  const cached = renderToStaticMarkup(createElement(MetricsDetails, { metrics: {
    firstTokenMs: null, tokensPerSecond: null, inputTokens: 100, cachedTokens: 60, outputTokens: 50,
    ...counts,
  } }));
  assert.match(cached, /缓存未命中<\/dt><dd[^>]*>40<\/dd>/);
  assert.match(cached, /缓存命中率<\/dt><dd[^>]*>60%<\/dd>/);
  assert.doesNotMatch(html, /暂无数据/);
  const metrics = { ...counts, firstTokenMs: null, tokensPerSecond: null, inputTokens: 3, cachedTokens: 2, outputTokens: null };
  const rounded = renderToStaticMarkup(createElement(MetricsDetails, { metrics }));
  assert.match(rounded, /缓存命中率<\/dt><dd[^>]*>67%<\/dd>/);
  for (const inputTokens of [0, null]) {
    const unknown = renderToStaticMarkup(createElement(MetricsDetails, { metrics: { ...metrics, inputTokens, cachedTokens: 0 } }));
    assert.match(unknown, /缓存命中率<\/dt><dd[^>]*>暂无数据<\/dd>/);
    assert.doesNotMatch(unknown, /NaN|Infinity|>0%/);
  }
});

test("统计浮层标明未结束请求和缺失用量，不将部分统计显示为完整数据", () => {
  const html = renderToStaticMarkup(createElement(MetricsDetails, { metrics: {
    requestCount: 3, finishedRequestCount: 2, missingUsageCount: 1,
    firstTokenMs: 100, tokensPerSecond: null, inputTokens: null, cachedTokens: null, outputTokens: null,
  } }));
  assert.match(html, /已汇总 2 次已结束请求/);
  assert.match(html, /1 次请求缺少部分用量/);
  assert.match(html, /输出 token<\/dt><dd[^>]*>暂无数据<\/dd>/);
  assert.match(html, /本轮费用<\/dt><dd[^>]*>暂无数据<\/dd>/);
});

test("费用按固定人民币价格计算，区分缓存与普通输入，保留微小费用和真实零值", () => {
  const cases = [
    { inputTokens: 1_000_000, cachedTokens: 1_000_000, outputTokens: 0, expected: "¥0.0200" },
    { inputTokens: 1_000_000, cachedTokens: 0, outputTokens: 0, expected: "¥1.0000" },
    { inputTokens: 0, cachedTokens: 0, outputTokens: 1_000_000, expected: "¥4.0000" },
    { inputTokens: 2_000_000, cachedTokens: 1_000_000, outputTokens: 1_000_000, expected: "¥5.0200" },
    { inputTokens: 1, cachedTokens: 1, outputTokens: 0, expected: "¥0.00000002" },
    { inputTokens: 0, cachedTokens: 0, outputTokens: 0, expected: "¥0.0000" },
  ];
  for (const { expected, ...tokens } of cases) {
    const html = renderToStaticMarkup(createElement(MetricsDetails, { metrics: {
      ...tokens, requestCount: 1, finishedRequestCount: 1, missingUsageCount: 0,
      firstTokenMs: null, tokensPerSecond: null,
    } }));
    assert.ok(html.includes(`本轮费用</dt><dd class="text-right tabular-nums">${expected}</dd>`), expected);
  }
});
