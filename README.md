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

Server、Protocol、Responses、Store、Context 和 Agent Core 已有部分实现，桌面应用和 Tool 目前只建立清单，随实现增加入口和实际依赖，不预写空函数。
根目录的类型检查覆盖各包的 `src/` 和 `tests/`；桌面端实现时再添加 React 配置。

## 数据存储

配置和对话历史统一存入 SQLite。默认数据库路径为 `%LOCALAPPDATA%\Tilot\tilot.sqlite`：Server 的 `getDefaultDataDirectory` 解析目录，创建 Store 时传入绝对路径。当前已创建配置、任务、轮次、用户输入、模型请求和工具调用表。

按开发者选择，API Key 以明文 JSON 保存在同目录的 `credentials.json`，包含一组 baseURL 和 apiKey，不写入 SQLite。`Store.credentials` 提供 getApiKey、saveApiKey 和 deleteApiKey；保存时通过临时文件替换，空密钥不会覆盖旧值。读取时核对规范化后的完整服务地址，地址不同返回未配置；保存新地址的密钥会替换旧凭据。Server 已提供凭据设置、删除和状态接口，不提供密钥原文读取接口；测试仅使用临时目录中的模拟密钥。

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

`@tilot/agent-core` 的 `runTurn(store, client, options)` 创建轮次、保存首条输入、构建上下文并调用 Responses，最后返回已保存的轮次终态。`options` 包含 threadId、input、instructions，以及可选的 signal 和 onEvent 回调。回调支持返回 Promise，Core 等待事件处理完成后再继续读取。Server 使用已配置 baseURL 和对应的文件凭据创建 SDK 客户端；Core 不读取密钥。

同一任务由 Store 阻止并行轮次，目前不同任务可以并行。每次请求冻结普通配置与首条输入边界；执行期间追加的输入不会改变正在发送的请求，本批在下一轮回放这些输入。系统提示词由调用方传入，每次请求发送，不内置默认提示词。

`turn.started` 提供轮次标识，`response.event` 携带轮次、请求尝试标识和原始 SDK 事件。完整终态先保存再交付；函数返回值是本轮本地最终状态。模型失败、截断、断流或处理事件抛错会停止请求，截断尝试保存为 incomplete，所属轮次记为 failed。取消前已中止的调用不创建轮次；流中取消会结束尝试和轮次并释放请求。终态通知或数据库写入异常直接抛给调用方，不伪装成模型失败。

本批发送空 tools 和 tool_choice=none；意外返回工具调用会保存为失败诊断，不登记工具执行。本批不自动重试、不执行工具、不做上下文预算与压缩。断流诊断保留最近收到的响应对象，不把预览增量拼成正式响应；终态保存中途若进程退出，由启动恢复标记仍运行的记录。

## 本地服务与通信

