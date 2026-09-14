# DeepSeek Responses 接入规范

适用版本：v0.1 · API 核查日期：2026-09-14

## 1. 协议与配置

首版只实现 `POST https://api.deepseek.com/responses`。DeepSeekResponsesProvider 位于 Node Runtime，通过 HttpTransport 发起请求；Node fetch 处理 HTTP，eventsource-parser 处理 SSE。Core 只依赖 ModelProvider 接口。[接口定义][A1]

应用配置示例：

```json
{
  "schemaVersion": 1,
  "provider": "deepseek",
  "api": "responses",
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

不发送 Chat Completions 的 messages、thinking、reasoning_effort 或 max_tokens 字段，不实现该协议的兼容分支。网络适配与协议适配分开，Tauri Client 不请求模型 API。首版固定 DeepSeek 官方地址，关闭 HTTP 重定向并保持 TLS 校验；模型不能更改 endpoint。

## 2. Provider 契约与兼容边界

| 对象 | 内容 |
| --- | --- |
| ModelRequest | 配置快照、系统策略、规范历史、工具 schema、预算 |
| ModelTurn | turnId、文本投影、toolCalls、providerState |
| providerState | protocol、schemaVersion、responseId、按原顺序保存的完整 output |
| ToolCall | 输出项 itemId、原 call_id、name、argumentsJson |
| ProviderEvent | text_delta、reasoning_delta、tool_delta、completed、failed |
| Completion | ModelTurn、响应状态、可空 usage、返回模型及请求标识 |

入口为 `stream(request, cancellation): AsyncIterable<ProviderEvent>`。Runtime 将 Core 的 Cancellation 转为 HTTP AbortSignal。Provider 不执行工具，不依赖 Client，不把原始 API 对象作为 UI 状态。

DeepSeek 的实现无服务端会话存储，不支持 previous_response_id、conversation 或 background。每次请求从本地记录重建所需 input；responseId 仅用于追踪，不能作为服务端恢复凭据。[无状态约束][A1]

parallel_tool_calls 和 max_tool_calls 被服务忽略，调用数量及串行策略必须在 Runtime 执行。instructions 用于系统策略；该实现将 developer 角色作为 user 处理，不能靠它承载更高优先级指令。[兼容表][A4]

首版只声明五个 function 工具，不使用 custom apply_patch 或服务端内置工具。对未支持的参数主动拒绝或省略，不以“服务端未报错”判断功能生效。

## 3. 输出项与工具回放

### 保存与投影

保存完整 response.output、原始顺序、推理正文、arguments 字符串和两个不同的 ID：

- itemId 是输出项的 id，用于匹配流式事件。
- call_id 连接 function_call 与 function_call_output，用于模型工具回放。

不得将所有输出项压成一条 assistant 文本，也不能把 itemId 当作 call_id。UI 仅从保存记录生成展示投影。

发起下一步请求时，Provider 将已提交输出映射为 input 支持的字段，保留消息、reasoning.content、调用及结果的顺序。输出专用状态字段不用于控制权限。原始输出保留用于诊断，投影不能覆盖原记录。

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

Runtime 校验完整参数、授权和文件版本，执行后的结果按原 call_id 回传：

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
2. 新用户轮次、界面折叠或重连不删除 Provider 所需字段。
3. 以一个 ModelTurn 及其全部工具结果为完整消息组；禁止保留孤立调用或结果。
4. 新请求先校验配对、ID 和类型。缺失必要历史时建立有明确摘要的新上下文，不伪造推理或执行记录。
5. 协议允许补入宿主实际执行的工具记录，但首版不主动使用这一能力，不虚构模型调用。[工具历史说明][A5]

## 4. 流式处理

HttpTransport 返回响应状态、头和异步字节流。使用流式 UTF-8 解码，处理跨字节分片，再由 SSE 解析器交给 Provider 聚合。不能先调用 text/json 等待整个响应。[SSE 解析器][A6]

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
- 只有最终状态 completed、输出结构完整且调用 ID 合法，才提交 ModelTurn 和工具意图；随后校验工具参数。参数失败产生结构化错误结果，不派发实际操作。
- completed 仍可能携带 function_call。此时进入工具执行和下一次模型请求，不结束 Run。
- incomplete、failed、断流及本地取消的部分 output 只保存为 Attempt 诊断，不进入可执行历史。
- usage 缺失标为未知。未知且影响执行的输出类型按协议错误处理，不静默丢弃后继续。

每次重试建立新 attemptId、清空临时缓冲，复用冻结请求；不把新流接在旧流尾部。结束、失败和取消均释放 reader 及连接资源。

## 5. 超时、重试与恢复

| 预算 | 初始值 |
| --- | --- |
| 连接或响应头等待 | 30 秒 |
| 无有效模型输出 | 180 秒 |
| 单请求总时长 | 600 秒 |
| 自动重试 | 最多 2 次 |

心跳不延长无输出上限。Provider 为唯一重试入口，使用抖动退避与合理的 Retry-After，并服从 Run 预算。Node 传输层不叠加另一套自动重试。

| 情况 | 行为 |
| --- | --- |
| 400/422 | 修正请求或上下文后再发起 |
| 401/402 | 停止，提示密钥或余额问题 |
| 429、可恢复 5xx | 有限重试 |
| response.failed | 依据 error 分类，不能一律重试 |
| response.incomplete | 按原因处理；输出预算不足可受控调整，过滤不自动重试 |
| 断流 | 仅重试未提交模型 Attempt |
| 用户取消 | 停止，不重试 |
| 工具已成功、后续模型失败 | 复用结果，不重新执行工具 |
| 文件写入结果未知 | 按 Runtime 操作记录核对后再继续 |

错误分类参考 [服务错误][A7]。Runtime 重启后重新构造 input，不依赖服务端响应存储。Client 刷新只影响订阅，不中断 Runtime 的模型请求。取消或断流请求仍可能产生服务费用，无法确认时单列未知。

## 6. 上下文管理

发送前满足：

```text
估算输入 token + 最大输出 token + 安全余量
    <= min(模型上下文上限, 应用预算)
