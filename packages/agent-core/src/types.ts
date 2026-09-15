export type JsonValue = null | boolean | number | string | readonly JsonValue[] | { readonly [key: string]: JsonValue };

export interface Cancellation {
  readonly cancelled: boolean;
  /** Already cancelled tokens notify immediately. The returned function removes the listener. */
  subscribe(listener: () => void): () => void;
}

export interface RuntimeServices {
  newId(): string;
  now(): number;
  scheduleDeadline(milliseconds: number, expire: () => void): () => void;
}

export interface ToolCall {
  readonly itemId: string;
  readonly callId: string;
  readonly name: string;
  readonly argumentsJson: string;
}

export interface ModelTurn {
  readonly text: string;
  readonly toolCalls: readonly ToolCall[];
  readonly providerState: JsonValue;
}

export type ProviderEvent =
  | { readonly type: "text_delta" | "reasoning_delta" | "tool_delta"; readonly delta: string }
  | { readonly type: "completed"; readonly turn: ModelTurn }
  | { readonly type: "failed"; readonly message: string };

export interface ToolDefinition {
  readonly name: string;
  readonly description: string;
  readonly parameters: JsonValue;
  readonly effect: "read" | "write";
}

export interface ModelRequest {
  readonly taskId: string;
  readonly runId: string;
  readonly stepId: string;
  readonly attemptId: string;
  readonly history: readonly HistoryEntry[];
  readonly tools: readonly ToolDefinition[];
}

export interface ModelProvider {
  /** Must release stream resources on cancellation; only completed carries executable output. */
  stream(request: ModelRequest, cancellation: Cancellation): AsyncIterable<ProviderEvent>;
}

export interface ToolError { readonly code: string; readonly message: string }
export interface ToolResult {
  readonly status: "ok" | "error" | "denied" | "cancelled" | "unknown";
  readonly summary: string;
  readonly data?: JsonValue;
  readonly error?: ToolError;
}
export type ValidationResult = { readonly ok: true; readonly arguments: JsonValue } | { readonly ok: false; readonly error: ToolError };
export interface ToolExecution {
  readonly executionId: string;
  readonly callId: string;
  readonly name: string;
  readonly arguments: JsonValue;
}
export interface ToolExecutor {
  readonly definitions: readonly ToolDefinition[];
  validate(name: string, argumentsValue: JsonValue): Promise<ValidationResult>;
  /** Cancellation does not abandon in-flight execution. Uncertain effects must return unknown. */
  execute(input: ToolExecution, cancellation: Cancellation): Promise<ToolResult>;
}

export interface ToolIntent { readonly executionId: string; readonly call: ToolCall }
export interface ToolOutcome { readonly executionId: string; readonly callId: string; readonly result: ToolResult }
export type HistoryEntry =
  | { readonly type: "user"; readonly text: string }
  | { readonly type: "model"; readonly stepId: string; readonly attemptId: string; readonly turn: ModelTurn; readonly intents: readonly ToolIntent[] }
  | { readonly type: "tool_results"; readonly stepId: string; readonly results: readonly ToolOutcome[] };

export type StopReason = "completed" | "cancelled" | "deadline" | "step_limit" | "tool_limit" | "repeated_error" | "provider_error" | "invalid_response" | "unknown_effect";
export interface RunResult {
  readonly status: "completed" | "failed" | "cancelled" | "interrupted";
  readonly outcome: "success" | "partial" | null;
  readonly reason: StopReason;
  readonly text: string;
  readonly steps: number;
  readonly toolCalls: number;
}
export type RunRecord = HistoryEntry
  | { readonly type: "run_started"; readonly timestamp: number }
  | { readonly type: "run_finished"; readonly timestamp: number; readonly result: RunResult }
  | { readonly type: "attempt_failed"; readonly stepId: string; readonly attemptId: string; readonly reason: StopReason };
export interface JournalBatch {
  readonly taskId: string;
  readonly runId: string;
  readonly records: readonly RunRecord[];
}
export interface Journal {
  /** Resolve only after the whole batch commits. Reject without partially committing it. */
  commit(batch: JournalBatch): Promise<void>;
}
export interface RunLimits { readonly maxSteps: number; readonly maxToolCalls: number; readonly maxActiveMs: number }
export interface RunInput {
  readonly taskId: string;
  readonly runId: string;
  readonly text: string;
  readonly history?: readonly HistoryEntry[];
  readonly limits?: Partial<RunLimits>;
}
export interface AgentDependencies {
  readonly provider: ModelProvider;
  readonly tools: ToolExecutor;
  readonly journal: Journal;
  readonly cancellation: Cancellation;
  readonly services: RuntimeServices;
  /** Best-effort preview only; failures in the observer cannot change execution or records. */
  readonly onPreview?: (event: { runId: string; attemptId: string; type: "text_delta" | "reasoning_delta" | "tool_delta"; delta: string }) => void;
}
