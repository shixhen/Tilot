# Tilot

基于 Tauri、React、TypeScript 和 Node.js 的本地桌面 Agent。
当前已建立 Responses 客户端、SQLite 历史存储、Context 上下文构建、Core 工具调用循环，以及桌面宿主与 Node 服务连接。项目任务已开放 read、write、edit、shell、ls、find、grep、web_fetch 八个工具，普通对话也可使用 web_fetch。桌面支持多服务与模型配置、普通对话、流式正文与推理、命令输出预览、编辑差异、目录和搜索结果、网页来源与正文、取消、历史切换和中断后继续。Context 已接入项目指令、技能元数据和请求前预算检查，尚未实现自动摘要，也尚未完成真实模型与原生桌面的完整联调。

分批开发顺序与验收方式见 [开发计划](docs/development-plan.md)。

## 本地开发

使用 Node.js 24.5+（24.x）和 npm，在项目根目录执行：

```sh
npm ci
npm run typecheck
npm test
```

`typecheck` 检查 TypeScript 类型，不生成文件，也不启动应用。
`test` 运行本地自动化测试；模型请求使用模拟数据，不连接真实模型服务。
测试与实现放在同一个包中，分别位于 `tests/` 和 `src/`。根目录 `npm test` 汇总运行各包测试，也可用 `npm test --workspace @tilot/responses` 单独运行一个包。
`packages/tool/src/workspace.ts` 定义项目目录、打开逻辑及文件访问路径检查，由 Server 复用。
文件工具路径统一使用 `/` 分隔的项目相对路径，空字符串在路径检查中表示根目录。路径检查拒绝目录穿越、Windows 特殊路径及内部链接。这是应用级路径检查，不是操作系统沙箱，也不能约束 PowerShell 命令访问。

Tool 已提供 `readProjectFile(workspace, {path, offset?, limit?}, signal?)`：读取 UTF-8 文本（含 BOM），保留 LF/CRLF，默认返回 200 行，可明确请求最多 2,000 行，正文仍最多 50 KiB。结果包含 `content`、`offset`、`lineCount`、`nextOffset` 和 `truncatedBy`（lines、bytes 或 null）；不切断长行，超过单行限制时明确报错。分块读取并检查所读部分的编码与二进制控制字符，支持取消。

Tool 还提供 `writeProjectFile(workspace, {path, content}, signal?)` 和 `editProjectFile(workspace, {path, edits: [{oldText, newText}, ...]}, signal?)`。write 以 UTF-8 创建或完整覆盖文件，自动创建缺少的父目录。edit 每次接受 1–20 项替换，全部针对同一份原文件定位；任一项无匹配、多处匹配或相互重叠时，整个调用不写入。只兼容 LF/CRLF，空格、引号、Unicode 和单独 CR 仍严格匹配，整个结果无变化时明确报错。

edit 保留 BOM 和未修改部分的原始字符；插入内容采用匹配片段的第一个 LF/CRLF，没有换行时采用文件第一个换行，无换行文件采用 LF。write/edit 共用同文件修改队列，写入同目录临时文件后再替换目标，提交前取消或失败会清理临时文件。edit 提交前还检查目标字节是否仍与读取时一致，外部修改或删除会要求重读；这是冲突检查，不提供操作系统文件锁。write 返回 `path`、`bytesWritten`；edit 另返回 `replacements`、`firstChangedLine`、`diff`、`diffTruncated`。差异保留三行上下文，最多 50 KiB，截断不影响实际文件写入，但截断差异不能作为完整补丁应用。

Tool 还提供 `runShell(workspace, {command, timeoutSeconds?}, signal?, host?, execution?)`：在项目根目录启动独立的 Windows PowerShell 5.1，默认 300 秒，最多 600 秒。使用 UTF-8 临时脚本和输出，不加载个人配置，禁止交互输入，不保持跨调用会话。结果包含 `status`、`exitCode`、`durationMs`、`output`、`outputBytes`、`outputLines`、`truncated`、`truncatedBy` 和 `partialLine`；`completed` 仅表示正常结束，成功与否仍看退出码。标准输出和错误输出按接收顺序合并，最多保留末尾 2,000 行或 50 KiB，`partialLine` 表示预览首行不完整；外部程序也应输出 UTF-8。

