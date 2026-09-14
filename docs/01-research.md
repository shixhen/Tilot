# 技术调研与选型

核查日期：2026-09-14 · 范围：Windows 代码读写助手

## 1. 选型结论

采用 **Tauri 2 + React + TypeScript**。任务引擎为独立 TypeScript 模块，首版与界面运行于同一 WebView，通过适配器访问文件、数据库和 HTTP。

当前五个代码文件工具不需要 Node 专属运行能力，因此首版不分发 Node.js，也不设置默认 sidecar。开发和测试仍使用 Node 工具链。

Tauri 插件提供原生实现的 JavaScript 接口。Rust 保留在插件注册、窗口、凭据、受限文件操作和数据库事务桥接中；模型循环、工具规则和上下文逻辑使用 TypeScript。[Tauri 架构][T1]

## 2. 架构边界

| 层 | 职责 | 依赖约束 |
| --- | --- | --- |
| task-engine | 任务状态、模型循环、工具、上下文 | 不引用 DOM、React、Tauri 或 Node API |
| adapters/tauri | FileSystem、Storage、HTTP、凭据适配 | 将核心接口映射至插件或原生命令 |
| ui | 项目树、对话、代码与差异预览 | 通过应用服务操作任务 |
| native | 权限范围、文件提交、事务、系统集成 | 不实现模型或提示词逻辑 |

接口注入指由应用向引擎提供文件、存储等能力，而不是由引擎自行导入平台 API。以后更换运行环境时，主要替换适配器。

首版没有命令执行需求，不预设 Process 接口。只有出现 Node 专属依赖，或实测证明需要独立运行环境时，再评估 sidecar。

WebView 方案减少分发依赖，但引擎与界面共享线程和生命周期：页面重载会中断循环，长时间同步计算会影响交互。采用分页、异步 I/O 和协作调度；不承诺关闭应用后继续运行。

## 3. 关键选型核查

| 项目 | 采用方案 | 必须补充的约束 |
| --- | --- | --- |
| 数据库 | Tauri SQL 插件 + SQLite | migration 不等于业务事务；原生侧提供单连接事务提交 |
| 网络 | Tauri HTTP Client | 验证响应体流式读取、取消和超时；限制 API 地址 |
| 桌面测试 | WebdriverIO + @wdio/tauri-service | Windows 使用 external 驱动模式，生产包不含测试入口 |
| 模型 | 可配置的 DeepSeekProvider | 按日期核查模型 ID、能力和返回模型，不自动替换用户配置 |

SQL 插件支持 SQLite 和 migration，但当前 JavaScript 接口只有 load/get、select、execute、close 等方法，没有显式事务对象。连续调用 BEGIN、写入和 COMMIT，不能假设使用连接池中的同一连接。[SQL 插件][S1]、[接口源码][S2]

HTTP 插件提供 fetch 接口；当前实现支持响应体读取与取消。能完成普通 JSON 请求不足以证明 SSE 可用，需在实际 WebView2 和锁定插件版本中验证。[HTTP Client][H1]、[实现源码][H2]

官方推荐通过 WebdriverIO 与 @wdio/tauri-service 使用 Tauri WebDriver；直接使用 tauri-driver 仍是 Windows 可用路线。[测试指南][W1]

## 4. 技术栈

| 层 | 组件 |
| --- | --- |
| 界面与构建 | React、CSS Modules、TypeScript、Vite、npm |
| 任务引擎 | 独立 TypeScript 模块、Zod、eventsource-parser |
| 文件 | 受限 Tauri 文件命令；文本搜索与编辑规则在 TypeScript 中 |
| HTTP | @tauri-apps/plugin-http |
| 存储 | @tauri-apps/plugin-sql、SQLite、原生事务命令 |
| 桌面与分发 | Tauri 2、Rust、NSIS、WebView2 |
| 测试 | Vitest、WebdriverIO、@wdio/tauri-service、cargo test |

文件命令保留在原生侧，用于统一检查项目范围和完成不可拆分的文件提交步骤。数据库迁移以版本化 SQL 文件维护，Rust 注册执行。

M0 锁定 npm、Cargo 依赖及测试驱动版本，验证原生插件、事务与生产安装包。安装体积、内存和响应速度均以实测为准。

## 5. 参考项目与模型

| 项目 | 参考内容 | Tilot 采用的设计 |
| --- | --- | --- |
| Pi | Agent Loop、消息投影、事件流 | 核心独立于 UI；模型历史与界面状态分离 |
| Codex | 工具 orchestrator | 统一校验、确认、执行和结果记录 |
| DeepSeek Harness | 模型适配、工具流水线 | Provider 接口和统一工具边界 |

参考源码及固定提交见 [来源记录](06-sources-and-decisions.md)。当前范围不引入完整插件框架。

截至核查日，DeepSeek 官方要求使用 `deepseek-flash`；`deepseek-v4-flash` 属兼容旧名称，已转由新 Flash 模型服务。`deepseek-v4-pro` 仍在提供服务。默认配置保留 `deepseek-flash`，接入前复核模型表。[模型说明][D1]

[T1]: https://v2.tauri.app/concept/architecture/
[S1]: https://v2.tauri.app/plugin/sql/
[S2]: https://github.com/tauri-apps/plugins-workspace/blob/v2/plugins/sql/guest-js/index.ts
[H1]: https://v2.tauri.app/plugin/http-client/
[H2]: https://github.com/tauri-apps/plugins-workspace/blob/v2/plugins/http/guest-js/index.ts
[W1]: https://v2.tauri.app/develop/tests/webdriver/
[D1]: https://api-docs.deepseek.com/quick_start/pricing/
