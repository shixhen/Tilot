import { snapshot } from "@tilot/agent-core";
import type { Journal, JournalBatch } from "@tilot/agent-core";

export class MemoryJournal implements Journal {
  #batches: readonly JournalBatch[] = [];
  constructor(private readonly beforeCommit?: (batch: JournalBatch) => void) {}
  get batches(): readonly JournalBatch[] { return snapshot(this.#batches); }
  async commit(batch: JournalBatch): Promise<void> {
    const safe = snapshot(batch);
    // All preparation and injected failures happen before replacing the committed state.
    const next = snapshot([...this.#batches, safe]);
    this.beforeCommit?.(safe);
    this.#batches = next;
  }
}
