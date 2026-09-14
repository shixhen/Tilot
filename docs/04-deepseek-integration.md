# DeepSeek 接入规范

适用版本：v0.1 · API 文档核查日期：2026-09-14

## 1. 协议与配置

采用 DeepSeek 官方 Chat Completions。TypeScript Provider 通过注入的 HttpTransport 请求模型，Tauri 适配器使用 @tauri-apps/plugin-http；eventsource-parser 解析 SSE。Provider 不直接依赖浏览器 fetch、Node fetch 或 Tauri API。[API 入门][A1]、[HTTP 插件][A10]

截至核查日，默认模型为 `deepseek-flash`，可选 `deepseek-v4-pro`。官方将 `deepseek-v4-flash` 视为兼容旧名称，其请求转由新 Flash 模型服务，因此不将它替换为首选 ID。[模型说明][A3]

模型 ID、能力和核查日期保存在版本化配置中，Provider 不按模型名称写死行为。保留用户选择，更新配置不自动改换模型；每次请求记录请求 ID 和实际返回的 model。首版 endpoint 限于 DeepSeek 官方地址，与 Tauri HTTP 权限一致，模型输出不能更改。

```json
{
  "schemaVersion": 1,
  "provider": "deepseek",
  "baseURL": "https://api.deepseek.com",
  "api": "chat-completions",
  "model": "deepseek-flash",
  "thinking": { "type": "enabled" },
  "reasoningEffort": "high",
  "contextBudgetTokens": 65536,
  "maxOutputTokens": 16384,
  "reserveTokens": 4096,
  "maxStepsPerRun": 30,
  "maxAutomaticRetries": 2
}
```

以上为应用配置。Provider 将 reasoningEffort、maxOutputTokens 映射为 `reasoning_effort`、`max_tokens`，并加入 messages、tools 和 stream；密钥独立传入。

“快速”关闭推理，“标准”使用 high；高级选项提供 low/max。每次请求显式发送设置。推理模式不发送采样调参，tool_choice 使用 auto。strict 为 Beta，v0.1 默认关闭；本地始终校验工具参数。[推理参数][A2]、[工具约束][A4]、[请求字段][A5]

## 2. Provider 契约

| 对象 | 必要内容 |
| --- | --- |
| ModelRequest | 模型配置、冻结消息、工具 schema、输出预算 |
| Capabilities | tools、reasoning、strictTools、contextWindowTokens、reasoningReplay |
| AssistantMessage | id、content、toolCalls、providerMetadata |
| ToolCall | 原调用 ID、name、argumentsJson |
| providerMetadata | reasoningContent、responseModel、requestId |
| ProviderEvent | text_delta、reasoning_delta、tool_delta、completed 或 failed |

调用入口为 `stream(request, cancellation): AsyncIterable<ProviderEvent>`。cancellation 使用核心接口，由适配器转换为 AbortSignal。工具增量包含 index 及可选 id、name、args；完成事件包含规范消息、finishReason 和可空 usage。

Provider 不执行工具。规范消息保存模型所需字段，界面预览由独立投影生成。请求与响应均做运行时校验。

## 3. 消息回放

请求带 `tools` 时，保留上下文中所有历史 assistant 的 `reasoning_content`，包括未实际调用工具的轮次；无 tools 的请求不要求回传该字段。[Thinking Mode][A2]

实现规则：

1. 保存实际返回的 reasoning，区分字段缺失和空值。
2. 新用户轮次、切换推理模式及界面折叠均不删除回放字段。
3. 工具批次保持 assistant → 各 tool result 的完整配对，结果按声明顺序和原调用 ID 保存。
4. 已提交调用的拒绝、错误与取消产生结构化结果；半截流式调用不进入规范历史。
5. 旧历史缺少必要字段时，通过摘要建立新请求序列；不伪造推理或调用记录。

Chat Completions 不支持任意插入模型未生成的工具调用。运行时摘要与上下文补充使用独立消息，不包装为虚构 tool call。[Tool Calls][A4]

## 4. 流式处理

HttpTransport 返回状态、响应头和 AsyncIterable<Uint8Array>。Tauri 适配器读取 response.body，不先调用 text/json 等待全量结果；RuntimeServices 提供流式 UTF-8 解码器，eventsource-parser 识别 SSE 帧，聚合器按 choice index、tool index 累积内容。跨字节分片不得分别解码，v0.1 仅请求一个 choice。[SSE 解析器][A9]

结束、失败或取消均释放响应体 reader。插件错误统一转换为 Provider 错误，不假设取消一定表现为浏览器 DOMException。当前插件实现支持响应流和取消，但实际行为须在锁定版本的 Windows WebView2 中验收。[HTTP 实现][A11]

- 正文、reasoning、工具参数分别聚合，同一帧的各字段独立处理。
- ID 和名称可仅出现在早期帧；参数完整后才解析 JSON 并校验 schema。
- 心跳、空内容与 usage 帧不产生正文。
- 完成标志、结束原因和消息结构全部合法后，提交 assistant 与工具意图。
- 断流或重试使用独立 attemptId，重置预览，不拼接旧 Attempt。
- usage 缺失标记未知。

