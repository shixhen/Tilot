# 设计文档

版本：0.1 · 状态：草案 · 更新日期：2026-09-14

Tilot 采用 TS Agent Core + Client/Runtime 解耦架构。Windows Client 使用 Tauri 2，Runtime 运行于独立 Node.js sidecar；模型接口统一采用 DeepSeek Responses API。

| 文档 | 内容 |
| --- | --- |
| [技术调研](01-research.md) | 分层依据、依赖选型与参考项目 |
| [产品方案](02-product-plan.md) | 代码读写范围与交互 |
| [技术设计](03-technical-design.md) | Core、Client、Runtime、通信与恢复 |
| [DeepSeek 接入](04-deepseek-integration.md) | Responses 协议、输出项、事件与回放 |
| [开发计划](05-roadmap-and-validation.md) | 里程碑、测试与 Windows 分发 |
| [来源与决策](06-sources-and-decisions.md) | 调研依据及架构决策 |

当前计划仅覆盖代码读写。应用代码尚未实现，技术参数、性能及交付周期待原型验证。
