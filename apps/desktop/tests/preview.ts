import { mockIPC } from "@tauri-apps/api/mocks";
import { emit } from "@tauri-apps/api/event";
import type { AppConfig, AttemptView, RpcRequest, Thread, Turn, TurnNotification } from "@tilot/protocol";

// 仅供浏览器手动验收，不进入应用入口或生产构建，不读取本地真实配置或密钥。
let config: AppConfig = { providerId: "default", model: "deepseek-flash", reasoningEffort: "high",
  providers: [{ id: "default", name: "example.invalid", baseURL: "https://example.invalid", models: [{ id: "deepseek-flash", contextTokens: 65536 }] }], maxOutputTokens: 16384, reserveTokens: 4096, maxStepsPerRun: 30, maxAutomaticRetries: 2 };
// 已配置密钥的服务 id。
let configured: string[] = [];
let seq = 0;
let pickCount = 0;
const threads: Thread[] = [];
const turns: Turn[] = [];
const inputs = new Map<string, string>();
const attempts = new Map<string, AttemptView[]>();

/** 模拟本地服务事件，消息顺序和正式协议相同。 */
async function notify(event: TurnNotification): Promise<void> {
  await emit("backend-event", { type: "message", message: { ...event, seq: ++seq } });
}

/** 验收用服务：支持设置、创建、切换、流式预览和取消，不连接模型。 */
async function respond(request: RpcRequest): Promise<unknown> {
  switch (request.method) {
    case "config.get": return config;
    case "config.set":
      config = request.params.config;
      configured = configured.filter((id) => config.providers.some((provider) => provider.id === id));
      return config;
    case "credentials.status": return { configured };
    case "credentials.set": configured = [...new Set([...configured, request.params.providerId])]; return null;
    case "thread.list": return threads;
    case "thread.create": {
      const thread = { id: crypto.randomUUID(), title: request.params.title, projectPath: request.params.projectPath ?? null,
        providerId: config.providerId, model: config.model, reasoningEffort: config.reasoningEffort, createdAt: Date.now(), updatedAt: Date.now() };
      threads.unshift(thread); return thread;
    }
    case "thread.update": {
      const thread = threads.find((item) => item.id === request.params.threadId)!;
      Object.assign(thread, { providerId: request.params.providerId, model: request.params.model, reasoningEffort: request.params.reasoningEffort });
      return thread;
    }
    // 模拟 GET /models：任意非空密钥都能加载，地址不同返回不同模型。
    case "models.fetch":
      if (!request.params.apiKey.trim() && !configured.includes(request.params.providerId)) throw new Error("请填写 API Key。");
      await new Promise((resolve) => setTimeout(resolve, 400));
      return request.params.baseURL.includes("deepseek") ? ["deepseek-flash", "deepseek-pro"] : ["model-a", "model-b", "model-c"];
    case "turn.list": return turns.filter((turn) => turn.threadId === request.params.threadId);
    case "turn.inputs": return [{ id: 1, turnId: request.params.turnId, content: inputs.get(request.params.turnId), createdAt: Date.now() }];
    case "turn.attempts": return attempts.get(request.params.turnId) ?? [];
    case "turn.start": {
      const turn: Turn = { id: crypto.randomUUID(), threadId: request.params.threadId, sequence: turns.length + 1, status: "running", createdAt: Date.now(), finishedAt: null, error: null };
      turns.push(turn); inputs.set(turn.id, request.params.input);
      await notify({ event: "turn.started", turn });
      // 模拟完整循环；普通对话只有网页读取，项目对话另演示本地工具。
      const { threadId } = turn;
      const project = Boolean(threads.find((thread) => thread.id === threadId)?.projectPath);
      const thinking = Array.from({ length: 8 }, (_, index) => `第 ${index + 1} 步：${project ? "检查目录结构并确认需要读取哪些文件" : "读取用户提供的公开网页，检查来源与正文"}。\n\n`);
      const answer = ["## 项目结构\n\n- **Server**：管理服务\n- **Core**：调度执行\n\n", "```ts\nexport function greet(name: string) {\n  return `你好，${name}`;\n}\n```\n\n", "| 模块 | 状态 |\n| --- | --- |\n| 桌面对话 | 已接入 |\n\n[文档](https://example.com)"];
      const tool = { id: crypto.randomUUID(), outputIndex: 1, name: "shell", arguments: JSON.stringify({ command: "git ls-files apps packages | Select-Object -First 40" }), output: null as string | null, running: true };
      const edit = { id: `${turn.id}-edit`, outputIndex: 2, name: "edit", arguments: JSON.stringify({ path: "src/greet.ts", edits: [
        { oldText: 'const greeting = "Hello";', newText: 'const greeting = "你好";' },
        { oldText: "return greeting;", newText: "return `${greeting}，${name}`;" },
      ] }), output: null as string | null, running: false };
      const searches = [
        { name: "ls", arguments: {}, data: { path: "", entries: [{ path: "package.json", type: "file" }, { path: "src", type: "directory" }], truncated: false, truncatedBy: null } },
        { name: "find", arguments: { pattern: "*.ts", path: "src" }, data: { path: "src", files: ["src/greet.ts"], truncated: false, truncatedBy: null } },
        { name: "grep", arguments: { pattern: "greeting", path: "src", context: 1, limit: 1 }, data: { path: "src", matches: [
          { path: "src/greet.ts", line: 1, text: 'const greeting = "你好";', textTruncated: false, before: [],
            after: [{ line: 2, text: "export function greet(name: string) {", textTruncated: false }] },
        ], truncated: true, truncatedBy: "items" } },
      ].map((search, index) => ({ id: `${turn.id}-${search.name}`, outputIndex: index + 3, name: search.name,
        arguments: JSON.stringify(search.arguments), output: JSON.stringify({ status: "ok", data: search.data }), running: false }));
      const web = { id: `${turn.id}-web`, outputIndex: project ? 6 : 1, name: "web_fetch", arguments: '{"url":"https://example.com/docs"}',
        output: JSON.stringify({ status: "ok", data: { url: "https://example.com/docs", finalUrl: "https://example.com/docs", title: "Tilot 网页读取示例", fetchedAt: Date.now(),
          content: "# 网页读取\n\n网页正文已转换为 Markdown。\n\n- 保留来源链接\n- 缓存正文可继续读取\n\n[更多说明](https://example.com/guide)",
          outputId: `${turn.id}-web-cache`, offset: 1, lineCount: 9, nextOffset: 10, truncatedBy: "lines", artifactTruncated: false,
        } }), running: false };
      const first: AttemptView = { id: `${turn.id}-1`, turnId: turn.id, sequence: 1, inputThroughId: 1, status: "completed", error: null, createdAt: turn.createdAt, finishedAt: Date.now(),
        messages: [{ itemId: `${turn.id}-thought`, outputIndex: 0, parts: [{ kind: "reasoning", text: thinking.join("") }] }], tools: project ? [tool] : [] };
      const second: AttemptView = { ...first, id: `${turn.id}-2`, sequence: 2, tools: [], messages: [{ itemId: `${turn.id}-answer`, outputIndex: 0, parts: [{ kind: "text", text: answer.join("") }] }] };
      const projectSteps = [
        () => notify({ event: "attempt.updated", threadId, turnId: turn.id, attempt: first }),
        ...["apps/desktop/src/main.tsx", "apps/desktop/src/main.tsx\napps/desktop/src/workspace/page.tsx"].map((output) => () => notify({
          event: "tool.progress", threadId, turnId: turn.id, attemptId: first.id, toolId: tool.id, output, truncated: false, partialLine: false,
        })),
        () => {
          tool.running = false;
          const output = "apps/desktop/src/main.tsx\napps/desktop/src/workspace/page.tsx\npackages/server/src/rpc.ts";
          tool.output = JSON.stringify({ status: "ok", data: { status: "completed", output, exitCode: 0, durationMs: 1500,
            outputId: tool.id, outputBytes: new TextEncoder().encode(output).length, outputLines: 3, truncated: false, truncatedBy: null, partialLine: false, artifactTruncated: false,
          } });
          return notify({ event: "attempt.updated", threadId, turnId: turn.id, attempt: { ...first, tools: [{ ...tool }] } });
        },
        () => {
          edit.running = true;
          return notify({ event: "attempt.updated", threadId, turnId: turn.id, attempt: { ...first, tools: [{ ...tool }, { ...edit }] } });
        },
        () => {
          edit.running = false;
          edit.output = JSON.stringify({ status: "ok", data: { path: "src/greet.ts", bytesWritten: 101, replacements: 2, firstChangedLine: 1,
            diff: '--- a/src/greet.ts\n+++ b/src/greet.ts\n@@ -1,4 +1,4 @@\n-const greeting = "Hello";\n+const greeting = "你好";\n export function greet(name: string) {\n-  return greeting;\n+  return `${greeting}，${name}`;\n }\n', diffTruncated: false,
          } });
          return notify({ event: "attempt.updated", threadId, turnId: turn.id, attempt: { ...first, tools: [{ ...tool }, { ...edit }] } });
        },
        () => notify({ event: "attempt.updated", threadId, turnId: turn.id, attempt: { ...first, tools: [{ ...tool }, { ...edit }, ...searches] } }),
      ];
      const finalTools = () => [...(project ? [{ ...tool }, { ...edit }, ...searches] : []), web];
      const steps = [
        ...thinking.map((delta) => () => notify({ event: "message.delta", threadId, turnId: turn.id, itemId: `${turn.id}-thought`, contentIndex: 0, kind: "reasoning", delta })),
        ...(project ? projectSteps : []),
        () => notify({ event: "attempt.updated", threadId, turnId: turn.id, attempt: { ...first, tools: finalTools() } }),
        ...answer.map((delta) => () => notify({ event: "message.delta", threadId, turnId: turn.id, itemId: `${turn.id}-answer`, contentIndex: 0, kind: "text", delta })),
        () => {
          turn.status = "completed"; turn.finishedAt = Date.now();
          attempts.set(turn.id, [{ ...first, tools: finalTools() }, second]);
          return notify({ event: "turn.finished", turn });
        },
      ];
      const timer = setInterval(() => {
        if (turn.status !== "running") { clearInterval(timer); return; }
        void steps.shift()!();
        if (!steps.length) clearInterval(timer);
      }, 500);
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
