# Tilot 技术设计文档

**目标：桌面端本地 Agent，基于 Tauri + React + TypeScript + Node.js sidecar，仅接入 Responses API**

## 项目目标

整体设计遵循几个原则：

1. UI 不直接运行 Agent Loop。
2. UI 不直接调用模型 API。
3. Agent Core 是 Agent 执行流程的唯一调度中心。
4. Context 负责“模型这一轮看到什么”。
5. Tool 负责“模型可以做什么”，MCP 也属于 Tool。
6. Store 负责“应用长期保存什么”。
7. 仅支持 Responses API，不设计通用多协议 Provider 抽象。
8. UI 与 Server 通过 RPC 通信，并通过事件实现流式输出。

---

# 总体架构

```mermaid
flowchart LR
    UI[Tauri + React Desktop UI]
    SERVER[RPC Server]
    CORE[Agent Core]

    CONTEXT[Context]
    TOOL[Tool]
    STORE[Store]
    RESP[Responses Client]

    SDK[OpenAI SDK]
    API[Responses API]
    LLM[LLM]

    UI <--> SERVER
    SERVER <--> CORE

    CORE --> CONTEXT
    CORE --> TOOL
    CORE --> STORE
    CORE --> RESP

    CONTEXT --> STORE

    TOOL --> STORE

    RESP --> SDK
    SDK --> API
    API --> LLM
```

系统主要分成六个核心模块：

```text
Server
Agent Core
Context
Tool
Store
Responses
```

其中 Agent Core 是 Agent 执行流程的调度中心。各模块分别位于 `packages/` 下，Server 同时提供 Node.js 服务的启动入口；不设独立的 runtime 包。

---

# Server

Server 是 UI 与 Agent Core 之间的边界。

它负责 RPC 通信，并在服务入口组装模块、管理启动和关闭；Agent 业务逻辑由 Agent Core 调度。

已确认使用子进程标准输入/输出传输 UTF-8 JSON Lines，每行一条请求、响应或事件。标准输出只用于协议，标准错误用于进程错误；Tauri 负责服务进程的启动和关闭。当前已实现任务、配置、凭据、对话启动与取消，以及正文和推理事件推送；桌面连接后续接入。

turn.start 取得轮次标识即返回，运行过程由 Server 的 TurnManager 管理取消信号和异步任务。Core 仍负责模型执行及状态保存。连接关闭时先取消并等待活动轮次，再关闭 Store；事件按连接内 seq 排序，完成文本替换预览，失败不会伪造成功消息。

历史展示通过 turn.list/read/inputs/attempts 查询。Server 把 Store 的已保存响应投影为界面消息，与实时完成事件共用转换函数；Protocol 只定义展示结构，不依赖 SDK。失败请求返回状态和错误，不回传诊断片段。用户输入与请求分别分页，以 inputThroughId 表达已消费的输入边界；模型上下文仍由 Context 构造，不能使用界面投影代替原始回放历史。

例如 UI 调用：

```ts
client.turn.start({
  threadId,
  input: "帮我分析这个项目",
});
```

经过 RPC 后，Server 最终调用：

```ts
agentCore.runTurn({
  threadId,
  input,
});
```


Server 主要负责三类事情。

### Request

例如：

```text
thread.create
thread.list
thread.read

turn.start
turn.steer
turn.interrupt

config.get
config.set

model.list

mcp.list
mcp.connect
```

### Response

RPC 请求对应的结果：

```json
{
  "id": "req_123",
  "success": true,
  "result": {}
}
```

### Event

Server 主动推送给 UI：

```text
turn.started

message.started
message.delta
message.completed

tool.started
tool.updated
tool.completed

context.compacted

turn.completed

error
```

因此 UI 与 Server 的通信模型是：

```text
Request / Response
+
Server Push Event
```

---

# Agent Core

Agent Core 是 Tilot 的核心调度模块。

它负责：

```text
开始 Turn
调用 Context
调用 Responses API
处理模型输出
判断 Tool Call
执行 Tool
保存执行结果
再次调用模型
结束 Turn
处理取消
产生运行事件
```

Agent Core 不负责：

```text
SQL
MCP 协议细节
Skill 文件解析细节
Responses API SDK 细节
UI
RPC 序列化
```


Agent Core 知道的是：

> 什么时候需要 Context。

但它不应该知道：

> Context 内部具体应该加载哪些消息、Skill、摘要。

---

# Context

Context 负责解决一个核心问题：

> **下一次 Responses API 请求应该给模型什么内容？**

Store 保存的是完整数据，而 Context 从完整数据中选择、转换和组织模型真正需要看到的内容。

---

# Skill

Skill 规范参考OpenAI官方的相关文档


# Tool

Tool 管理所有“Agent 能做什么”的能力。

所有与工具有关的内容都归入：

```text
tool/
```

包括：

```text
Built-in Tool
MCP Tool
Tool Registry
Tool Executor
Permission
Tool Result
```

可以逐渐演进成：

```text
tool/
├── builtin/
│   ├── read-file/
│   ├── write-file/
│   ├── shell/
│   └── apply-patch/
│
├── mcp/
│   ├── client/
│   ├── connection/
│   └── config/
│
├── registry/
├── executor/
├── permission/
└── types/
```

不过这些都是 Tool 内部实现细节，对 Agent Core 只暴露统一接口。

# MCP

MCP 完全属于 Tool。

MCP 负责：

```text
连接 MCP Server
初始化 MCP Session
tools/list
tools/call
resources/list
resources/read
认证
超时
连接生命周期
```

但是 MCP Tool 最终必须转成 Tilot 的统一 Tool 定义。

例如：

```text
Tool Registry
├── read_file
├── shell
├── apply_patch
├── github.search
└── database.query
```

模型无需知道：

```text
read_file 是 Tilot 内置 Tool

github.search 是 MCP Tool
```

执行时再由 Tool 层路由：

```text
Agent Core
    ↓
Tool.execute()
    ↓
Tool Registry
   /        \
Builtin     MCP
  ↓          ↓
Executor   MCP Client
              ↓
          MCP Server
```

---

# Store

Store 是 Tilot 的统一持久化边界。

定义：

> **Store 负责所有进程退出后仍然需要存在的数据。**

例如：

```text
对话
Thread
Turn
Message
Tool Call
Tool Result
Compaction
配置
Workspace
API Key
OAuth Token
```

Store 不负责：

```text
Agent 调度
Context 构造
Tool 执行
模型请求
RPC
```

---

# Responses 模块

Tilot 明确只支持 Responses API，因此不设计：

```text
Provider
├── OpenAI
├── Anthropic
├── Gemini
└── ...
```

这种通用 Provider 系统。

所有类型，与Responses API 强耦合，能用的直接复用

使用流式输出

---

# Config

配置统一归入 Store。

普通配置和历史使用 SQLite。API Key 按开发者选择，单独以明文 JSON 存放在应用数据目录的 credentials.json；保存一组服务地址和密钥，读取时匹配地址，不随普通配置接口返回密钥。这里不使用系统凭据管理器。


# 模块依赖原则

建议长期保持以下依赖方向：

```text
UI
 ↓
Server
 ↓
Agent Core
 ├── Context
 │      ↓
 │     Store
 │
 ├── Tool
 │      ↓
 │     Store
 │
 ├── Store
 │
 └── Responses
        ↓
      OpenAI SDK
```
