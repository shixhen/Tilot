import assert from "node:assert/strict";
import { test } from "node:test";
import type { Response } from "openai/resources/responses/responses";
import { emptyQuestionDraft, parseQuestions, parseQuestionDraft } from "@tilot/protocol";
import { Store } from "@tilot/store";
import { temporaryDirectory } from "./helpers.ts";

function propose(store: Store, threadId: string, suffix = "1") {
  const turn = store.startTurn(threadId, "任务");
  const attempt = store.history.startAttempt(turn.id, store.listTurnInputs(turn.id)[0]!.id);
  const questions = [{ title: "采用哪种方案？", options: ["A", "B"], recommendedIndex: 1 }, { title: "额外要求？", options: [] }];
  const call = { type: "function_call", id: `item-${suffix}`, call_id: `call-${suffix}`, name: "request_user_input_async", arguments: JSON.stringify({ questions }), status: "completed" };
  store.history.finishAttempt(attempt.id, { status: "completed", response: { id: `r-${suffix}`, status: "completed", output: [call] } as Response });
  const tool = store.history.listToolCalls(attempt.id)[0]!;
  assert.throws(() => store.questions.create(tool.id, questions), /已开始/);
  store.history.startTool(tool.id);
  const group = store.questions.create(tool.id, questions);
  store.history.saveToolResult(tool.id, { type: "function_call_output", call_id: call.call_id, output: '{"accepted":true}' });
  return { group, turn };
}

test("未答问题和完整草稿跨重开保留，唯一待答组不会被覆盖，关闭释放名额", (context) => {
  const directory = temporaryDirectory(context);
  let store = new Store(directory);
  try {
    const thread = store.createThread("提问");
    const { group, turn } = propose(store, thread.id);
    const draft = emptyQuestionDraft(group.questions);
    draft.activeIndex = 1; draft.answers[0] = { mode: "option", optionIndex: 1, text: "保留但不提交的文字" };
    draft.answers[1] = { mode: "text", optionIndex: null, text: "中文\n🙂" };
    store.questions.saveDraft(group.id, draft);
    store.finishTurn(turn.id, "cancelled");
    store.close(); store = new Store(directory);
    assert.deepEqual(store.questions.pending(thread.id)?.draft, draft);
    const next = store.startTurn(thread.id, "普通消息不清除问题");
    const attempt = store.history.startAttempt(next.id, store.listTurnInputs(next.id)[0]!.id);
    const call = { type: "function_call", id: "other", call_id: "other", name: "request_user_input_async", arguments: "{}", status: "completed" };
    store.history.finishAttempt(attempt.id, { status: "completed", response: { id: "other", status: "completed", output: [call] } as Response });
    const tool = store.history.listToolCalls(attempt.id)[0]!; store.history.startTool(tool.id);
    assert.throws(() => store.questions.create(tool.id, group.questions), /已有待回答/);
    store.questions.close(group.id);
    assert.equal(store.questions.pending(thread.id), null);
    assert.equal(store.questions.create(tool.id, group.questions).id, tool.id);
  } finally { store.close(); }
});

test("整组回答和输入原子保存，运行中追加、空闲新开、重复投递不重复开轮", (context) => {
  const store = new Store(temporaryDirectory(context));
  try {
    const thread = store.createThread("整组");
    const { group, turn } = propose(store, thread.id);
    const draft = emptyQuestionDraft(group.questions);
    assert.throws(() => store.answerQuestion(group.id, draft, turn.id), /尚未回答/);
    assert.equal(store.listTurnInputs(turn.id).length, 1);
    draft.answers[0] = { mode: "option", optionIndex: 1, text: "绝对不应发送的草稿" };
    draft.answers[1]!.mode = "skipped";
    assert.throws(() => store.answerQuestion(group.id, draft), /UNIQUE constraint/);
    assert.equal(store.questions.pending(thread.id)?.id, group.id);
    const answer = store.answerQuestion(group.id, draft, turn.id);
    assert.equal(answer.turn.id, turn.id);
    assert.match(answer.input.content, /问题 1：采用哪种方案？\n回答：B/);
    assert.match(answer.input.content, /回答：已跳过/);
    assert.doesNotMatch(answer.input.content, /绝对不应发送/);
    assert.deepEqual(store.answerQuestion(group.id, draft), answer);
    assert.equal(store.listTurnInputs(turn.id).length, 2);
    draft.answers[0]!.optionIndex = 0;
    assert.throws(() => store.answerQuestion(group.id, draft), /已提交/);
    store.finishTurn(turn.id, "completed");
    const other = propose(store, thread.id, "2"); store.finishTurn(other.turn.id, "completed");
    const skipped = emptyQuestionDraft(other.group.questions); skipped.answers.forEach((a) => { a.mode = "skipped"; });
    const next = store.answerQuestion(other.group.id, skipped);
    assert.notEqual(next.turn.id, other.turn.id);
    assert.equal(store.listTurnInputs(next.turn.id).length, 1);
    assert.equal(store.answerQuestion(other.group.id, skipped).turn.id, next.turn.id);
    assert.equal(store.listTurns(thread.id).length, 3);
  } finally { store.close(); }
});

test("问题至少一题且不限制题数，选项限四个，空白、非法推荐和不完整提交均拒绝", () => {
  assert.equal(parseQuestions(Array.from({ length: 40 }, () => ({ title: "问题", options: [] }))).length, 40);
  for (const value of [[], [{ title: " " }], [{ title: "题", options: [" "] }], [{ title: "题", options: ["1", "2", "3", "4", "5"] }], [{ title: "题", options: ["A"], recommendedIndex: 1 }]]) assert.throws(() => parseQuestions(value));
  const questions = parseQuestions([{ title: "自由填写" }]);
  const draft = emptyQuestionDraft(questions); draft.answers[0]!.mode = "text";
  assert.throws(() => parseQuestionDraft(draft, questions), /不能为空/);
});
