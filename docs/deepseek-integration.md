# DeepSeek Responses 接入规范

API 核查日期：2026-10-04。正式 Server 链路此前已通过 deepseek-flash 真实联调，结果与复跑方式见 [联调记录](deepseek-live-testing.md)。本次取消应用 Token 限制的改动以本地测试验证，未新增付费请求。

## 1. 协议与配置

Responses 模块位于 `packages/responses`，使用 OpenAI SDK 的 `client.responses.create()`。客户端接收 `apiKey` 和可选的 `baseURL`，默认地址为 `https://api.deepseek.com`，用户可配置兼容 Responses API 的服务地址。不设计通用 Provider 或 HttpTransport，不自行实现 HTTP、UTF-8 解码与 SSE 解析；这些由 SDK 处理。SDK 流式调用方式见 [OpenAI 官方说明][A6]。

应用配置示例：
```json
{
  "providerId": "default",
  "model": "deepseek-flash",
  "reasoningEffort": "high",
  "providers": [{
    "id": "default", "name": "api.deepseek.com", "baseURL": "https://api.deepseek.com",
    "models": [{ "id": "deepseek-flash" }]
  }],
  "maxAutomaticRetries": 2
}
```

`providers` 是用户添加的模型服务（名称、地址），保存在 providers 表中；每个服务的模型从它的 `/models` 加载，名称保存在 provider_models 表中，更换服务地址后该服务的模型整体替换。`providerId`、`model` 与 `reasoningEffort` 是新任务的默认值，每个任务另外保存自己的服务、模型和思考强度；仍被任务使用的服务不能删除。密钥按服务 id 保存在 credentials.json，并记录保存时的地址，服务改地址后旧密钥不再使用，删除服务时一并删除。普通配置保存在 SQLite 的 app_config 表中，数据库结构版本由 `PRAGMA user_version` 管理。首版协议固定为 Responses，不重复保存 provider/api 标记；凭据不包含在此配置中。

| 应用数据 | 请求字段 |
| --- | --- |
| model | model |
| 系统策略 | instructions，每次请求都发送 |
| 本次所需历史 | input，按顺序排列消息、推理、调用及结果 |
| reasoningEffort | reasoning.effort |
| 工具声明 | tools 中的平铺 function 对象及 DeepSeek 服务端工具 |
| 流式开关 | stream: true |

“快速”对应 effort=none，“标准”对应 high；高级设置提供 low/max。请求省略可选的 max_output_tokens，由服务决定默认输出上限；应用也不设置输入预算或预留量。模型 ID、能力和核查日期使用版本化配置，记录实际响应 model，不自动改换用户选择。[请求参数][A2]、[模型说明][A3]

不发送 Chat Completions 的 messages、thinking、reasoning_effort 或 max_tokens 字段，不实现该协议的兼容分支。Tauri Client 不请求模型 API。服务地址由用户配置，模型不能更改 endpoint；地址支持 HTTP/HTTPS，不能包含凭据、查询参数或片段。关闭 HTTP 重定向，HTTPS 请求保持 TLS 校验。下文的兼容性约束针对 DeepSeek，自定义服务的能力需另行核对。

## 2. SDK 类型与兼容边界

| 对象 | 内容 |
| --- | --- |
| 请求 | 复用 ResponseCreateParamsStreaming |
| 历史输入 | 复用 ResponseInputItem，保留消息、推理、工具调用及结果的顺序 |
| 工具声明与调用 | 复用 FunctionTool、ResponseFunctionToolCall |
| 流式事件 | 复用 ResponseStreamEvent |
| 完整响应 | 复用 Response，保存完整 output、status、usage、model 和 id |

通过 `client.responses.create({ ...request, stream: true }, { signal })` 获取事件流，使用 `for await` 消费，使用 AbortSignal 取消。Responses 负责 SDK 调用，Core 负责执行调度，Tool 负责工具执行，Store 负责保存；Server 将运行事件转换成 UI 展示数据。任务、轮次和请求尝试的 ID 单独保存，不为 SDK 已有协议类型再建一套通用抽象。

DeepSeek 的实现无服务端会话存储，不支持 previous_response_id、conversation 或 background。每次请求从本地记录重建所需 input；responseId 仅用于追踪，不能作为服务端恢复凭据。[无状态约束][A1]

