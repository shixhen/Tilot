import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { AttemptView, ResponseMetrics } from "@tilot/protocol";
import type { Request } from "../src/client.ts";
import { applyEvent, loadConversation, mergeHistory, type TurnRecord } from "../src/conversation.ts";
import { getRequestMetrics, getTurnMetrics } from "../src/request-metrics.ts";
import { MetricsDetails } from "../src/workspace/message-actions.tsx";
import { TurnMessages } from "../src/workspace/transcript.tsx";
import { TooltipProvider } from "../src/components/ui/tooltip.tsx";

/** 构造独立请求记录；同一请求可含多条消息和工具，但只产生一份服务端用量。 */
function attempt(sequence: number, metrics: Partial<ResponseMetrics> = {}): AttemptView {
  return {
    id: `attempt-${sequence}`, turnId: "turn", sequence, inputThroughId: 1,
    status: "completed", error: null, createdAt: 1200 + (sequence - 1) * 20000, finishedAt: 3000 + (sequence - 1) * 20000,
    messages: [], tools: [],
    metrics: { firstTokenMs: 250, durationMs: 1250, inputTokens: 100, cachedTokens: 60, outputTokens: 20, ...metrics },
  };
}

function record(attempts: AttemptView[]): TurnRecord {
  return {
    turn: { id: "turn", threadId: "thread", sequence: 1, permissionMode: "read-only", status: "completed", createdAt: 1000, finishedAt: 90000, error: null },
    inputs: [{ id: 1, turnId: "turn", content: "任务", createdAt: 1000 }], attempts, previews: [],
  };
}

test("整轮累计全部模型请求，同一请求的思考、消息及工具不会重复计数，比例按合计计算", () => {
  const first = attempt(1, { inputTokens: 100, cachedTokens: 100, outputTokens: 50, firstTokenMs: 500, durationMs: 2000 });
  first.messages = [
    { itemId: "reasoning", outputIndex: 0, parts: [{ kind: "reasoning", text: "思考" }] },
    { itemId: "message", outputIndex: 1, parts: [{ kind: "text", text: "先读文件" }] },
  ];
  first.tools = [{ id: "tool", outputIndex: 2, name: "read", arguments: "{}", output: "文件内容", running: false }];
  const second = attempt(2, { inputTokens: 300, cachedTokens: 30, outputTokens: 100, firstTokenMs: 3000, durationMs: 8000 });
  const metrics = getTurnMetrics(record([first, second]));
  assert.equal(metrics.requestCount, 2);
  assert.equal(metrics.inputTokens, 400);
  assert.equal(metrics.cachedTokens, 130);
  assert.equal(metrics.outputTokens, 150);
  assert.equal(metrics.firstTokenMs, 700);
  assert.equal(metrics.tokensPerSecond, 150 / 6.5);
  const html = renderToStaticMarkup(createElement(MetricsDetails, { metrics }));
  assert.match(html, /缓存命中率<\/dt><dd[^>]*>33%<\/dd>/);
  assert.match(html, /缓存未命中<\/dt><dd[^>]*>270<\/dd>/);
  assert.match(html, /输出 token<\/dt><dd[^>]*>150<\/dd>/);
  assert.match(html, /23\.1 token\/s/);
});

test("失败、截断、取消和中断的已返回用量均计入，汇总函数只依赖原始请求集合", () => {
  const attempts = ["completed", "failed", "incomplete", "cancelled", "interrupted"].map((status, index) => ({
    ...attempt(index + 1), status: status as AttemptView["status"],
  }));
  assert.deepEqual(getRequestMetrics(attempts), {
    requestCount: 5, finishedRequestCount: 5, missingUsageCount: 0,
    inputTokens: 500, cachedTokens: 300, outputTokens: 100, tokensPerSecond: 20,
  });
});

