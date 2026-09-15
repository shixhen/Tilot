import { CancellationSource, runAgent } from "@tilot/agent-core";
import { createNodeServices } from "./adapters/node-services.js";
import { createDemoProvider } from "./demo-scenario.js";
import { MemoryJournal } from "./storage/memory-journal.js";
import { MemoryTools } from "./tools/memory-tools.js";

const cancellation = new CancellationSource();
const stop = () => cancellation.cancel();
process.once("SIGINT", stop);
try {
  console.log("Tilot M0.1：固定内存项目演示（模拟模型，无 API 请求）");
  const journal = new MemoryJournal();
  const result = await runAgent({ taskId: "demo-task", runId: "demo-run", text: "找到问候函数，并解释它的作用。" }, {
    provider: createDemoProvider(), tools: new MemoryTools(), journal,
    cancellation: cancellation.token, services: createNodeServices(),
  });
  for (const batch of journal.batches) for (const record of batch.records) {
    if (record.type === "model") for (const intent of record.intents) console.log(`[调用] ${intent.call.name} ${intent.call.argumentsJson}`);
    if (record.type === "tool_results") for (const outcome of record.results) console.log(`[结果] ${outcome.result.status}：${outcome.result.summary}`);
  }
  console.log(`\n[最终回答] ${result.text}\n[运行结果] ${result.status} / ${result.outcome ?? result.reason}；${result.steps} 步，${result.toolCalls} 次工具调用。`);
  if (result.status !== "completed") process.exitCode = 1;
} catch (error) {
  console.error(error instanceof Error ? error.message : "演示运行失败");
  process.exitCode = 1;
} finally { process.off("SIGINT", stop); }
