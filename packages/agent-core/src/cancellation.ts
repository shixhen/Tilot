import type { Cancellation } from "./types.js";

export class CancellationSource {
  #cancelled = false;
  #listeners = new Set<() => void>();
  readonly token: Cancellation;
  constructor() {
    const source = this;
    this.token = {
      get cancelled() { return source.#cancelled; },
      subscribe: (listener) => {
        if (this.#cancelled) listener();
        else this.#listeners.add(listener);
        return () => { this.#listeners.delete(listener); };
      },
    };
  }
  cancel(): void {
    if (this.#cancelled) return;
    this.#cancelled = true;
    for (const listener of this.#listeners) {
      try { listener(); } catch { /* Every listener must receive cancellation. */ }
    }
    this.#listeners.clear();
  }
}
export class Cancelled extends Error {}

export async function nextEvent<T>(iterator: AsyncIterator<T>, cancellation: Cancellation): Promise<IteratorResult<T>> {
  if (cancellation.cancelled) throw new Cancelled();
  let unsubscribe = () => {};
  const stopped = new Promise<never>((_, reject) => {
    unsubscribe = cancellation.subscribe(() => reject(new Cancelled()));
  });
  try { return await Promise.race([iterator.next(), stopped]); }
  finally { unsubscribe(); }
}
