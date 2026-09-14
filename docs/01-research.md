# 技术调研与选型

核查日期：2026-09-14 · 范围：Windows 代码读写助手

## 1. 选型结论

采用 **TS Agent Core + Client/Runtime 解耦**架构。Client 使用 Tauri 2 + React；Runtime 使用独立 Node.js sidecar，加载 Agent Core 并提供文件、模型和存储能力。

Agent Core 是业务核心，Runtime 是执行环境，Client 是用户界面。Core 不依赖平台，Runtime 不依赖桌面界面，Client 通过版本化协议访问 Runtime。

sidecar 指随应用安装、由桌面宿主启动的后台程序。Tauri 支持分发 Node 运行环境与 JavaScript 资源，用户无需自行安装 Node.js。[官方说明][T1]

## 2. 采用独立 Runtime 的依据

| 目标 | 对应设计 |
| --- | --- |
| 界面与执行分离 | 页面刷新后重新订阅，任务及模型连接由 Runtime 持有 |
| 核心可独立验证 | Core 注入 Provider、工具执行器和存储接口，可使用内存替身测试 |
| 客户端可替换 | Client 仅依赖协议；核心不引用 React、Tauri 或 UI 数据结构 |
| 文件状态有统一归属 | Runtime 统一管理授权、修改记录、数据库与恢复 |
| 控制 Rust 范围 | Rust 仅负责窗口、系统对话框、凭据和进程通信 |

代价是 Node 运行环境、SQLite 原生模块和跨进程协议的维护。选择依据为执行边界及可维护性，安装大小和内存必须实测。

独立进程不等于常驻服务。首版随桌面应用启动和退出；界面刷新不会终止任务，退出应用会停止 Runtime。

## 3. 依赖边界

| 部分 | 允许依赖 | 禁止依赖 |
| --- | --- | --- |
| Agent Core | 普通 TypeScript 类型、注入接口 | DOM、React、Tauri、Node API、SQLite 驱动 |
| Runtime | Core、协议、Node 适配器、具体 Provider | React、WebView、桌面插件 |
| Client SDK | 协议、注入的通信接口 | Core 内部实现、Node API |
| Desktop | Client SDK、React、Tauri | Runtime 内部模块、数据库和模型凭据读取 |

Runtime 直接发起模型请求、读写项目和数据库。桌面宿主只提供原生交互和启动凭据，不成为文件、HTTP 或事务的中转层。

## 4. 技术栈

| 层 | 组件 |
| --- | --- |
| 桌面 Client | Tauri 2、React、CSS Modules、Vite |
| Agent Core | TypeScript、Zod、平台无关接口 |
| Runtime | Node.js 24 LTS、TypeScript、Node 文件与网络 API |
| 模型 | DeepSeekResponsesProvider、Node fetch、eventsource-parser |
| 存储 | SQLite、better-sqlite3、独立 Store Worker |
| 构建与分发 | npm workspaces、esbuild、Tauri externalBin、NSIS |
| 测试 | Vitest、WebdriverIO、@wdio/tauri-service、cargo test |

Node、后台 JavaScript 和原生依赖作为一个应用版本分发。SQLite 在 Runtime 内提交事务；Client 不使用 Tauri SQL 或 HTTP 插件。[Node 发布周期][N1]、[SQLite 驱动][S1]、[外部程序分发][T2]

M0 锁定具体版本，优先验证生产包的 Node/SQLite 兼容性、资源定位和进程退出。

## 5. 模型协议

首版仅实现 **Responses API**，保留 ModelProvider 抽象。采用独立输出项和语义事件组织模型结果，适配任务记录及流式展示。[Responses 指南][D1]

DeepSeek 的 Responses 是无状态接口：历史由应用保存，不能依赖 previous_response_id、服务端会话或后台任务。代码工具仍由 Runtime 执行，协议不会代替文件授权和恢复。[接口说明][D2]

使用 `deepseek-flash` 作为默认模型，模型 ID、能力及实际返回值独立记录。Chat Completions 仅作为协议比较背景，不在首版维护第二套实现。

## 6. 参考项目

| 项目 | 参考内容 | Tilot 采用的设计 |
| --- | --- | --- |
| Pi | Agent Loop、消息投影、事件流 | 小核心、运行环境注入、历史与界面分离 |
| Codex | 工具 orchestrator、应用服务协议 | 执行统一入口及客户端/运行时边界 |
| DeepSeek Harness | Provider、工具流水线、桌面后台 | 模型适配与执行分层 |

固定提交及原始资料见 [来源记录](06-sources-and-decisions.md)。首版不引入完整插件框架或其他业务工具。

[T1]: https://v2.tauri.app/learn/sidecar-nodejs/
[T2]: https://v2.tauri.app/develop/sidecar/
[N1]: https://nodejs.org/en/about/previous-releases
[S1]: https://github.com/WiseLibs/better-sqlite3
[D1]: https://api-docs.deepseek.com/guides/responses_api/
[D2]: https://api-docs.deepseek.com/api/create-response/