Core 提供 `host = {outputs: OutputCache, threadId}` 和 `execution = {executionId, onUpdate?}`。命令日志保存在宿主数据目录，通过本地执行记录 id 返回 `outputId`，不暴露缓存路径。`read` 通过 `{outputId, offset?, limit?}` 按行读取；遇到超过 50 KiB 的日志单行会返回 `partialLine` 和 `nextByteOffset`，随后通过 `{outputId, byteOffset: nextByteOffset}` 继续读，直到字节模式的 `nextByteOffset` 为 null。每次最多 50 KiB，保持 UTF-8 字符完整。`path` 与 `outputId` 恰好指定一个；`byteOffset` 仅用于日志，不能与 `offset/limit` 同用。日志按任务归属隔离；普通文件仍只返回完整行。

日志单条最多 10 MiB，保留 7 天，总缓存最多 256 MiB。达到单条上限仅保存完整 UTF-8 前缀，返回 `artifactTruncated: true`，命令仍继续执行并维护尾部输出。创建日志前清理过期和超过容量的已结束日志，运行中日志不回收；缓存被运行中日志占满时不启动新命令。日志写入失败返回已知退出状态、尾部输出和 `logError`，`outputId` 为 null，不能据此重跑命令。

取消和超时调用 Windows `taskkill /T /F`，等待进程关闭后返回对应状态；终止失败会明确报错。首版不支持脱离父进程的后台服务，进程树终止不是沙箱或进程隔离。已用真实 PowerShell 与 Node 子进程测试中文、退出码、截断、超时及取消。

目录和代码搜索提供三个独立工具：

| 工具 | 用途与结果 | 默认及最大数量 |
| --- | --- | --- |
| ls | 非递归列目录，返回项目相对路径和文件/目录/链接类型 | 500 项 |
| find | 按 rg glob 查找文件，返回可直接交给 read 的项目相对路径 | 1,000 个文件 |
| grep | 搜索 UTF-8 内容，返回相对路径、匹配行号及上下文；支持单行正则、字面匹配和忽略大小写 | 默认 100 条，最多 1,000 条匹配行 |

三个工具省略 `path` 或传空字符串时使用项目根目录，JSON 正文最多 50 KiB，结果含 `truncated` 与 `truncatedBy`（items、bytes 或 null），超限时应缩小范围。ls 包含隐藏项，按名称排序，内部链接只列名称和类型。find/grep 搜索隐藏文件，遵守 `.gitignore`、`.ignore`、`.rgignore`，排除 `.git`，不跟随内部链接；glob 不覆盖忽略规则。glob 含 `/` 时相对项目根目录，否则匹配各层文件名；`path` 只限定搜索起点。grep 显式指定文件时搜索该文件，不能同时指定 glob。grep 的 context 为 0–10，每行最多 1 KiB，`textTruncated` 表示该行不完整；行号可作为 read 的 offset。搜索最长 30 秒；单条 rg 输出记录超过 1 MiB 明确报错，可用 shell 定向查看超长行。

开发阶段 find/grep 使用本机 ripgrep（rg），当前实测版本为 15.2.0。优先读取宿主环境的 `TILOT_RG_PATH` 绝对文件路径，否则从 PATH 的绝对目录查找 `rg.exe`；缺少程序时返回明确错误，ls/read 等其他工具仍可使用。正式打包按已确认方案内置固定版本 rg，资源封装在打包阶段实施；工具调用期间不自动下载。没有新增 fd 或 JavaScript glob 依赖。

