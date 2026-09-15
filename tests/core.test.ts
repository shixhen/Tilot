import { describe, expect, it, vi } from "vitest";
import { JournalCommitError } from "@tilot/agent-core";
import type { HistoryEntry, ModelProvider, ProviderEvent, ToolResult } from "@tilot/agent-core";
import { MemoryJournal, createDemoProvider } from "../packages/runtime/src/index.js";
import { call, deferred, events, harness, reply, turn } from "./support.js";

describe("完整模型结果与历史", () => {
  it("纯文本结束，预览不重复追加，释放期限订阅", async () => {
    const h = harness([events({ type: "text_delta", delta: "回" }, { type: "completed", turn: turn() })]);
    expect(await h.run()).toMatchObject({ status: "completed", outcome: "success", text: "回答", steps: 1, toolCalls: 0 });
    expect(h.preview).toHaveBeenCalledOnce();
    expect(h.tools.execute).not.toHaveBeenCalled();
    expect(h.services.timers.size).toBe(0);
    expect(h.records().map(r => r.type)).toEqual(["run_started", "user", "model", "run_finished"]);
  });

  it("完整响应含工具时继续，模拟模型消费真实内存结果", async () => {
    const h = harness([]);
    const provider = createDemoProvider();
    const result = await h.run({}, { provider });
    expect(result).toMatchObject({ status: "completed", outcome: "success", steps: 3, toolCalls: 2 });
    expect(result.text).toContain("示例 项目/问候.ts:1");
    expect(h.tools.execute.mock.calls.map(([execution]) => execution.name)).toEqual(["list_files", "read_file"]);
    expect(h.tools.execute.mock.calls[1]![0].arguments).toMatchObject({ path: "示例 项目/问候.ts" });
    const model = h.records().find(r => r.type === "model");
    expect(provider.requests[1]!.history).toContainEqual(model);
    expect(provider.requests[1]!.history.at(-1)?.type).toBe("tool_results");
    expect(model?.type === "model" && model.intents[0]?.executionId).not.toBe("call-list");
  });

  it("同一步工具串行，开始前已有完整意图，后续请求保留对应结果和原始状态", async () => {
    const h = harness([reply(call("a"), call("b")), reply()]);
    const entered = deferred();
    const release = deferred<ToolResult>();
    h.tools.execute.mockImplementationOnce(async () => {
      expect(h.records().filter(r => r.type === "model")[0]?.intents).toHaveLength(2);
      entered.resolve();
      return release.promise;
    });
    const running = h.run();
    await entered.promise;
    expect(h.tools.execute).toHaveBeenCalledTimes(1);
    release.resolve({ status: "ok", summary: "第一项完成" });
    await running;
    const group = h.provider.requests[1]!.history.at(-1);
    expect(group?.type === "tool_results" && group.results.map(r => r.callId)).toEqual(["call-a", "call-b"]);
    const model = h.provider.requests[1]!.history.at(-2);
    expect(model?.type === "model" && model.turn.providerState).toEqual(turn().providerState);
    expect(h.tools.execute).toHaveBeenCalledTimes(2);
  });

  it.each([
    ["断流", [{ type: "tool_delta", delta: '{"name":"list_files"}' }]],
    ["失败", [{ type: "failed", message: "network" }]],
    ["冲突终态", [{ type: "completed", turn: turn([call()]) }, { type: "failed", message: "late" }]],
    ["重复终态", [{ type: "completed", turn: turn([call()]) }, { type: "completed", turn: turn() }]],
    ["未知事件", [{ type: "unsupported" }]],
  ])("%s 不提交模型意图或执行工具", async (_, sequence) => {
    const h = harness([events(...sequence as ProviderEvent[])]);
    expect((await h.run()).status).toBe("failed");
    expect(h.tools.execute).not.toHaveBeenCalled();
    expect(h.records().some(r => r.type === "model")).toBe(false);
    expect(h.records().some(r => r.type === "attempt_failed")).toBe(true);
  });

  it("拒绝同一响应或已有历史中的重复调用 ID", async () => {
    const h = harness([reply(call(), { ...call(), itemId: "different-item" })]);
    expect((await h.run()).reason).toBe("invalid_response");
    const prior = harness([reply(call()), reply()]);
    await prior.run();
    const history = prior.records().filter((r): r is HistoryEntry => ["user", "model", "tool_results"].includes(r.type));
    const next = harness([reply(call())]);
    expect((await next.run({ history })).reason).toBe("invalid_response");
    expect(next.tools.execute).not.toHaveBeenCalled();
  });

  it("已有历史缺少结果或存在 unknown 时，在任何记录和请求前拒绝", async () => {
    const model: HistoryEntry = { type: "model", stepId: "old-step", attemptId: "old-attempt", turn: turn([call()]), intents: [{ executionId: "old-execution", call: call() }] };
    const h = harness([reply()]);
    await expect(h.run({ history: [model] })).rejects.toThrow("Incomplete");
    await expect(h.run({ history: [model, { type: "tool_results", stepId: "old-step", results: [{ executionId: "old-execution", callId: "call-1", result: { status: "unknown", summary: "待核对" } }] }] })).rejects.toThrow("Unresolved");
    expect(h.provider.requests).toHaveLength(0);
    expect(h.records()).toHaveLength(0);
  });

  it("快照不随 Provider 后续修改变化，预览观察者异常不影响执行", async () => {
    const raw = { text: "原文", toolCalls: [], providerState: { output: ["原始推理"] } };
    const h = harness([async function* (request) {
      expect(Object.isFrozen(request.history)).toBe(true);
      yield { type: "text_delta", delta: "原" };
      yield { type: "completed", turn: raw };
      raw.text = "篡改";
      raw.providerState.output[0] = "篡改";
    }]);
    expect((await h.run({}, { onPreview: () => { throw new Error("UI disconnected"); } })).text).toBe("原文");
    expect(h.records().find(r => r.type === "model")?.turn.providerState).toEqual({ output: ["原始推理"] });
  });
});

