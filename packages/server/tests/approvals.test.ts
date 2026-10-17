import assert from "node:assert/strict";
import { test } from "node:test";
import type { TurnNotification } from "@tilot/protocol";
import { ApprovalManager } from "../src/approvals.ts";

test("审批只放行一个调用，不继承许可；拒绝和停止会结束等待，过期审批不能再次通过", async () => {
  const events: TurnNotification[] = [];
  const approvals = new ApprovalManager(async (event) => { events.push(event); });
  const input = { threadId: "thread", turnId: "turn", toolId: "tool", name: "shell", arguments: '{"command":"Get-Date"}' };
  const first = approvals.request(input);
  const approval = approvals.list("thread")[0]!;
  assert.deepEqual(approvals.list("other"), []);
  approvals.respond(approval.id, true);
  assert.equal(await first, true);
  assert.throws(() => approvals.respond(approval.id, true), /已结束/);
  const second = approvals.request(input);
  const next = approvals.list("thread")[0]!;
  assert.notEqual(next.id, approval.id);
  approvals.respond(next.id, false);
  assert.equal(await second, false);
  const controller = new AbortController();
  const cancelled = approvals.request(input, controller.signal);
  const pending = approvals.list("thread")[0]!;
  controller.abort();
  await assert.rejects(cancelled, { name: "AbortError" });
  assert.deepEqual(approvals.list("thread"), []);
  assert.throws(() => approvals.respond(pending.id, true), /已结束/);
  assert.deepEqual(events.map((event) => event.event), ["approval.requested", "approval.resolved", "approval.requested", "approval.resolved", "approval.requested", "approval.resolved"]);
});
