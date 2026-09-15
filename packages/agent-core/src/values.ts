import type { HistoryEntry, JsonValue, ModelTurn, ToolResult } from "./types.js";

/** Copy and freeze strictly JSON-compatible data without silently dropping unsupported values. */
export function snapshot<T>(value: T): T {
  const seen = new Set<object>();
  function copy(item: unknown): JsonValue {
    if (item === null || typeof item === "string" || typeof item === "boolean") return item;
    if (typeof item === "number" && Number.isFinite(item)) return item;
    if (typeof item !== "object" || seen.has(item)) throw new Error("Expected acyclic JSON data");
    if (Object.getOwnPropertySymbols(item).length) throw new Error("Expected JSON string keys");
    if (!Array.isArray(item) && Object.getPrototypeOf(item) !== Object.prototype && Object.getPrototypeOf(item) !== null) throw new Error("Expected plain JSON object");
    seen.add(item);
    const result = Array.isArray(item) ? Array.from(item, copy) : Object.fromEntries(Object.entries(item).map(([key, child]) => [key, copy(child)]));
    seen.delete(item);
    return Object.freeze(result);
  }
  return copy(value) as T;
}

export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") return `{${Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(",")}}`;
  return JSON.stringify(value) ?? "undefined";
}

export function validateTurn(turn: ModelTurn, previousIds: ReadonlySet<string>): void {
  snapshot(turn);
  if (typeof turn.text !== "string" || !Array.isArray(turn.toolCalls) || turn.providerState === undefined) throw new Error("Invalid model turn");
  const items = new Set<string>();
  const calls = new Set(previousIds);
  for (const call of turn.toolCalls) {
    if (!call || ![call.itemId, call.callId, call.name].every(v => typeof v === "string" && v.length > 0) || typeof call.argumentsJson !== "string") throw new Error("Invalid tool call");
    if (items.has(call.itemId) || calls.has(call.callId)) throw new Error("Duplicate tool ID");
    items.add(call.itemId);
    calls.add(call.callId);
  }
}

export function validateResult(result: ToolResult): ToolResult {
  const safe = snapshot(result);
  if (!safe || !["ok", "error", "denied", "cancelled", "unknown"].includes(safe.status) || typeof safe.summary !== "string") throw new Error("Invalid tool result");
  if (safe.error && (typeof safe.error.code !== "string" || typeof safe.error.message !== "string")) throw new Error("Invalid tool error");
  return safe;
}

export function validateHistory(history: readonly HistoryEntry[]): Set<string> {
  const ids = new Set<string>();
  const executions = new Set<string>();
  for (let index = 0; index < history.length; index++) {
    const entry = history[index]!;
    if (entry.type === "user") {
      if (typeof entry.text !== "string") throw new Error("Invalid user message");
      continue;
    }
    if (entry.type !== "model" || !entry.stepId || !entry.attemptId) throw new Error("Orphan tool result or invalid model record");
    validateTurn(entry.turn, ids);
    if (entry.intents.length !== entry.turn.toolCalls.length) throw new Error("Missing tool intentions");
    for (const [i, intent] of entry.intents.entries()) {
      if (!intent.executionId || executions.has(intent.executionId) || canonical(intent.call) !== canonical(entry.turn.toolCalls[i])) throw new Error("Invalid tool intention");
      executions.add(intent.executionId);
      ids.add(intent.call.callId);
    }
    if (!entry.intents.length) continue;
    const group = history[++index];
    if (group?.type !== "tool_results" || group.stepId !== entry.stepId || group.results.length !== entry.intents.length) throw new Error("Incomplete tool result group");
    for (const [i, outcome] of group.results.entries()) {
      const intent = entry.intents[i]!;
      if (outcome.executionId !== intent.executionId || outcome.callId !== intent.call.callId) throw new Error("Mismatched tool result");
      if (validateResult(outcome.result).status === "unknown") throw new Error("Unresolved tool effect in history");
    }
  }
  return ids;
}
