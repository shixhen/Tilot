import assert from "node:assert/strict";
import { test } from "node:test";
import { act, createElement, useState } from "react";
import { JSDOM } from "jsdom";
import type { Thread } from "@tilot/protocol";

test("对话操作从对应行打开，删除要确认，失败时仍可重试", { timeout: 10000 }, async () => {
  const dom = new JSDOM('<!doctype html><div id="root"></div>', { url: "http://localhost", pretendToBeVisual: true });
  const win = dom.window;
  for (const key of ["document", "HTMLElement", "HTMLButtonElement", "HTMLInputElement", "Element", "Node", "NodeFilter", "MutationObserver", "Event", "KeyboardEvent", "CustomEvent", "getComputedStyle"] as const) {
    Object.defineProperty(globalThis, key, { value: win[key], configurable: true });
  }
  Object.assign(globalThis, { window: win, IS_REACT_ACT_ENVIRONMENT: true,
    requestAnimationFrame: win.requestAnimationFrame.bind(win), cancelAnimationFrame: win.cancelAnimationFrame.bind(win) });
  Object.defineProperty(win, "matchMedia", { value: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }) });
  const { createRoot } = await import("react-dom/client");
  const { SidebarProvider } = await import("../src/components/ui/sidebar.tsx");
  const { TaskNavigation } = await import("../src/workspace/navigation.tsx");
  const threads: Thread[] = [null, "D:\\project"].map((projectPath, index) => ({ id: String(index), title: `对话 ${index}`, projectPath,
    providerId: "default", model: "deepseek-flash", reasoningEffort: "high", permissionMode: "read-only", permissionLockedAt: null, createdAt: index, updatedAt: index }));
  const calls: string[] = [];
  function Harness() {
    const [remaining, setRemaining] = useState(threads);
    return createElement(SidebarProvider, {}, createElement(TaskNavigation, { threads: remaining, selected: "0", disabled: false,
      onSelect: () => { throw new Error("操作按钮不应触发选择"); }, onNew: () => {}, onOpenProject: () => {}, onDelete: async (thread) => {
        calls.push(thread.id);
        if (calls.length === 1) throw new Error("对话正在运行");
        setRemaining((current) => current.filter((item) => item.id !== thread.id));
      } }));
  }
  const root = createRoot(win.document.getElementById("root")!);
  const action = (title: string) => win.document.querySelector<HTMLButtonElement>(`[aria-label="对话操作：${title}"]`);
  const button = (scope: string, label: string) => [...win.document.querySelectorAll<HTMLButtonElement>(`${scope} button`)].find((item) => item.textContent === label);
  const click = async (node: HTMLButtonElement | null | undefined) => { assert.ok(node); await act(async () => node.click()); };
  const dialog = '[data-slot="dialog-content"]';
  const openDelete = async (title: string) => {
    await click(action(title));
    await click(button('[data-slot="popover-content"]', "删除对话"));
  };
  try {
    await act(async () => root.render(createElement(Harness)));
    assert.match(action("对话 1")!.className, /group-hover\/thread:opacity-100/);
    await openDelete("对话 0");
    assert.match(win.document.querySelector(dialog)?.textContent ?? "", /「对话 0」/);
    await click(button(dialog, "取消"));
    assert.deepEqual(calls, []);
    await openDelete("对话 1");
    await click(button(dialog, "删除对话"));
    assert.match(win.document.querySelector('[role="alert"]')?.textContent ?? "", /正在运行/);
    assert.ok(action("对话 1"));
    await click(button(dialog, "删除对话"));
    assert.deepEqual(calls, ["1", "1"]);
    assert.equal(action("对话 1") === null, true);
    assert.ok(action("对话 0"));
  } finally { await act(async () => root.unmount()); win.close(); }
});
