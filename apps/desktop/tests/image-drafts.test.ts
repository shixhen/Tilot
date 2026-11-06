import assert from "node:assert/strict";
import { test } from "node:test";
import type { ImageRef } from "@tilot/protocol";
import type { Request } from "../src/client.ts";
import { ImageDrafts, droppedImages } from "../src/image-drafts.ts";
import { JSDOM } from "jsdom";

test("多图导入按添加顺序显示，成功项先发送，失败和发送期间才完成的图片仍保留，重启恢复图文", async () => {
  let saved: string | null = null;
  const storage = { getItem: () => saved, setItem: (_key: string, value: string) => { saved = value; } };
  const imports: { path: string; reply: ReturnType<typeof Promise.withResolvers<ImageRef>> }[] = [];
  const request = (async (_method: string, params: { path: string }) => {
    const reply = Promise.withResolvers<ImageRef>(); imports.push({ path: params.path, reply }); return reply.promise;
  }) as Request;
  const book = new ImageDrafts(request, storage);
  const image = (name: string, id: string): ImageRef => ({ id: id.repeat(64), name, bytes: 70, mimeType: "image/png" });
  book.edit("new:", "对比这些图片"); book.add("new:", [{ path: "/first.png" }, { path: "/second.png" }, { path: "/pending.png" }]);
  imports[1]!.reply.reject(new Error("读取失败")); imports[0]!.reply.resolve(image("first.png", "a"));
  await new Promise((resolve) => setImmediate(resolve));
  const snapshot = book.view("new:");
  assert.equal(snapshot.attachments[0]!.image!.id, "a".repeat(64)); assert.equal(snapshot.attachments[1]!.error, "读取失败");
  imports[2]!.reply.resolve(image("pending.png", "c")); await new Promise((resolve) => setImmediate(resolve));
  book.settle("new:", "thread", snapshot, true);
  const retained = book.view("thread");
  assert.equal(retained.text, ""); assert.equal(retained.attachments.length, 2);
  assert.equal(retained.attachments[0]!.error, "读取失败"); assert.equal(retained.attachments[1]!.image!.id, "c".repeat(64));
  book.edit("thread", "这次只看保留的图片");
  const reopened = new ImageDrafts(request, storage);
  assert.deepEqual(reopened.view("thread"), book.view("thread"));
  const retry = reopened.retry(retained.attachments[0]!.id);
  imports[3]!.reply.resolve(image("second.png", "b")); await retry;
  assert.deepEqual(reopened.view("thread").attachments.map((item) => item.image!.name), ["second.png", "pending.png"]);
  const beforeFailure = reopened.view("thread"); reopened.settle("thread", "thread", beforeFailure, false);
  assert.deepEqual(reopened.view("thread"), beforeFailure);
});

test("删除或切换草稿后，迟到的图片导入不复活附件、不串到其他对话；坏存档不被覆盖", async () => {
  const replies: ReturnType<typeof Promise.withResolvers<ImageRef>>[] = [];
  const request = (async () => { const reply = Promise.withResolvers<ImageRef>(); replies.push(reply); return reply.promise; }) as Request;
  let saved: string | null = null;
  const storage = { getItem: () => saved, setItem: (_key: string, value: string) => { saved = value; } };
  const book = new ImageDrafts(request, storage);
  book.add("thread-a", [{ url: "https://example.test/a.png" }]);
  book.remove("thread-a", book.view("thread-a").attachments[0]!.id); book.edit("thread-b", "其他对话");
  replies[0]!.resolve({ id: "a".repeat(64), name: "a.png", bytes: 70, mimeType: "image/png" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(book.view("thread-a").attachments.length, 0); assert.equal(book.view("thread-b").text, "其他对话");
  saved = "invalid-json"; const broken = new ImageDrafts(request, storage);
  broken.edit("thread", "仍能编辑"); assert.match(broken.error, /无法读取/); assert.equal(saved, "invalid-json");
});

test("剪贴板和拖拽 File 使用原始字节；网页拖拽提取图片 URL，普通文本网址不自动转附件", { timeout: 5000 }, async () => {
  const dom = new JSDOM("");
  Object.defineProperty(globalThis, "FileReader", { value: dom.window.FileReader, configurable: true });
  Object.defineProperty(globalThis, "DOMParser", { value: dom.window.DOMParser, configurable: true });
  let imported: unknown;
  const request = (async (_method: string, params: unknown) => { imported = params; return { id: "a".repeat(64), name: "粘贴.png", bytes: 4, mimeType: "image/png" }; }) as Request;
  const ready = Promise.withResolvers<void>();
  const book = new ImageDrafts(request, { getItem: () => null, setItem: () => {} });
  const unsubscribe = book.subscribe(() => { if (book.view("thread").attachments[0]?.image) ready.resolve(); });
  const bytes = new Uint8Array([137, 80, 78, 71]); const file = new dom.window.File([bytes], "粘贴.png", { type: "image/png" });
  book.add("thread", [file]);
  await ready.promise;
  unsubscribe();
  assert.deepEqual(imported, { base64: Buffer.from(bytes).toString("base64"), name: "粘贴.png" });
  const transfer = (values: Record<string, string>, files: File[] = []) => ({ files, getData: (type: string) => values[type] ?? "" }) as unknown as DataTransfer;
  assert.deepEqual(droppedImages(transfer({ "text/plain": "https://example.test/a.png" })), []);
  assert.deepEqual(droppedImages(transfer({ "text/html": '<img src="https://example.test/a.png">' })), [{ url: "https://example.test/a.png" }]);
  assert.deepEqual(droppedImages(transfer({ "text/html": '<img src="/a.png">', "text/uri-list": "https://example.test/a.png" })), [{ url: "https://example.test/a.png" }]);
  assert.deepEqual(droppedImages(transfer({ "text/uri-list": "# comment\r\nhttps://example.test/b.webp" })), [{ url: "https://example.test/b.webp" }]);
  assert.deepEqual(droppedImages(transfer({ "text/uri-list": "https://example.test/b.webp" }, [file])), [file]);
  dom.window.close();
});

test("在入队与清空草稿之间退出，恢复核对后不出现重复待发内容，未交付和失败附件仍保留", async () => {
  let saved: string | null = null;
  const storage = { getItem: () => saved, setItem: (_key: string, value: string) => { saved = value; } };
  const request = (async () => { throw new Error("导入失败"); }) as Request;
  const book = new ImageDrafts(request, storage);
  book.edit("thread", "已交付任务"); book.add("thread", [{ path: "/missing.png" }]);
  await new Promise((resolve) => setImmediate(resolve));
  const id = book.prepare("thread", book.view("thread"))!;
  book.edit("not-sent", "还没入队"); book.prepare("not-sent", book.view("not-sent"));
  const reopened = new ImageDrafts(request, storage);
  await reopened.recover(async (ids) => { assert.ok(ids.includes(id)); return [id]; });
  assert.equal(reopened.view("thread").text, ""); assert.equal(reopened.view("thread").attachments[0]!.error, "导入失败");
  assert.equal(reopened.view("not-sent").text, "还没入队"); assert.equal(reopened.view("not-sent").submission, undefined);
});
