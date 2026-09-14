# 设计文档

版本：0.1 · 状态：草案 · 更新日期：2026-09-14

Tilot 当前阶段采用 Windows 桌面形态，仅实现代码文件读取、搜索、新建与修改。模型使用 DeepSeek；桌面采用 Tauri 2，界面与纯 TypeScript 任务引擎运行于 WebView，通过适配器使用 Tauri 原生能力。

| 文档 | 内容 |
| --- | --- |
| [技术调研](01-research.md) | Tauri 2 与语言选型、参考项目 |
| [产品方案](02-product-plan.md) | 代码读写范围与交互 |
| [技术设计](03-technical-design.md) | 模块、接口、文件修改与恢复 |
| [DeepSeek 接入](04-deepseek-integration.md) | 消息回放、流式处理与重试 |
| [开发计划](05-roadmap-and-validation.md) | 里程碑、测试与 Windows 分发 |
| [来源与决策](06-sources-and-decisions.md) | 调研依据及架构决策 |

当前计划仅覆盖代码读写，不包含其他业务能力。应用代码尚未实现，技术参数及性能目标待原型验证。
