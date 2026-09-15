# M0 首批实现讲解

阶段：M0.1 · 日期：2026-09-15 · 范围：无界面的内存工具闭环

## 1. 这一批可以做什么

现在可以运行一个完整的 Agent 循环：模拟模型先列举固定项目中的文件，再读取其中的问候函数，最后根据工具返回的内容给出带路径、行号的回答。

模型、项目文件和运行记录都在内存里。无需 API Key，不产生服务费用，也不读取或修改磁盘项目。演示退出后，记录随进程消失。它验证的是核心执行规则；桌面界面、真实文件工具、SQLite 和 DeepSeek 尚未接入。

在项目根目录执行：

```powershell
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$OutputEncoding = [Console]::OutputEncoding
npm run demo:core
```

命令先构建，再通过 Node 执行构建产物。预期输出顺序为：

```text
Tilot M0.1：固定内存项目演示（模拟模型，无 API 请求）
[调用] list_files {"projectId":"memory-demo"}
[结果] ok：已列出内存文件
[调用] read_file {"projectId":"memory-demo","path":"示例 项目/问候.ts"}
[结果] ok：已读取 示例 项目/问候.ts

[最终回答] 示例 项目/问候.ts:1 定义了 greet(name)，第 2 行把姓名放进中文问候语并返回，例如：你好，小明！
[运行结果] completed / success；3 步，2 次工具调用。
```

控制台按顺序展示已经提交的记录。Core 另外提供实时预览回调，测试覆盖其行为；演示不将预览与最终记录重复输出。`Ctrl+C` 请求取消运行。

## 2. 模块为什么这样分

| 位置 | 当前内容 | 职责 |
| --- | --- | --- |
| `packages/agent-core/src/types.ts` | 五个注入接口及记录类型 | 约定各部分如何协作 |
| `packages/agent-core/src/run.ts` | `runAgent` | 决定何时请求模型、执行工具、停止和记录 |
| `packages/agent-core/src/values.ts` | 快照、历史校验、错误指纹 | 保持历史稳定，检查调用与结果配对 |
| `packages/agent-core/src/cancellation.ts` | 取消通知、可中止的流等待 | 在不依赖平台的情况下传播停止请求 |
| `packages/runtime/src/providers` | `FakeProvider` | 按脚本生成规范模型事件 |
| `packages/runtime/src/tools` | `MemoryTools` | 校验并读取固定内存文件 |
| `packages/runtime/src/storage` | `MemoryJournal` | 原子保存一组内存记录 |
| `packages/runtime/src/adapters` | Node 时间、ID、定时器 | 提供平台能力 |
| `tests` | 确定性的核心和宿主测试 | 验证实际行为及故障边界 |

“注入接口”指 Core 只规定它需要什么能力，由启动它的宿主提供具体实现。例如 Core 调用 `journal.commit`，现在保存到内存，后面可以由 Store Worker 保存到 SQLite。循环本身不用知道数据库驱动如何调用。

Core 的源码只依赖自己的相对模块。Node 的时间、随机 ID、定时器位于 Runtime。测试虽然运行在 Node 中，Core 的生产源码仍单独用没有 DOM、Node 类型的配置检查。

`typecheck` 还会检查编译器实际加载的全部文件，只允许 Core 源码和 ECMAScript 标准声明；显式导入 Node 类型、通过别的模块间接引入平台类型，也不能通过。检查脚本按锁定的 TypeScript 7 原生包定位标准库。

## 3. 核心 API 与使用方式

入口是 `runAgent(input, dependencies): Promise<RunResult>`。`Promise` 表示调用者等待异步运行结束后取得结果；模型流和工具执行可以在等待期间工作。

输入包含 `taskId`、`runId`、当前 `text`，可选已有 `history` 和 `limits`。任务与运行 ID 由宿主确定；Step、Attempt、工具执行 ID 由注入的 `newId` 生成。宿主须保证 ID 唯一，且首版只调度一个 Run。

| 注入对象 | 当前约定 |
| --- | --- |
| `ModelProvider` | `stream(request, cancellation)` 返回异步事件流；完整输出放在 `completed.turn` |
| `ToolExecutor` | 固定 `definitions`；异步 `validate` 和 `execute`；执行器再次检查参数 |
| `Journal` | `commit(batch)` 成功表示整组提交完成，失败必须不留下半组记录 |
| `Cancellation` | `cancelled` 状态和 `subscribe` 通知；已取消时订阅立即通知 |
| `RuntimeServices` | `newId`、`now`、`scheduleDeadline`；后者返回清理定时器的函数 |

`RunResult` 包含终态 `status`、结果 `outcome`、停止原因 `reason`、最后完整响应文本、Step 数和工具调用数。正常完成分为 `success` 与 `partial`；本次运行中出现过工具错误、拒绝或取消结果时，正常结束标为 `partial`。

预算默认是 30 Step、100 次工具调用、20 分钟活动时间。一次模型请求计为一个 Step；进入处理的调用计入工具预算，包括参数错误和未知工具。因停止或预算限制而直接补齐的未执行结果，不再增加调用计数。恰好用完工具预算后，模型仍可生成不调用工具的最终回答。

运行返回 `failed` 表示已记录明确失败；Journal 拒绝提交则抛出 `JournalCommitError`。两者不能混淆：后者意味着宿主无法确认终态已保存。非法输入或不完整已有历史在启动前直接拒绝。

