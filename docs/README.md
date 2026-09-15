# 设计文档

版本：0.1 · 状态：草案 · 更新日期：2026-09-15

Tilot 采用 TS Agent Core + Client/Runtime 解耦架构。Windows Client 使用 Tauri 2，Runtime 运行于独立 Node.js sidecar；模型接口统一采用 DeepSeek Responses API。

| 文档 | 内容 |
| --- | --- |
| [技术调研](01-research.md) | 分层依据、依赖选型与参考项目 |
| [产品方案](02-product-plan.md) | 代码读写范围与交互 |
| [技术设计](03-technical-design.md) | Core、Client、Runtime、通信与恢复 |
| [DeepSeek 接入](04-deepseek-integration.md) | Responses 协议、输出项、事件与回放 |
| [开发计划](05-roadmap-and-validation.md) | 里程碑、测试与 Windows 分发 |
| [来源与决策](06-sources-and-decisions.md) | 调研依据及架构决策 |
| [开发环境](07-development-environment.md) | 本机工具、已安装依赖、恢复安装与检查 |
| [M0 首批实现讲解](08-m0-core-implementation.md) | 已实现的内存循环、接口、演示、故障处理与验收 |

当前计划仅覆盖代码读写。M0.1 内存内核闭环已完成；独立进程、SQLite、桌面、真实项目工具和模型服务尚未接入。技术参数、性能及交付周期继续按后续原型复核。
