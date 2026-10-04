# DeepSeek 真实联调记录

验证日期：2026-10-02。完整结果为 passed；逐轮计时和服务端用量见 [原始结果](deepseek-live-results.json)。

## 连接与验证方式

使用 Tilot 已保存的官方服务 `https://api.deepseek.com/`，所选和实际返回模型均为 `deepseek-flash`。`GET /models` 返回 `deepseek-flash` 与 `deepseek-v4-pro`；本批没有调用后者生成回答。

环境为 Windows、Node.js 24.14.0。脚本启动正式 `packages/server/src/main.ts` 子进程，通过桌面同样使用的 UTF-8 JSON Lines 协议发起请求，实际经过 Server、Agent Core、Context、Responses、Store 和 Tool，没有替换模型响应或工具实现。

用户数据库只读查询连接配置；执行使用独立临时项目和数据库。密钥临时复制到测试数据库旁的凭据文件，结束后连同项目、数据库和输出缓存清理。用户原有项目、对话、配置和密钥不修改，结果不包含密钥或完整推理文本。

当时测试使用推理强度 high，隔离配置的输出上限为 4,096 token、每轮最多 12 次模型请求，不自动重试。2026-10-03 已按开发者要求取消每轮请求次数上限，当前复跑脚本也不再设置此项；原始结果保留当时配置。输出截断和其后继续两个场景改为 none，其中截断场景将输出上限临时设为 16 token，结束后恢复。网页访问使用现有宿主代理环境。

2026-10-03 项目技能目录统一改为 `.tilot/skills`，当前脚本在此目录创建并验证技能；下述真实模型结果仍为 2026-10-02 的原始记录，本次目录调整没有重新调用付费模型。

2026-10-04 已取消应用的输入与输出 Token 限制。当前复跑脚本不再设置 4,096 输出上限，也不再人为触发 16 Token 截断；最后两个旧场景改为一个使用服务默认上限的 none 模式场景。下表和原始结果保留之前的真实验证，新行为以本地回归测试验证，本次未新增付费模型请求。

本次重新核对 [DeepSeek Responses 官方说明](https://api-docs.deepseek.com/zh-cn/guides/responses_api/) 和 [接口参数](https://api-docs.deepseek.com/api/create-response/)；继续使用无状态 Responses API，每次从本地完整历史构建 input。

## 验证结果

| 场景 | 实际验证与结果 | 最终一次运行耗时 |
| --- | --- | --- |
| 普通对话网页读取 | 模型调用 web_fetch 抓取 Example Domain，随后按 outputId/nextOffset 续读；标题、缓存标识和抓取时间一致 | 5.77 秒 |
| 项目工具与技能 | 调用 ls、find、grep、read、edit、shell、write；按需读取 SKILL.md，修复加法函数，原始测试独立再运行通过，创建中文 CHANGELOG.md | 9.15 秒 |
| 重启后历史与命令日志 | 关闭并重新启动正式 Server；保存回答一致，模型从历史取得 shell outputId，再用 read 读取原日志，未重新执行命令 | 3.29 秒 |
| 重启后网页缓存 | 重新启动后只按 outputId 读取，未传 url，仍保留原抓取时间 | 3.13 秒 |
| 真实流式取消 | 首个真实增量后请求停止；Attempt 和 Turn 均为 cancelled，没有成功历史消息 | 取消请求至终态约 12 毫秒 |
| 进程中断恢复 | 真实 write 的结果保存后强制结束服务；重启标记旧轮次 interrupted，turn.resume 创建新轮次，模型先 read 核实再回答；文件内容和修改时间不变，没有再次 write/edit | 恢复轮次 6.31 秒 |
| 真实输出截断 | 服务返回 incomplete/max_output_tokens；Attempt 保存为 incomplete，Turn 标为 failed，诊断不展示为成功消息或登记工具 | 0.50 秒 |
| 截断后继续 | 恢复输出上限后开启下一轮，none 模式完成回答，没有推理增量 | 0.79 秒 |

项目根 AGENTS.md 要求的中文和 emoji 标记，以及技能正文中的独立标记，均出现在模型最终回答中。shell 的 UTF-8 中文成功标记、退出码、实时进度和可重读日志都已核对。

最后重新打开测试数据库，核对服务返回的模型、原始 reasoning 正文与先前历史投影一致，以及已保存工具结果的 call_id 配对。服务并不保证每个 high 请求都有推理正文；只验证它实际返回的正文，允许直接输出工具调用。

完整通过的最后一次执行保存了 20 次模型请求：已返回用量累计输入 65,797 token，其中缓存命中 61,312；输出 4,467 token。取消请求没有返回 usage，单独计为未知，不能按零收费处理。上述统计只包括最后一次完整运行，不包括此前连接预检和调整联调脚本的请求，也不是账单总额。

本地 `npm test` 和 `npm run typecheck` 全部通过。本次只增加手动联调入口和记录，现有正式模型、工具与执行循环代码没有修改。

## 如何复跑

先在 Tilot 中配置官方 DeepSeek 服务并保存密钥，选择其模型作为默认模型；需要 Windows、Node.js 24.5+（24.x）和开发环境中的 rg。按当前结果复跑时将默认推理强度设为 high。

```sh
npm run test:deepseek
```

入口是 [scripts/deepseek-smoke.mjs](../scripts/deepseek-smoke.mjs)。它读取当前默认官方服务和模型，执行网页、项目工具、历史缓存、取消、中断恢复和 none 模式场景，按行打印脱敏结果，最终打印 passed/failed。真实请求按 DeepSeek 服务计费；它不包含在 `npm test` 中，也不自动在 CI 中执行。

模型选择工具和请求次数会变化，计时与 token 用量每次可能不同。脚本保留每步工具的实际结果，用真实文件内容、独立测试、数据库状态和缓存标识判断成功，不依赖某一段固定回答或唯一工具顺序。

## 验证边界

本批完成正式 Node 服务链路的真实模型联调。原生 Tauri 窗口中的项目选择、发送、停止及重启展示，以及 Windows 安装包，仍需后续验收。本次没有测试第三方服务、deepseek-v4-pro、长会话接近上下文上限、账户限流或余额不足。

本次强制退出时 write 结果已经保存，没有留下未决工具结果；“工具已执行但结果尚未保存”的恢复仍由已有本地故障测试覆盖，不能把这次联调当成该边界的真实模型验证。web_search 继续按开发者要求暂缓。
