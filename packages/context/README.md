# Context 与提示词

Context 构建模型请求的指令和历史输入，校验工具调用与结果配对，并加载项目根目录指令和技能索引。

内置提示词正文以 UTF-8 Markdown 存放在 `prompts/`，直接修改对应文件即可：

| 文件 | 用途 |
| --- | --- |
| `system.md` | 正式系统策略，包含协作、工具、技能与恢复约束 |
| `project-instructions.md` | 项目根目录 AGENTS.md 的包装说明 |
| `skills.md` | 项目技能元数据的包装说明 |
| `resume.md` | 点击“继续任务”时使用的用户输入 |
| `unknown-tool-result.md` | 回放中断历史时，未保存工具结果的未知状态说明 |
| `cancelled-turn.md` | 用户主动取消的轮次结束说明 |
| `failed-turn.md` | 请求或执行失败的轮次结束说明 |
| `interrupted-turn.md` | 执行进程异常退出的轮次结束说明 |

文件内容整体作为提示词使用，不加入仅供维护人员阅读的备注。`src/prompts.ts` 只负责读取，不保存另一份正文，不缓存，不依赖工作目录。文件缺失、不是有效 UTF-8 或内容为空时明确报错，不使用旧文本兜底。

Core 在每轮开始时通过 Context 读取 `system.md`，轮内所有模型请求使用同一份系统策略；修改后下一轮生效，无需重启应用。Context 构建上下文时按需读取项目、技能或未知结果说明。`resume.md` 在点击继续时读取；已经保存到历史中的恢复输入和工具结果不随文件编辑改写。Core 调用方仍可显式传入 `instructions`，包括空字符串，供测试或其他宿主使用。

DeepSeek 按输入前缀复用缓存，读取文件本身不影响缓存。修改靠前的系统策略可能影响其后历史的缓存复用；轮内固定避免中途切换指令，下一轮使用新内容时仍可能重新建立缓存，不能保证缓存命中率不变。规则见 [DeepSeek 缓存文档](https://api-docs.deepseek.com/zh-cn/guides/kv_cache/)。项目 AGENTS.md 和技能索引仍按原有规则每次请求重新加载，修改它们也可能改变请求前缀。

项目自行维护的 AGENTS.md、`.tilot/skills/*/SKILL.md` 仍放在项目里；技能正文由模型按需读取。工具及参数描述直接放在工具声明中，不加入本目录。

## 取消与恢复

回放以输出项的完整性为准。Core 只在通过流式校验并收到完整的 `response.output_item.done` 时保存输出位置和原文；`incomplete` 项、单独的文本或参数 done、仅有增量的片段不作正式历史。请求仍保存实际的 cancelled、failed、incomplete 或 interrupted 状态，原始响应留作诊断，不能拼成一份假 completed 响应。

数据库版本 12 为未成功请求增加 `completedOutputsJson`，逐项保存确认内容；成功请求直接复用原始响应，避免重复存储正文。旧版成功响应继续回放；旧版失败或取消诊断中缺乏完整确认的内容不自动回填。服务和桌面同样只展示已确认项为正式历史，未完成预览仅在当前应用会话保留。

完整工具项先保存调用意图，只有请求成功终态后才能执行。请求取消、失败或在生成期间异常退出时，为未执行的完整调用保存 not_executed 配对结果。已执行工具继续保存实际结果、取消信息与 Shell 输出，不自动重跑。进程在工具执行期间退出时，旧结果仍可为空；Context 为中断轮次补充 unknown 配对说明，startAttempt 允许新轮次继续，之后仍可补录核实的实际结果。

按每次请求的输入边界回放完整消息组及工具结果，之后保留尚未消费的补充输入。在该轮历史末尾、下一轮用户输入之前加入一次 developer 结束说明，区分主动取消、请求失败与进程退出，提醒先核实可能已有的副作用。Context 重建不会向数据库重复写入说明。

事件语义参考 [OpenAI Responses 流式事件](https://developers.openai.com/api/reference/resources/responses/streaming-events) 与当前安装 SDK：项 done 是生命周期边界，还须验证项状态和字段；正文必须 completed，推理和函数调用兼容 SDK 中可省略的 status，但明确 in_progress/incomplete 的项不得回放。

目前桌面开发版直接运行 TypeScript 源码；将来打包 Node 服务时，需要随 Context 分发 `prompts/*.md` 并保留其与读取模块的相对目录结构，不能只复制 JavaScript。
