import assert from "node:assert/strict";
import { test } from "node:test";
import { JSDOM } from "jsdom";
import { act, createElement, useState } from "react";
import { emptyQuestionDraft, type QuestionDraft, type QuestionGroup } from "@tilot/protocol";

test("官方 Questionnaire 逐题作答、保留草稿，普通文字不渲染 Markdown，末题手动整组提交", async () => {
  const dom = new JSDOM('<!doctype html><input id="main"><div id="root"></div>', { url: "http://localhost", pretendToBeVisual: true });
  const win = dom.window;
  for (const key of ["window", "document", "HTMLElement", "HTMLInputElement", "HTMLTextAreaElement", "HTMLSelectElement", "Element", "Node", "NodeFilter", "MutationObserver", "Event", "KeyboardEvent", "CustomEvent", "getComputedStyle"] as const) {
    Object.defineProperty(globalThis, key, { value: key === "window" ? win : win[key], configurable: true });
  }
  Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { value: true, configurable: true });
  const { createRoot } = await import("react-dom/client");
  const { QuestionPanel } = await import("../src/workspace/question-panel.tsx");
  const questions = [{ title: "**普通问题**", options: ["A", "B"], recommendedIndex: 1 }, { title: "写要求", options: [] }, { title: "可跳过", options: [] }];
  const group: QuestionGroup = { id: "q", threadId: "thread", turnId: "turn", status: "pending", inputId: null, createdAt: 1, questions, draft: emptyQuestionDraft(questions) };
  let latest = group.draft; let submissions = 0;
  function Harness() {
    const [draft, update] = useState(group.draft);
    return createElement(QuestionPanel, { state: { question: group, draft, busy: false, error: "" }, connected: true,
      onEdit: (next: QuestionDraft) => { latest = next; update(next); }, onSubmit: () => { submissions++; }, onClose: () => {}, onRetry: () => {} });
  }
  const root = createRoot(win.document.getElementById("root")!);
  const click = async (node: Element) => { await act(async () => { (node as HTMLElement).click(); }); };
  const button = (text: string) => [...win.document.querySelectorAll("button")].find((b) => b.textContent === text)!;
  const type = async (node: HTMLTextAreaElement, text: string) => { await act(async () => {
    Object.getOwnPropertyDescriptor(win.HTMLTextAreaElement.prototype, "value")!.set!.call(node, text);
    node.dispatchEvent(new win.Event("input", { bubbles: true }));
  }); };
  try {
    const main = win.document.getElementById("main")!; main.focus();
    await act(async () => { root.render(createElement(Harness)); });
    assert.equal(win.document.activeElement, main);
    assert.equal(win.document.querySelector("strong"), null);
    const radios = [...win.document.querySelectorAll<HTMLInputElement>('fieldset:not([hidden]) input[type="radio"]')];
    assert.equal(radios[0]!.value, "1"); assert.ok(radios.every((r) => !r.checked));
    assert.equal(button("下一题").disabled, true);
    await type(win.document.querySelector<HTMLTextAreaElement>('fieldset:not([hidden]) textarea')!, "第一题保留的文字草稿");
    await click(radios[1]!); assert.equal(latest.activeIndex, 1); assert.equal(latest.answers[0]!.optionIndex, 0);
    assert.equal(latest.answers[0]!.text, "第一题保留的文字草稿");
    const textarea = win.document.querySelector<HTMLTextAreaElement>('fieldset:not([hidden]) textarea')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(win.HTMLTextAreaElement.prototype, "value")!.set!.call(textarea, "第一行\n第二行🙂");
      textarea.dispatchEvent(new win.Event("input", { bubbles: true }));
    });
    assert.equal(latest.answers[1]!.mode, "text");
    await act(async () => { textarea.dispatchEvent(new win.KeyboardEvent("keydown", { key: "Enter", ctrlKey: true, bubbles: true })); });
    assert.equal(latest.activeIndex, 2); assert.equal(submissions, 0);
    await click(button("跳过此题")); assert.equal(latest.answers[2]!.mode, "skipped");
    await click(button("提交答案")); assert.equal(submissions, 1);
    await click(button("上一题"));
    assert.equal(win.document.querySelector<HTMLTextAreaElement>('fieldset:not([hidden]) textarea')!.value, "第一行\n第二行🙂");
    await click(button("上一题"));
    const restored = win.document.querySelector<HTMLTextAreaElement>('fieldset:not([hidden]) textarea')!;
    await act(async () => restored.focus());
    assert.equal(restored.value, "第一题保留的文字草稿"); assert.equal(latest.answers[0]!.mode, "text");
    await click(win.document.querySelector('button[aria-label="关闭本组问题"]')!);
    assert.match(win.document.querySelector('[role="dialog"]')!.textContent!, /放弃这组问题/);
  } finally { await act(async () => root.unmount()); win.close(); }
});
