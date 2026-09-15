import { describe, expect, it } from "vitest";
import { CancellationSource } from "@tilot/agent-core";
import { DEMO_PROJECT_ID, MemoryJournal, MemoryTools, createDemoProvider } from "../packages/runtime/src/index.js";
import { harness } from "./support.js";

describe("内存宿主", () => {
  it("Journal 批次失败整体回滚，已保存状态不暴露可变引用", async () => {
    const journal = new MemoryJournal(batch => { if (batch.runId === "fail") throw new Error("故障注入"); });
    const record = { type: "user" as const, text: "原始输入" };
    await journal.commit({ taskId: "task", runId: "ok", records: [record] });
    record.text = "后续修改";
    await expect(journal.commit({ taskId: "task", runId: "fail", records: [{ type: "user", text: "不应保存" }, { type: "run_started", timestamp: 1 }] })).rejects.toThrow();
    expect(journal.batches).toHaveLength(1);
    expect(journal.batches[0]?.records).toEqual([{ type: "user", text: "原始输入" }]);
    expect(Object.isFrozen(journal.batches[0]?.records)).toBe(true);
  });

  it("支持中文空格路径和真实行号，内存路径精确匹配", async () => {
    const tools = new MemoryTools();
    const token = new CancellationSource().token;
    const read = (path: string) => tools.execute({ executionId: "execution", callId: "call", name: "read_file", arguments: { projectId: DEMO_PROJECT_ID, path } }, token);
    expect(await read("示例 项目/问候.ts")).toMatchObject({ status: "ok", data: { lines: [{ line: 1, text: "export function greet(name: string): string {" }, { line: 2, text: "  return `你好，${name}！`;" }, { line: 3, text: "}" }] } });
    for (const path of ["__proto__", "constructor", "../secret", "D:\\code\\secret", "missing"]) expect((await read(path)).error?.code).toBe("NOT_FOUND");
  });

  it("演示结果可重复，FakeProvider 拒绝没有工具结果的直接跳步", async () => {
    const a = await harness([]).run({}, { provider: createDemoProvider() });
    const b = await harness([]).run({}, { provider: createDemoProvider() });
    expect(a).toEqual(b);
    const provider = createDemoProvider();
    const request = { taskId: "t", runId: "r", stepId: "s", attemptId: "a", history: [], tools: [] };
    const token = new CancellationSource().token;
    for await (const _event of provider.stream(request, token)) { /* First scripted request. */ }
    await expect(async () => { for await (const _event of provider.stream(request, token)) { /* Invalid second request. */ } }).rejects.toThrow("缺少 list_files");
  });
});
