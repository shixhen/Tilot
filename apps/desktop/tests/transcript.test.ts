import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { AttemptView, ToolView } from "@tilot/protocol";
import type { TurnRecord } from "../src/conversation.ts";
import { TooltipProvider } from "../src/components/ui/tooltip.tsx";
import { listTranscriptBlocks, TurnMessages } from "../src/workspace/transcript.tsx";

function record(): TurnRecord {
  return {
    turn: { id: "turn", threadId: "thread", sequence: 1, permissionMode: "read-only", status: "running", createdAt: 1000, finishedAt: null, error: null },
    inputs: [{ id: 1, turnId: "turn", content: "原任务", createdAt: 1000 }], attempts: [], previews: [],
  };
}

function attempt(sequence: number, inputThroughId = 1): AttemptView {
  return { id: `attempt-${sequence}`, turnId: "turn", sequence, inputThroughId, status: "completed", error: null,
    createdAt: 1000, finishedAt: 2000, messages: [], tools: [] };
}

function tool(id: string): ToolView {
  return { id, outputIndex: 1, name: "read", arguments: '{"path":"file.ts"}', output: '{"status":"ok"}', running: false };
}

function render(current: TurnRecord): string {
  return renderToStaticMarkup(createElement(TooltipProvider, null, createElement(TurnMessages, { record: current })));
}

function processStates(html: string): string[] {
  return [...html.matchAll(/<div\b[^>]*\bdata-process="[^"]+"[^>]*>/g)].map(([tag]) => {
    assert.match(tag, /data-state="(?:open|closed)"/);
    return tag.includes('data-state="open"') ? "open" : "closed";
  });
}

test("跨请求合并连续思考与工具，中间正文仅随整轮总开关收起", () => {
  const current = record();
  const first = attempt(1);
  first.messages = [{ itemId: "first", outputIndex: 0, parts: [{ kind: "reasoning", text: "第一次推理" }] }];
  first.tools = [tool("read-1")];
  const second = attempt(2);
  second.messages = [{ itemId: "second", outputIndex: 0, parts: [{ kind: "reasoning", text: "第二次推理" }] }];
  const third = attempt(3);
  third.messages = [{ itemId: "mixed", outputIndex: 0, parts: [
    { kind: "text", text: "文件已检查，继续验证。" }, { kind: "refusal", text: "需要保留的说明。" },
    { kind: "reasoning", text: "继续推理" },
  ] }];
  third.tools = [tool("read-2")];
  current.attempts = [first, second, third];
  current.previews = [{ itemId: "answer", parts: [{ kind: "text", text: "这是最终正文。" }], complete: false }];
  const blocks = listTranscriptBlocks(current);
  assert.deepEqual(blocks.map((block) => block.kind), ["input", "process", "message", "process", "message"]);
  const processes = blocks.filter((block) => block.kind === "process");
  assert.deepEqual(processes.map((block) => block.entries.map((entry) => entry.kind)), [["reasoning", "tool", "reasoning"], ["reasoning", "tool"]]);
  const body = blocks[2];
  assert.equal(body?.kind, "message");
  assert.equal(body.parts.length, 2);
  // 运行中和异常结束仍展示中间正文，成功后总开关默认收起全部过程。
  for (const status of ["running", "completed", "failed", "cancelled", "interrupted"] as const) {
    current.turn.status = status;
    const html = render(current);
    const text = html.replace(/<[^>]*>/g, "");
    if (status === "completed") {
      assert.deepEqual(processStates(html), []);
      assert.doesNotMatch(text, /文件已检查，继续验证。|需要保留的说明。/);
    } else {
      assert.deepEqual(processStates(html), ["closed", "closed"]);
      assert.match(text, /文件已检查，继续验证。/);
      assert.match(text, /需要保留的说明。/);
    }
    assert.match(text, /这是最终正文。/);
    assert.doesNotMatch(text, /第一次推理|第二次推理|继续推理/);
  }
});

