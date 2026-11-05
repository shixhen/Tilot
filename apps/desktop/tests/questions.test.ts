import assert from "node:assert/strict";
import { test } from "node:test";
import { emptyQuestionDraft, type QuestionDelivery, type QuestionGroup } from "@tilot/protocol";
import type { Request } from "../src/client.ts";
import { QuestionSession, type QuestionState } from "../src/questions.ts";

const group: QuestionGroup = { id: "question", threadId: "thread", turnId: "turn", status: "pending", inputId: null, createdAt: 1,
  questions: [{ title: "问题", options: ["A", "B"] }], draft: { activeIndex: 0, answers: [{ mode: "unanswered", optionIndex: null, text: "" }] } };
function localStore() {
  const map = new Map<string, string>();
  return { getItem: (key: string) => map.get(key) ?? null, setItem: (key: string, value: string) => { map.set(key, value); }, removeItem: (key: string) => { map.delete(key); } };
}
const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

test("离线填写的草稿重开后恢复，重连串行保存，旧保存应答不会覆盖新文字", async () => {
  const storage = localStore(); let view: QuestionState | null = null;
  const saves: { draft: typeof group.draft; resolve: (q: QuestionGroup) => void }[] = [];
  const request = ((method, params) => {
    assert.equal(method, "question.draft");
    const pending = Promise.withResolvers<QuestionGroup>();
    saves.push({ draft: structuredClone((params as { draft: typeof group.draft }).draft), resolve: pending.resolve }); return pending.promise;
  }) as Request;
  let session = new QuestionSession(request, storage, (_, state) => { view = state; }, async () => {});
  session.receive("thread", group);
  const first = emptyQuestionDraft(group.questions); first.answers[0] = { mode: "text", text: "离线🙂", optionIndex: null };
  session.edit("thread", first); session.dispose();
  session = new QuestionSession(request, storage, (_, state) => { view = state; }, async () => {});
  session.setConnected(true); session.receive("thread", group);
  assert.equal((view as unknown as QuestionState).draft.answers[0]!.text, "离线🙂");
  const latest = structuredClone(first); latest.answers[0]!.text = "继续写完"; session.edit("thread", latest);
  saves[0]!.resolve({ ...group, draft: first }); await flush();
  assert.equal(saves.length, 2); assert.deepEqual(saves[1]!.draft, latest);
  saves[1]!.resolve({ ...group, draft: latest }); await flush();
  assert.deepEqual((view as unknown as QuestionState).draft, latest); assert.equal(storage.getItem("tilot.question.question"), null);
  session.dispose();
});

test("提交失败保留答案、重复点击不重发，成功后清理卡片和离线副本", async () => {
  let view: QuestionState | null = null; let calls = 0;
  const storage = localStore(); const pending = Promise.withResolvers<QuestionDelivery>();
  const request = ((method) => { assert.equal(method, "question.submit"); calls++; return pending.promise; }) as Request;
  let fail = true;
  const session = new QuestionSession(request, storage, (_, state) => { view = state; }, async (_, action) => {
    if (fail) throw new Error("投递失败"); await action();
  });
  session.receive("thread", group); const draft = emptyQuestionDraft(group.questions); draft.answers[0]!.mode = "skipped";
  session.edit("thread", draft); session.setConnected(true);
  await session.submit("thread"); assert.match((view as unknown as QuestionState).error, /投递失败/);
  fail = false; const first = session.submit("thread"); await flush(); await session.submit("thread"); assert.equal(calls, 1);
  pending.resolve({} as QuestionDelivery); await first;
  assert.equal(view, null); assert.equal(storage.getItem("tilot.question.question"), null); session.dispose();
});