describe("工具错误与预算", () => {
  it.each([
    [call("1", "missing"), "UNKNOWN_TOOL"],
    [call("1", "list_files", "{"), "INVALID_ARGUMENTS"],
    [call("1", "list_files", '{"projectId":"other"}'), "INVALID_ARGUMENTS"],
    [call("1", "list_files", '{"projectId":"memory-demo","extra":1}'), "INVALID_ARGUMENTS"],
  ])("非法调用形成结果供下一轮修正：%j", async (toolCall, code) => {
    const h = harness([reply(toolCall), reply()]);
    expect(await h.run()).toMatchObject({ status: "completed", outcome: "partial" });
    const group = h.provider.requests[1]!.history.at(-1);
    expect(group?.type === "tool_results" && group.results[0]?.result.error?.code).toBe(code);
    expect(h.tools.execute).not.toHaveBeenCalled();
  });

  it("工具抛错不自动重试，模型可在收到错误后继续", async () => {
    const h = harness([reply(call()), reply()]);
    h.tools.execute.mockRejectedValue(new Error("private implementation detail"));
    expect((await h.run()).outcome).toBe("partial");
    expect(h.tools.execute).toHaveBeenCalledOnce();
    expect(JSON.stringify(h.records())).not.toContain("private implementation detail");
  });

  it("写工具即使被注册也拒绝执行", async () => {
    const h = harness([reply(call("w", "write_file")), reply()]);
    const tools = { ...h.tools, definitions: [{ name: "write_file", description: "write", parameters: {}, effect: "write" as const }] };
    expect((await h.run({}, { tools })).outcome).toBe("partial");
    expect(h.tools.execute).not.toHaveBeenCalled();
  });

  it("三次同名、规范化参数、相同错误码停止", async () => {
    const h = harness([reply(call("1", "missing", '{"a":1,"b":2}')), reply(call("2", "missing", '{ "b": 2, "a": 1 }')), reply(call("3", "missing", '{"a":1,"b":2}'), call("4"))]);
    expect(await h.run()).toMatchObject({ reason: "repeated_error", steps: 3, toolCalls: 3 });
    expect(h.tools.execute).not.toHaveBeenCalled();
    const group = h.records().filter(r => r.type === "tool_results").at(-1)!;
    expect(group.results.map(r => r.result.status)).toEqual(["error", "denied"]);
  });

  it("成功调用会重置连续错误计数", async () => {
    const h = harness([reply(call("1", "missing"), call("2", "missing"), call("3"), call("4", "missing"), call("5", "missing")), reply()]);
    expect((await h.run()).status).toBe("completed");
  });

  it("相同错误码的动态说明不重置计数，不同错误码会重置", async () => {
    const steps = [reply(call("1")), reply(call("2")), reply(call("3")), reply()];
    const same = harness(steps);
    let index = 0;
    same.tools.execute.mockImplementation(async () => ({ status: "error", summary: `第 ${++index} 次`, error: { code: "READ_FAILED", message: `失败 ${index}` } }));
    expect((await same.run()).reason).toBe("repeated_error");
    const different = harness(steps);
    for (const code of ["FIRST", "SECOND", "SECOND"]) different.tools.execute.mockResolvedValueOnce({ status: "error", summary: "失败", error: { code, message: "失败" } });
    expect((await different.run()).status).toBe("completed");
  });

  it("非法预算在运行前拒绝", async () => {
    const h = harness([reply()]);
    for (const maxSteps of [0, -1, NaN, Infinity, 1.5]) await expect(h.run({ limits: { maxSteps } })).rejects.toThrow();
    expect(h.records()).toHaveLength(0);
  });

  it("工具上限对批次内调用生效，超限调用仍补齐结果", async () => {
    const h = harness([reply(call("1"), call("2"), call("3"))]);
    expect(await h.run({ limits: { maxToolCalls: 1 } })).toMatchObject({ reason: "tool_limit", toolCalls: 1 });
    expect(h.tools.execute).toHaveBeenCalledOnce();
    expect(h.records().find(r => r.type === "tool_results")?.results).toHaveLength(3);
  });

  it("步数上限阻止下一模型请求，但保留本步完整结果", async () => {
    const h = harness([reply(call()), reply()]);
    expect((await h.run({ limits: { maxSteps: 1 } })).reason).toBe("step_limit");
    expect(h.provider.requests).toHaveLength(1);
    expect(h.records().some(r => r.type === "tool_results")).toBe(true);
  });

  it("unknown 中断运行，补齐余下结果，不派发新调用", async () => {
    const h = harness([reply(call("1"), call("2"))]);
    h.tools.execute.mockResolvedValueOnce({ status: "unknown", summary: "需核对结果" });
    expect(await h.run()).toMatchObject({ status: "interrupted", reason: "unknown_effect" });
    expect(h.tools.execute).toHaveBeenCalledOnce();
    expect(h.records().find(r => r.type === "tool_results")?.results.map(r => r.result.status)).toEqual(["unknown", "denied"]);
  });
});

