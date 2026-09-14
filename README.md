# Tilot

面向 Windows 的代码助手，以 DeepSeek 为主要模型，自研轻量级 agent harness（任务运行时）。

当前阶段仅实现项目代码文件的读取、搜索、新建与修改，提供修改预览、确认、撤销和任务历史。

- **阶段**：方案设计，应用代码尚未实现
- **平台**：Windows，首期目标环境为 Windows 11 x64
- **桌面**：Tauri 2、React、TypeScript
- **任务引擎**：纯 TypeScript 模块，首版运行于 Tauri WebView
- **原生能力**：Tauri 插件与必要的 Rust 文件、事务桥接
- **存储**：Tauri SQL 插件 + SQLite

[文档目录](docs/README.md) · [产品方案](docs/02-product-plan.md) · [技术设计](docs/03-technical-design.md) · [开发计划](docs/05-roadmap-and-validation.md)

设计参考：[Pi](https://github.com/earendil-works/pi)、[Codex](https://github.com/openai/codex)、[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)。

源码、文档及文本命令统一使用 UTF-8。
