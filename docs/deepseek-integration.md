# DeepSeek Responses 接入规范

API 核查日期：2026-09-18

## 1. 协议与配置

Responses 模块位于 `packages/responses`，使用 OpenAI SDK 的 `client.responses.create()`。客户端接收 `apiKey` 和可选的 `baseURL`，默认地址为 `https://api.deepseek.com`，用户可配置兼容 Responses API 的服务地址。不设计通用 Provider 或 HttpTransport，不自行实现 HTTP、UTF-8 解码与 SSE 解析；这些由 SDK 处理。SDK 流式调用方式见 [OpenAI 官方说明][A6]。

应用配置示例：
```json
{
  "baseURL": "https://api.deepseek.com",
  "model": "deepseek-flash",
  "reasoningEffort": "high",
  "contextBudgetTokens": 65536,
  "maxOutputTokens": 16384,
  "reserveTokens": 4096,
  "maxStepsPerRun": 30,
  "maxAutomaticRetries": 2
}
```

普通配置保存在 SQLite 的 app_config 表中，数据库结构版本由 `PRAGMA user_version` 管理。首版协议固定为 Responses，不重复保存 provider/api 标记；凭据不包含在此配置中。

| 应用数据 | 请求字段 |
| --- | --- |
| model | model |
| 系统策略 | instructions，每次请求都发送 |
| 本次所需历史 | input，按顺序排列消息、推理、调用及结果 |
| reasoningEffort | reasoning.effort |
| maxOutputTokens | max_output_tokens |
| 工具声明 | tools 中的平铺 function 对象 |
| 流式开关 | stream: true |

“快速”对应 effort=none，“标准”对应 high；高级设置提供 low/max。输出预算包含推理与正文。模型 ID、能力和核查日期使用版本化配置，记录实际响应 model，不自动改换用户选择。[推理参数][A2]、[模型说明][A3]

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

parallel_tool_calls 和 max_tool_calls 被服务忽略，调用数量及串行策略由 Agent Core 控制，通过 Tool 执行。instructions 用于系统策略；该实现将 developer 角色作为 user 处理，不能靠它承载更高优先级指令。[兼容表][A4]

首版只声明五个 function 工具，不使用 custom apply_patch 或服务端内置工具。对未支持的参数主动拒绝或省略，不以“服务端未报错”判断功能生效。

## 3. 输出项与工具回放

### 保存与投影

保存完整 response.output、原始顺序、推理正文、arguments 字符串和两个不同的 ID：

- itemId 是输出项的 id，用于匹配流式事件。
- call_id 连接 function_call 与 function_call_output，用于模型工具回放。

不得将所有输出项压成一条 assistant 文本，也不能把 itemId 当作 call_id。UI 仅从保存记录生成展示投影。

发起下一步请求时，Context 将已提交输出组织为 input，保留消息、reasoning.content、调用及结果的顺序。参考 demo 使用 SDK 的 `toResponseInputItems`，接入时核对选用 SDK 版本的导出及字段保留行为。demo 中过滤 reasoning 仅用于测试，正式实现直接保留 reasoning 项及其正文。输出专用状态字段不用于控制权限。原始输出保留用于诊断，投影不能覆盖原记录。

### 工具声明与结果

Responses 的 function 字段位于工具对象顶层。以下仅示意读取工具：

```json
{
  "type": "function",
  "name": "read_file",
  "description": "读取授权项目中的代码文件",
  "parameters": {
    "type": "object",
    "properties": {
      "projectId": { "type": "string" },
      "path": { "type": "string" }
    },
    "required": ["projectId", "path"],
    "additionalProperties": false
  }
}
```

Tool 校验完整参数、授权和文件版本，执行后的结果按原 call_id 回传：

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
4. 新请求先校验配对、ID 和类型。缺失必要历史时建立有明确摘要的新上下文，不伪造推理或执行记录。
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
| response.failed | 按错误类别结束或有限重试，不执行本次工具 |

表中省略前缀的事件均以 `response.` 开头。该流以终态事件结束，没有 `data: [DONE]`。连接关闭、item.done 或参数 done 均不能代替最终成功事件。[事件定义][A4]

聚合规则：

- sequence_number 在每个 Attempt 内递增，可有间隔；不充当任务事件 seq。重复号仅在内容完全相同时去重，冲突或倒序视为协议错误。
- 正文、推理和工具参数独立累积；多个工具交错时按 itemId/output_index 区分。
- done 与最终 output 是完整值，核对或替换对应缓冲，不能再次追加造成重复。
- 只有最终状态 completed、输出结构完整且调用 ID 合法，才提交完整响应和工具意图；随后校验工具参数。参数失败产生结构化错误结果，不派发实际操作。
- completed 仍可能携带 function_call。此时进入工具执行和下一次模型请求，不结束 Run。
- incomplete、failed、断流及本地取消的部分 output 只保存为 Attempt 诊断，不进入可执行历史。
- usage 缺失标为未知。未知且影响执行的输出类型按协议错误处理，不静默丢弃后继续。

每次重试建立新 attemptId、清空临时缓冲，复用冻结请求；不把新流接在旧流尾部。SDK 设置 `maxRetries: 0`，重试由应用统一管理，避免两层重试叠加。结束、失败和取消时结束事件消费；主动中断时取消 SDK 请求，由 SDK 释放底层连接资源。

## 5. 上下文管理

发送前满足：

```text
估算输入 token + 最大输出 token + 安全余量
    <= min(模型上下文上限, 应用预算)
```

输入包括 instructions、工具 schema、消息、推理和工具结果。默认可用输入预算为 45,056 token；无可靠 tokenizer 时保守估算并用 usage 校准。

先分页和截断工具结果，再压缩旧历史。仅在工具结果组完整后压缩，保留目标、约束、文件版本、已完成修改、待办和未知项。Tool 依据独立的授权记录校验操作，不以模型上下文或摘要作为授权依据。

原始历史保留；摘要记录覆盖边界，构造新的请求序列。被保留的输出项继续携带必要推理及配对结果，已整体摘要的旧组不再回放。摘要使用独立的无工具 Responses 请求，其 usage 计入 Run；失败保留旧上下文并暂停或有限修复。

不发送 truncation 或 context_management 期待服务自动处理超限；Context 负责预算检查与压缩，Agent Core 根据结果继续或暂停执行。[兼容限制][A4]

## 6. 缓存与费用

保持系统策略及工具 schema 顺序稳定。前缀缓存由 DeepSeek 管理，不代替本地历史存储。[缓存说明][A8]

使用 Responses 的 usage 字段归一化：

- 输入总量：input_tokens。
- 缓存命中输入：input_tokens_details.cached_tokens。
- 未命中输入：输入总量减缓存命中量。
- 输出总量：output_tokens；其中 reasoning_tokens 是子项，不重复计费。

费用按有日期的模型价格配置计算。缺失 usage 不按零处理，断流费用单列未知；请求前成本估算和 Run 费用限制属于软预算。

[A1]: https://api-docs.deepseek.com/zh-cn/guides/responses_api/
[A2]: https://api-docs.deepseek.com/api/create-response/
[A3]: https://api-docs.deepseek.com/quick_start/pricing
[A4]: https://api-docs.deepseek.com/zh-cn/guides/responses_api/
[A5]: https://api-docs.deepseek.com/zh-cn/guides/responses_api/
[A6]: https://developers.openai.com/api/docs/guides/streaming-responses
[A8]: https://api-docs.deepseek.com/guides/kv_cache