describe("取消、期限和提交失败", () => {
  it("启动前取消不请求模型", async () => {
    const h = harness([reply()]);
    h.cancellation.cancel();
    expect((await h.run()).status).toBe("cancelled");
    expect(h.provider.requests).toHaveLength(0);
  });

  it.each(["cancelled", "deadline"] as const)("模型永久等待时 %s 仍能停止，迟到完整结果不执行", async reason => {
    const h = harness([]);
    const entered = deferred();
    const late = deferred<IteratorResult<ProviderEvent>>();
    const close = vi.fn(async () => ({ done: true as const, value: undefined }));
    const provider: ModelProvider = { stream: () => ({ [Symbol.asyncIterator]: () => ({ next: () => { entered.resolve(); return late.promise; }, return: close }) }) };
    const running = h.run({ limits: { maxActiveMs: 10 } }, { provider });
    await entered.promise;
    if (reason === "cancelled") h.cancellation.cancel();
    else h.services.advance(10);
    expect((await running).reason).toBe(reason);
    late.resolve({ done: false, value: { type: "completed", turn: turn([call()]) } });
    await Promise.resolve();
    expect(close).toHaveBeenCalledOnce();
    expect(h.tools.execute).not.toHaveBeenCalled();
    expect(h.services.timers.size).toBe(0);
  });

  it("工具执行中取消等待实际结果，剩余调用补为取消", async () => {
    const h = harness([reply(call("1"), call("2"))]);
    const entered = deferred();
    const result = deferred<ToolResult>();
    h.tools.execute.mockImplementationOnce(async () => { entered.resolve(); return result.promise; });
    const running = h.run();
    await entered.promise;
    h.cancellation.cancel();
    expect(h.records().some(r => r.type === "run_finished")).toBe(false);
    result.resolve({ status: "ok", summary: "在途读取完成" });
    expect((await running).status).toBe("cancelled");
    expect(h.tools.execute).toHaveBeenCalledOnce();
    expect(h.records().find(r => r.type === "tool_results")?.results.map(r => r.result.status)).toEqual(["ok", "cancelled"]);
  });

  it("意图提交期间取消仍保存全部调用的取消结果", async () => {
    const h = harness([reply(call("1"), call("2"))]);
    const journal = new MemoryJournal(batch => { if (batch.records[0]?.type === "model") h.cancellation.cancel(); });
    expect((await h.run({}, { journal })).status).toBe("cancelled");
    expect(h.tools.execute).not.toHaveBeenCalled();
    expect(journal.batches.flatMap(b => b.records).find(r => r.type === "tool_results")?.results.map(r => r.result.status)).toEqual(["cancelled", "cancelled"]);
  });

  it("等待参数校验时取消，不进入实际执行", async () => {
    const h = harness([reply(call())]);
    const entered = deferred();
    const release = deferred();
    h.tools.validate.mockImplementationOnce(async () => { entered.resolve(); await release.promise; return { ok: true, arguments: {} }; });
    const running = h.run();
    await entered.promise;
    h.cancellation.cancel();
    release.resolve();
    expect((await running).status).toBe("cancelled");
    expect(h.tools.execute).not.toHaveBeenCalled();
  });

  it("在途工具超时仍等待结果，unknown 比取消优先", async () => {
    const h = harness([reply(call("1"), call("2"))]);
    const entered = deferred();
    const release = deferred<ToolResult>();
    h.tools.execute.mockImplementationOnce(async () => { entered.resolve(); return release.promise; });
    const running = h.run({ limits: { maxActiveMs: 5 } });
    await entered.promise;
    h.services.advance(5);
    expect(h.records().some(r => r.type === "run_finished")).toBe(false);
    release.resolve({ status: "unknown", summary: "结果仍需核对" });
    expect((await running).status).toBe("interrupted");
    expect(h.tools.execute).toHaveBeenCalledOnce();
  });

  it.each(["run_started", "model", "tool_results", "run_finished"])("%s 提交失败终止调度，不声称终态已保存", async type => {
    const h = harness([reply(call()), reply()]);
    const journal = new MemoryJournal(batch => { if (batch.records[0]?.type === type) throw new Error("disk full"); });
    await expect(h.run({}, { journal })).rejects.toBeInstanceOf(JournalCommitError);
    expect(journal.batches.flatMap(b => b.records).some(r => r.type === "run_finished")).toBe(false);
    expect(h.tools.execute.mock.calls.length).toBe(["run_started", "model"].includes(type) ? 0 : 1);
    expect(h.provider.requests.length).toBe(type === "run_started" ? 0 : type === "run_finished" ? 2 : 1);
    expect(h.services.timers.size).toBe(0);
  });
});
