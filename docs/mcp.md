# MCP 工具接入

Tilot 支持通过本地 stdio 和远程 Streamable HTTP 服务添加工具。采用 Pi 的统一工具适配思路，协议、分页、取消和版本协商使用官方 TypeScript 客户端。工具说明直接来自服务的工具声明，不另建提示词文件。

## 全局配置

手动创建 `~/.tilot/mcp.json`，Windows 对应 `%USERPROFILE%\.tilot\mcp.json`。文件使用 UTF-8，支持 UTF-8 BOM，内容为普通 JSON，不支持注释。文件不存在时不加载任何 MCP 服务。首版不读取项目配置，也不提供管理界面。

```json
{
  "mcpServers": {
    "local-demo": {
      "command": "node",
      "args": ["C:/tools/my-mcp/server.js"],
      "env": { "API_KEY": "${LOCAL_MCP_KEY}" }
    },
    "remote-demo": {
      "url": "https://mcp.example.com/mcp",
      "headers": { "Authorization": "Bearer ${REMOTE_MCP_TOKEN}" },
      "timeoutMs": 120000
    }
  }
}
```

示例路径、网址和环境变量应换成实际服务。配置格式：

| 字段 | 说明 |
| --- | --- |
| `command`、`args` | 本地程序和参数数组；与 `url` 二选一，不将命令拼成 shell 字符串 |
| `env` | 本地服务的环境变量，叠加在 SDK 的默认环境（含 PATH）上 |
| `url`、`headers` | 远程 HTTP(S) MCP 端点及静态请求头 |
| `timeoutMs` | 单次调用的超时毫秒数，默认 120000；不包含审批等待 |
| `enabled` | 可选；设为 false 后，下一轮不再加载此服务 |

`command`、`args`、`env`、`url`、`headers` 中的字符串支持 `${环境变量名}`。变量从应用进程环境读取，未设置时该服务配置报错；修改系统环境后通常需要重新启动应用。连接和协议错误会隐藏配置中的环境变量值与 Header 凭据。密钥也可以直接填写，但环境变量方便避免将密钥写进配置文件。

本地服务的工作目录固定为用户主目录，不提供 `cwd` 字段。加入全局配置即授权启动该程序；服务应自行遵守 MCP 的标准输入输出协议，日志写到 stderr。需要交互输入的启动命令不受支持。每轮开始重新读取配置和工具列表，当前轮次保持原声明与连接；服务发来的工具列表变更也在下一轮体现。

## 权限与运行

| 对话权限 | MCP 行为 |
| --- | --- |
| 只读 | 不读取 MCP 配置、不启动服务，不发送 MCP 工具声明；执行入口也拒绝 MCP 调用 |
| 项目内修改 | 所有 MCP 调用在输入框上方逐条审批，允许只对当前调用有效 |
| 完全访问 | 直接执行 MCP 调用 |

不依赖服务自报的 readOnlyHint 放行操作，也不把远程写操作当作项目内文件写入。审批仍不设超时，拒绝或停止后不执行该调用。工具卡片显示原始输入、实际输出、状态和执行耗时；审批等待不计入执行耗时。

相同配置复用连接，多个对话可共用。配置改变后，新轮次使用新连接，旧轮次继续原连接，最后一个使用者结束后关闭旧连接。停止只取消当前等待或调用，关闭应用时关闭连接和本地进程。连接与工具发现各有 30 秒请求超时；协议探测使用 SDK 协商，不兼容旧的独立 HTTP+SSE 传输。

单个服务配置或连接失败会在当前界面提示，并作为诊断数据告知模型；内置工具和其他正常服务继续可用。诊断提示在当前应用会话保留，重启后不作为轮次历史加载。失败、超时或断线的调用不自动重试，下一步由模型决定；连接已关闭时，下一轮重新建立连接。远程端点明确返回 HTTP 404 时关闭失效会话，下一轮重新初始化；该会话中尚未完成的请求返回连接错误，不自动重跑。没有 tools 能力的服务直接跳过，不调用资源或提示词接口。

## 返回内容

支持文本和结构化 JSON；服务同时返回相同 JSON 文本与 structuredContent 时不重复展示。图片支持 PNG、JPEG、WebP：直接图片、内嵌二进制图片资源，以及工具结果明确提供的图片资源链接，保存原图并按 Responses 标准送给模型。某张取图失败保留实际工具结果和其他内容，不重跑原工具。音频等其他内容仍明确提示暂不支持。不开放通用资源浏览与提示词模板，也不实现 OAuth 登录；详见 [图片输入与恢复](images.md)。

正文最多预览 50 KiB，UTF-8 字符不拆开。长输出保存到现有宿主缓存，结果包含 outputId 和 nextByteOffset，可通过 `read({outputId, byteOffset: nextByteOffset})` 继续读取，直到 nextByteOffset 为 null。也可通过 offset/limit 按行读取。输出按对话隔离，沿用缓存的单条 10 MiB、总计 256 MiB、保留 7 天规则；artifactTruncated 表示缓存本身不完整。网页缓存仍只能由 web_fetch 读取。

MCP 的 isError 会映射为工具失败并保留正文和续读信息；协议或连接错误也作为配对的工具结果保存，不重新执行有副作用的操作。缓存保存失败保留预览、远端执行状态和 logError，不因此重跑调用。内部工具名加 mcp__服务名__工具名 前缀，有歧义的分隔符、特殊字符或超长名称使用稳定摘要，避免名称冲突或模型名称限制导致 API 报错。

## 实现与验证

- `packages/tool/src/mcp-config.ts`：全局配置、变量展开及逐服务校验。
- `packages/tool/src/mcp.ts`：连接复用、每轮快照、模型工具适配和输出处理。
- `packages/agent-core/src/run-turn.ts`、`packages/server/src/turn-manager.ts`：轮次注入、取消、通知与退出清理。
- `packages/tool/tests/mcp.test.ts`：真实 stdio 子进程和本地 HTTP 服务，覆盖权限、配置变更、取消、超时、失败及长输出续读。

参考：[Pi MCP](https://github.com/earendil-works/pi/blob/main/packages/mcp/README.md)、[官方 TypeScript 客户端](https://ts.sdk.modelcontextprotocol.io/v2/clients/connect)。没有调用付费模型或实际第三方 MCP 服务，也未启动桌面预览。
