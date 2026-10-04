import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { Store } from "@tilot/store";
import { CredentialStore } from "../packages/store/src/credentials.ts";
import { InputQueue } from "../apps/desktop/src/input-queue.ts";
import { answer, loadConnection, log, Session } from "./deepseek-smoke.mjs";

/** 通过真实模型、正式 Server 和界面实际使用的队列控制器验证同轮引导与自动续发。 */
async function main() {
  const config = loadConnection();
  const directory = mkdtempSync(join(tmpdir(), "tilot-steering-live-"));
  let session;
  let queue;
  const errors = [];
  try {
    const store = new Store(directory);
    try {
      store.saveConfig({ ...config, maxAutomaticRetries: 0 });
      const provider = config.providers[0];
      const key = new CredentialStore(join(process.env.LOCALAPPDATA, "Tilot")).getApiKey(provider.id, provider.baseURL);
      store.credentials.saveApiKey(provider.id, provider.baseURL, key);
    } finally { store.close(); }
    session = new Session(directory);
    queue = new InputQueue({
      start: (threadId, input) => session.request("turn.start", { threadId, input }),
      steer: (turnId, input) => session.request("turn.steer", { turnId, input }),
      changed: () => {}, error: (error) => { errors.push(error.message); },
    });
    queue.setConnected(true);
    session.onMessage = (message) => { if ("turn" in message) queue.observe(message.turn); };
    const thread = await session.request("thread.create", { title: "等待输入与引导真实联调" });
    const turn = await session.request("turn.start", { threadId: thread.id, input: "请完整逐行列出从 1 到 40 的整数平方，每行写整数和平方，不要省略，不调用工具。" });
    await session.waitFor((message) => message.event === "message.delta" && message.turnId === turn.id);
    queue.enqueue(thread.id, "本轮只回答 QUEUED_ONE，不调用工具。");
    queue.enqueue(thread.id, "本轮只回答 QUEUED_TWO，不调用工具。");
    queue.enqueue(thread.id, "这是当前任务的补充：继续完成原来的平方列表，在最后附加 STEERING_APPLIED，不要停止当前任务，也不要调用工具。");
    const guidingId = queue.view(thread.id).messages[2].id;
    await queue.steer(thread.id, guidingId);
    assert.equal(errors.length, 0);
    assert.equal(queue.view(thread.id).messages.length, 2, "引导未被当前轮次接受。");
    const first = await session.finish(turn);
    assert.equal(first.turn.status, "completed", first.turn.error ?? "引导轮次失败。");
    assert.ok(first.attempts.length >= 2);
    assert.ok(first.attempts.every((attempt) => attempt.status === "completed"), "引导取消了当前请求。");
    assert.match(answer(first.attempts), /STEERING_APPLIED/);
    const last = await session.waitFor((message) => message.event === "turn.finished" && message.turn.threadId === thread.id && message.turn.sequence === 3);
    assert.equal(last.turn.status, "completed");
    const turns = await session.request("turn.list", { threadId: thread.id });
    assert.equal(turns.length, 3);
    const result = [];
    for (const current of turns) {
      const attempts = await session.request("turn.attempts", { turnId: current.id });
      const inputs = await session.request("turn.inputs", { turnId: current.id });
      result.push({ sequence: current.sequence, status: current.status, inputs: inputs.length, attempts: attempts.length,
        attemptStatuses: attempts.map((attempt) => attempt.status), metrics: attempts.map((attempt) => attempt.metrics) });
      if (current.sequence === 1) assert.equal(inputs.length, 2);
      else assert.match(answer(attempts), current.sequence === 2 ? /QUEUED_ONE/ : /QUEUED_TWO/);
    }
    // 第三轮完成后，启动确认的微任务也必须收尾，等待区才应为空。
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(queue.view(thread.id).messages.length, 0);
    assert.deepEqual(errors, []);
    log({ status: "passed", check: "same-turn-steering-and-automatic-queue", model: config.model, turns: result });
  } finally {
    queue?.setConnected(false);
    if (session) await session.close(true);
    assert.equal(dirname(resolve(directory)), resolve(tmpdir()));
    assert.ok(directory.startsWith(join(tmpdir(), "tilot-steering-live-")));
    rmSync(directory, { recursive: true, force: true });
  }
}

main().catch((error) => { log({ status: "failed", error: error.message }); process.exitCode = 1; });