网页读取使用 `webFetch(host, {url, offset?, limit?}, signal?)`，不需要搜索服务密钥，也不调用额外模型。只接受匿名公开 HTTP(S) 地址，原始及编码后的 URL 最多 4 KiB。HTML 用 Turndown 转为 Markdown，保留标题、列表、代码、表格及链接，图片只保留说明；文本和 JSON 保留正文。返回 `url`、`finalUrl`、`fetchedAt`（毫秒时间戳）、可选 `title`、`outputId` 及分页字段。默认 200 行，最多 2,000 行或 50 KiB 正文；续读传 `{outputId, offset: nextOffset}`，不重新联网。超长行先返回 `partialLine` 和 `nextByteOffset`，随后用 `{outputId, byteOffset: nextByteOffset}` 按字符边界读到末尾；字节模式不与 url/offset/limit 同用。

抓取总超时 30 秒，最多 5 次重定向；下载、解压后正文及转换后正文各最多 2 MiB，超限明确失败，不发布部分网页。支持 gzip/deflate/br，按响应 charset 解码，未声明时使用 UTF-8；不支持的编码或内容类型明确报错。拒绝本机、私网、保留 IP 和本地域名，逐跳检查重定向；直连时验证所有 DNS 地址并固定连接目标，禁止 DNS64 私网映射。只发匿名网页请求，不执行 JS、不加载图片或其他资源、不提供登录态或 PDF 解析；导航等公开页面文本可能保留，不承诺文章主体提取。

