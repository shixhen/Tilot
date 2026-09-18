# Tilot

基于 Tauri、React、TypeScript 和 Node.js 的本地桌面 Agent。
当前仅建立工程基础，实现项目目录验证，尚未接入界面和模型。

## 本地开发

使用 Node.js 24 和 npm，在项目根目录执行：

```sh
npm ci
npm run typecheck
npm test
```

`typecheck` 检查 TypeScript 类型，不生成文件，也不启动应用。
`test` 运行本地自动化测试；模型请求使用模拟数据，不连接真实模型服务。
`packages/server/src/workspace.ts` 定义项目目录及其打开逻辑。
打开目录只验证目录本身；后续文件工具还需要独立检查文件访问范围和忽略规则。

## 目录与职责

采用 npm workspaces，在同一个仓库管理桌面应用和独立模块包。

| 目录 | 职责 |
| --- | --- |
| `apps/desktop` | `src` 放 React 界面，`src-tauri` 放 Tauri 桌面宿主 |
| `packages/server` | Node.js 服务入口，组装模块、管理生命周期、处理 RPC 和推送事件 |
| `packages/agent-core` | 调度 Agent 执行流程 |
| `packages/context` | 构建上下文、加载 Skills、压缩历史 |
| `packages/tool` | 内置工具、MCP、注册与执行 |
| `packages/store` | 保存对话、配置、凭据和其他持久数据 |
| `packages/responses` | 通过 OpenAI SDK 调用 Responses API |
| `packages/protocol` | 桌面端与 Server 共用的 RPC 请求、响应和事件类型 |

当前各包只建立清单，随实现增加入口和实际依赖，不预写空函数。
根目录的类型检查目前覆盖 `packages` 中的代码；桌面端实现时再添加 React 配置。

## 已确认的设计决定

- Responses 使用 OpenAI SDK 接入 Responses API，优先复用 SDK 类型。
- 不设计通用 Provider，不自行实现 HTTP 或 SSE 协议解析。
- 模块划分见 `docs/technical-design.md`，模型接入细节见 `docs/deepseek-integration.md`。
- 功能范围以 `docs/product-requirements.md` 为准，不实现技术设计示例中的 shell 工具。
- 分小批次开发，函数和类型添加中文用途注释；每批解释并经确认后继续。
