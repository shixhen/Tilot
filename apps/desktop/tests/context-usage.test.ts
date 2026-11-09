import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { act, createElement } from "react";
import { JSDOM } from "jsdom";
import type { AppConfig } from "@tilot/protocol";
import type { TurnRecord } from "../src/conversation.ts";
import type { Request } from "../src/client.ts";

async function setup(context: TestContext) {
  const dom = new JSDOM('<div id="root"></div>', { url: "http://localhost", pretendToBeVisual: true });
  const win = dom.window;
  for (const key of ["document", "HTMLElement", "HTMLInputElement", "HTMLButtonElement", "HTMLSelectElement", "Element", "Node", "NodeFilter", "MutationObserver", "Event", "KeyboardEvent", "CustomEvent", "getComputedStyle"] as const) {
    Object.defineProperty(globalThis, key, { value: win[key], configurable: true });
  }
  Object.assign(globalThis, { window: win, IS_REACT_ACT_ENVIRONMENT: true });
  const { createRoot } = await import("react-dom/client");
  const root = createRoot(win.document.getElementById("root")!);
  context.after(async () => { await act(async () => root.unmount()); win.close(); });
  return { root, win };
}

test("上下文图标悬浮才显示用量，切换容量更新比例，未知用量与未设置容量有明确提示", { timeout: 10000 }, async (context) => {
  const { root, win } = await setup(context);
  const { TooltipProvider } = await import("../src/components/ui/tooltip.tsx");
  const { ContextUsage } = await import("../src/workspace/context-usage.tsx");
  const records: TurnRecord[] = [{
    turn: { id: "turn", threadId: "thread", sequence: 1, permissionMode: "read-only", status: "completed", createdAt: 1, finishedAt: 2, error: null },
    inputs: [], previews: [], attempts: [{
      id: "attempt", turnId: "turn", sequence: 1, inputThroughId: 1, status: "completed", createdAt: 1, finishedAt: 2, error: null, messages: [], tools: [],
      metrics: { inputTokens: 219000, cachedTokens: 100000, outputTokens: 0, firstTokenMs: null, durationMs: null },
    }],
  }];
  const render = async (capacity: number | null, data = records) => {
    await act(async () => root.render(createElement(TooltipProvider, { children: createElement(ContextUsage, { records: data, capacity }) })));
  };
  await render(475000);
  assert.equal(win.document.querySelector('[role="tooltip"]'), null);
  const trigger = win.document.querySelector('[aria-label="上下文使用情况"]')!;
  await act(async () => {
    trigger.dispatchEvent(new win.MouseEvent("pointermove", { bubbles: true }));
    await delay(20);
  });
  const details = () => win.document.querySelector('[data-slot="tooltip-content"]')!.textContent!;
  assert.match(details(), /46% 已用（剩余 54%）/);
  assert.match(details(), /已用 219k Token，总容量 475k Token/);
  await render(100000);
  assert.match(details(), /219% 已用（剩余 0%）/);
  await render(null);
  assert.match(details(), /总容量 未设置/);
  await render(475000, []);
  assert.match(details(), /已用 暂无数据/);
  await act(async () => trigger.dispatchEvent(new win.MouseEvent("pointerleave", { bubbles: true })));
  await act(async () => win.document.body.dispatchEvent(new win.MouseEvent("pointermove", { bubbles: true, clientX: 1000, clientY: 1000 })));
  assert.equal(win.document.querySelector('[role="tooltip"]') === null, true);
});

test("设置逐模型编辑上下文容量，刷新列表保留同地址的容量，保存并重新打开后仍可编辑", { timeout: 10000 }, async (context) => {
  const { root, win } = await setup(context);
  const { SettingsDialog } = await import("../src/workspace/settings-dialog.tsx");
  let saved: AppConfig = {
    providerId: "default", model: "model-a", reasoningEffort: "high", maxAutomaticRetries: 2, defaultPermissionMode: "workspace-write",
    providers: [{ id: "default", name: "测试服务", baseURL: "https://example.test", models: [{ id: "model-a", contextTokens: 475000 }] }],
  };
  const request = (async (method: string, params: { config: AppConfig }) => {
    if (method === "models.fetch") return ["model-a", "model-b"];
    if (method === "config.set") { saved = structuredClone(params.config); return saved; }
    throw new Error(method);
  }) as Request;
  const render = async (key: string) => {
    await act(async () => root.render(createElement(SettingsDialog, { key, config: saved, configured: ["default"], used: [], request, onSaved: async () => {}, onClose: () => {} })));
  };
  const input = () => win.document.querySelector<HTMLInputElement>('[aria-label="model-a 上下文容量（Token）"]')!;
  const type = async (value: string) => {
    await act(async () => {
      Object.getOwnPropertyDescriptor(win.HTMLInputElement.prototype, "value")!.set!.call(input(), value);
      input().dispatchEvent(new win.Event("input", { bubbles: true }));
    });
  };
  const save = async () => { await act(async () => win.document.querySelector("form")!.dispatchEvent(new win.Event("submit", { bubbles: true, cancelable: true }))); };
  await render("first");
  assert.equal(input().value, "475000");
  await type("1048576");
  await act(async () => win.document.querySelector<HTMLButtonElement>('[aria-label="重新加载模型"]')!.click());
  assert.equal(input().value, "1048576");
  assert.equal(win.document.querySelector<HTMLInputElement>('[aria-label="model-b 上下文容量（Token）"]')!.value, "666000");
  await save();
  assert.equal(saved.providers[0]!.models[0]!.contextTokens, 1048576);
  await render("reopened");
  assert.equal(input().value, "1048576");
  await type("");
  await save();
  assert.equal(saved.providers[0]!.models[0]!.contextTokens, undefined);
  await render("default-capacity");
  assert.equal(input().value, "666000");
});