test("用户补充消息分隔过程，只有当前块默认展开，轮次结束全部收起", () => {
  const current = record();
  const first = attempt(1);
  first.tools = [tool("read-1")];
  current.inputs.push({ id: 2, turnId: "turn", content: "补充要求", createdAt: 2000 });
  const second = attempt(2, 2);
  second.messages = [{ itemId: "reasoning", outputIndex: 0, parts: [{ kind: "reasoning", text: "补充后的推理", timing: { startedAt: 2100, durationMs: 1250 } }] }];
  second.tools = [tool("read-2")];
  current.attempts = [first, second];
  const blocks = listTranscriptBlocks(current);
  assert.deepEqual(blocks.map((block) => block.kind), ["input", "process", "input", "process"]);
  const html = render(current);
  assert.deepEqual(processStates(html), ["closed", "open"]);
  assert.match(html, /补充要求/);
  assert.match(html, /耗时 1.3s/);
  assert.match(html, /读取文件/);
  assert.match(html, /正在思考/);
  assert.match(html, /1 次思考 · 1 次工具调用/);
  current.turn.status = "cancelled";
  assert.deepEqual(processStates(render(current)), ["closed", "closed"]);
});

test("等待、流式思考、持久化和后续工具共用稳定过程标识，空正文不拆块", () => {
  const current = record();
  const waiting = listTranscriptBlocks(current).at(-1)!;
  assert.equal(waiting.kind, "process");
  assert.equal(waiting.entries.length, 0);
  current.previews = [{ itemId: "reasoning", parts: [{ kind: "reasoning", text: "开始推理" }, { kind: "text", text: "" }], complete: false }];
  const streamed = listTranscriptBlocks(current).at(-1)!;
  assert.equal(streamed.kind, "process");
  assert.equal(streamed.key, waiting.key);
  assert.equal(streamed.entries.length, 1);
  const first = attempt(1);
  first.messages = [{ itemId: "reasoning", outputIndex: 0, parts: current.previews[0]!.parts }];
  first.tools = [tool("read-1"), { ...tool("read-2"), outputIndex: 2 }];
  current.attempts = [first];
  current.previews = [];
  const saved = listTranscriptBlocks(current).at(-1)!;
  assert.equal(saved.kind, "process");
  assert.equal(saved.key, waiting.key);
  assert.deepEqual(saved.entries.map((entry) => entry.kind), ["reasoning", "tool", "tool"]);
});

test("标题按单块运行状态切换，所有工具即使尚未执行也算命令", () => {
  for (const name of ["read", "write", "edit", "shell", "ls", "find", "grep", "web_fetch"]) {
    const current = record();
    const first = attempt(1);
    first.tools = [{ ...tool("unstarted"), name, startedAt: null, durationMs: null, output: '{"status":"not_executed"}' }];
    current.attempts = [first];
    assert.match(render(current), /正在思考/);
    current.previews = [{ itemId: "mixed", parts: [{ kind: "text", text: "继续下一步" }, { kind: "reasoning", text: "再想一想" }], complete: false }];
    const during = render(current);
    assert.match(during, /已运行命令/);
    assert.match(during, /正在思考/);
    assert.match(during, /1 次工具调用/);
    assert.doesNotMatch(during, /次思考/);
    // 异常结束时总开关默认展开，仍能检查各过程块的结束文案。
    current.turn.status = "cancelled";
    const ended = render(current);
    assert.match(ended, /已运行命令/);
    assert.match(ended, /已完成思考/);
    assert.doesNotMatch(ended, /正在思考/);
  }
});

