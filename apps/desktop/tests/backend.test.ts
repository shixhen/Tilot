import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { emit } from "@tauri-apps/api/event";
import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";
import type { ServerEvent } from "@tilot/protocol";
import { BackendConnection } from "../src/backend.ts";

// 官方 IPC 模拟需要 window 和 crypto；测试不加载 React 或真实桌面窗口。
beforeEach(() => {
  Reflect.set(globalThis, "window", { crypto: globalThis.crypto });
  mockIPC(() => undefined, { shouldMockEvents: true });
});
afterEach(() => {
  clearMocks();
  Reflect.deleteProperty(globalThis, "window");
});

// 普通浏览器缺少桌面通信桥，应返回可理解的提示而非底层接口异常。
test("浏览器直接打开时说明需要桌面程序", async () => {
  Reflect.deleteProperty(window, "__TAURI_INTERNALS__");
  await assert.rejects(BackendConnection.connect(() => assert.fail("不应收到服务事件"), assert.fail), /请在 Tilot 桌面程序中使用对话功能/);
});

// 应答可以乱序到达，流式事件不能占用等待中的 RPC 应答。
test("按 id 匹配乱序应答，并独立交付流式事件", async () => {
  const events: ServerEvent[] = [];
  const connection = await BackendConnection.connect((event) => events.push(event), assert.fail);
  try {
    const first = connection.request({ id: "first", method: "thread.list", params: {} });
    const second = connection.request({ id: "second", method: "credentials.status", params: {} });
    await assert.rejects(connection.request({ id: "first", method: "thread.list", params: {} }), /正在使用/);
    const event: ServerEvent = {
      event: "message.delta", seq: 1, threadId: "thread", turnId: "turn",
      itemId: "item", contentIndex: 0, kind: "text", delta: "你好",
    };
    await emit("backend-event", { type: "message", message: event });
    await emit("backend-event", { type: "message", message: { id: "second", success: true, result: { configured: true } } });
    await emit("backend-event", { type: "message", message: { id: "first", success: true, result: [] } });
    assert.deepEqual(await first, []);
    assert.deepEqual(await second, { configured: true });
    assert.deepEqual(events, [event]);
  } finally {
    connection.dispose();
  }
});

// 服务退出后必须结束所有等待，并拒绝后续请求。
test("服务退出时拒绝未完成请求并通知界面", async () => {
  const errors: Error[] = [];
  const connection = await BackendConnection.connect(() => {}, (error) => errors.push(error));
  const pending = connection.request({ id: "pending", method: "thread.list", params: {} });
  const rejected = assert.rejects(pending, /连接已关闭/);
  await emit("backend-event", { type: "stopped", error: "服务异常退出" });
  await rejected;
  assert.equal(errors[0]?.message, "服务异常退出");
  await assert.rejects(connection.request({ id: "later", method: "thread.list", params: {} }), /连接已关闭/);
});
