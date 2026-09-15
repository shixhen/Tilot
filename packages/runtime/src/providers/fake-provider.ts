import { snapshot } from "@tilot/agent-core";
import type { Cancellation, ModelProvider, ModelRequest, ProviderEvent } from "@tilot/agent-core";

export type FakeStep = (request: ModelRequest, cancellation: Cancellation) => AsyncIterable<ProviderEvent>;

/** Deterministic provider. Scripts inspect real request history before producing the next turn. */
export class FakeProvider implements ModelProvider {
  #requests: ModelRequest[] = [];
  constructor(private readonly steps: readonly FakeStep[]) {}
  get requests(): readonly ModelRequest[] { return snapshot(this.#requests); }
  async *stream(request: ModelRequest, cancellation: Cancellation): AsyncIterable<ProviderEvent> {
    if (cancellation.cancelled) return;
    const script = this.steps[this.#requests.length];
    this.#requests.push(snapshot(request));
    if (!script) throw new Error("FakeProvider 脚本已耗尽");
    yield* script(request, cancellation);
  }
}