## 4. 一次运行的数据流

1. 深拷贝并冻结输入历史，校验旧调用与结果一一配对；保存 `run_started` 和新用户消息。
2. 为本步生成 Step、Attempt ID，把冻结后的历史和工具定义交给 Provider。
3. 消费流式事件。文本、推理和参数增量仅发给可选的 `onPreview`，不作为执行依据。
4. 收到 `completed` 后校验结构、调用 ID 与可序列化状态。还需正常结束规范事件流；出现重复终态、终态后的事件或无终态断流，都不会提交工具意图。
5. 原子保存 `model` 记录，其中包含完整模型结果和所有工具意图，然后开始串行执行。
6. 每个调用产生一个结果。整组 `tool_results` 提交后加入历史，再请求下一步；无工具调用的完整响应结束运行。
7. 提交 `run_finished` 后返回最终结果。

先记录意图再执行，是为了明确“模型决定了什么”和“实际做了什么”的边界。先保存完整结果组再请求模型，则保证下一次模型不会收到孤立调用或孤立结果。

`itemId` 标识模型输出项，`callId` 用于将模型调用和工具结果配对，`executionId` 是宿主内部执行标识。三者分别保存。Core 不解析 `providerState`，只严格复制和保留其中的 JSON 数据，因此不会因为只显示正文而丢失 Provider 所需的历史字段。

FakeProvider 本身只负责消费脚本。演示脚本的第二步从真实 `list_files` 结果取得路径，第三步核验真实 `read_file` 返回的源码，再生成回答。缺少前一步工具结果时，脚本会失败。

## 5. 失败与取消

| 场景 | 当前处理 |
| --- | --- |
| 未知工具、坏 JSON、参数不合法 | 生成 `error` 结果交给下一步模型，不执行工具 |
| 注册了写工具 | 返回 `denied / UNSUPPORTED_EFFECT`；首批只执行内存只读工具 |
| 只读工具抛出异常 | 返回 `error / TOOL_EXECUTION`，不泄露内部异常文本，不自动重试 |
| 连续三次相同失败 | 按工具名、规范化参数、错误码计数，停止自动循环；成功或不同错误会重置计数 |
| 模型失败、断流、非法输出 | 保存失败 Attempt 诊断，不保存可执行的部分输出 |
| 模型请求中取消 | 停止等待，关闭迭代器；迟到响应不再执行 |
| 工具执行中取消或超时 | 等待该工具返回实际结果，再为剩余调用补齐取消结果 |
| 工具返回 `unknown` | 停止调度，Run 记为 `interrupted`；已有 unknown 历史不能直接继续 |
| 任意 Journal 提交失败 | 停止后续工具与模型请求，向宿主抛出记录错误 |

取消先阻止派发，不能把正在执行的操作假定为已经撤销。即使取消通知已经到达，只要工具还没返回，运行就不会报告结束。若随后返回 `unknown`，结果未知优先于取消，必须先核对。

ModelProvider 必须配合取消释放资源。Core 可以停止等待不配合的模型流并忽略迟到输出，但不能强制释放适配器掌握的网络资源。M2 的 HTTP 适配器需要把取消通知映射为请求中止并清理连接。工具和 Journal 的在途调用必须最终返回，不能靠取消跳过其结果核对。

`onPreview` 是可丢弃的观察回调，异常不影响运行记录或调度。MemoryJournal 的故障注入发生在替换内存状态之前，因此测试可以证明失败时整组回滚。

## 6. 验证方法与结果

```powershell
npm run typecheck
npm run build
npm test
npm run demo:core
```

2026-09-15，本机 Windows x64、Node 24.14.0 下：

- Core 独立类型检查、首批源码与测试类型检查、依赖边界检查通过。
- Core 与 Runtime 的 ESM 构建通过，演示直接运行构建后的 JavaScript。
- 自动化测试 38 项通过，覆盖完整循环、调用配对、状态保留、串行执行、错误、预算、取消、unknown 和提交失败。
- 演示成功完成 3 Step、2 次内存工具调用，中文路径和行号正确，无 API 请求或项目文件读写。

测试使用手动推进的时间和可控 Promise，不通过长时间睡眠等待取消。内存项目不是 Windows 文件系统的模拟实现；这里只做固定键查找，不能据此宣称真实路径安全、编码、忽略规则或文件写入已通过验证。

## 7. 后续如何接上真实实现

M0.2 增加独立 Runtime 入口、最小协议握手和 Store Worker。Journal 届时映射为 SQLite 事务，任务状态、事件序号和请求去重结果需要在同一事务内提交；当前内存批次接口不代表这些持久化功能已经存在。

M0.3 尽早验证自带 Node、Worker 入口和 SQLite 原生模块的桌面安装包。M0.4 再完成 SDK 同步、背压、权限与进程生命周期，M0.5 在干净 Windows 环境完成验收。

M1 接入真实项目读取，补齐路径策略、编码、忽略规则和文件版本；M2 实现 DeepSeek Provider 的输出项、SSE、重试和历史回放；M3 接入固定修改批次、确认、备份和撤销。当前没有实现审批等待、输入追加、压缩、自动重试、崩溃恢复或生产级持久事件。
