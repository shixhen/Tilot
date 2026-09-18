import assert from "node:assert/strict";
import { test } from "node:test";
import type { ResponseOutputItem } from "openai/resources/responses/responses";
import { getResponseToolCalls, type ResponseTerminalEvent } from "@tilot/responses/output";

/** 构造终态测试数据；刻意允许非法输出，以模拟 SDK 收到未经运行时校验的 JSON。 */
function terminal(
  output: unknown[],
  status: "completed" | "failed" | "incomplete" = "completed",
): ResponseTerminalEvent {
  return {
    type: `response.${status}`,
    sequence_number: 1,
    response: {
      id: "resp_1", object: "response", created_at: 1,
      model: "deepseek-flash", status, output: output as ResponseOutputItem[], output_text: "",
      error: null, incomplete_details: null, instructions: null, metadata: null,
      parallel_tool_calls: true, temperature: null, top_p: null, tools: [], tool_choice: "auto",
    },
  };
}

/** 创建带独立输出项 id 和调用 call_id 的工具调用样本。 */
function toolCall(id = "item_1", callId = "call_1") {
  return { type: "function_call", id, call_id: callId, name: "read_file", arguments: "{}", status: "completed" };
}

test("文本与拒绝内容可正常结束，无工具调用", () => {
  const event = terminal([{
    type: "message", id: "msg_1", role: "assistant", status: "completed",
    content: [{ type: "output_text", text: "回答", annotations: [] }, { type: "refusal", refusal: "无法处理" }],
  }]);
  assert.deepEqual(getResponseToolCalls(event), []);
  assert.deepEqual(getResponseToolCalls(terminal([])), []);
});

test("混合输出按顺序提取工具，保留原始响应、推理和未知 usage", () => {
  const first = toolCall();
  const second = toolCall("item_2", "call_2");
  const reasoning = {
    type: "reasoning", id: "reason_1", summary: [],
    content: [{ type: "reasoning_text", text: "先检查项目结构" }],
  };
  const event = terminal([reasoning, first, second]);
  const original = structuredClone(event);
  const calls = getResponseToolCalls(event);
  assert.deepEqual(event, original);
  assert.deepEqual(calls, [first, second]);
  assert.equal(calls[0], first);
  assert.equal(event.response.output[0], reasoning);
  assert.equal(event.response.usage, undefined);
  // 兼容服务可能显式返回 null；它同样表示未知，不能改写成零用量。
  Reflect.set(event.response, "usage", null);
  getResponseToolCalls(event);
  assert.equal(event.response.usage, null);
});

test("失败和截断响应中的部分工具调用不进入可执行列表", () => {
  for (const status of ["failed", "incomplete"] as const) {
    const event = terminal([{ type: "function_call", arguments: "{" }], status);
    const original = structuredClone(event);
    assert.deepEqual(getResponseToolCalls(event), []);
    assert.deepEqual(event, original);
  }
});

test("终态与状态矛盾，以及成功响应携带错误信息，均拒绝", () => {
  const event = terminal([]);
  event.response.status = "incomplete";
  assert.throws(() => getResponseToolCalls(event), /状态不一致/);
  const errored = terminal([]);
  errored.response.error = { code: "server_error", message: "失败" };
  assert.throws(() => getResponseToolCalls(errored), /失败或截断信息/);
  const truncated = terminal([]);
  truncated.response.incomplete_details = { reason: "max_output_tokens" };
  assert.throws(() => getResponseToolCalls(truncated), /失败或截断信息/);
});

test("缺失响应 id 或 output 时拒绝", () => {
  const event = terminal([]);
  event.response.id = " ";
  assert.throws(() => getResponseToolCalls(event), /id 或 output/);
  const malformed = terminal([]);
  Reflect.deleteProperty(malformed.response, "output");
  assert.throws(() => getResponseToolCalls(malformed), /id 或 output/);
});

test("缺失或重复的输出项 id、call_id 均拒绝，但两种标识可同名", () => {
  const invalidOutputs = [
    [toolCall("", "call_1")],
    [toolCall("item_1", " ")],
    [toolCall(), toolCall("item_1", "call_2")],
    [toolCall(), toolCall("item_2", "call_1")],
  ];
  for (const output of invalidOutputs) {
    assert.throws(() => getResponseToolCalls(terminal(output)), /不能为空|重复/);
  }
  assert.equal(getResponseToolCalls(terminal([toolCall("same", "same")])).length, 1);
});

test("未知或未完成的输出项使整份成功响应失效", () => {
  const invalidItems = [
    null,
    { type: "custom_tool_call", id: "item_2" },
    { ...toolCall("item_2", "call_2"), status: "in_progress" },
    { ...toolCall("item_2", "call_2"), arguments: {} },
    { ...toolCall("item_2", "call_2"), name: " " },
    { type: "message", id: "msg_1", role: "user", status: "completed", content: [] },
    { type: "message", id: "msg_1", role: "assistant", status: "incomplete", content: [] },
    { type: "reasoning", id: "reason_1", status: "in_progress", content: [] },
  ];
  for (const item of invalidItems) {
    assert.throws(() => getResponseToolCalls(terminal([toolCall(), item])));
  }
});

test("推理缺失正文、正文格式损坏或未知内容块均拒绝", () => {
  const invalidItems = [
    { type: "reasoning", id: "reason_1", summary: [{ type: "summary_text", text: "仅摘要" }] },
    { type: "reasoning", id: "reason_1", content: [{ type: "reasoning_text", text: 123 }] },
    { type: "message", id: "msg_1", role: "assistant", status: "completed", content: [null] },
    { type: "message", id: "msg_1", role: "assistant", status: "completed", content: [{ type: "audio" }] },
  ];
  for (const item of invalidItems) {
    assert.throws(() => getResponseToolCalls(terminal([item])), /content 数组|内容块/);
  }
});

test("arguments 保持原字符串，JSON 解析和参数校验交给 Tool", () => {
  const item = { ...toolCall(), arguments: "{invalid json" };
  assert.equal(getResponseToolCalls(terminal([item]))[0]?.arguments, item.arguments);
});