桌面新建对话时，先显示首条输入的片段或图片名。使用 DeepSeek 官方服务及思考模式时，首轮仍有临时标题就随正常模型请求附加 `title: { enabled: true }`。首个响应若只有工具调用，标题可随首轮后续响应返回。成功终态中的 `response.title` 会替换临时标题，由桌面刷新对话列表。保存自动标题或手动改名后停止请求标题。首轮结束时仍无标题则沿用临时标题。DeepSeek 仅在思考模式下允许客户端工具和自动标题同时启用，快速模式沿用首条输入标题。发送给 DeepSeek 的文件查找工具名称为 `find_files`，避开服务的保留名称 `find`。已有标题和原始工具历史照常保存。数据库版本 17 保存临时标题的标记。[DeepSeek 会话标题](https://api-docs.deepseek.com/zh-cn/guides/conversation_title/)

parallel_tool_calls 和 max_tool_calls 被服务忽略，调用数量及串行策略由 Agent Core 控制，通过 Tool 执行。instructions 用于系统策略；该实现将 developer 角色作为 user 处理，不能靠它承载更高优先级指令。[兼容表][A4]

本地工具按对话权限声明，工具描述与参数直接写在声明中。使用官方 DeepSeek 地址且开启思考时，额外声明 `deepseek_web_search` 和 `deepseek_read_url`，是否使用由模型决定。思考模式同时声明两者时，打开网页由深度搜索处理。快速模式保留本地工具及 `web_fetch`。请求在开始生成前被服务明确拒绝使用官方联网工具时，保留失败记录，提示原因并移除这两个声明重试一次。

服务端联网步骤直接在过程块显示查询词、页面、可用结果或错误，回复末尾集中显示正文引用。`web_fetch` 由 Tilot 执行，读取指定 URL 并返回可续读的网页正文。官方联网由 DeepSeek 执行，读取结果可通过加密 `signature` 回放。[DeepSeek 联网工具][A9]

## 3. 输出项与工具回放

### 保存与投影

保存完整 response.output、原始顺序、推理正文、arguments 字符串和两个不同的 ID：

- itemId 是输出项的 id，用于匹配流式事件。
- call_id 连接 function_call 与 function_call_output，用于模型工具回放。

不得将所有输出项压成一条 assistant 文本，也不能把 itemId 当作 call_id。UI 仅从保存记录生成展示投影。

发起下一步请求时，Context 将已提交输出组织为 input，保留消息、reasoning.content、调用及结果的顺序。当前实现使用 OpenAI SDK 7.18.0 的 `openai/lib/responses/ResponseInputItems` 导出的 `toResponseInputItems`；已通过本地源码和测试核对推理正文保留行为。demo 中过滤 reasoning 仅用于测试，正式实现直接保留 reasoning 项及其正文。输出专用状态字段不用于控制权限。原始输出保留用于诊断，投影不能覆盖原记录。

服务端联网的 `web_search_call` 在收到 `response.output_item.done` 后保存。后续请求发送到官方服务时，按原顺序回放完整项及其 `kind` 和 `signature`。服务端已经返回执行结果，因此无需配对本地 `function_call_output`。

### 工具声明与结果

Responses 的 function 字段位于工具对象顶层。以下仅示意读取工具：

```json
{
  "type": "function",
  "name": "read",
  "description": "读取授权项目中的代码文件",
  "parameters": {
    "type": "object",
    "properties": {
      "path": { "type": "string" }
    },
    "required": ["path"],
    "additionalProperties": false
  }
}
```

项目目录由宿主根据当前任务绑定传给 Tool，不由模型提供 projectId 或根目录。上面仅示意必要参数，实际分段读取参数随工具实现补齐。Tool 校验完整参数与执行策略，执行后的结果按原 call_id 回传：

```json
{
  "type": "function_call_output",
  "call_id": "call_example",
  "output": "{\"status\":\"ok\",\"data\":{\"path\":\"src/main.ts\",\"content\":\"...\"}}"
}
```

对一个模型响应中的全部调用，按声明顺序补齐结果后再请求模型。拒绝、错误、未执行和取消也必须有结构化结果；未知副作用先恢复核对，不能当作成功。内部执行 ID 与模型 call_id 分别保存。[调用配对][A1]

### 上下文回放规则

1. 保留待回放响应中的 reasoning 项及其正文，不以 summary 或 encrypted_content 替代。
2. 新用户轮次、界面折叠或重连不删除 Responses 回放所需字段。
3. 以一个完整模型响应及其全部工具结果为完整消息组；禁止保留孤立调用或结果。
4. 新请求先校验配对、ID 和类型。缺失必要历史时明确停止，不伪造推理或执行记录；恢复中的未决工具只在上下文中补充“执行结果未知”的配对说明。按当前产品决定不启用摘要。
5. 协议允许补入宿主实际执行的工具记录，但首版不主动使用这一能力，不虚构模型调用。[工具历史说明][A5]

## 4. 流式处理

消费 SDK 返回的异步事件流，不自行解析 HTTP 字节流。增量事件用于界面预览，成功终态事件中的完整 response 用于校验和保存。[SDK 流式调用][A6]

| API 事件 | 处理 |
| --- | --- |
| response.created / in_progress | 建立响应标识，确认本次 Attempt |
| output_item.added / done | 按 output_index、itemId 登记和完成输出项 |
| content_part.added / done | 跟踪正文或推理的内容块 |
| output_text.delta / reasoning_text.delta | 更新独立预览缓冲 |
| function_call_arguments.delta / done | 按输出项聚合参数，done 仍不触发执行 |
| response.completed | 校验最终 response.status、完整 output 和 usage |
| response.incomplete | 记录截断或过滤，不执行本次工具 |
| response.failed | 保存诊断并结束本轮；当前不自动重试，不执行本次工具 |

表中省略前缀的事件均以 `response.` 开头。该流以终态事件结束，没有 `data: [DONE]`。连接关闭、item.done 或参数 done 均不能代替最终成功事件。[事件定义][A4]

聚合规则：

- sequence_number 在每个 Attempt 内递增，可有间隔；不充当任务事件 seq。重复号仅在内容完全相同时去重，冲突或倒序视为协议错误。
- 正文、推理和工具参数独立累积；多个工具交错时按 itemId/output_index 区分。
- done 与最终 output 是完整值，核对或替换对应缓冲，不能再次追加造成重复。
- 完整的工具意图随输出项保存。只有响应最终状态为 completed、输出结构完整且调用 ID 合法，才校验参数和执行本地工具。参数失败时保存结构化错误结果。
- completed 仍可能携带 function_call。此时进入工具执行和下一次模型请求，不结束 Run。
- incomplete、failed、断流及本地取消时，已确认完整的项可以回放，未确认的片段留作诊断。尚未执行的本地工具配对未执行结果。
- usage 缺失标为未知。未知且影响执行的输出类型按协议错误处理，不静默丢弃后继续。

每次重试建立新 attemptId、清空临时缓冲，复用冻结请求；不把新流接在旧流尾部。SDK 设置 `maxRetries: 0`，重试由应用统一管理，避免两层重试叠加。结束、失败和取消时结束事件消费；主动中断时取消 SDK 请求，由 SDK 释放底层连接资源。

运行中引导由 harness 接收并保存，不中止当前 HTTP/SSE 请求，也不修改已经发出的 input。当前完整响应及其工具结果保存后，下一次 `responses.create()` 纳入最新引导，沿用同一轮次、冻结配置和完整历史；没有工具调用但仍有引导时也继续请求。等待区的普通消息则在成功结束后创建新轮次。正式 DeepSeek 的同轮引导和自动续发已通过独立真实联调，详见 [行为与验证](queued-input-and-steering.md)。

## 5. 上下文管理

2026-10-04 起，按开发者要求取消应用的输入预算、输出上限和安全预留量，不再以 UTF-8 字节数估算并提前拒绝请求。输入包含 instructions、工具 schema、消息、推理和工具结果，Context 完整回放历史并检查配对。

不启用摘要或历史裁剪。服务返回 HTTP 错误、response.failed 或 response.incomplete 时，Core 保存失败尝试及已收到的响应对象。生成前明确拒绝官方联网工具时，按上文降级重试。请求体过大时的图片处理见 [图片输入](images.md)。其余错误结束本轮并展示原因。工具自身的分页及输出限制由工具声明和执行器负责。

原始历史与当前输入保留。项目上下文仅加载根目录 AGENTS.md 及项目 .tilot/skills 中的技能元数据，正文按需读取；详见 [上下文与项目技能](context-and-skills.md)。

不发送 truncation 或 context_management 期待服务自动裁剪历史；上下文超限由 API 报错，Agent Core 按现有错误流程结束本轮并保留原始历史。[兼容限制][A4]

## 6. 缓存与费用

保持系统策略及工具 schema 顺序稳定。前缀缓存由 DeepSeek 管理，不代替本地历史存储。[缓存说明][A8]

使用 Responses 的 usage 字段归一化：

- 输入总量：input_tokens。
- 缓存命中输入：input_tokens_details.cached_tokens。
- 未命中输入：输入总量减缓存命中量。
- 输出总量：output_tokens；其中 reasoning_tokens 是子项，不重复计费。

按整轮累计服务返回的用量。联网次数取 `usage.server_tool_use` 中 `tool_search`、`tool_fetch`、`tool_image_search` 之和，有 usage 而省略 `server_tool_use` 时显示零次。本轮费用仅按 Token 用量估算，每百万缓存命中输入 ¥0.02、未命中输入 ¥1、输出 ¥4。

失败、截断及取消请求带 usage 时原样保存并参与累计。缺失字段影响的合计显示未知。缓存命中率按累计缓存命中除以累计输入计算。TPS 按累计输出除以各次模型生成时间之和计算，排除工具执行与首 Token 等待。原始用量和计时仍按请求保存，可用于历史重算及未来的对话范围汇总。

[A1]: https://api-docs.deepseek.com/zh-cn/guides/responses_api/
[A2]: https://api-docs.deepseek.com/api/create-response/
[A3]: https://api-docs.deepseek.com/quick_start/pricing
[A4]: https://api-docs.deepseek.com/zh-cn/guides/responses_api/
[A5]: https://api-docs.deepseek.com/zh-cn/guides/responses_api/
[A6]: https://developers.openai.com/api/docs/guides/streaming-responses
[A8]: https://api-docs.deepseek.com/guides/kv_cache
[A9]: https://api-docs.deepseek.com/zh-cn/guides/web_tools/
