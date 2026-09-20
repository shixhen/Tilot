import { mockIPC } from "@tauri-apps/api/mocks";
import { emit } from "@tauri-apps/api/event";
import type { AppConfig, RpcRequest, Thread, Turn, ServerEvent } from "@tilot/protocol";

// 仅供浏览器手动验收，不进入应用入口或生产构建，不读取本地真实配置或密钥。
let config: AppConfig = { baseURL: "https://example.invalid", model: "deepseek-flash", reasoningEffort: "high", contextBudgetTokens: 65536, maxOutputTokens: 16384, reserveTokens: 4096, maxStepsPerRun: 30, maxAutomaticRetries: 2 };
let configured = false;
let seq = 0;
let pickCount = 0;
const threads: Thread[] = [];
const turns: Turn[] = [];
const inputs = new Map<string, string>();

/** 模拟本地服务事件，消息顺序和正式协议相同。 */
async function notify(event: Omit<Extract<ServerEvent, { event: "message.delta" }>, "seq"> | { event: "turn.started" | "turn.finished"; turn: Turn }): Promise<void> {
  await emit("backend-event", { type: "message", message: { ...event, seq: ++seq } });
}

/** 验收用服务：支持设置、创建、切换、流式预览和取消，不连接模型。 */
async function respond(request: RpcRequest): Promise<unknown> {
  switch (request.method) {
    case "config.get": return config;
    case "config.set": config = request.params.config; return config;
    case "credentials.status": return { configured };
    case "credentials.set": configured = true; return null;
    case "credentials.delete": configured = false; return null;
    case "thread.list": return threads;
    case "thread.create": {
      const thread = { id: crypto.randomUUID(), title: request.params.title, projectPath: request.params.projectPath ?? null, createdAt: Date.now(), updatedAt: Date.now() };
      threads.unshift(thread); return thread;
    }
    case "turn.list": return turns.filter((turn) => turn.threadId === request.params.threadId);
    case "turn.inputs": return [{ id: 1, turnId: request.params.turnId, content: inputs.get(request.params.turnId), createdAt: Date.now() }];
    case "turn.attempts": return [];
    case "turn.start": {
      const turn: Turn = { id: crypto.randomUUID(), threadId: request.params.threadId, sequence: turns.length + 1, status: "running", createdAt: Date.now(), finishedAt: null, error: null };
      turns.push(turn); inputs.set(turn.id, request.params.input);
      await notify({ event: "turn.started", turn });
      let index = 0;
      const chunks = ["我会先梳理问题。", "## 项目结构\n\n- **Server**：管理服务\n- **Core**：调度执行\n\n```ts\nexport function greet(name: string) {\n  return `你好，${name}`;", "\n}\n```\n\n| 模块 | 状态 |\n| --- | --- |\n| 桌面对话 | 已接入 |\n\n> 这是一段界面测试回复。\n\n[文档](https://example.com)\n\n你可以切换任务、展开思考过程，或点击停止按钮。"];
      const timer = setInterval(() => {
        if (turn.status !== "running") { clearInterval(timer); return; }
        if (index < chunks.length) {
          const reasoning = index === 0;
          void notify({ event: "message.delta", threadId: turn.threadId, turnId: turn.id, itemId: reasoning ? "thought" : "answer", contentIndex: 0, kind: reasoning ? "reasoning" : "text", delta: chunks[index++]! });
          if (index === chunks.length) clearInterval(timer);
        }
      }, 800);
      return turn;
    }
    case "turn.interrupt": {
      const turn = turns.find((turn) => turn.id === request.params.turnId)!;
      turn.status = "cancelled"; turn.finishedAt = Date.now();
      await notify({ event: "turn.finished", turn }); return { interrupted: true };
    }
    default: throw new Error(`验收页面不支持 ${request.method}`);
  }
}

mockIPC(async (command, payload) => {
  // 浏览器不打开原生选择器；第一次模拟选择目录，第二次模拟取消。
  if (command === "plugin:dialog|open") return ++pickCount % 2 === 1 ? "D:\\Projects\\Tilot-demo" : null;
  if (command !== "send_backend") return;
  const request = (payload as { request: RpcRequest }).request;
  const result = await respond(request);
  await emit("backend-event", { type: "message", message: { id: request.id, success: true, result } });
}, { shouldMockEvents: true });
await import("../src/main");