test("运行中的请求不补零，终态快照替换原记录，重复事件不重复累计", () => {
  const running = { ...attempt(2), status: "running" as const };
  delete running.metrics;
  let records = [record([attempt(1), running])];
  records[0]!.turn.status = "running";
  const current = getTurnMetrics(records[0]!);
  assert.equal(current.requestCount, 2);
  assert.equal(current.finishedRequestCount, 1);
  assert.equal(current.missingUsageCount, 0);
  assert.equal(current.outputTokens, 20);
  const event = { event: "attempt.updated" as const, threadId: "thread", turnId: "turn", seq: 1, attempt: attempt(2) };
  records = applyEvent(applyEvent(records, event), event);
  assert.equal(getTurnMetrics(records[0]!).outputTokens, 40);
  assert.equal(getTurnMetrics(records[0]!).requestCount, 2);
});

test("缺失用量只使对应合计未知，不误用部分和；旧计时缺失时不估算 TPS", () => {
  const partial = getTurnMetrics(record([attempt(1), attempt(2, { cachedTokens: null })]));
  assert.equal(partial.missingUsageCount, 1);
  assert.equal(partial.inputTokens, 200);
  assert.equal(partial.outputTokens, 40);
  assert.equal(partial.cachedTokens, null);
  const missing = attempt(2);
  delete missing.metrics;
  const unknown = getTurnMetrics(record([attempt(1), missing]));
  assert.equal(unknown.inputTokens, null);
  assert.equal(unknown.outputTokens, null);
  assert.equal(unknown.tokensPerSecond, null);
  const old = getTurnMetrics(record([attempt(1, { firstTokenMs: null, durationMs: null }), attempt(2)]));
  assert.equal(old.firstTokenMs, null);
  assert.equal(old.tokensPerSecond, null);
  assert.equal(old.outputTokens, 40);
});

test("迟到的运行中历史不能覆盖失败请求的终态用量或减少已结束请求次数", () => {
  const failed = { ...attempt(1), status: "failed" as const, error: "诊断" };
  const live = record([failed]);
  live.turn.status = "failed";
  const running = { ...attempt(1), status: "running" as const };
  delete running.metrics;
  const old = record([running]);
  old.turn.status = "running";
  const merged = mergeHistory([live], [old])[0]!;
  assert.equal(merged.attempts[0]!.status, "failed");
  assert.equal(getTurnMetrics(merged).outputTokens, 20);
  assert.equal(getTurnMetrics(merged).finishedRequestCount, 1);
});

test("零用量保留为零，无输出请求不计生成时间，首 token 从轮次开始到首次实际输出", () => {
  const empty = attempt(1, { firstTokenMs: null, durationMs: 200, inputTokens: 0, cachedTokens: 0, outputTokens: 0 });
  const zero = getTurnMetrics(record([empty]));
  assert.equal(zero.inputTokens, 0);
  assert.equal(zero.cachedTokens, 0);
  assert.equal(zero.outputTokens, 0);
  assert.equal(zero.tokensPerSecond, null);
  const next = { ...attempt(2), createdAt: 2000 };
  const metrics = getTurnMetrics(record([empty, next]));
  assert.equal(metrics.firstTokenMs, 1250);
  assert.equal(metrics.tokensPerSecond, 20);
  const noDuration = getTurnMetrics(record([attempt(1, { durationMs: 250 })]));
  assert.equal(noDuration.tokensPerSecond, null);
  const noRequests = getTurnMetrics(record([]));
  assert.equal(noRequests.requestCount, 0);
  assert.equal(noRequests.outputTokens, null);
});

test("重新读取跨页历史后汇总所有请求，不遗漏第 100 次之后的请求", async () => {
  const saved = record(Array.from({ length: 120 }, (_, index) => attempt(index + 1)));
  const request = (async (method: string, params: { afterSequence?: number }) => {
    if (method === "turn.list") return [saved.turn];
    if (method === "turn.inputs") return saved.inputs;
    if (method === "turn.attempts") return JSON.parse(JSON.stringify(saved.attempts.slice(params.afterSequence ?? 0, (params.afterSequence ?? 0) + 100)));
    throw new Error(`不应调用 ${method}`);
  }) as Request;
  const loaded = await loadConversation(request, "thread");
  assert.deepEqual(getTurnMetrics(loaded[0]!), getTurnMetrics(saved));
  assert.equal(getTurnMetrics(loaded[0]!).requestCount, 120);
  assert.equal(getTurnMetrics(loaded[0]!).outputTokens, 2400);
});