已确认使用子进程标准输入/输出，采用 UTF-8 JSON Lines：每行一个 JSON 请求，输出每行一个应答或事件。JSON 字符串内的换行由序列化转义，标准输出只放协议，启动和传输错误写到标准错误。Tauri 启动和管理 Node.js 服务的连接仍待实现；传输方式参考 [Tauri sidecar 文档](https://v2.tauri.app/learn/sidecar-nodejs/)。

在根目录启动开发服务：

```sh
node packages/server/src/main.ts
```

首个命令行参数可传入绝对数据目录；省略时使用默认目录。输入结束后，服务处理完已收到的请求，取消活动轮次，等待 Core 保存终态后关闭数据库。输入或输出异常也会停止连接并取消活动轮次。当前入口不自动恢复遗留轮次，需待宿主确保旧执行停止后接入恢复。

当前支持 thread.create、thread.read、thread.list 和 thread.rename。例如发送：

```json
{"id":"req-1","method":"thread.create","params":{"title":"新任务"}}
```

连接设置使用以下接口，每次请求都包含 params 对象：

| 方法 | params | 成功结果 |
| --- | --- | --- |
| config.get | `{}` | 普通配置 |
| config.set | `{config: 完整配置}` | 保存后的普通配置 |
| credentials.status | `{}` | `{configured: boolean}`，对应当前配置的 baseURL |
| credentials.set | `{baseURL, apiKey}` | null |
| credentials.delete | `{}` | null |

配置类型与数值范围分别在 RPC 边界和 Store 校验，失败不会覆盖旧值。保存配置不会连带修改密钥；保存密钥不会修改当前服务地址。

响应使用 `{id, success, result}` 或 `{id, success, error}`；找不到任务时 read 返回 null，格式错误且无法识别请求时 id 为 null。创建有项目的任务时，Server 先验证并解析真实目录。请求按到达顺序处理；当前不提供重试去重。

`turn.start` 的参数为 `{threadId, input, instructions}`，取得轮次标识后返回 Turn，不等待模型结束；同一任务的重复启动会失败。`turn.interrupt` 接收 `{turnId}`，返回 `{interrupted: boolean}`：true 表示已请求取消，最终状态以 turn.finished 为准；轮次已结束或不属于当前连接时返回 false。不同任务可以并行，流式执行不阻塞后续管理请求。

服务会交错推送以下事件：

| event | 内容和处理方式 |
| --- | --- |
| turn.started | turn 包含轮次与任务标识；可能先于启动应答到达 |
| message.delta | 按 turnId、itemId、contentIndex 追加对应 kind 的正文、推理或拒绝预览 |
| message.completed | 成功落库后的完整 parts，按 itemId 替换预览，不能再次追加 |
| turn.finished | 已保存的最终 turn，包含完成、失败或取消状态 |

事件 seq 在当前连接内从 1 递增，重启后重新计数。失败或取消不会产生成功的 message.completed，界面应结合 turn.finished 标记预览状态。应答和事件通过同一写入队列发送，Core 等待事件写入完成；无法交付事件或保存状态时结束连接，不伪造成功。当前没有断线事件重放，可通过历史查询恢复已保存内容。

历史展示接口如下，所有列表默认每页 50 条、最多 100 条，按保存顺序返回：

| 方法 | params | 结果 |
| --- | --- | --- |
| turn.list | `{threadId, afterSequence?, limit?}` | 任务的轮次列表 |
| turn.read | `{turnId}` | 单个轮次及状态，不存在时为 null |
| turn.inputs | `{turnId, afterId?, limit?}` | 该轮次的用户输入，保留原文 |
| turn.attempts | `{turnId, afterSequence?, limit?}` | 请求状态、输入边界及成功消息的展示数据 |

首批查询省略游标，后续传入上一页最后一个 id 或 sequence；查不到记录的列表返回空数组，不创建任务或轮次。请求消息采用与 message.completed 相同的 itemId、outputIndex 和 parts，保留推理、正文和拒绝文本。失败、取消、中断及运行中的请求 messages 为空，不把诊断响应伪装成回答；SDK 原始响应和系统策略不会传给界面。工具调用和结果仍保存在 Store，工具展示随工具执行阶段接入。

历史查询只包含已保存内容，不包含尚未落库的流式预览。界面应按 turnId、请求 id 和 itemId 合并历史与事件；收到 turn.finished 后重新读取该轮次及请求记录。afterSequence 只用于翻页，不能用它查询已有运行记录的状态变化。按 inputThroughId 可判断每次响应之前已纳入哪些用户输入。

Protocol 只包含通信类型、展示数据及共享任务、轮次与配置数据，没有 Node.js、数据库或 SDK 依赖。Store 复用其中的 Thread、Turn 和 AppConfig 类型，避免桌面通过 Store 导入数据库代码。

## 已确认的设计决定

- Responses 使用 OpenAI SDK 接入 Responses API，优先复用 SDK 类型。
- 不设计通用 Provider，不自行实现 HTTP 或 SSE 协议解析。
- 模块划分见 `docs/technical-design.md`，模型接入细节见 `docs/deepseek-integration.md`。
- 功能范围以 `docs/product-requirements.md` 为准，不实现技术设计示例中的 shell 工具。
- 分小批次开发，函数和类型添加中文用途注释；每批解释并经确认后继续。
