# Tilot

面向 Windows 的代码助手，以 DeepSeek 为主要模型，自研轻量级 agent harness（任务运行时）。

当前阶段仅实现项目代码文件的读取、搜索、新建与修改，提供差异预览、确认、撤销和任务历史。

- **阶段**：方案设计，应用代码尚未实现
- **平台**：Windows，首期目标环境为 Windows 11 x64
- **Client**：Tauri 2 + React + TypeScript
- **Agent Core**：平台无关的 TypeScript 核心
- **Runtime**：随应用分发的 Node.js sidecar，负责执行与持久化
- **模型协议**：DeepSeek Responses API，首版仅实现这一种协议

[文档目录](docs/README.md) · [产品方案](docs/02-product-plan.md) · [技术设计](docs/03-technical-design.md) · [开发计划](docs/05-roadmap-and-validation.md)

设计参考：[Pi](https://github.com/earendil-works/pi)、[Codex](https://github.com/openai/codex)、[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)。

源码、文档及文本命令统一使用 UTF-8。
