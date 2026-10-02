# 工具对比与网络搜索接入建议

Pi、Codex 核查日期：2026-09-30；DeepSeek Harness 与费用核查日期：2026-10-01。本文记录源码调研和实现建议；网络工具尚未实现，也不改变当前四个基础工具的产品范围。

后续工具范围与具体实施顺序见 [工具重写设计与实施计划](tool-rewrite-plan.md)：先重写四个基础工具，再补网络与目录搜索工具。工具及参数描述现已迁入声明，本文先前的范围建议按该计划更新。

| 项目 | 核查版本 |
| --- | --- |
| Tilot | 本次工作区代码 |
| Pi | main，`0582d9c11da78c1812d4537af2d194f1dd060d26` |
| Codex | main，`67727e7cf114cf3e1b71db368d74b24e32f6cb12` |
| DeepSeek Harness | master，`639ed015397290b3745d163aafe02ffee4aa3f84` |

## 1. Pi 的工具

Pi 当前内置工具名为 read、bash、powershell、edit、write、grep、find、ls，共八个。默认编程组合是 read、bash、edit、write；另有 read、grep、find、ls 的只读组合。powershell 是可选工具，不能把八个工具都描述为默认开放。见 [工具清单与组合](https://github.com/earendil-works/pi/blob/0582d9c11da78c1812d4537af2d194f1dd060d26/packages/coding-agent/src/core/tools/index.ts)。

| 工具 | 用途 |
| --- | --- |
| read | 读取文本，也支持向兼容模型传入图片 |
| write | 创建或完整覆盖文件 |
| edit | 对一个文件进行一处或多处文本替换，并返回差异 |
| bash / powershell | 执行对应的命令 |
| grep | 搜索文件内容 |
| find | 按模式查找文件路径 |
| ls | 列出目录内容 |

相对 Tilot，值得参考的细节有：

- read 支持图片，Tilot 当前只返回 UTF-8 文本。图片需要工具结果、上下文回放和界面一起支持，不能只把图片文件交给现有文本读取函数。见 [Pi read](https://github.com/earendil-works/pi/blob/0582d9c11da78c1812d4537af2d194f1dd060d26/packages/coding-agent/src/core/tools/read.ts)。
- edit 一次接受同一文件的多个替换，按原始内容定位，拒绝重叠，并返回显示差异、标准 patch 和首个变更行。它还有换行规范化及匹配容错；Tilot 采用一次精确替换，要求原始换行一致，返回路径和写入字节数。可以先参考多处编辑和差异展示，匹配容错需要单独评估。见 [Pi edit](https://github.com/earendil-works/pi/blob/0582d9c11da78c1812d4537af2d194f1dd060d26/packages/coding-agent/src/core/tools/edit.ts) 与 [匹配和差异实现](https://github.com/earendil-works/pi/blob/0582d9c11da78c1812d4537af2d194f1dd060d26/packages/coding-agent/src/core/tools/edit-diff.ts)。
- 命令输出截断时保留完整临时文件，并支持执行期间的增量更新。Tilot 只返回末尾 50 KiB，桌面能显示“执行中”，但目前要等命令结束才能取得该调用的输出。见 [Pi bash](https://github.com/earendil-works/pi/blob/0582d9c11da78c1812d4537af2d194f1dd060d26/packages/coding-agent/src/core/tools/bash.ts)。

上述八个内置工具中没有专用网络搜索工具。扩展提供的工具不属于这个基础清单。

## 2. Codex 的工具

Codex 按模型、配置、运行环境和功能开关组装工具；不存在适用于所有会话的固定数量。这里比较 GitHub 中的运行核心，桌面插件和外部 MCP 的具体工具另由安装与连接状态决定。

| 主要工具或工具组 | 用途 | Tilot 现状 |
| --- | --- | --- |
| exec_command、write_stdin | 启动命令，返回会话 id，随后读取输出或写入输入 | shell 每次启动独立 PowerShell，不提供持续会话 |
| apply_patch | 用补丁创建、修改或删除文件 | write 完整写入，edit 精确替换；删除交给 shell |
| view_image | 查看图片 | 尚无图片工具 |
| update_plan、request_user_input 及异步询问 | 更新工作计划、请求用户补充信息 | 目前通过对话文本沟通 |
| web_search | 托管网络搜索 | 尚无专用网络工具 |
| MCP 工具及资源列表、模板列表、资源读取 | 接入外部工具和资源 | 尚无 MCP 接入 |
| tool_search、代码模式执行与等待 | 动态发现工具、用代码组织调用 | 固定声明四个函数工具，逐个执行 |
| spawn_agent、send_message、followup_task、wait_agent 等 | 可选的多代理协作；另保留旧版接口 | 尚无子代理调度 |
| 权限、上下文余量、时钟、等待、插件安装等辅助工具 | 按配置补充运行控制能力 | 预算由本地请求前检查，尚无对应模型工具 |

工具组装及条件见 [spec_plan.rs](https://github.com/openai/codex/blob/67727e7cf114cf3e1b71db368d74b24e32f6cb12/codex-rs/core/src/tools/spec_plan.rs)；持续命令的参数和结果见 [shell_spec.rs](https://github.com/openai/codex/blob/67727e7cf114cf3e1b71db368d74b24e32f6cb12/codex-rs/core/src/tools/handlers/shell_spec.rs)；多代理工具名见 [multi_agents_spec.rs](https://github.com/openai/codex/blob/67727e7cf114cf3e1b71db368d74b24e32f6cb12/codex-rs/core/src/tools/handlers/multi_agents_spec.rs)。

Codex 的托管搜索声明是 Responses 的 web_search 类型。源码区分 cached、indexed、live、disabled：缓存模式不启用外部网页访问，indexed 的实时访问受索引约束，live 开放实时访问。官方说明明确它与本地 shell 的联网权限分开。仓库还有可选的独立 web.run 扩展通路，取决于服务和运行时能力，不能从 CLI 源码推断其服务端搜索实现已经开源。见 [搜索声明](https://github.com/openai/codex/blob/67727e7cf114cf3e1b71db368d74b24e32f6cb12/codex-rs/core/src/tools/hosted_spec.rs) 与 [官方网络搜索说明](https://learn.chatgpt.com/docs/web-search)。

## 3. 对 Tilot 的判断

Tilot 已覆盖 Pi 默认编程组合的四类核心能力，适合继续保持轻量。目录与代码搜索已经能通过 shell 完成，没有必要仅为了工具数量增加 grep、find、ls。

建议后续按需求补齐：文件差异展示、命令输出增量与截断后的全文读取、专用网络搜索与网页读取。持续命令会话适用于开发服务器或交互程序，但需要会话生命周期管理，可以单独开发。图片、多代理、MCP 和动态工具发现则属于更大的能力扩展。

## 4. 网络搜索应由 Tilot 执行

DeepSeek 的 Responses 兼容接口支持 function 工具，但忽略内置工具类型。向它声明 `{ type: "web_search" }` 不会获得 OpenAI 的托管搜索能力；兼容请求格式不代表拥有相同的后端服务。见 [DeepSeek Responses API](https://api-docs.deepseek.com/api/create-response/)。这不代表 DeepSeek 的所有接口都没有搜索能力：Harness 通过独立的 Anthropic 兼容 Messages 请求触发原生搜索，详见第 9 节。

建议增加普通 function 工具，沿用现有流程：模型提出查询 → Core 调用 Tool → Tool 调用搜索服务 → 保存 function_call_output → Context 回放 → 模型挑选网页、读取并回答。

这里假设首版同时提供搜索结果和网页正文；如果只需搜索，可以先实现第一个工具。

| 建议工具 | 参数 | 结果 |
| --- | --- | --- |
| web_search | query，可选 limit、domains | 标题、原始 URL、摘要、获取时间；来源提供时附发布时间 |
| web_fetch | url，可选 offset、limit | 提取后的 Markdown 正文、URL、获取时间、续读位置 |

这是两个不同步骤：搜索摘要帮助挑选来源，读取正文用于核对具体内容。模型应根据实际结果引用 URL；缺失日期不猜测，不把服务生成的答案当成已经核实的原文。

## 5. 搜索服务的选择

| 方案 | 提供能力 | 对首版的影响 |
| --- | --- | --- |
| DeepSeek 原生搜索 + 本地 HTTP 读取 | 用独立 Messages 请求取得来源，本地下载网页并转换 Markdown | 可复用 DeepSeek 官方凭据，不需第三方搜索账号；增加模型请求和本地网页读取工作 |
| Tavily Search + Extract | 搜索结果、域名过滤、网页正文提取 | 一个服务覆盖两个工具，适合先验证整个流程 |
| Brave Web Search + 正文提取 | 独立搜索索引返回标题、URL、摘要等 | 搜索可直接接入；正文另选服务或本地提取方案 |

依据 [Tavily Search](https://docs.tavily.com/documentation/api-reference/endpoint/search)、[Tavily Extract](https://docs.tavily.com/documentation/api-reference/endpoint/extract)、[Brave Web Search](https://api-dashboard.search.brave.com/api-reference/web/search/post) 及第 9 节的 Harness 源码。此前推荐 Tavily 是基于它能同时提供两个接口、减少首版开发工作；补查 Harness 后，建议优先验证 DeepSeek 原生搜索，再根据效果决定是否接第三方服务。尚未实测各方案的网络可达性、中文质量、延迟或总成本。

若采用 Tavily，首版可使用：

- 搜索请求发往固定的 `https://api.tavily.com/search`；query 映射到 query，limit 映射到 max_results，domains 映射到 include_domains。
- 固定 basic 搜索；关闭 include_answer、include_raw_content 和 auto_parameters，先只拿结果列表，让 DeepSeek 自己选择后续来源。
- 网页读取发往固定的 `https://api.tavily.com/extract`，每次提取一个 URL，使用 basic 和 Markdown 格式，再由 Tilot 分段返回。
- 使用 Node 自带 fetch 即可调用这两个 JSON 接口；超时和取消交给 AbortSignal，首版无需额外 HTTP 框架、浏览器引擎或通用搜索适配层。

这些是采用 Tavily 时的建议参数，不是当前应用配置。Tavily 的搜索和提取接口需要 Tavily 密钥，不能使用 DeepSeek 密钥代替；采用 DeepSeek 原生搜索则可按其官方端点复用对应的 DeepSeek 凭据。

## 6. 对现有代码的改动位置

1. `packages/tool/src` 增加搜索和网页读取的声明与执行函数；在 createToolSet 中按配置组合网络工具与四个本地工具。用途和参数说明直接写在对应工具声明中，不增加独立的工具提示词文件。
2. Server 根据搜索配置提供执行依赖；createToolSet 将 workspace 绑定给文件与 shell 工具，将搜索依赖绑定给网络工具。密钥由宿主传入，不成为模型参数。
3. `packages/agent-core/src/run-turn.ts` 在一轮开始时确定实际开放的工具：项目工具按绑定状态提供，网络工具按配置提供。请求声明和预算检查使用同一份清单；同时修改目前“无项目则拒绝全部工具调用”的判断和 `workspace!` 执行假设。
4. 第三方搜索密钥单独保存，并在桌面设置中提供入口。不要把第三方搜索服务塞进模型 providers：当前 credentials.retain 只保留模型服务 id，会在保存模型配置时清理其他条目。若采用 DeepSeek 原生搜索，可显式引用 DeepSeek 官方服务的凭据，但不能把任意第三方 Responses 服务的密钥发往 DeepSeek。
5. 复用现有工具结果存储、历史回放和 attempt.updated 事件。桌面 ToolCall 加入搜索与网页读取的名称和摘要，回答中的来源链接复用现有 Markdown 与 Tauri Opener。

建议网络工具在已配置时也能用于普通对话，因为联网查询无需项目目录。此项会扩展“普通对话没有工具”的现有产品约定，实施前需要更新需求文档并与开发者确认。

## 7. 首版约束与验证

- 搜索默认 5 条、最多 10 条；限制单条摘要和结果总长度。网页正文可沿用 200 行、50 KiB 的分段上限，返回 nextOffset，避免一次塞入大量网页内容。
- 同一轮可短暂缓存已提取的网页，续读使用同一份正文，避免重复提取收费和内容变化；取消或轮次结束后清理。长效缓存后续再做。
- 查询只发送模型给出的搜索文本，不自动附带项目文件或完整对话。网页提取只接收公开 HTTP(S) URL，不带本机 cookie 或模型服务密钥。
- 401、429、超时和提取失败明确返回工具错误。首版不自动切换供应商，也不在失败后擅自启动浏览器抓取。
- 保持网页文字作为工具数据；沿用系统提示词中的约束，不把网页里冒充用户或系统的指令当成授权。
- 若采用外部 Extract 服务，由它取得网页内容；若参考 Harness 在本机直接读取网页，需要处理私网访问、DNS 与重定向校验、下载大小及 HTML 转换，不能直接让 fetch 跟随任意地址。

本地测试应覆盖参数、响应映射、超时与取消、结果长度、正文分页、缺少配置、历史回放，以及无项目对话的开放规则。服务密钥配置后再做少量真实查询，验证中文、官方技术文档、时效性问题和用户给定 URL；模拟测试不能证明网络可达或搜索质量。

## 8. 搜索服务费用

以下为 2026-10-01 的官方标价，货币为美元；搜索服务费用与 Tilot 主模型读取结果时的 token 费用分开。

| 服务 | 免费额度 | 按量费用 |
| --- | --- | --- |
| Tavily | 每月 1,000 credits，无需信用卡 | $0.008/credit；basic 搜索 1 credit/请求，advanced 搜索 2 credits/请求；basic 提取每 5 个成功 URL 1 credit |
| Brave Search | 每月 $5 credits | Search $5/1,000 请求；仅按该搜索单价计算，$5 相当于 1,000 次请求 |

来源：[Tavily Credits & Pricing](https://docs.tavily.com/documentation/api-credits)、[Brave Search API](https://brave.com/search/api/)。Brave 的页面说明免费计划也要求信用卡验证。免费额度有上限，不能称为不限量免费。

## 9. DeepSeek Harness 如何搜索和读取网页

Harness 把能力拆为三层：模型面对固定的 web_search/web_fetch 工具；ctx.web 负责提供方选择与统一结果；具体提供方分别实现 DeepSeek、Exa、Perplexity 搜索或本地 HTTP 读取。Tavily 不在当前这份内置提供方清单中。见 [Web 包清单](https://github.com/deepseek-ai/deepseek-harness/blob/639ed015397290b3745d163aafe02ffee4aa3f84/packages/web/README.md)。

### DeepSeek 原生搜索

- 使用独立的 `POST https://api.deepseek.com/anthropic/v1/messages` 请求；搜索端点与主对话端点分开，不在 Responses 请求上开启搜索。
- 请求附带 `web_search_20250305` 服务端工具，默认搜索模型为 `deepseek-v4-flash`、输出上限 4096、max_uses 为 5。这些是该提交的默认值，不代表 Tilot 应照搬或已验证此模型名可用。
- 可使用 DeepSeek 账号登录凭据或已有 DEEPSEEK_API_KEY。每次查询额外执行一个模型回合，而非调用一个专用搜索结果 API。
- 从 web_search_tool_result 中取得 URL、标题、时间，再从文本的 citations 中拼接引用摘录，按 URL 去重。缺少结构化结果时明确失败，不从模型散文猜出搜索结果。

见 [搜索提供方源码](https://github.com/deepseek-ai/deepseek-harness/blob/639ed015397290b3745d163aafe02ffee4aa3f84/packages/web/web-search-deepseek/src/provider.ts) 和 [提供方说明](https://github.com/deepseek-ai/deepseek-harness/blob/639ed015397290b3745d163aafe02ffee4aa3f84/packages/web/web-search-deepseek/README.md)。无需单独第三方搜索账号不等于免费；源码和说明确认增加模型回合、延迟与 token 消耗，未据此确认一项单独的搜索收费标准或账号免费权益。

### 网页读取

web-fetch-http 在本机匿名请求公开 HTTP(S) 网页，不调用收费的正文提取服务。它限制地址、重定向、大小和时间，验证并固定公开 IP；tool-web 再用 turndown 与 GFM 插件把 HTML 转为 Markdown，并移除不可见内容。见 [HTTP 读取说明](https://github.com/deepseek-ai/deepseek-harness/blob/639ed015397290b3745d163aafe02ffee4aa3f84/packages/web/web-fetch-http/README.md) 与 [转换实现](https://github.com/deepseek-ai/deepseek-harness/blob/639ed015397290b3745d163aafe02ffee4aa3f84/packages/web/tool-web/src/fetch.ts)。

这里的 HTML 转换不等于浏览器渲染，也不保证只保留文章主体。需要登录、依赖 JavaScript 或有反爬限制的页面可能无法获得完整内容；读取工具本身不按 URL 付服务费，但后续模型处理内容仍会消耗 token。

## 10. 修订后的建议

Tilot 以 DeepSeek 为主要模型，优先做少量 DeepSeek 原生搜索验证更合适：检查现有官方 API 凭据是否能调用该搜索端点、实际搜索结果和账单表现，再决定正式接入。主对话继续使用 Responses；辅助搜索请求封装在网络工具内部，无需增加通用多协议模型适配层。

网页读取可参考 Harness 的本地 HTTP + Markdown 转换，减少对正文提取服务的依赖。若搜索质量或延迟不合适，再考虑 Tavily 的免费额度起步。现阶段没有发送任何带用户凭据的搜索请求，也没有实现网络工具。
