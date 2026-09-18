# Tilot

基于 Tauri、React、TypeScript 和 Node.js 的本地桌面 Agent。
当前已建立工程基础、项目目录验证、Responses 客户端、SQLite 历史存储、Context 上下文构建，以及 Core 无工具单轮执行，尚未接入桌面界面或进行真实模型联调。

分批开发顺序与验收方式见 [开发计划](docs/development-plan.md)。

## 本地开发

使用 Node.js 24 和 npm，在项目根目录执行：

```sh
npm ci
npm run typecheck
npm test
```

`typecheck` 检查 TypeScript 类型，不生成文件，也不启动应用。
`test` 运行本地自动化测试；模型请求使用模拟数据，不连接真实模型服务。
测试与实现放在同一个包中，分别位于 `tests/` 和 `src/`。根目录 `npm test` 汇总运行各包测试，也可用 `npm test --workspace @tilot/responses` 单独运行一个包。
`packages/server/src/workspace.ts` 定义项目目录及其打开逻辑。
打开目录只验证目录本身；后续文件工具还需要独立检查文件访问范围和忽略规则。

## 目录与职责

采用 npm workspaces，在同一个仓库管理桌面应用和独立模块包。

| 目录 | 职责 |
| --- | --- |
| `apps/desktop` | `src` 放 React 界面，`src-tauri` 放 Tauri 桌面宿主 |
| `packages/server` | Node.js 服务入口，组装模块、管理生命周期、处理 RPC 和推送事件 |
| `packages/agent-core` | 调度 Agent 执行流程 |
| `packages/context` | 构建上下文、加载 Skills、压缩历史 |
| `packages/tool` | 内置工具、MCP、注册与执行 |
| `packages/store` | 保存对话、配置、凭据和其他持久数据 |
| `packages/responses` | 通过 OpenAI SDK 调用 Responses API |
| `packages/protocol` | 桌面端与 Server 共用的 RPC 请求、响应和事件类型 |

Server、Responses、Store、Context 和 Agent Core 已有部分实现，其余包目前只建立清单，随实现增加入口和实际依赖，不预写空函数。
根目录的类型检查覆盖各包的 `src/` 和 `tests/`；桌面端实现时再添加 React 配置。

## 数据存储

配置和对话历史统一存入 SQLite。默认数据库路径为 `%LOCALAPPDATA%\Tilot\tilot.sqlite`：Server 的 `getDefaultDataDirectory` 解析目录，创建 Store 时传入绝对路径。当前已创建配置、任务、轮次、用户输入、模型请求和工具调用表；API Key 等凭据单独处理，尚未实现凭据存储。

任务支持创建、读取、分页列表和重命名。创建时可不绑定项目；已绑定项目不能通过重命名改变。Store 只保存项目路径，Server 负责验证目录，无项目任务后续不得调用项目文件工具。任务列表默认每页 50 条，最多 100 条。

每个任务最多有一个运行中的轮次。`startTurn` 同时保存轮次和首条输入，`appendTurnInput` 保存运行中的补充输入，`finishTurn` 记录完成、失败或取消。输入原文不会被裁剪；轮次列表按 sequence、输入列表按 id 顺序分页。补充输入何时发送给模型由后续 Core 决定。

`Store.history` 提供模型历史接口：`startAttempt` 记录一次请求及其用户输入边界，`finishAttempt` 保存完整 SDK 响应和本地终态。成功响应须由调用方先经 Responses 校验；Store 保留 reasoning 和原始参数，失败、截断或取消尝试只作诊断，不登记可执行调用。重试使用新的尝试记录，不覆盖旧记录。

成功响应及其工具调用记录在同一事务中保存。`saveToolResult` 使用本地执行 id 定位记录，并核对模型的 call_id；结果只能保存一次。查询结果按原始输出位置排序，工具结果未补齐时不能开始该任务的下一次请求，也不能将所属轮次标为完成。`getAttempt`、`listAttempts` 和 `listToolCalls` 用于读取这些记录。

Server 在启动时确认旧执行已停止后，应显式调用 `recoverInterruptedTurns`，把遗留运行轮次和请求标记为中断。创建 Store 或关闭连接不会自动修改状态；当前只有恢复接口，尚未接入服务启动流程。缺少结果的工具调用保留为未决，不能据此自动重跑；核实执行情况后可补录结果。本批不包含工具执行或自动恢复策略。

Store 使用 [better-sqlite3](https://github.com/WiseLibs/better-sqlite3)，数据库操作在 Node.js 服务中执行。打包时需携带与目标 Node.js 版本及 Windows 架构匹配的原生模块。数据库使用 `user_version` 标记结构版本，后续增加表时显式迁移；未知版本直接报错，不自动重建数据库。

## 上下文构建

`@tilot/context` 的 `buildContext(store, { turnId, inputThroughId, instructions })` 返回下一次请求所需的 `instructions` 和 `input`。调用方先选定正在运行的轮次及输入边界，在 `startAttempt` 之前构建上下文；同一任务的执行互斥由 Core 管理。

Context 读完该任务截至目标轮次的历史，按成功请求记录的输入边界插入用户消息，再放入完整响应及其全部工具结果。失败诊断不参与回放，reasoning 正文和原始工具参数保留，转换使用 SDK 的 `toResponseInputItems`。缺失结果、标识冲突或输入边界倒退直接报错，不返回残缺上下文。

当前默认保留旧轮次中取消或中断前尚未发送的输入，将其放在该轮次最后一个完整消息组之后；当前轮次只纳入指定边界以内的输入。Context 不写数据库，不发起模型请求；系统策略由调用方传入，预算、摘要压缩及 Skills 加载尚未实现。

## 无工具单轮执行

`@tilot/agent-core` 的 `runTurn(store, client, options)` 创建轮次、保存首条输入、构建上下文并调用 Responses，最后返回已保存的轮次终态。`options` 包含 threadId、input、instructions，以及可选的 signal 和同步 onEvent 回调。Server 负责创建使用已配置 baseURL 和凭据的 SDK 客户端；Core 不读取密钥。

同一任务由 Store 阻止并行轮次，目前不同任务可以并行。每次请求冻结普通配置与首条输入边界；执行期间追加的输入不会改变正在发送的请求，本批在下一轮回放这些输入。系统提示词由调用方传入，每次请求发送，不内置默认提示词。

`turn.started` 提供轮次标识，`response.event` 携带轮次、请求尝试标识和原始 SDK 事件。完整终态先保存再交付；函数返回值是本轮本地最终状态。模型失败、截断、断流或处理事件抛错会停止请求，截断尝试保存为 incomplete，所属轮次记为 failed。取消前已中止的调用不创建轮次；流中取消会结束尝试和轮次并释放请求。终态通知或数据库写入异常直接抛给调用方，不伪装成模型失败。

本批发送空 tools 和 tool_choice=none；意外返回工具调用会保存为失败诊断，不登记工具执行。本批不自动重试、不执行工具、不做上下文预算与压缩。断流诊断保留最近收到的响应对象，不把预览增量拼成正式响应；终态保存中途若进程退出，由启动恢复标记仍运行的记录。

## 已确认的设计决定

- Responses 使用 OpenAI SDK 接入 Responses API，优先复用 SDK 类型。
- 不设计通用 Provider，不自行实现 HTTP 或 SSE 协议解析。
- 模块划分见 `docs/technical-design.md`，模型接入细节见 `docs/deepseek-integration.md`。
- 功能范围以 `docs/product-requirements.md` 为准，不实现技术设计示例中的 shell 工具。
- 分小批次开发，函数和类型添加中文用途注释；每批解释并经确认后继续。