```

输入包括 instructions、工具 schema、消息、推理和工具结果。默认可用输入预算为 45,056 token；无可靠 tokenizer 时保守估算并用 usage 校准。

先分页和截断工具结果，再压缩旧历史。仅在工具结果组完整后压缩，保留目标、约束、文件版本、已完成修改、待办和未知项。授权始终由 Runtime 的独立记录决定。

原始历史保留；摘要记录覆盖边界，构造新的请求序列。被保留的输出项继续携带必要推理及配对结果，已整体摘要的旧组不再回放。摘要使用独立的无工具 Responses 请求，其 usage 计入 Run；失败保留旧上下文并暂停或有限修复。

不发送 truncation 或 context_management 期待服务自动处理超限；超限处理属于 Runtime 策略。[兼容限制][A4]

## 7. 缓存与费用

保持系统策略及工具 schema 顺序稳定。前缀缓存由 DeepSeek 管理，不代替本地历史存储。[缓存说明][A8]

使用 Responses 的 usage 字段归一化：

- 输入总量：input_tokens。
- 缓存命中输入：input_tokens_details.cached_tokens。
- 未命中输入：输入总量减缓存命中量。
- 输出总量：output_tokens；其中 reasoning_tokens 是子项，不重复计费。

费用按有日期的模型价格配置计算。缺失 usage 不按零处理，断流费用单列未知；请求前成本估算和 Run 费用限制属于软预算。

## 8. 契约测试

| 编号 | 场景 | 断言 |
| --- | --- | --- |
| DS-01 | UTF-8 跨字节分片、SSE 多帧 | 文本与事件解析正确 |
| DS-02 | 文本、推理、多个工具交错 | 输出项独立，done 不重复追加 |
| DS-03 | completed 包含 function_call | 执行工具并继续，Run 不提前完成 |
| DS-04 | 工具配对 | 区分 itemId/call_id，每个调用恰有一个结果 |
| DS-05 | 跨轮次及重启回放 | 完整 input、推理和工具结果保留 |
| DS-06 | 非法参数、未知工具、越权路径 | 不执行，产生明确错误结果 |
| DS-07 | incomplete、failed、无终态断流 | 部分调用不执行，无 DONE 依赖 |
| DS-08 | 重复/倒序事件、冲突终态 | 不重复提交，冲突显式失败 |
| DS-09 | 限流、鉴权及响应头前/流中取消 | 分类、重试和资源释放正确 |
| DS-10 | 请求多工具及超出工具预算 | Runtime 仍串行执行并约束数量 |
| DS-11 | 压缩后继续 | 摘要边界、推理及调用配对有效 |
| DS-12 | 工具成功后模型断流 | 只重试模型，无重复文件修改 |
| DS-13 | usage 含缓存和 reasoning 子项 | 归一化正确，不重复计数 |
| DS-14 | 持久历史缺损、Provider schema 变化 | 拒绝盲目回放，建立可核对的新上下文 |

测试分为固定事件回放、Node HTTP 集成和真实服务契约。真实 API 测试单独启用，记录模型、Node、Provider 版本和日期；文档核查不代替服务实测。

[A1]: https://api-docs.deepseek.com/api/create-response/
[A2]: https://api-docs.deepseek.com/guides/thinking_mode/
[A3]: https://api-docs.deepseek.com/quick_start/pricing/
[A4]: https://api-docs.deepseek.com/guides/responses_api/
[A5]: https://api-docs.deepseek.com/guides/tool_calls/
[A6]: https://github.com/rexxars/eventsource-parser
[A7]: https://api-docs.deepseek.com/quick_start/error_codes/
[A8]: https://api-docs.deepseek.com/guides/kv_cache/