网页正文与命令日志共用宿主输出缓存和 7 天/256 MiB 总限额，通过类型及任务归属隔离；web_fetch 只能续读网页，read 的 outputId 只能读命令日志。网络层按宿主 HTTP_PROXY/HTTPS_PROXY（含小写）、ALL_PROXY 和 NO_PROXY 自动选择代理或直连，支持 HTTP/HTTPS 代理，没有额外界面开关。代理模式由宿主指定的可信代理解析及连接目标，不用本机 Fake-IP 固定目标；代理凭据仅发给代理，错误结果不回显凭据。代理出错明确报告，不自动改为直连。代理选择使用 [proxy-from-env](https://github.com/Rob--W/proxy-from-env)，传输使用 [Node 内置代理支持](https://nodejs.org/docs/latest-v24.x/api/http.html#built-in-proxy-support)。

八个模型工具在 `packages/tool/src/` 的对应模块中各自维护描述、参数和执行校验，不单独维护提示词文件。`createToolSet(workspace?, host?)` 创建一轮工具集合，由 `execute.ts` 统一查找和包装结果；Core 的请求声明、预算检查与执行共享这个集合。七个本地工具只对绑定项目的任务开放；宿主提供缓存后，web_fetch 在两种对话中都开放。Git、测试与构建继续由 shell 承担；目前没有专用网络搜索或 MCP 接入。[工具重写计划](docs/tool-rewrite-plan.md)的 A1–A3、B1、B3a 已实现，按开发者要求暂缓搜索；背景调研见 [工具对比](docs/tool-comparison.md)。

启动 Windows 桌面开发版还需要 Rust、Visual Studio C++ Build Tools 和 WebView2：

```sh
npm run desktop
```

窗口通过 Rust 宿主启动本机 Node.js 24 服务，读取默认数据目录中的任务。刷新页面复用服务，重复启动会聚焦已有窗口；关闭应用时先通知服务取消执行并保存，超时再强制结束。

`npm run build --workspace @tilot/desktop` 检查并构建前端；`npm run test:desktop` 验证 Rust 桥接与真实 Node 子进程的通信和退出。`npm test` 包含前端连接及历史/事件合并测试。前端交互已通过浏览器模拟服务验收，原生桌面端与真实模型的完整联调尚未完成。发布所需的 Node、服务代码及 SQLite 原生模块封装留到打包阶段，目前不生成安装包。

## 桌面对话

界面布局、功能入口和交互以 Codex 为参照，当前采用截图中的深色任务侧栏、蓝色用户消息和底部输入框，不增加侧栏文件树。连接设置可添加多个服务，各自填写名称、Base URL 和 API Key，自动从 `/models` 加载模型，并为每个模型设置最大上下文。输入框中选择服务、模型和推理强度，每个任务保存自己的选择。密钥留空保留旧值，更换地址时需填写对应密钥；仍被任务使用的服务不能删除。普通配置和密钥分开保存，部分失败会明确提示已经保存的部分。

界面基础组件使用 shadcn/ui（New York）：Button、Input、Textarea 等组件源码放在 `apps/desktop/src/components/ui`，基于 Tailwind CSS 4，并使用 Lucide 图标。组件按官方注册表引入，保留 MIT 许可；`components.json` 和 `@/` 别名支持后续继续添加组件。应用布局和 Markdown 样式仍保留为直观的 CSS，不一次迁移全部样式。Codex 桌面前端并未开源，外观参考用户截图，不声称复用了其前端实现。

新对话在首次发送时建立任务；默认普通对话，也可以先通过“选择项目”选取本地目录。选择后不立即创建任务，取消系统选择器不会改变当前任务与草稿。首次发送时 Server 验证目录并保存解析后的真实路径，之后绑定固定；已有任务可在同项目中新建对话，不能更换绑定。侧栏按项目路径分组，可折叠，悬停项目名称查看完整路径。项目名称和访问状态收在输入框工具栏，输入框随内容增高。不同项目的新对话草稿分别保留在本次打开的界面中。

Enter 发送，Shift + Enter 换行；中文输入法确认候选不会触发发送。正式系统提示词统一放在 `packages/prompts/src/system.ts`，由 Server 提供，涵盖协作、工具使用、技能和中断恢复约束；桌面不传入或拼接系统提示词。

正文和推理使用 Markdown 排版，支持标题、列表、引用、表格与任务列表。代码块保留缩进，支持横向滚动和复制，流式未闭合代码块也能显示。网页链接经 Tauri Opener 交给系统默认浏览器，仅支持完整 HTTP(S) 地址；模型输出的 HTML 不执行，图片仅显示说明，不自动下载。代码语法着色暂未接入。

完成消息替换临时预览，失败或取消片段标为临时预览；重新打开应用只恢复数据库中已保存的消息。历史读取覆盖全部分页，任务切换隔离消息与本次打开期间的草稿；向上阅读时不强制滚回底部。项目对话可通过七个本地工具列目录、读取、搜索、修改文件及执行命令，两种对话都可读取公开网页。工具展示支持名称、参数、执行状态和结果，执行中自动展开、结束后自动收起；ls/find/grep 显示目录类型、文件列表、匹配/上下文行号、空结果和截断提示。shell 实时展示有界输出快照，结束后展示退出码、耗时、截断和日志保存状态，read 展示行或字节续读位置。web_fetch 展示标题、来源链接、抓取时间和正文缓存续读位置；正文只作文本展示。临时输出不落库、不进入模型上下文，正式结果会替换预览；旧查询和迟到进度不能覆盖最终结果。edit 从已保存结果显示新增、删除、替换数、首个变更行及差异截断提示；旧历史没有 diff 时仍显示原始结果，新调用只接受 edits 数组。请求记录还可展示首 token 延迟、输出速度和服务返回的 token 用量。

目录选择使用 Tauri Dialog 系统对话框，当前浏览器验收模拟了选择和取消的返回值；原生 Windows 目录选择器仍需人工交互验收。Server 测试覆盖无效目录、目录链接解析和项目绑定持久化。

Markdown 使用 [react-markdown](https://github.com/remarkjs/react-markdown) 与 remark-gfm，未自行编写解析器。桌面测试使用 tsx 执行包含 React 组件的测试，其余包仍使用 Node 原生测试入口。Windows 开发版已编译通过，Rust 与真实 Node 服务的通信和退出测试通过；原生窗口内的发送、外部链接打开和关闭操作仍需人工验收。

浏览器界面验收：运行 `npm run dev --workspace @tilot/desktop` 后打开 `http://127.0.0.1:1420/tests/preview.html`。该测试入口使用内存模拟服务，只供验证设置、流式预览、工具及编辑差异、任务切换与停止；不调用模型、不读写真实凭据，也不进入生产构建。正式入口仍通过 Tauri 连接真实 Node 服务。

## 目录与职责

采用 npm workspaces，在同一个仓库管理桌面应用和独立模块包。

| 目录 | 职责 |
| --- | --- |
| `apps/desktop` | `src` 放 React 界面，`src-tauri` 放 Tauri 桌面宿主 |
| `packages/server` | Node.js 服务入口，组装模块、管理生命周期、处理 RPC 和推送事件 |
| `packages/agent-core` | 调度 Agent 执行流程 |
| `packages/context` | 构建上下文、加载 Skills、压缩历史 |
| `packages/tool` | 内置工具、MCP、注册与执行 |
| `packages/prompts` | 统一维护系统、项目和恢复提示词 |
| `packages/store` | 保存对话、配置、凭据和其他持久数据 |
| `packages/responses` | 通过 OpenAI SDK 调用 Responses API |
| `packages/protocol` | 桌面端与 Server 共用的 RPC 请求、响应和事件类型 |

桌面应用及各包已有实现；Tool 已接入八个项目工具，普通对话开放网页读取，Context 已加载项目指令和技能元数据并检查预算。上表中的 MCP 和历史压缩是模块规划职责，尚未实现。
根目录的类型检查覆盖各包和桌面的 `src/` 与 `tests/`；桌面使用独立 React 配置。

## 数据存储

配置和对话历史统一存入 SQLite。默认数据库路径为 `%LOCALAPPDATA%\Tilot\tilot.sqlite`：Server 的 `getDefaultDataDirectory` 解析目录，创建 Store 时传入绝对路径。当前已创建配置、任务、轮次、用户输入、模型请求和工具调用表。

命令日志与网页正文独立保存在同一数据目录的 `outputs` 下，正文与归属、类型及来源元数据分开保存；只向当前任务返回不透明标识。重启后已发布且未过期的缓存仍可读，遗留未发布正文在下次清理时删除。缓存过期或回收不修改 SQLite 中已保存的工具结果，不在项目内创建输出缓存目录。

按开发者选择，API Key 以明文 JSON 保存在同目录的 `credentials.json`，按服务 id 保存各自的 baseURL 和 apiKey，不写入 SQLite。`Store.credentials` 提供 getApiKey、saveApiKey 和 retain；保存时通过临时文件替换，删除服务时清理对应凭据。读取时核对规范化后的完整服务地址，地址不同返回未配置；旧版单服务凭据按 default 服务读取。Server 只提供凭据设置和已配置服务列表，不提供密钥原文读取接口；测试仅使用临时目录中的模拟密钥。

SQLite 的 providers 和 provider_models 表保存服务及模型，app_config 保存新任务的默认服务、模型、推理强度和执行限制。已有任务各自保存服务、模型和推理强度，可通过 thread.update 修改，不随新任务默认值变化。

任务支持创建、读取、分页列表和重命名。创建时可不绑定项目；已绑定项目不能通过重命名改变。Store 只保存项目路径，Server 负责验证目录，无项目任务后续不得调用项目文件工具。任务列表默认每页 50 条，最多 100 条。

每个任务最多有一个运行中的轮次。`startTurn` 同时保存轮次和首条输入，`appendTurnInput` 保存运行中的补充输入，`finishTurn` 记录完成、失败或取消。输入原文不会被裁剪；轮次列表按 sequence、输入列表按 id 顺序分页。补充输入何时发送给模型由后续 Core 决定。

`Store.history` 提供模型历史接口：`startAttempt` 记录一次请求及其用户输入边界，`finishAttempt` 保存完整 SDK 响应和本地终态。成功响应须由调用方先经 Responses 校验；Store 保留 reasoning 和原始参数，失败、截断或取消尝试只作诊断，不登记可执行调用。重试使用新的尝试记录，不覆盖旧记录。

成功响应及其工具调用记录在同一事务中保存。`saveToolResult` 使用本地执行 id 定位记录，并核对模型的 call_id；结果只能保存一次。查询结果按原始输出位置排序，工具结果未补齐时不能开始该任务的下一次请求，也不能将所属轮次标为完成。`getAttempt`、`listAttempts` 和 `listToolCalls` 用于读取这些记录。

Server 启动时先取得数据目录的服务排他锁，再调用 `recoverInterruptedTurns`，把遗留运行轮次和请求标记为中断；另一个服务持有锁时不会进行恢复。创建 Store 或关闭连接不会自动修改状态。缺少结果的工具调用保留为未决，不自动重跑；继续中断任务时，Context 只向模型补入“执行结果未知”的配对结果，不把它写成数据库中的实际执行结果。模型须先核实状态，继续操作创建新轮次，保留旧记录。

Store 使用 [better-sqlite3](https://github.com/WiseLibs/better-sqlite3)，数据库操作在 Node.js 服务中执行。打包时需携带与目标 Node.js 版本及 Windows 架构匹配的原生模块。数据库使用 `user_version` 标记结构版本，后续增加表时显式迁移；未知版本直接报错，不自动重建数据库。

## 上下文构建

`@tilot/context` 的 `buildContext(store, { turnId, inputThroughId, instructions })` 返回下一次请求所需的 `instructions` 和 `input`。调用方先选定正在运行的轮次及输入边界，在 `startAttempt` 之前构建上下文；同一任务的执行互斥由 Core 管理。

Context 读完该任务截至目标轮次的历史，按成功请求记录的输入边界插入用户消息，再放入完整响应及其全部工具结果。失败诊断不参与回放，reasoning 正文和原始工具参数保留，转换使用 SDK 的 `toResponseInputItems`。缺失结果、标识冲突或输入边界倒退直接报错，不返回残缺上下文。

当前默认保留旧轮次中取消或中断前尚未发送的输入，将其放在该轮次最后一个完整消息组之后；当前轮次只纳入指定边界以内的输入。Context 不写数据库，不发起模型请求；系统策略由调用方传入。

项目任务每次请求前加载根目录 AGENTS.md 和 `.codex/skills/*/SKILL.md` 的技能元数据，不搜索父目录或全局技能目录。模型需要使用技能时再通过 read 读取正文。请求前按序列化指令、历史和工具声明的 UTF-8 字节数保守估算输入预算，并预留输出和安全余量；这不是精确 token 计算。超过当前模型的最大上下文时明确报错，不自动摘要或裁剪历史。

## 模型与工具调用循环

`@tilot/agent-core` 的 `runTurn(store, client, options)` 创建轮次、保存首条输入、构建上下文并调用 Responses，最后返回已保存的轮次终态。`options` 包含 threadId、input、instructions，以及可选的 signal 和 onEvent 回调。回调支持返回 Promise，Core 等待事件处理完成后再继续读取。Server 使用已配置 baseURL 和对应的文件凭据创建 SDK 客户端；Core 不读取密钥。

同一任务由 Store 阻止并行轮次，目前不同任务可以并行。每轮开始冻结任务所选服务、模型、推理强度及其余普通配置与首条输入边界，整轮工具循环使用同一边界；执行期间追加的输入留到下一轮回放。系统提示词由 Server 从 Prompts 包传入，每次请求发送；Core 不内置默认提示词。

`turn.started` 提供轮次标识，`response.event` 携带轮次、请求尝试标识和原始 SDK 事件。完整终态先保存再交付；函数返回值是本轮本地最终状态。模型失败、截断、断流或处理事件抛错会停止请求，截断尝试保存为 incomplete，所属轮次记为 failed。取消前已中止的调用不创建轮次；流中取消会结束尝试和轮次并释放请求。终态通知或数据库写入异常直接抛给调用方，不伪装成模型失败。

普通任务声明 web_fetch；项目任务另外声明 read、write、edit、shell、ls、find、grep，两者使用 tool_choice=auto。Tool 校验参数后执行；成功响应先落库，同一响应中的调用依次执行，每个结果按原 call_id 保存，再通过 Context 构建下一次请求。普通任务要求访问项目文件同样返回未声明工具错误。未知工具、非法参数和执行失败返回错误结果供模型处理，Core 不自动重试。工具开始和结果保存后通过内部 tool.updated 事件通知 Server，再转换为桌面的 attempt.updated 展示事件。

shell 的临时输出通过 `tool.progress` 交付，最多每 100 ms 一次。日志和事件写入等待期间暂停输出管道，避免无界排队；取消仍会等待进程和在途输出处理结束。进度交付失败时先停止命令，保存实际结果并为后续调用补齐未执行结果，再结束轮次和连接。

maxStepsPerRun 限制一轮的模型请求次数。最后一次响应若仍要求工具，则不执行这些调用，保存 not_executed 结果并结束为失败。取消会传递给正在执行的工具，尚未执行的调用逐一保存原因；不再启动下一次模型请求。模型重复使用历史输出或调用标识时拒绝执行。成功请求及工具结果完整保存后才通知终态，通知失败不重跑已完成工具。

当前已检查上下文预算，尚无自动摘要或历史裁剪。断流诊断保留最近收到的响应对象，不把预览增量拼成正式响应；进程异常退出后缺少结果的调用仍须核实，不能自动重跑。循环已通过模拟模型流、真实临时文件和 PowerShell 验证，尚未完成真实模型的完整联调。

## 本地服务与通信

已使用子进程标准输入/输出，采用 UTF-8 JSON Lines：每行一个 JSON 请求，输出每行一个应答或事件。JSON 字符串内的换行由序列化转义，标准输出只放协议，启动和传输错误写到标准错误。Tauri 宿主管理 Node 进程，通过命令发送请求、事件转发应答；React 按请求 id 配对应答，服务退出后结束全部等待。前端不能指定可执行程序或启动参数。

在根目录启动开发服务：

```sh
node packages/server/src/main.ts
```

首个命令行参数可传入绝对数据目录；省略时使用默认目录。入口取得服务排他锁后恢复遗留轮次，再开始处理请求。输入结束后，服务处理完已收到的请求，取消活动轮次，等待 Core 保存终态后关闭数据库并释放锁。输入或输出异常也会停止连接并取消活动轮次。

当前支持 thread.create、thread.read、thread.list、thread.rename 和 thread.update；thread.update 为任务保存所选 providerId、model 和 reasoningEffort。例如发送：

```json
{"id":"req-1","method":"thread.create","params":{"title":"新任务"}}
```

连接设置使用以下接口，每次请求都包含 params 对象：

| 方法 | params | 成功结果 |
| --- | --- | --- |
| config.get | `{}` | 普通配置 |
| config.set | `{config: 完整配置}` | 保存后的普通配置 |
| credentials.status | `{}` | `{configured: string[]}`，列出当前地址已有有效密钥的服务 id |
| credentials.set | `{providerId, apiKey}` | null |
| models.fetch | `{providerId, baseURL, apiKey}` | 模型 id 列表；空密钥使用该服务同地址的已保存密钥 |

配置类型与数值范围分别在 RPC 边界和 Store 校验，校验失败不会覆盖旧值。保存配置不会写入新密钥，但删除服务会清理对应凭据；保存密钥不会修改当前服务地址。

响应使用 `{id, success, result}` 或 `{id, success, error}`；找不到任务时 read 返回 null，格式错误且无法识别请求时 id 为 null。创建有项目的任务时，Server 先验证并解析真实目录。请求按到达顺序处理；当前不提供重试去重。

`turn.start` 的参数为 `{threadId, input}`，取得轮次标识后返回 Turn，不等待模型结束；同一任务的重复启动会失败。`turn.interrupt` 接收 `{turnId}`，返回 `{interrupted: boolean}`：true 表示已请求取消，最终状态以 turn.finished 为准；轮次已结束或不属于当前连接时返回 false。`turn.resume` 接收 `{turnId}`，仅允许继续没有后续轮次的最新中断轮次，创建新轮次核实并继续，不重跑旧调用。不同任务可以并行，流式执行不阻塞后续管理请求。

服务会交错推送以下事件：

| event | 内容和处理方式 |
| --- | --- |
| turn.started | turn 包含轮次与任务标识；可能先于启动应答到达 |
| message.delta | 按 turnId、itemId、contentIndex 追加对应 kind 的正文、推理或拒绝预览 |
| message.completed | 成功落库后的完整 parts，按 itemId 替换预览，不能再次追加 |
| attempt.updated | 更新请求记录及其工具参数、结果和正在执行的工具标识 |
| tool.progress | 按 threadId、turnId、attemptId、toolId 替换临时命令输出快照；包含 output、truncated、partialLine，不作为历史或模型输入 |
| turn.finished | 已保存的最终 turn，包含完成、失败或取消状态 |

事件 seq 在当前连接内从 1 递增，重启后重新计数。失败或取消不会产生成功的 message.completed，界面应结合 turn.finished 标记预览状态。应答和事件通过同一写入队列发送，Core 等待事件写入完成；无法交付事件或保存状态时结束连接，不伪造成功。当前没有断线事件重放，可通过历史查询恢复已保存内容。

历史展示接口如下，所有列表默认每页 50 条、最多 100 条，按保存顺序返回：

| 方法 | params | 结果 |
| --- | --- | --- |
| turn.list | `{threadId, afterSequence?, limit?}` | 任务的轮次列表 |
| turn.read | `{turnId}` | 单个轮次及状态，不存在时为 null |
| turn.inputs | `{turnId, afterId?, limit?}` | 该轮次的用户输入，保留原文 |
| turn.attempts | `{turnId, afterSequence?, limit?}` | 请求状态、输入边界及成功消息的展示数据 |

首批查询省略游标，后续传入上一页最后一个 id 或 sequence；查不到记录的列表返回空数组，不创建任务或轮次。请求消息采用与 message.completed 相同的 itemId、outputIndex 和 parts，保留推理、正文和拒绝文本。失败、取消、中断及运行中的请求 messages 为空，不把诊断响应伪装成回答；SDK 原始响应和系统策略不会传给界面。成功请求的工具调用及已保存结果通过 tools 返回，并保留 outputIndex；metrics 提供实测延迟、输出速度与 token 用量，未采集的指标为 null。

历史查询只包含已保存内容，不包含尚未落库的流式预览。界面应按 turnId、请求 id 和 itemId 合并历史与事件；收到 turn.finished 后重新读取该轮次及请求记录。afterSequence 只用于翻页，不能用它查询已有运行记录的状态变化。按 inputThroughId 可判断每次响应之前已纳入哪些用户输入。

Protocol 只包含通信类型、展示数据及共享任务、轮次与配置数据，没有 Node.js、数据库或 SDK 依赖。Store 复用其中的 Thread、Turn 和 AppConfig 类型，避免桌面通过 Store 导入数据库代码。

## 已确认的设计决定

- Responses 使用 OpenAI SDK 接入 Responses API，优先复用 SDK 类型。
- 支持多个 Responses 模型服务的配置，不设计通用模型协议适配层，不自行实现模型 HTTP 或 SSE 协议解析。
- 模块划分见 `docs/technical-design.md`，模型接入细节见 `docs/deepseek-integration.md`。
- 当前项目工具为 read、write、edit、shell、ls、find、grep、web_fetch；普通对话开放 web_fetch。shell 使用 PowerShell，网络搜索按开发者要求暂缓；规格与进度见 [工具重写计划](docs/tool-rewrite-plan.md)，其余功能范围见 `docs/product-requirements.md`。
- 执行体验按开发者 Codex 截图中的“完全访问”模式：直接执行，不逐次弹窗；四个基础工具、文件差异、命令进度与日志续读已接入。
- 分小批次开发，函数和类型添加中文用途注释；每批解释并经确认后继续。
