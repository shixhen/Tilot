# 来源与决策记录

架构及服务文档核查日期：2026-09-14；参考仓库沿用 2026-09-13 的固定提交。

## 参考仓库

| 项目 | 固定提交 | 提交日期 |
| --- | --- | --- |
| Pi | `71dca871bc80b6bc97be37f0ca3189399d651fff` | 2026-09-11 |
| Codex | `36f0dbe796d9bb1a18a0fc0640ed08b3e1d54564` | 2026-09-13 |
| DeepSeek Harness | `c291e7961a515f6d7af9304e7fd1d257929aef26` | 2026-09-10 |

以下为本次架构分析的主要资料，检查范围限所列源码与文档。

### Pi

- [Agent API](https://github.com/earendil-works/pi/blob/71dca871bc80b6bc97be37f0ca3189399d651fff/packages/agent/README.md) · [Agent Loop](https://github.com/earendil-works/pi/blob/71dca871bc80b6bc97be37f0ca3189399d651fff/packages/agent/src/agent-loop.ts)
- [Session Format](https://github.com/earendil-works/pi/blob/71dca871bc80b6bc97be37f0ca3189399d651fff/packages/coding-agent/docs/session-format.md) · [Compaction](https://github.com/earendil-works/pi/blob/71dca871bc80b6bc97be37f0ca3189399d651fff/packages/coding-agent/docs/compaction.md)
- [SDK](https://github.com/earendil-works/pi/blob/71dca871bc80b6bc97be37f0ca3189399d651fff/packages/coding-agent/docs/sdk.md)

### Codex

- [Tool Orchestrator](https://github.com/openai/codex/blob/36f0dbe796d9bb1a18a0fc0640ed08b3e1d54564/codex-rs/core/src/tools/orchestrator.rs)
- [Core](https://github.com/openai/codex/blob/36f0dbe796d9bb1a18a0fc0640ed08b3e1d54564/codex-rs/core/README.md) · [App Server](https://github.com/openai/codex/blob/36f0dbe796d9bb1a18a0fc0640ed08b3e1d54564/codex-rs/app-server/README.md)

### DeepSeek Harness

- [架构](https://github.com/deepseek-ai/deepseek-harness/blob/c291e7961a515f6d7af9304e7fd1d257929aef26/docs/architecture.zh.md) · [工具流水线](https://github.com/deepseek-ai/deepseek-harness/blob/c291e7961a515f6d7af9304e7fd1d257929aef26/docs/tool-execution-pipeline.zh.md)
- [桌面端](https://github.com/deepseek-ai/deepseek-harness/blob/c291e7961a515f6d7af9304e7fd1d257929aef26/apps/desktop/README.zh.md) · [模型适配器](https://github.com/deepseek-ai/deepseek-harness/blob/c291e7961a515f6d7af9304e7fd1d257929aef26/packages/llm/llm-deepseek/src/adapter.ts)

## 技术资料

| 主题 | 来源 |
| --- | --- |
| Tauri 与 sidecar | [Architecture](https://v2.tauri.app/concept/architecture/) · [Node sidecar](https://v2.tauri.app/learn/sidecar-nodejs/) · [External Binaries](https://v2.tauri.app/develop/sidecar/) |
| 桌面通信与权限 | [Rust Commands](https://v2.tauri.app/develop/calling-rust/) · [Channels](https://v2.tauri.app/develop/calling-frontend/) · [Capabilities](https://v2.tauri.app/security/capabilities/) · [AppManifest::commands](https://docs.rs/tauri-build/latest/tauri_build/struct.AppManifest.html#method.commands) |
| Node 与 SQLite | [Node Releases](https://nodejs.org/en/about/previous-releases) · [better-sqlite3](https://github.com/WiseLibs/better-sqlite3) · [SQLite WAL](https://www.sqlite.org/wal.html) |
| 流式解析 | [eventsource-parser](https://github.com/rexxars/eventsource-parser) |
| 桌面测试 | [WebdriverIO / Tauri 指南](https://v2.tauri.app/develop/tests/webdriver/) |
| Windows 构建与分发 | [Prerequisites](https://v2.tauri.app/start/prerequisites/) · [Installer](https://v2.tauri.app/distribute/windows-installer/) · [Signing](https://v2.tauri.app/distribute/sign/windows/) |
| 密钥保护 | [Windows DPAPI](https://learn.microsoft.com/en-us/windows/win32/api/dpapi/nf-dpapi-cryptprotectdata) |
| DeepSeek Responses | [指南与兼容表](https://api-docs.deepseek.com/guides/responses_api/) · [接口定义](https://api-docs.deepseek.com/api/create-response/) |
| 推理与工具 | [Thinking Mode](https://api-docs.deepseek.com/guides/thinking_mode/) · [Tool Calls](https://api-docs.deepseek.com/guides/tool_calls/) |
| 模型与费用 | [Models & Pricing](https://api-docs.deepseek.com/quick_start/pricing/) · [Context Caching](https://api-docs.deepseek.com/guides/kv_cache/) |
| 连接与错误 | [Rate Limit](https://api-docs.deepseek.com/quick_start/rate_limit/) · [Error Codes](https://api-docs.deepseek.com/quick_start/error_codes/) |

动态文档须在接入及发布前复核。依赖在 M0 锁定具体版本；源码说明不等于所选版本的实测结论。

Pi、DeepSeek Harness 使用 MIT，Codex 使用 Apache-2.0；复用源码及分发依赖时保留对应 LICENSE、NOTICE 和第三方声明。

## 架构决策

| 编号 | 决策 | 依据 | 复核条件 |
| --- | --- | --- | --- |
| ADR-001 | Tauri 2 + React Client | Windows 桌面及 TypeScript 开发要求 | 桌面需求变化 |
| ADR-002 | 平台无关 TS Agent Core | 核心可测试，不绑定客户端或运行环境 | 接口不能覆盖实际执行需要 |
| ADR-003 | 独立 Node.js Runtime sidecar | 执行状态与界面生命周期分离 | 实测资源或分发成本超出预算 |
| ADR-004 | Client SDK + 版本化协议 | Client 不依赖 Core/Runtime 内部实现 | 出现其他客户端需求 |
| ADR-005 | Runtime 直接访问 HTTP、文件及 SQLite | 避免经桌面插件中转业务能力 | 执行环境发生变化 |
| ADR-006 | Store Worker + better-sqlite3 | 单写者、完整事务、不阻塞调度线程 | 原生模块兼容性无法满足 |
| ADR-007 | 首版只实现 Responses，保留 ModelProvider | 结构化输出项与语义事件适合 Agent 记录 | 必要服务能力需要其他协议 |
| ADR-008 | 五个文件工具、串行执行、固定确认 | 聚焦代码读写和文件一致性 | 有经验证的并发需求 |
| ADR-009 | WebdriverIO + tauri-service external 模式 | Windows 桌面验收与官方工具路线 | 驱动或平台要求变化 |
| ADR-010 | Windows 11 x64、NSIS、手动升级 | 收敛发布矩阵 | 目标设备变化 |

Responses 为无状态实现，本地历史、工具结果、压缩和恢复由 Runtime 管理。response.completed 不代表整个任务已完成；API 的并行工具参数不能替代 Runtime 串行策略。

## 待验证项

| 验证项 | 阶段 | 判定依据 |
| --- | --- | --- |
| Core 无平台依赖 | M0 | 独立类型检查及内存测试宿主 |
| Runtime 独立运行、Node/SQLite 打包 | M0 | 无 WebView 集成测试及干净 Windows 安装 |
| 私有传输、背压、进程退出 | M0 | 管道分片、Host 故障及残留进程检查 |
| Client 重连与去重 | M1 | 同一 Run 重订阅，状态及事件一致 |
| Responses 输出项、事件与回放 | M2 | DS 固定回放及真实 API 契约 |
| 文件替换、冲突和撤销 | M3 | 版本变化、文件占用及竞态记录 |
| 中断恢复、压缩、迁移与分发 | M4 | 故障注入、固定任务和安装验收 |

发布记录包含应用、Core、Protocol、Runtime、Node、原生模块、WebView2、模型配置及数据 schema 版本，以及日期、测试结果和已知限制。
