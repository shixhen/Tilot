# Tilot

面向 Windows 的代码助手，以 DeepSeek 为主要模型，自研轻量级 agent harness（任务运行时）。

首版目标覆盖项目代码文件的读取、搜索、新建与修改，以及差异预览、确认、撤销和任务历史。当前已完成内存 Agent 循环原型，尚未接入真实项目文件和模型服务。

- **阶段**：M0.1 内核闭环完成，提供无界面的模拟模型与内存工具演示
- **平台**：Windows，首期目标环境为 Windows 11 x64
- **Client**：Tauri 2 + React + TypeScript
- **Agent Core**：平台无关的 TypeScript 核心
- **Runtime**：随应用分发的 Node.js sidecar，负责执行与持久化
- **模型协议**：DeepSeek Responses API，首版仅实现这一种协议

[文档目录](docs/README.md) · [产品方案](docs/02-product-plan.md) · [技术设计](docs/03-technical-design.md) · [开发计划](docs/05-roadmap-and-validation.md)

本机工具、依赖清单和恢复安装方法见 [开发环境](docs/07-development-environment.md)。

在项目根目录运行 `npm run demo:core`，查看“列举文件 → 读取代码 → 回答”的完整过程。演示会自动构建，无需 API Key，不读取或修改磁盘项目。

验证命令为 `npm run typecheck`、`npm run build` 和 `npm test`。各模块职责、接口、取消规则及后续接入方式见 [M0 首批实现讲解](docs/08-m0-core-implementation.md)。桌面应用和安装包尚未实现。

设计参考：[Pi](https://github.com/earendil-works/pi)、[Codex](https://github.com/openai/codex)、[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)。

源码、文档及文本命令统一使用 UTF-8。
