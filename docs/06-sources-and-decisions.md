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
| Tauri 分层与运行环境 | [Architecture](https://v2.tauri.app/concept/architecture/) · [Capabilities](https://v2.tauri.app/security/capabilities/) |
| 原生命令 | [Rust Commands](https://v2.tauri.app/develop/calling-rust/) · [Permissions](https://v2.tauri.app/security/permissions/) |
| SQL 与 migration | [SQL 插件](https://v2.tauri.app/plugin/sql/) · [JavaScript 接口](https://github.com/tauri-apps/plugins-workspace/blob/v2/plugins/sql/guest-js/index.ts) |
| 事务与连接池核查 | [插件状态](https://github.com/tauri-apps/plugins-workspace/blob/v2/plugins/sql/src/lib.rs) · [执行实现](https://github.com/tauri-apps/plugins-workspace/blob/v2/plugins/sql/src/wrapper.rs) |
| HTTP 与 SSE | [HTTP Client](https://v2.tauri.app/plugin/http-client/) · [流式读取/取消实现](https://github.com/tauri-apps/plugins-workspace/blob/v2/plugins/http/guest-js/index.ts) · [eventsource-parser](https://github.com/rexxars/eventsource-parser) |
| 测试 | [WebdriverIO / Tauri 指南](https://v2.tauri.app/develop/tests/webdriver/) |
| Windows 构建与分发 | [Prerequisites](https://v2.tauri.app/start/prerequisites/) · [Installer](https://v2.tauri.app/distribute/windows-installer/) · [Signing](https://v2.tauri.app/distribute/sign/windows/) |
| 密钥保护 | [Windows DPAPI](https://learn.microsoft.com/en-us/windows/win32/api/dpapi/nf-dpapi-cryptprotectdata) |
| DeepSeek 基础接口 | [入门](https://api-docs.deepseek.com/) · [Chat Completions](https://api-docs.deepseek.com/api/create-chat-completion/) |
| 推理与工具 | [Thinking Mode](https://api-docs.deepseek.com/guides/thinking_mode/) · [Tool Calls](https://api-docs.deepseek.com/guides/tool_calls/) |
| 模型、容量与费用 | [Models & Pricing](https://api-docs.deepseek.com/quick_start/pricing/) · [Context Caching](https://api-docs.deepseek.com/guides/kv_cache/) |
| 连接与错误 | [Rate Limit](https://api-docs.deepseek.com/quick_start/rate_limit/) · [Error Codes](https://api-docs.deepseek.com/quick_start/error_codes/) |

Tauri 插件源码引用 v2 分支，用于本次接口核查；M0 必须以实际锁定版本重验，不能将分支当前行为视为所有 2.x 版本的保证。服务文档及模型映射为动态信息，发布前复核。

Pi、DeepSeek Harness 使用 MIT，Codex 使用 Apache-2.0；复用源码及分发依赖时保留对应 LICENSE、NOTICE 和第三方声明。

## 架构决策

| 编号 | 决策 | 依据 | 复核条件 |
| --- | --- | --- | --- |
| ADR-001 | Tauri 2 + React + TypeScript | Windows 桌面与开发语言要求 | 桌面要求变化 |
| ADR-002 | 纯 TypeScript 引擎，首版运行于 WebView | 当前代码文件工具不依赖 Node | 出现 Node 专属能力或独立运行需求 |
| ADR-003 | 通过接口注入平台能力 | 核心可独立测试和迁移 | 不同平台适配成本经测量 |
| ADR-004 | 自研小核心、五个文件工具 | 聚焦代码读写与执行记录 | 当前范围无法满足实际任务 |
| ADR-005 | Tauri SQL + SQLite，原生命令提交事务 | 减少运行依赖，保留原子状态提交 | 锁定插件版本的连接池接口变化 |
| ADR-006 | Tauri HTTP + DeepSeekProvider | 原生网络与平台无关协议适配 | SSE 或取消契约无法满足 |
| ADR-007 | 串行工具、固定修改确认 | 文件一致性与结果可核对 | 资源锁和并发收益经验证 |
| ADR-008 | WebdriverIO + tauri-service，Windows external 模式 | 遵循官方测试路线 | 测试平台或驱动要求变化 |
| ADR-009 | Windows 11 x64、NSIS、手动升级 | 收敛分发矩阵 | 目标设备变化 |

Node sidecar 仅作为条件性迁移方案，不在首版实现或安装包中。Process、其他业务工具及第三方执行插件不进入当前接口范围。

## 待验证项

| 验证项 | 阶段 | 判定依据 |
| --- | --- | --- |
| 核心无平台依赖、生产包启动 | M0 | 独立类型检查、干净 Windows 安装 |
| HTTP SSE、取消与释放 | M0 | 真实插件传输，覆盖响应头前与流中取消 |
| SQL 事务与迁移 | M0 | 中途失败回滚、重复请求、实际连接设置 |
| 权限、密钥与 WebView 生命周期 | M0 | 原生命令检查、持久记录检查、重载核对 |
| 模型消息与 reasoning 回放 | M2 | 固定回放及真实 API 契约 |
| 文件替换、外部冲突、撤销 | M3 | 版本变化、占用及竞态记录 |
| 中断恢复、压缩、升级与质量 | M4 | 故障注入、固定代码任务、安装验收 |

发布记录包含应用、Tauri 插件、WebView2、模型配置、工具和数据 schema 版本，以及日期、结果与已知限制。