| finish_reason | 行为 |
| --- | --- |
| stop | 无工具时提交回答并检查交付 |
| tool_calls | 完整调用提交后交执行器 |
| length | 标记截断，不执行本次工具；可调整预算后有限重试 |
| content_filter | 停止并报告 |
| insufficient_system_resource | 按 Provider 策略有限重试 |
| aborted、未知值、结构不一致 | 记录中断或协议错误，不派发工具 |

字段及结束原因见 [Chat Completions][A5]。连接关闭本身不构成成功条件。

## 5. 超时与重试

| 超时 | 初始值 |
| --- | --- |
| 连接或响应头等待 | 30 秒 |
| 已连接但无有效模型输出 | 180 秒 |
| 单请求总时长 | 600 秒 |

服务可能发送 keep-alive；心跳不延长应用的无输出上限。[连接行为][A6] 计时器按实际传输阶段实现，取消优先于重试。

Provider 是唯一重试入口，传输层不叠加重试策略。最多两次自动重试，使用抖动退避、合理的 Retry-After，并服从 Run 预算。

| 错误 | 策略 |
| --- | --- |
| 400/422 | 修复参数或协议后再请求 |
| 401/402 | 提示凭据或余额问题 |
| 429、可恢复 5xx | 有限重试 |
| 连接失败、断流 | 仅重试未提交的模型 Attempt |
| 用户取消 | 停止，不重试 |
| 文件操作结果未知 | 转工具恢复流程 |

错误类别参考 [Error Codes][A7]。每次重试复用冻结上下文并创建新 attemptId；已成功工具不重复执行。断流请求的服务费用可能未知。WebView 重载或崩溃不等于服务端请求已取消；丢失取消句柄时，不把请求标记为未计费，原生 HTTP 资源释放在 M0 验证。

## 6. 上下文管理

### 预算

`B = min(服务上下文上限, 应用预算)`，发送前满足：

```text
估算输入 token + 最大输出 token + 安全余量 <= B
```

输入包含系统提示、工具 schema、正文、工具结果及需回放的 reasoning。默认配置的输入预算为 45,056 token。

无可靠 tokenizer 时采用保守估算并用真实 usage 校准。超长请求触发一次受控压缩；模型不能自行提高预算。

### 压缩

先限制工具输出、保存大结果引用，再摘要旧历史。压缩仅在工具批次结束后进行，以完整消息组为边界。

摘要保存目标、约束、已完成修改、待办、文件路径与版本、行号、错误及未知项。权限仍以独立项目授权和修改确认记录为准。

保存原始历史与覆盖/保留边界，建立新的请求序列。保留的 assistant 继续携带必要 reasoning；已整体摘要的旧消息不再回放。最新消息组仍超限时，改用分页或缩小输入范围。

摘要采用独立无工具请求，usage 计入 Run。失败保留原历史，最多一次自动修复；继续失败则暂停。

## 7. 缓存与费用

固定系统提示和工具 schema 排序，按需追加任务上下文。服务端前缀缓存不承担本地历史存储。[Context Caching][A8]

```text
费用 = (缓存命中输入 × 命中价
      + 未命中输入 × 未命中价
      + 输出 × 输出价) / 1,000,000
```

使用有日期的价格配置，预算按高峰价保守估算。prompt_tokens 若含缓存量，应拆分后计费；输出按 completion tokens 计，不重复累加 reasoning 子项。

每次请求前估计下一步成本。无 usage 或断流费用单列未知，因此 Run 费用限制属于应用软预算。

## 8. 契约测试

| 编号 | 场景 | 断言 |
| --- | --- | --- |
| DS-01 | 中文文本跨 UTF-8 字节分片 | 编码、完成状态、usage 正确 |
| DS-02 | 多工具参数交错分片 | 调用独立，各执行一次，结果顺序正确 |
| DS-03/04 | 跨用户轮次及无工具调用轮次 | reasoning 字段完整回放 |
| DS-05/06 | 半截或非法参数、未知工具 | 不派发无效动作，错误结构明确 |
| DS-07/08 | 截断、异常结束、心跳、空帧 | 不误判完成，不无限等待 |
| DS-09/10 | 限流、鉴权失败、响应头前/响应流中取消 | 分类正确，释放连接，遵守重试上限 |
| DS-11 | 压缩后继续 | 消息配对、文件版本和待办保留 |
| DS-12 | 工具成功后模型断流 | 仅重试模型 |

测试包含核心固定响应回放、Tauri HTTP 真实传输及 DeepSeek 服务契约。后两者不能仅用浏览器 mock 替代；真实 API 测试单独启用，记录模型配置、插件版本、WebView2 版本和日期。

[A1]: https://api-docs.deepseek.com/
[A2]: https://api-docs.deepseek.com/guides/thinking_mode/
[A3]: https://api-docs.deepseek.com/quick_start/pricing/
[A4]: https://api-docs.deepseek.com/guides/tool_calls/
[A5]: https://api-docs.deepseek.com/api/create-chat-completion/
[A6]: https://api-docs.deepseek.com/quick_start/rate_limit/
[A7]: https://api-docs.deepseek.com/quick_start/error_codes/
[A8]: https://api-docs.deepseek.com/guides/kv_cache/

[A9]: https://github.com/rexxars/eventsource-parser

[A10]: https://v2.tauri.app/plugin/http-client/
[A11]: https://github.com/tauri-apps/plugins-workspace/blob/v2/plugins/http/guest-js/index.ts
