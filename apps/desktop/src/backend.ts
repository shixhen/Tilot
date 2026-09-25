import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type { RpcRequest, RpcResult, ServerEvent, ServerMessage } from "@tilot/protocol";

/** Rust 宿主转发的消息或进程退出通知，不包含进程启动参数。 */
type BackendEvent =
  | { type: "message"; message: ServerMessage }
  | { type: "stopped"; error: string | null };

/** 等待 RPC 应答的调用，连接结束时统一拒绝，避免界面一直等待。 */
interface PendingRequest {
  resolve: (result: RpcResult) => void;
  reject: (error: Error) => void;
}

/** 前端服务连接，按请求 id 关联应答，服务事件独立交付。 */
export class BackendConnection {
  private readonly pending = new Map<string, PendingRequest>();
  private unlisten: UnlistenFn | undefined;
  private closed = false;
  private readonly onEvent: (event: ServerEvent) => void;
  private readonly onDisconnect: (error: Error) => void;

  /** 保存界面回调，实际连接由 connect 完成。 */
  private constructor(onEvent: (event: ServerEvent) => void, onDisconnect: (error: Error) => void) {
    this.onEvent = onEvent;
    this.onDisconnect = onDisconnect;
  }

  /** 先订阅事件再启动服务，避免遗漏启动阶段的应答或错误。 */
  static async connect(onEvent: (event: ServerEvent) => void, onDisconnect: (error: Error) => void): Promise<BackendConnection> {
    // 桌面宿主或官方测试 mock 才会注入通信桥，普通浏览器不具备本地服务连接能力。
    if (!("__TAURI_INTERNALS__" in window)) {
      throw new Error("请在 Tilot 桌面程序中使用对话功能；当前浏览器页面仅供查看界面。");
    }
    const connection = new BackendConnection(onEvent, onDisconnect);
    try {
      connection.unlisten = await listen<BackendEvent>("backend-event", ({ payload }) => connection.receive(payload));
      await invoke("connect_backend");
      if (connection.closed) throw new Error("本地服务在连接期间退出。");
      return connection;
    } catch (error) {
      connection.dispose();
      throw error;
    }
  }

  /** 发送带唯一 id 的请求；先登记应答，再写入，避免快速应答早于登记。 */
  request(request: RpcRequest): Promise<RpcResult> {
    if (this.closed) return Promise.reject(new Error("本地服务连接已关闭。"));
    if (this.pending.has(request.id)) return Promise.reject(new Error("请求 id 正在使用中。"));
    return new Promise((resolve, reject) => {
      this.pending.set(request.id, { resolve, reject });
      void invoke("send_backend", { request }).catch((error: unknown) => {
        const pending = this.pending.get(request.id);
        this.pending.delete(request.id);
        pending?.reject(new Error(String(error)));
      });
    });
  }

  /** 移除本页面订阅并结束等待；Node 进程生命周期仍由 Rust 宿主管理。 */
  dispose(): void {
    this.closed = true;
    this.unlisten?.();
    this.unlisten = undefined;
    for (const pending of this.pending.values()) pending.reject(new Error("本地服务连接已关闭。"));
    this.pending.clear();
  }

  /** 分发消息，不将流式事件误认为 RPC 返回值；退出时通知界面并结束所有等待。 */
  private receive(event: BackendEvent): void {
    if (this.closed) return;
    if (event.type === "stopped") {
      this.dispose();
      this.onDisconnect(new Error(event.error ?? "本地服务已退出。"));
      return;
    }
    const message = event.message;
    if ("event" in message) {
      this.onEvent(message);
    } else if (message.id !== null) {
      const pending = this.pending.get(message.id);
      this.pending.delete(message.id);
      if (message.success) pending?.resolve(message.result);
      else pending?.reject(new Error(message.error.message));
    }
  }
}