test("整轮总开关覆盖全部中间正文和过程块，保留补充输入及最终结果", () => {
  const current = record();
  const first = attempt(1);
  first.messages = [{ itemId: "first", outputIndex: 0, parts: [
    { kind: "reasoning", text: "第一段思考" }, { kind: "text", text: "第一段中间输出" },
  ] }];
  first.tools = [tool("read-1")];
  const second = attempt(2, 2);
  second.messages = [{ itemId: "second", outputIndex: 0, parts: [
    { kind: "reasoning", text: "第二段思考" }, { kind: "text", text: "第二段中间输出" },
  ] }];
  second.tools = [tool("read-2")];
  current.inputs.push({ id: 2, turnId: "turn", content: "用户补充要求", createdAt: 2000 });
  current.attempts = [first, second];
  current.previews = [{ itemId: "answer", parts: [{ kind: "text", text: "最终任务结果" }], complete: true }];
  for (const status of ["running", "failed", "cancelled", "interrupted"] as const) {
    current.turn.status = status;
    const html = render(current);
    assert.match(html, /data-state="open"[^>]*data-turn-process="turn"/);
    // 用户补充消息两侧各是一段整体动画，而不是每个过程块分别动画。
    const controlled = html.match(/aria-controls="([^"]+)"/)![1]!.split(" ");
    assert.equal(controlled.length, 2);
    const ids = [...html.matchAll(/\sid="([^"]+)"/g)].map((match) => match[1]);
    assert.equal(new Set(ids).size, ids.length);
    for (const [, controls] of html.matchAll(/aria-controls="([^"]+)"/g)) {
      for (const id of controls!.split(" ")) assert.ok(ids.includes(id));
    }
    assert.match(html, /第一段中间输出/);
    assert.match(html, /第二段中间输出/);
    assert.match(html.replace(/<[^>]*>/g, ""), /最终任务结果/);
  }
  current.turn = { ...current.turn, status: "completed", finishedAt: 9000 };
  const ended = render(current);
  assert.match(ended, /data-state="closed"[^>]*data-turn-process="turn"/);
  assert.match(ended, /用时 8.0s/);
  assert.doesNotMatch(ended, /第一段中间输出|第二段中间输出/);
  assert.match(ended, /原任务/);
  assert.match(ended, /用户补充要求/);
  assert.match(ended, /最终任务结果/);
  assert.equal((ended.match(/aria-label="复制消息"/g) ?? []).length, 3);
  assert.equal((ended.match(/aria-label="本轮模型请求统计"/g) ?? []).length, 1);
});

test("没有补充消息时，全部中间正文及过程块共用一个整体动画容器", () => {
  const current = record();
  current.attempts = [1, 2].map((sequence) => ({ ...attempt(sequence),
    messages: [{ itemId: `message-${sequence}`, outputIndex: 0, parts: [
      { kind: "reasoning", text: `第 ${sequence} 段思考` }, { kind: "text", text: `第 ${sequence} 段中间正文` },
    ] }], tools: [tool(`read-${sequence}`)],
  }));
  current.previews = [{ itemId: "answer", parts: [{ kind: "text", text: "最终结果" }], complete: true }];
  const html = render(current);
  const controlled = html.match(/aria-controls="([^"]+)"/)![1]!.split(" ");
  assert.equal(controlled.length, 1);
  assert.match(html, /第 1 段中间正文/);
  assert.match(html, /第 2 段中间正文/);
  current.turn = { ...current.turn, status: "completed", finishedAt: 9000 };
  const ended = render(current);
  assert.doesNotMatch(ended, /中间正文/);
  assert.match(ended, /最终结果/);
});

test("只有思考的过程块不显示次数，运行时和结束后都保持简洁标题", () => {
  const current = record();
  current.attempts = [1, 2].map((sequence) => ({ ...attempt(sequence), messages: [
    { itemId: `thought-${sequence}`, outputIndex: 0, parts: [{ kind: "reasoning", text: "推理内容" }] },
  ] }));
  const running = render(current);
  assert.match(running, /正在思考/);
  assert.doesNotMatch(running, /次思考|次工具调用/);
  current.turn.status = "completed";
  const ended = render(current);
  assert.match(ended, /已完成思考/);
  assert.doesNotMatch(ended, /次思考|次工具调用/);
});

test("纯过程轮次不显示复制和用量操作，用户消息和正文操作分别保留", () => {
  const current = record();
  const first = attempt(1);
  first.messages = [{ itemId: "thought", outputIndex: 0, parts: [{ kind: "reasoning", text: "检查问题" }] }];
  first.tools = [{ ...tool("failed"), output: '{"status":"error","error":"失败"}' }];
  current.attempts = [first];
  current.turn.status = "completed";
  const processOnly = render(current);
  assert.equal((processOnly.match(/aria-label="复制消息"/g) ?? []).length, 1);
  assert.doesNotMatch(processOnly, /aria-label="本轮模型请求统计"|曾有.*失败/);
  current.previews = [{ itemId: "body", parts: [{ kind: "text", text: "正文回复" }], complete: true }];
  const withBody = render(current);
  assert.equal((withBody.match(/aria-label="复制消息"/g) ?? []).length, 2);
  assert.equal((withBody.match(/aria-label="本轮模型请求统计"/g) ?? []).length, 1);
});
