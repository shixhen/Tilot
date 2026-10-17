import { randomUUID } from "node:crypto";
import type { ToolApproval, TurnNotification } from "@tilot/protocol";

interface PendingApproval {
  approval: ToolApproval;
  resolve: (allowed: boolean) => void;
  signal: AbortSignal | undefined;
}

/** 只保存当前进程正在等待的调用；停止会取消等待，不保存可复用许可。 */
export class ApprovalManager {
  private readonly pending = new Map<string, PendingApproval>();
  private readonly emit: (event: TurnNotification) => Promise<void>;

  constructor(emit: (event: TurnNotification) => Promise<void>) { this.emit = emit; }

  list(threadId: string): ToolApproval[] {
    return [...this.pending.values()].filter((item) => item.approval.threadId === threadId).map((item) => ({ ...item.approval }));
  }

  async request(input: Omit<ToolApproval, "id">, signal?: AbortSignal): Promise<boolean> {
    signal?.throwIfAborted();
    const approval = { ...input, id: randomUUID() };
    const deferred = Promise.withResolvers<boolean>();
    const abort = () => deferred.resolve(false);
    signal?.addEventListener("abort", abort, { once: true });
    this.pending.set(approval.id, { approval, resolve: deferred.resolve, signal });
    try {
      await this.emit({ event: "approval.requested", approval });
      const allowed = await deferred.promise;
      signal?.throwIfAborted();
      return allowed;
    } finally {
      signal?.removeEventListener("abort", abort);
      this.pending.delete(approval.id);
      await this.emit({ event: "approval.resolved", threadId: input.threadId, turnId: input.turnId, approvalId: approval.id });
    }
  }

  respond(id: string, allowed: boolean): void {
    const pending = this.pending.get(id);
    if (!pending || pending.signal?.aborted) throw new Error("该审批已结束或已取消。");
    this.pending.delete(id);
    pending.resolve(allowed);
  }
}
