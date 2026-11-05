import assert from "node:assert/strict";
import { test } from "node:test";
import { act, createElement } from "react";
import { JSDOM } from "jsdom";
import type { ImageRef } from "@tilot/protocol";
import type { Request } from "../src/client.ts";
import type { WorkspaceState } from "../src/hooks/use-workspace.ts";

test("缩略图只读取本地图片，点击打开应用内预览，可缩放、复位及拖动", async () => {
  const dom = new JSDOM('<!doctype html><div id="root"></div>', { url: "http://localhost", pretendToBeVisual: true }); const win = dom.window;
  for (const key of ["window", "document", "HTMLElement", "Element", "Node", "NodeFilter", "HTMLInputElement", "MutationObserver", "Event", "KeyboardEvent", "CustomEvent", "getComputedStyle"] as const) Object.defineProperty(globalThis, key, { value: key === "window" ? win : win[key], configurable: true });
  Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { value: true, configurable: true });
  win.HTMLElement.prototype.setPointerCapture = () => {};
  const { createRoot } = await import("react-dom/client");
  const { ImageProvider, ImageGallery } = await import("../src/workspace/images.tsx");
  const image: ImageRef = { id: "a".repeat(64), name: "截图.png", bytes: 70, mimeType: "image/png" };
  const calls: unknown[] = [];
  const request = (async (method: string, params: unknown) => { calls.push({ method, params }); return { image, dataUrl: "data:image/png;base64,aGVsbG8=" }; }) as Request;
  const root = createRoot(win.document.getElementById("root")!);
  const click = async (label: string) => { await act(async () => { win.document.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)!.click(); }); };
  try {
    await act(async () => { root.render(createElement(ImageProvider, { request, threadId: "thread", children: createElement(ImageGallery, { images: [image] }) })); });
    await click("查看图片 截图.png");
    assert.equal(win.document.querySelector('[role="dialog"] img')!.getAttribute("src"), "data:image/png;base64,aGVsbG8=");
    await click("放大图片"); assert.match(win.document.querySelector('[role="dialog"]')!.textContent!, /125%/);
    await click("缩小图片"); await click("复位图片");
    const picture = win.document.querySelector<HTMLImageElement>('[role="dialog"] img')!;
    const container = picture.parentElement!;
    await act(async () => {
      container.dispatchEvent(new win.MouseEvent("pointerdown", { bubbles: true, button: 0, clientX: 10, clientY: 20 }));
      container.dispatchEvent(new win.MouseEvent("pointermove", { bubbles: true, clientX: 30, clientY: 50 }));
      container.dispatchEvent(new win.MouseEvent("pointerup", { bubbles: true }));
    });
    assert.match(picture.style.transform, /translate\(20px, 30px\)/);
    assert.ok(calls.every((call) => (call as { method: string }).method === "image.read"));
    assert.equal(calls.length, 1);
  } finally { await act(async () => root.unmount()); win.close(); }
});

test("输入框加号提供上传菜单，图片粘贴加入附件，普通网址粘贴保持文本，失败项可重试或移除", async () => {
  const dom = new JSDOM('<!doctype html><div id="root"></div>', { url: "http://localhost", pretendToBeVisual: true }); const win = dom.window;
  for (const key of ["window", "document", "HTMLElement", "Element", "Node", "NodeFilter", "HTMLInputElement", "HTMLTextAreaElement", "MutationObserver", "Event", "KeyboardEvent", "CustomEvent", "getComputedStyle"] as const) Object.defineProperty(globalThis, key, { value: key === "window" ? win : win[key], configurable: true });
  Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { value: true, configurable: true });
  Object.defineProperty(globalThis, "ResizeObserver", { value: class { observe() {} disconnect() {} }, configurable: true });
  const { createRoot } = await import("react-dom/client"); const { Composer } = await import("../src/workspace/composer.tsx");
  const file = new win.File(["图片字节"], "clipboard.png", { type: "image/png" });
  let uploads = 0; let retries = 0; let removals = 0; const added: unknown[][] = [];
  const state = { draft: "", attachments: [{ id: "failure", name: "失败.png", error: "读取失败" }], busy: false, running: null, canSend: false,
    permissionMode: "read-only", projectPath: null, submit: () => {}, editDraft: () => {}, chooseImages: () => { uploads++; }, chooseProject: () => {}, select: () => {},
    retryImage: () => { retries++; }, removeImage: () => { removals++; }, addImages: (files: unknown[]) => added.push(files),
    chat: { connected: true, selected: null, error: "", queue: { messages: [], paused: false, busy: false }, approvals: [], question: null } } as unknown as WorkspaceState;
  const root = createRoot(win.document.getElementById("root")!);
  const click = async (node: Element) => { await act(async () => { (node as HTMLElement).click(); }); };
  try {
    await act(async () => root.render(createElement(Composer, { state })));
    await click(win.document.querySelector('[aria-label="添加"]')!);
    await click([...win.document.querySelectorAll("button")].find((button) => button.textContent === "上传图片")!);
    assert.equal(uploads, 1);
    const editor = win.document.querySelector("textarea")!;
    const paste = (files: File[]) => { const event = new win.Event("paste", { bubbles: true, cancelable: true }); Object.defineProperty(event, "clipboardData", { value: { files } }); return event; };
    const imagePaste = paste([file]); await act(async () => { editor.dispatchEvent(imagePaste); });
    assert.equal(imagePaste.defaultPrevented, true); assert.deepEqual(added, [[file]]);
    const textPaste = paste([]); await act(async () => { editor.dispatchEvent(textPaste); }); assert.equal(textPaste.defaultPrevented, false);
    await click([...win.document.querySelectorAll("button")].find((button) => button.textContent === "重试")!);
    await click(win.document.querySelector('[aria-label="移除图片 失败.png"]')!);
    assert.equal(retries, 1); assert.equal(removals, 1);
  } finally { await act(async () => root.unmount()); win.close(); }
});