test("中间正文没有操作栏，整轮结束后仅最后一条正文显示复制、时间和用量", () => {
  const first = attempt(1);
  first.messages = [{ itemId: "intermediate", outputIndex: 0, parts: [{ kind: "text", text: "先检查文件" }] }];
  first.tools = [{ id: "tool", outputIndex: 1, name: "read", arguments: '{}', output: null, running: true }];
  const current = record([first]);
  current.turn.status = "running";
  current.turn.finishedAt = null;
  current.previews = [{ itemId: "answer", parts: [{ kind: "text", text: "还在继续生成" }], complete: false }];
  const render = (saved: TurnRecord) => renderToStaticMarkup(createElement(TooltipProvider, null,
    createElement(TurnMessages, { record: saved, onEdit: () => {} })));
  const running = render(current);
  assert.match(running, /先检查文件|还在继续生成/);
  assert.match(running, /1 次工具调用/);
  assert.doesNotMatch(running, /aria-label="本轮模型请求统计"/);
  assert.equal((running.match(/aria-label="复制消息"/g) ?? []).length, 1);
  assert.match(running, /aria-label="编辑消息"/);
  assert.equal((running.match(/<time\b/g) ?? []).length, 1);
  assert.ok(running.includes(new Date(current.inputs[0]!.createdAt).toISOString()));
  assert.match(running, /group-hover\/message:opacity-100/);
  // 按轮次判断，而不是看某个请求、工具或正文是否已经完成。
  assert.equal(getTurnMetrics(current).finishedRequestCount, 1);
  for (const status of ["completed", "failed", "cancelled", "interrupted"] as const) {
    const ended = { ...current, turn: { ...current.turn, status, finishedAt: 90000 } };
    const html = render(ended);
    assert.match(html, /aria-label="本轮模型请求统计"/);
    assert.match(html, /aria-label="复制消息"/);
    assert.match(html, /aria-label="编辑消息"/);
    assert.equal((html.match(/aria-label="复制消息"/g) ?? []).length, 2);
    assert.equal((html.match(/aria-label="本轮模型请求统计"/g) ?? []).length, 1);
    const replies = [...html.matchAll(/<article\b[^>]*>[\s\S]*?<\/article>/g)].map(([article]) => article);
    if (status === "completed") {
      assert.equal(replies.length, 1);
      assert.doesNotMatch(html, /先检查文件/);
    } else {
      assert.equal(replies.length, 2);
      assert.match(replies[0]!, /先检查文件/);
      assert.doesNotMatch(replies[0]!, /aria-label="复制消息"|aria-label="本轮模型请求统计"|<time\b/);
    }
    assert.match(replies.at(-1)!, /aria-label="复制消息"/);
    assert.match(replies.at(-1)!, /aria-label="本轮模型请求统计"/);
  }
  const previous = record([first]);
  assert.match(render(previous), /aria-label="本轮模型请求统计"/);
});

test("没有正文的轮次不附加用量入口，结束后也不将统计挂在过程块下方", () => {
  const current = record([attempt(1)]);
  current.turn.status = "running";
  const render = () => renderToStaticMarkup(createElement(TooltipProvider, null, createElement(TurnMessages, { record: current })));
  assert.doesNotMatch(render(), /aria-label="本轮模型请求统计"/);
  for (const status of ["completed", "failed", "cancelled", "interrupted"] as const) {
    current.turn.status = status;
    assert.doesNotMatch(render(), /aria-label="本轮模型请求统计"/);
  }
});

test("没有正文的失败轮次保留错误提示，不附加统计图标", () => {
  const failed = record([{ ...attempt(1), status: "failed", error: "失败" }]);
  failed.turn.status = "failed";
  const html = renderToStaticMarkup(createElement(TooltipProvider, null, createElement(TurnMessages, { record: failed })));
  assert.match(html, /生成失败/);
  assert.doesNotMatch(html, /aria-label="本轮模型请求统计"/);
});
