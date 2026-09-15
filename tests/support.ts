import { vi } from "vitest";
import { CancellationSource, runAgent } from "@tilot/agent-core";
import type { AgentDependencies, ModelTurn, ProviderEvent, RunInput, RuntimeServices, ToolCall } from "@tilot/agent-core";
import { FakeProvider, MemoryJournal, MemoryTools, DEMO_PROJECT_ID } from "../packages/runtime/src/index.js";
import type { FakeStep } from "../packages/runtime/src/index.js";

export const input: RunInput = { taskId: "task-1", runId: "run-1", text: "解释示例代码" };
export function call(id = "1", name = "list_files", args = JSON.stringify({ projectId: DEMO_PROJECT_ID })): ToolCall {
  return { itemId: `item-${id}`, callId: `call-${id}`, name, argumentsJson: args };
}
export function turn(calls: readonly ToolCall[] = [], text = "回答"): ModelTurn {
  return { text, toolCalls: calls, providerState: { protocol: "fake", schemaVersion: 1, reasoning: ["保留原始状态"] } };
}
export function events(...items: ProviderEvent[]): FakeStep { return async function* () { yield* items; }; }
export function reply(...calls: ToolCall[]): FakeStep { return events({ type: "completed", turn: turn(calls) }); }
export function deferred<T = void>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}
export class ManualServices implements RuntimeServices {
  time = 0;
  counter = 0;
  timers = new Map<() => void, number>();
  now = () => this.time;
  newId = () => `internal-${++this.counter}`;
  scheduleDeadline(milliseconds: number, expire: () => void) {
    this.timers.set(expire, this.time + milliseconds);
    return () => { this.timers.delete(expire); };
  }
  advance(milliseconds: number) {
    this.time += milliseconds;
    for (const [expire, time] of this.timers) if (time <= this.time) { this.timers.delete(expire); expire(); }
  }
}
export function harness(steps: readonly FakeStep[]) {
  const memory = new MemoryTools();
  const tools = { definitions: memory.definitions, validate: vi.fn(memory.validate.bind(memory)), execute: vi.fn(memory.execute.bind(memory)) };
  const provider = new FakeProvider(steps);
  const journal = new MemoryJournal();
  const cancellation = new CancellationSource();
  const services = new ManualServices();
  const preview = vi.fn();
  return {
    provider, journal, cancellation, services, tools, preview,
    run: (overrides: Partial<RunInput> = {}, dependencies: Partial<AgentDependencies> = {}) => runAgent({ ...input, ...overrides }, {
      provider, tools, journal, cancellation: cancellation.token, services, onPreview: preview, ...dependencies,
    }),
    records: () => journal.batches.flatMap(batch => batch.records),
  };
}
