# 工具重写设计与实施计划

日期：2026-10-02。工具描述迁移、A1–A3、B1 和 B3a 网页读取已实现，具体结果见第 12–16 节。开发者要求先实现 fetch，B2 搜索验证和 B3b 搜索接入暂缓。

## 1. 已确认的范围

- 先重写现有 `read / write / edit / shell`，完成后再补网络搜索、网页读取和 `grep / find / ls`。
- 工具描述和参数描述直接放在对应工具声明中，不再建立独立的工具提示词文件。
- edit 只兼容 LF/CRLF，其他文本严格匹配，不对空格或 Unicode 字符做模糊匹配。
- 主要参考 Pi 的工具组织和执行细节；继续使用 Tilot 的 Responses、存储、上下文和桌面架构。
- 网络阶段先只实现 web_fetch，普通对话和项目对话都开放；搜索验证与 web_search 暂缓。

准备阶段已将四个工具及 `offset` 的描述原文迁入当时的 `packages/tool/src/execute.ts`，删除 `packages/prompts/src/tools.ts` 及其导出，并移除 Tool 对 Prompts 的依赖；当时保留了参数和行为，15 项工具测试及类型检查通过。A1 将声明进一步放到对应工具模块，扩展 read 的显式行数上限，并实现修改队列，见第 12 节。

本文的参数上限、输出缓存和新增接口按第 10 节分批验证，已完成部分在文末记录。关于新增工具的计划，以本文为准；[先前调研](tool-comparison.md)中“目录和搜索都交给 shell”的建议不再作为后续范围限制。

## 2. 重写前的实现与目标

下表保留准备阶段的实现基线；A1 完成后的实际结构和行为见第 12 节。

| 位置 | 当前实现 | 重写目标 |
| --- | --- | --- |
| `packages/tool/src/execute.ts` | 声明集中在数组，参数校验和执行集中在名称分支 | 每个工具在自己的文件中维护声明、校验和执行；入口只负责查找和统一包装 |
| `read.ts` | 分块读取有效 UTF-8；200 行、50 KiB；可续读 | 保留分块读取和原文，统一截断信息，允许明确请求更大行数 |
| `write.ts` | write、edit 共用文件；临时写入后 rename | 拆出 edit，复用文件替换与编码检查，增加同文件写入队列 |
| edit | 单个严格替换；没有差异 | 一个文件支持多个互不重叠的替换，返回有限长度的差异 |
| `shell.ts` | 独立 PowerShell 5.1；输出只保留末尾 50 KiB | 保留实际执行环境、超时和进程树取消；增加行数限制、进度和输出日志 |
| `agent-core/src/run-turn.ts` | 根据 workspace 选用固定 projectTools；顺序执行 | 用同一份工具集合完成声明、预算与调用校验；继续顺序执行 |
| `desktop/src/workspace/tool-call.tsx` | 展示参数、状态和文本结果 | 展示编辑差异、命令输出进度及截断信息，兼容旧历史 |

当前文件工具已限制项目相对路径、内部链接和无效 UTF-8，重写时应复用这些行为。shell 是具有宿主权限的本地命令，项目根目录只是其起始目录；文件工具的路径限制不等于 shell 被限制在项目内。

## 3. Pi 中值得采用的设计

本轮核查 Pi `main` 提交：`a4715ec9bffbfcb8a32a1a4100dcfd06c12c93e4`。与先前调研中的版本分开记录，后续开发不依赖不断变化的 main。

| Pi 的实现 | Tilot 的采用方式 |
| --- | --- |
| 工具通过 create…ToolDefinition 创建，声明和 execute 放在同一模块 | 采用；一个工具一个文件，公共入口不再包含各工具的参数分支 |
| read、shell 共用 2,000 行 / 50 KiB 截断基础；分别保留头部、尾部 | 采用统一截断算法；Tilot read 默认仍为 200 行，显式 limit 最多 2,000 行 |
| edit 接受 edits 数组，针对同一份原文件定位，拒绝重叠 | 采用，避免连续调用造成位置和上下文变化 |
| edit 返回显示差异、标准 patch 和首个变更行 | Tilot 首版只保存一份标准 unified diff 和首个变更行，避免两份差异重复进入上下文 |
| write、edit 共用按文件串行的修改队列 | 采用，覆盖不同任务同时修改同一文件的情况 |
| shell 增量收集输出、节流更新，截断后保存完整日志 | 采用；必须补上 Tilot 的日志读取接口和容量限制 |
| grep 使用 rg 的 JSON 输出，find 使用 fd，ls 使用文件系统 API | 后续采用专用工具；考虑让 grep、find 共用 rg，减少一个可执行文件依赖 |
| 可注入 operations，以接入 SSH 等远程后端 | 本轮不建立远程文件系统或命令后端，只注入确实需要的日志、进度和搜索依赖 |
| 工具附带终端渲染器及 promptSnippet / promptGuidelines | 桌面渲染保留在 React；工具操作规则直接写入 description 和参数说明，不增加另一套工具提示词 |
| read 支持图片；路径可为绝对路径、~ 等 | 图片单独开发；Tilot 文件路径继续遵守绑定项目的现有规则 |
| edit 准备参数时修复字符串数组、单对象和旧格式 | 不采用隐式参数修复；参数错误清楚回传，由模型提交合法的新调用 |

对应源码：[工具组合](https://github.com/earendil-works/pi/blob/a4715ec9bffbfcb8a32a1a4100dcfd06c12c93e4/packages/coding-agent/src/core/tools/index.ts)、[read](https://github.com/earendil-works/pi/blob/a4715ec9bffbfcb8a32a1a4100dcfd06c12c93e4/packages/coding-agent/src/core/tools/read.ts)、[截断](https://github.com/earendil-works/pi/blob/a4715ec9bffbfcb8a32a1a4100dcfd06c12c93e4/packages/coding-agent/src/core/tools/truncate.ts)、[edit](https://github.com/earendil-works/pi/blob/a4715ec9bffbfcb8a32a1a4100dcfd06c12c93e4/packages/coding-agent/src/core/tools/edit.ts)、[差异与匹配](https://github.com/earendil-works/pi/blob/a4715ec9bffbfcb8a32a1a4100dcfd06c12c93e4/packages/coding-agent/src/core/tools/edit-diff.ts)、[write](https://github.com/earendil-works/pi/blob/a4715ec9bffbfcb8a32a1a4100dcfd06c12c93e4/packages/coding-agent/src/core/tools/write.ts)、[文件修改队列](https://github.com/earendil-works/pi/blob/a4715ec9bffbfcb8a32a1a4100dcfd06c12c93e4/packages/coding-agent/src/core/tools/file-mutation-queue.ts)。

Pi 的默认编程组合是 read、bash、edit、write。powershell 和 grep/find/ls 是另有用途的可选工具。Tilot 当前在 Windows 上运行，命令工具继续叫 shell 并明确描述 PowerShell 环境，不为了名称一致改成 bash。

## 4. 工具声明、执行与说明的组织

### 4.1 文件划分

建议第一阶段形成以下结构；以实际复用情况决定辅助文件是否需要拆出，不把每个小函数独立成模块。

```text
packages/tool/src/
  index.ts          对外导出
  execute.ts        构建工具集合、查找工具、统一调用和结果包装
  tool.ts           工具类型与公共字段检查
  workspace.ts      现有项目路径规则
  text.ts           UTF-8 检查、输出限制等共用文本逻辑
  file-write.ts     临时文件替换、同文件修改队列
  read.ts           read 声明、参数校验、执行
  write.ts          write 声明、参数校验、执行
  edit.ts           edit 声明、参数校验、执行
  edit-diff.ts      替换定位与差异计算
  shell.ts          shell 声明、参数校验、进程执行
  output-cache.ts   命令日志保存、归属和容量回收
  output-accumulator.ts 有界命令尾部与累计统计
```

工具对象只需两项主要职责：`definition` 是发给模型的 SDK FunctionTool 声明，`execute` 是本地执行函数。工具执行上下文提供取消信号及必要的宿主依赖。数据库、模型客户端、桌面组件不放进工具对象。

使用普通对象、函数和 Map 即可。现阶段保留 SDK FunctionTool 类型，不引入插件基类、依赖注入框架、远程 operations 接口或整套 Pi AgentTool 类型。参数较少时继续使用明确的本地校验函数，不为四个工具新增 Schema 框架。

### 4.2 描述与参数在同一声明里

下面只是组织方式示意，不是本次已经实现的新参数：

```ts
export const readTool = {
  definition: {
    type: "function",
    name: "read",
    strict: false,
    description: "读取项目内 UTF-8 文本。默认读取 200 行；通过 nextOffset 继续读取。",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["path"],
      properties: {
        path: { type: "string", description: "项目相对文件路径，使用 / 分隔。" },
        offset: { type: "integer", minimum: 1, description: "起始行，从 1 开始；默认 1。" },
        limit: { type: "integer", minimum: 1, maximum: 2000, description: "最多读取的行数；默认 200。" },
      },
    },
  },
  execute: executeRead,
};
```

实际声明应写清用途、参数默认值、限制和失败后怎样调整调用。上限从同一个常量引用，避免执行改了而描述仍保留旧数值。

JSON Schema 是发给模型的参数说明，`strict: false` 下尤其不能依赖服务端替我们完整检查。execute 仍要检查对象、字段、类型、整数范围及工具自己的条件。拒绝未知字段，不忽略模型传入但实际无效的选项。

系统提示词继续保留授权、数据不构成新指令、中断核实等通用规则。A1 已将 oldText 唯一匹配、shell 方言等具体操作规则集中到相应声明，清理系统提示词中重复的具体参数说明。

### 4.3 一份工具集合贯穿一轮执行

Core 在一轮开始时，按项目绑定与宿主配置创建并冻结实际工具集合：

1. 从该集合取得模型请求的 tools。
2. 将同一份声明传给 checkContextBudget。
3. 只从该集合查找模型要求调用的工具。

声明之外的工具不执行，返回配对的错误结果。不要出现“请求只声明四个工具，执行入口却接受所有已安装工具”的情况。

只有项目任务开放本地工具：A 阶段为四个基础工具，B1 后为七个。B3a 已按开发者确认将 web_fetch 同时开放给普通对话和项目对话；Core 为两种对话提供相同的宿主缓存。

## 5. 四个基础工具的实施规格

### 5.1 read

项目文件参数保留 `path、offset?、limit?`：offset 默认 1；limit 默认 200，建议最大提高到 2,000；文本输出始终最多 50 KiB。

- 继续分块读取，不因为 Pi 将整份文本载入内存就改成无上限 readFile。
- 接受 UTF-8 BOM，结果不显示不可见 BOM；保留原始 LF/CRLF 和末尾换行。
- 返回 path、content、offset、lineCount、nextOffset，新增必要的截断原因；不为了显示行号改写 content。
- 只返回完整行，nextOffset 指向下一条未返回的行；到末尾为 null。不要为了 totalLines 再扫描整份大文件。
- 空文件返回空内容；越界 offset 明确报错。首条待返回行超过 50 KiB 时明确说明，不能返回空成功并重复相同游标。
- 无效 UTF-8 和二进制控制字符继续拒绝。图片读取不塞入当前文本 JSON 结果。

命令日志读取随 shell 日志子阶段扩展，见第 6 节；不在第一步就给 read 增加未经使用的选项。

### 5.2 write

参数保留 `path、content`；UTF-8 创建或完整覆盖，自动创建父目录，允许空内容。

- 保留同目录临时写入后 rename 的方式，失败时不先清空目标。
- write 与 edit 共用按真实目标路径的写入队列。Windows 键值应处理路径大小写别名；不存在的目标以已验证父目录及文件名确定键值。
- 同文件调用串行；不同文件不互相等待。队列只控制 Tilot 的 write/edit，不声称能锁住外部编辑器或 shell。
- 等临时写入完成后再检查取消，不能提前释放队列让未结束的 I/O 与下一次修改重叠。
- rename 是本次文件替换的提交点；成功后按已写入报告结果。提交之后到达的取消不能让已完成的写入被误记为“未执行”。
- 结果保留 path 和 bytesWritten，可增加 created 来区分创建与覆盖；不再次返回整个文件，也不为所有 write 强制生成全文件差异。

“覆盖前先读取”写入描述，但首版不增加 read-token 或历史读取证明。参数约束和模型操作建议应区分清楚。

### 5.3 edit

新调用采用 Pi 风格的单文件多处替换：

```json
{
  "path": "src/example.ts",
  "edits": [
    { "oldText": "原始片段 A", "newText": "新片段 A" },
    { "oldText": "原始片段 B", "newText": "新片段 B" }
  ]
}
```

edits 必须包含 1–20 项；oldText 非空，newText 可为空表示删除。模型应读取文件并提供足以唯一定位的上下文。

执行顺序固定为：取得修改队列 → 读取并检查 UTF-8 → 在同一份原始文本定位所有替换 → 检查唯一性与重叠 → 从后向前应用 → 计算差异 → 临时写入并替换。

- 各项匹配原文件，不匹配前一项修改后的文件。后一项不能引用前一项新插入的文字。
- 任一项无匹配、多处匹配或与其他项重叠时，整个调用失败，文件保持原样；相邻但不相交的替换允许。
- 整个结果没有变化时明确返回无变化错误。
- BOM 和未修改片段保留，不对整个文件重排空格或统一编码格式。
- 按已确认规则，仅在匹配视图中将 CRLF 转为 LF；oldText 同样转换。空格、尾部空白、引号、Unicode 字符等仍必须相同，单独的 CR 不作为另一种换行自动转换。
- 匹配位置必须映射回原文字符区间，再替换原文；不能将整份文件转为 LF 后重新写入。唯一性检查也基于同一匹配视图，包含相互重叠的重复出现。
- newText 的换行按目标片段中首次出现的 LF/CRLF 保存；片段没有换行时采用文件中首次出现的换行，无换行文件默认 LF。只处理插入片段，未修改内容保持原样；混合换行文件不整份统一。
- 写入前重新检查目标是否仍与本次读取一致；发现外部修改则失败并要求重读。这是冲突检查，不能宣称消除了外部程序的并发竞争。

结果建议为 path、bytesWritten、replacements、firstChangedLine、diff、diffTruncated。diff 使用标准 unified diff，保留少量上下文，最多 50 KiB；截断时明确它不能作为完整补丁应用。先用成熟的 diff 库计算差异，不手写复杂的差异算法；该库只负责显示，不决定修改位置。

旧历史仍显示和回放原始 `{path, oldText, newText}`，不重写数据库；新声明只接受 edits。旧调用不自动重跑，也不增加将旧字段混入新数组的隐式兼容逻辑。

### 5.4 shell

参数保留 `command、timeoutSeconds?`。第一阶段继续使用 Windows PowerShell 5.1、默认 300 秒、最大 600 秒；每次是独立进程，从绑定项目根目录开始。

- 继续隐藏进程窗口，关闭交互输入，明确不支持长期后台服务。不新增 cwd、env、后台标志等尚未管理生命周期的参数。
- 脚本和输入输出统一 UTF-8，兼容 PowerShell 5.1 读取脚本所需的 BOM；命令文本只执行一次，不经过另一个 shell 重复解释。
- 持续消费 stdout/stderr，按到达顺序合并；使用增量 UTF-8 解码，避免跨数据块的中文字符损坏。这个顺序不保证复原两个管道的绝对时间顺序。
- 给模型和界面预览保留最后 2,000 行或 50 KiB；超长单行可保留尾部并说明部分行截断。
- 增加 durationMs 与输出统计，保留 status、exitCode、output、truncated。
- 取消或超时调用 taskkill 终止进程树，等进程关闭和输出处理结束再返回。无法确认停止时明确报错，不把取消请求当成已停止。
- 启动失败、非零退出码、超时、取消和输出保存失败分别说明，失败后不自动重跑命令。

第一阶段不引入 Codex 的 exec_command/write_stdin 持续会话；流式显示命令输出不需要让进程跨工具调用存活。

参考：[Pi shell 主体](https://github.com/earendil-works/pi/blob/a4715ec9bffbfcb8a32a1a4100dcfd06c12c93e4/packages/coding-agent/src/core/tools/bash.ts)、[PowerShell](https://github.com/earendil-works/pi/blob/a4715ec9bffbfcb8a32a1a4100dcfd06c12c93e4/packages/coding-agent/src/core/tools/powershell.ts)、[输出收集器](https://github.com/earendil-works/pi/blob/a4715ec9bffbfcb8a32a1a4100dcfd06c12c93e4/packages/coding-agent/src/core/tools/output-accumulator.ts)。Pi shell 不设置默认超时，Tilot 继续保留自己的运行时限。

## 6. 截断输出怎样继续读取

Pi 可把完整日志的临时绝对路径交给 read。Tilot 的文件 read 拒绝项目外路径，所以不能只增加 fullOutputPath 字段就认为日志已经可读。

建议由宿主管理输出文件，并向模型返回不透明的 outputId：它是宿主生成的日志标识，不是文件路径。

- 日志放在应用数据目录的独立输出缓存中，不在用户仓库创建 `.tilot` 文件夹，也不放宽项目文件的路径校验。
- 每次 shell 结束后返回 outputId、日志是否完整及获取方式；read 增加 `outputId` 读取方式。path 与 outputId 必须恰好指定一个。
- read 日志也用 offset/limit 分页，返回 outputId 而非伪造项目 path。已确认增加 byteOffset：超长日志行首次返回部分内容、partialLine 和 nextByteOffset；随后只传 outputId、byteOffset，每页最多 50 KiB，在 UTF-8 字符边界续读，直到 nextByteOffset 为 null。byteOffset 不与 offset/limit 同用；普通文件仍只返回完整行。目录查询、write、edit 不能访问日志存储。
- 宿主按当前 threadId 检查标识归属，模型不能指定任意缓存路径或读取其他任务日志。输出保存用本地执行记录 id 定位，不仅依赖服务返回的 call_id。
- 单个日志最多保存 10 MiB。达到日志上限后保留完整 UTF-8 前缀，继续消费进程输出并维护尾部预览，标记 artifactTruncated；不能再称为“完整输出”。
- 缓存保留 7 天，总容量最多 256 MiB；创建日志前按结束时间回收过期和超过容量的日志，并清理重启遗留的未发布日志。为运行中日志预留容量，不能清理；缓存被运行中日志占满时拒绝启动新命令。失效标识明确返回“日志已过期或不存在”。
- 保存过程必须处理写入背压和写入错误，不能为了显示上限而无限排队磁盘写入；失败说明已知的命令结果，不能据此重新执行命令。
- 轮次结束后关闭日志句柄，保留缓存供后续轮次读取。即使日志过期，已保存的摘要、退出码和截断标识仍可回放。

输出缓存只保存工具输出。密钥仍从宿主传给服务，不进入工具声明、参数或日志元数据。

## 7. 结果、进度与历史的边界

### 7.1 保留现有结果信封

第一阶段保留 `{status: "ok", data}` 和 `{status: "error" | "cancelled", error}` 的 JSON 包装；Core 仍负责保存 SDK function_call_output 及 call_id 配对。

shell 的外层 ok 表示取得了可记录的执行结果，命令是否成功仍看 data.status 和 exitCode；非零退出码不能显示为成功。超时、取消后的部分输出和退出信息也要保留，不只返回一句错误。

not_executed 由 Core 为没有执行的调用生成，unknown 由恢复上下文生成。工具执行器不能把“结果未保存”填成成功或未执行。数据库错误和事件交付错误属于执行流程错误，应向上传递；不要全都包装成普通工具参数错误。

### 7.2 进度不作为正式工具结果

shell 的 onUpdate 最多每 100 ms 推送一次有界快照。快照只用于桌面显示，不逐段保存为 function_call_output，也不加入下一次模型上下文。

Core、Server、Protocol 和桌面已接通 tool.progress 事件，界面协议携带 threadId、turnId、attemptId、本地 toolId、有界 output、truncated 和 partialLine。终态保存后仍通过现有 attempt.updated 和历史查询恢复正式结果。

用快照替换预览，比重连时拼接没有重放保证的增量更简单。终态到达后忽略旧进度，切换任务时不把输出串到其他调用。发送失败时停止相关执行并处理实际进程状态，不能留下无人管理的命令。

edit 差异由已保存结果渲染，不在工具里引入 React。旧历史缺少 diff、durationMs 或 outputId 时仍能按现有 JSON 展示；不需要改写旧数据。

## 8. 目录和代码搜索工具（B1 已实现）

这三个工具用于稳定地提供目录、路径、行号和截断信息，避免模型反复生成 PowerShell 搜索脚本。它们与 shell 都可以保留，不要求 shell 停止承担 Git、测试和构建等工作。

| 工具 | 参数 | 结果与限制 |
| --- | --- | --- |
| ls | path?、limit? | 非递归列目录；默认根目录，默认/最多 500 项、50 KiB；文件/目录/链接类型及截断信息 |
| find | pattern、path?、limit? | 按 rg glob 查文件；默认/最多 1,000 项、50 KiB；项目相对路径 |
| grep | pattern、path?、glob?、ignoreCase?、literal?、context?、limit? | 默认 100、最多 1,000 条匹配行；最多 50 KiB；路径、行号、匹配文本、上下文及截断信息 |

统一约定 path 省略或为空时表示项目根目录；文件工具中的空 path 仍不合法。grep 的 context 为 0–10，每行最多 1 KiB UTF-8 字节，超出时保留完整字符并标记 textTruncated；匹配行号从 1 开始，可用于 read 的 offset。pattern/glob 最多 2 KiB，拒绝换行和无效 Unicode；grep 默认 rg 单行正则，literal=true 为字面匹配。所有上限写在实现常量及声明中，不扩展为全局配置项。

- ls 用 Node readdir 与 lstat，包含隐藏项，稳定排序，目录明确标识。内部链接可以列出名称和类型，但不能跟随访问或递归进入。
- grep 用 rg --json，通过参数数组启动，不拼接 shell 命令；pattern 放在选项终止符之后，不能被解释成命令选项。rg 无匹配属于正常空结果，执行错误另行回传。
- find 用 rg --files，和 grep 共用一个依赖。glob 含 / 时相对项目根目录，否则匹配各层文件名；path 只缩小遍历起点。例如 path=src 时，nested/*.ts 不会匹配 src/nested/b.ts，src/nested/*.ts 才会匹配。使用原生 rg glob，不承诺与 Pi 的 fd 完全相同。
- find/grep 的目录枚举遵守 .gitignore/.ignore/.rgignore，包含隐藏文件但排除 .git，非 Git 目录也启用规则。rg 的正向 --glob 会覆盖忽略规则，因此将“正常枚举”和“glob 枚举”两路已排序流取交集；不缓存全部路径，不另写 JavaScript glob 引擎。grep 显式指定文件时搜索该文件，即使它被忽略；此时不接受 glob。
- 搜索起点及候选路径遵守 workspace 规则。已用 Windows rg 15.2.0 验证 --no-follow 不进入指向项目内外部的 junction；起点或候选路径含内部链接时仍由 workspace 拒绝。grep 将已验证文件按最多 100 个、12,000 个命令行字符分批交给 rg，避免 Windows 命令行过长；上下文直接来自 rg JSON，不再次读取文件。
- 结果一律转换成项目相对路径，以便交给 read；不照搬 Pi 的“相对搜索子目录”结果而让模型漏掉目录前缀。
- 只有发现额外结果超过数量或 JSON 字节上限时才标记 truncated，并返回 truncatedBy=items/bytes；刚好等于上限的完整结果不伪报截断。建议缩小 path/glob/pattern，目录变动时不承诺跨调用分页。find/grep 最长 30 秒，单条 rg 记录超过 1 MiB 报错；取消、超限或错误都关闭管道并等待所有 rg 进程退出。
- 已确认开发阶段用本机 rg，打包时内置固定版本。宿主优先提供 TILOT_RG_PATH 绝对文件路径，否则只从 PATH 的绝对目录发现 rg.exe/rg，跳过工作目录及相对项；缺失时返回错误，ls/read 不受影响。固定版本资源分发在打包阶段实施，不在工具调用期间下载或切换搜索语义。

参考：[Pi grep](https://github.com/earendil-works/pi/blob/a4715ec9bffbfcb8a32a1a4100dcfd06c12c93e4/packages/coding-agent/src/core/tools/grep.ts)、[find](https://github.com/earendil-works/pi/blob/a4715ec9bffbfcb8a32a1a4100dcfd06c12c93e4/packages/coding-agent/src/core/tools/find.ts)、[ls](https://github.com/earendil-works/pi/blob/a4715ec9bffbfcb8a32a1a4100dcfd06c12c93e4/packages/coding-agent/src/core/tools/ls.ts)。

## 9. 网络工具：先读取，搜索暂缓

Pi 的上述八个基础工具没有专用网络搜索。这里参考 DeepSeek Harness 的搜索/读取分工，不把搜索服务绑死在主模型协议上。

| 工具 | 建议参数 | 结果 |
| --- | --- | --- |
| web_search | query、limit? | 来源标题、URL、摘要、获取时间；服务提供时附发布时间；默认 5 条，最多 10 条 |
| web_fetch（已实现） | url 与 outputId 恰好一个；offset、limit；长行续读用 byteOffset | Markdown/文本正文、原始/最终 URL、标题、获取时间、下一段位置 |

模型只提出查询或 URL，宿主选择实际搜索服务、持有密钥并执行请求。两者继续声明为普通 function；主对话保持 Responses，不发送 DeepSeek 不支持的内置 web_search 类型。

### 9.1 DeepSeek 原生搜索验证（暂缓）

开发者已调整顺序：先完成不依赖模型或搜索服务的 fetch，以下搜索方案仅保留设计，未发送真实搜索请求。

DeepSeek Harness 使用另一次 Anthropic 兼容 Messages 请求，并声明 web_search_20250305 服务端工具，再提取结构化来源与引用摘录。不是在主 Responses 请求里开启搜索。见[提供方源码](https://github.com/deepseek-ai/deepseek-harness/blob/639ed015397290b3745d163aafe02ffee4aa3f84/packages/web/web-search-deepseek/src/provider.ts)。

正式接入前先做少量真实查询，确认可用模型、权限、延迟、中文与技术文档质量、实际计费。优先采用该方案是当前建议，不表示已经验证账户可用，也不称它为免费搜索。

2026-10-01 接入前核查：固定版本 Harness 默认使用 `https://api.deepseek.com/anthropic/v1/messages`，模型名为 `deepseek-v4-flash`，单请求最多使用搜索 5 次。当前 [官方模型与价格](https://api-docs.deepseek.com/quick_start/pricing/)建议使用 `deepseek-flash`；旧名称仍接受，但映射到已更新的 Flash 模型。因此真实验证将使用当前模型名，首轮限制 `max_uses=1`、`max_tokens=2048`，分别记录 HTTP 状态、结构化来源、耗时和 usage，不把纯文本回答当成搜索成功。

[官方搜索说明](https://api-docs.deepseek.com/quick_start/agent_integrations/claude_code/)明确：搜索内容总结会产生额外模型请求和 token 费用。当前 Flash 每百万 token 的缓存未命中输入为 $0.15/$0.30，输出为 $0.60/$1.20，分别对应低峰/高峰；缓存命中输入为 $0.003/$0.006。价格只记录本次查阅值，真实搜索还需核对 usage 与账户计费；不能按固定单次金额或免费服务承诺。上述核查没有发起真实模型或搜索请求，B2 仍未完成。

只复用明确选择的 DeepSeek 官方凭据，不能把第三方 Responses 提供方的密钥发给 DeepSeek。先实现一个搜索提供方；如果效果不合适再接 Tavily 或 Brave，不预先做多提供方自动降级框架。第三方密钥与模型 provider 凭据的清理规则分开设计。

### 9.2 网页读取采用本地 HTTP 与 Markdown 转换（B3a）

参考 Harness 的匿名 HTTP 获取和 HTML 转 Markdown；公开文本/HTML 优先，不在首版启动浏览器、不携带本机 Cookie。见[HTTP 提供方](https://github.com/deepseek-ai/deepseek-harness/blob/639ed015397290b3745d163aafe02ffee4aa3f84/packages/web/web-fetch-http/README.md)、[HTML 转换](https://github.com/deepseek-ai/deepseek-harness/blob/639ed015397290b3745d163aafe02ffee4aa3f84/packages/web/tool-web/src/fetch.ts)。

- 只允许匿名公开 HTTP(S) 地址，原始及编码后的 URL 最多 4 KiB；拒绝回环、私网、保留 IP 和本地域名。直连验证 DNS 的全部 IPv4/IPv6，禁止 DNS64 私网映射，固定一个已验证地址并保留原 Host/TLS 名称。跨域重定向仍为匿名请求，最多 5 次，每跳重新检查 URL 并选择当前代理/直连方式。
- 总抓取超时 30 秒；按流累计下载和解压字节，各最多 2 MiB，转换后也最多 2 MiB。支持 gzip/deflate/br，超限拒绝且不保存部分正文，不能只信 Content-Length。
- 使用 Turndown 的纯 HTML 解析转换，移除脚本、嵌入资源、明确隐藏标记与行内隐藏样式，保留标题、列表、代码、表格、链接及图片说明。不执行 JS，不加载子资源，不提供登录态、外部样式计算、PDF 解析或完整文章主体提取。按响应 charset 解码，缺省 UTF-8；仅支持 HTML、text/* 和 JSON。
- 提取正文形成不可变缓存，分页用 outputId 读同一份内容，避免每一页重新请求产生内容变化。返回正文所属 URL 和抓取时间，不把它冒充实时重新抓取结果。
- url 与续读 outputId 恰好指定一个；web_fetch 只接受本任务网页类缓存标识，不能读取命令日志。read 的日志模式同样限制为命令日志，避免两种能力串用。
- 行分页默认 200 行、最多 2,000 行或 50 KiB 正文。超长行返回 partialLine、nextByteOffset，随后仅用 outputId、byteOffset 续读，直到字节模式的 nextByteOffset 为 null；不重新联网，UTF-8 字符不拆分。
- 来源及正文由宿主 OutputCache 保存，与命令日志共用 7 天/256 MiB 总限额，网页转换正文最多 2 MiB。元数据区分 shell/web；旧元数据缺省视为 shell，不需要迁移数据库或改写历史。
- 401/403/429、超时、大小超限和非支持内容明确返回错误；不自动换服务，不把网页提示词当成授权。

web_fetch 已确定同时向两种对话开放，不需要新增密钥或搜索设置。按开发者选择，网络层自动遵守宿主 HTTP_PROXY/HTTPS_PROXY、ALL_PROXY、NO_PROXY 及其小写形式，不增加代理开关；proxy-from-env 选择是否代理，Node 原生 Agent 处理 HTTP/HTTPS 代理和 HTTPS CONNECT。未配置代理或匹配 NO_PROXY 时直连并执行完整 DNS 检查；代理模式使用可信宿主代理的目标解析与连接，不对代理后端 DNS 作本机固定地址保证。代理凭据不进入网页来源、工具输出或历史，连接失败不自动降级为直连。搜索服务配置留到 B3b，不让模型服务切换自动改变已选搜索服务。

## 10. 分批实施顺序

用户已确认先完成四个基础工具，再补新增工具。每批形成可运行的结果，检查通过后说明变化并对齐下一批；单次不累积超过约 2,000 行的改动。

| 批次 | 工作 | 完成条件 |
| --- | --- | --- |
| 已完成 | 工具描述原文迁入当前声明，删除独立工具提示词和无用依赖 | 15 项 Tool 测试与全项目类型检查通过 |
| A1（已完成） | 工具对象与集合；每工具独立声明/校验；共享 UTF-8、截断、文件替换及修改队列 | 四个工具仍能完整执行；请求、预算与分发使用同一清单；无项目规则保持 |
| A2（已完成） | 多处替换、确定的匹配规则、外部冲突检查、有限差异；桌面差异展示 | 所有替换原子验证；BOM/换行保留；旧历史展示正常；差异与实写一致 |
| A3（已完成） | shell 输出行数限制、进度、日志缓存；read 日志模式及 byteOffset；Protocol/Server/桌面接线 | 真实 PowerShell 的退出码、超时与取消正确；日志能分页；进度不污染上下文 |
| B1（已完成） | ls、find、grep；本机 rg 发现、参数数组执行与有界流；桌面展示 | 中文与 Windows 路径、忽略规则、无匹配、截断、链接边界与搜索后读取验证通过 |
| B3a（已实现） | web_fetch；公开 HTTP、HTML 转 Markdown、正文缓存、来源展示与普通对话接线 | 匿名抓取、续读、取消、大小与地址边界及历史配对验证；真实网络限制如实记录 |
| B2（暂缓） | 少量 DeepSeek 搜索验证，确定搜索配置与凭据规则 | 记录真实结果和成本，选择一个可用提供方；失败时仍能继续本地工具工作 |
| B3b（暂缓） | web_search；搜索服务、引用展示与配置 | 真实搜索与正文能完成一个问答流程，取消和回放正确，配置不泄漏凭据 |

图片、持续命令会话、apply_patch、多代理、计划/询问工具、MCP、动态工具发现与远程 operations 不放进这些批次。新增这些能力时再决定对应接口，不提前把当前 Tool 包扩成通用框架。

## 11. 验证要覆盖的实际行为

复用现有测试，只为新增行为补必要用例，不为每个声明字段写重复快照测试。

| 范围 | 关键验证 |
| --- | --- |
| 声明与调用 | 非对象、未知字段、错误类型、越界整数和未声明工具不执行；合法调用能交回模型 |
| read | UTF-8/BOM/中文跨块、混合换行、空文件、完整续读、超长单行；不扫描整份文件计算总行数 |
| write | 创建/覆盖/清空、父目录、失败后原文件及临时文件状态、取消提交点 |
| edit | 多处原文件匹配、重复与重叠、部分失败零写入、LF/CRLF 互相匹配、空格/Unicode 不容错、混合换行未修改部分保留、无变化、差异一致性 |
| 并发 | 两个任务同文件 write/edit 串行；等待取消不执行；前一项失败不堵塞队列；外部变化明确报错 |
| shell | 真实 PowerShell 中文与原生命令退出码、大输出有界、子进程终止、最后一段输出不丢失 |
| 日志 | 截断后续读、归属与类型限制、日志容量与背压、保存失败、过期、不读取任意宿主文件 |
| 进度 | 快照覆盖、跨任务不混合、终态不被旧进度覆盖、事件失败后不留进程、不逐帧入库 |
| 历史 | 旧参数和旧结果仍可显示/回放；未知结果不重跑；缓存消失不改写正式历史 |
| 目录搜索 | .gitignore、隐藏项、glob、UTF-8、rg 非零退出、链接/junction、不完整结果标识 |
| 网络 | 服务响应映射、取消、限流与超时、公开地址与重定向检查、正文缓存及真实来源链接 |

第一阶段运行 Tool 与相关 Core/Context/Server/桌面测试，以及全项目类型检查；改动哪条链路就验证哪条链路。真实模型测试只用于确认工具参数与结果的可用性，不替代本地行为测试；模拟网络结果不证明搜索质量、账户权限或费用。

## 12. A1 实施记录

2026-10-01 完成：

- read、write、edit、shell 各自提供工具工厂，声明、参数校验和执行放在对应模块；execute.ts 只负责建立集合、查找、解析 JSON 和结果包装。
- Core 每轮只建立一次 createToolSet，模型请求、上下文预算和调用分发使用同一集合；普通对话仍不开放本地工具。
- text.ts 共用严格 UTF-8 解码、字节上限、完整行截断检查和 UTF-8 尾部截断。read 默认 200 行，显式上限 2,000 行；返回截断原因。shell 仍按原有末尾 50 KiB 限制，行数、进度和日志在 A3 实现。
- file-write.ts 共用临时文件替换与按路径串行的修改队列；write/edit 在队列内读取或创建文件，Windows 大小写路径共用队列。并行创建共享父目录也不会因另一工具刚创建目录而失败。
- edit 已拆成独立模块，仍使用原来的单处严格匹配参数。LF/CRLF 兼容、多处编辑、外部冲突检查和差异展示在 A2 实现。
- 系统策略不再重复具体编辑参数和 PowerShell 操作限制，工具声明直接提供这些说明。

验证：Tool 21 项、Core 11 项、Context 9 项、Server 15 项，共 56 项测试通过；全项目类型检查与差异格式检查通过。包括真实 PowerShell、并发编辑、write/edit 共用队列、大小写别名、等待中取消、失败后放行和共享父目录创建。未调用真实模型，也未改动存储格式与桌面展示协议。

## 13. A2 实施记录

2026-10-01 完成：

- edit 新调用只接受 `{path, edits: [{oldText, newText}, ...]}`，最多 20 项；各项非空原文、类型和未知字段均在工具侧校验。拒绝无效 Unicode 插入内容，避免编码时改变内容而使差异与落盘不一致。
- edit-diff.ts 负责匹配、原文位置映射和差异。所有替换在原文件的 LF 匹配视图中定位，包含重叠出现的唯一性检查；交叉、嵌套和同范围修改均拒绝，相邻范围允许。全部验证完成才从后向前替换。
- 仅兼容 LF/CRLF；其他字符严格匹配。保留 BOM 和未修改内容的原始字符，插入换行按片段、文件、LF 的顺序选择；整个结果无变化时报错。
- file-write.ts 在 edit 临时文件写完后，提交前比较目标和原始读取字节；外部内容、BOM 或换行变化以及删除都会停止提交并清理临时文件。这是检测冲突，不消除检查与替换之间的外部竞争，也不自动合并外部修改。
- 使用固定版本 jsdiff 9.0.0 的 [structuredPatch/formatPatch](https://github.com/kpdecker/jsdiff#api) 生成差异，保留三行上下文。差异对应实际写入文本，UTF-8 输出最多 50 KiB，不切断多字节字符；超限标出 diffTruncated，不缩减实际写入内容。仅返回一份 diff。
- 桌面 ToolResult 渲染已保存差异，用统一主题变量区分新增和删除，显示替换数、首个变更行及截断提示；长行水平滚动，文本不解释为 HTML。历史没有 diff 时继续显示原始结果，参数和历史回放不迁移，旧调用不会自动转换成新调用。
- README、模拟界面验收入口和相关测试同步更新。后续 A3 实施结果见第 14 节。

验证：Tool 30 项、Core 11 项、Context 10 项、Server 16 项、桌面 16 项，共 83 项测试通过；全项目类型检查、前端构建和差异格式检查通过。差异一致性测试使用 applyPatch 从原文还原并与落盘内容比较，覆盖 BOM、混合换行、删除及无末尾换行；另覆盖部分失败零写入、重复/重叠、外部字节变化与删除、20 项上限及 UTF-8 截断。浏览器使用内存模拟服务核对完成后的折叠、展开、差异颜色和文本展示；未调用真实模型，原生桌面与真实模型联调仍待后续验收。前端构建仍有已有的单包超过 500 kB 提示。

## 14. A3 实施记录

2026-10-01 完成：

- shell 增量 UTF-8 解码后，output-accumulator.ts 按到达顺序收集 stdout/stderr，尾部同时受 2,000 行和 50 KiB 限制。收集器统计总字节和总行数，shell 记录耗时；partialLine 区分首行不完整，截断不破坏字符。
- output-cache.ts 在宿主数据目录保存正文和归属元数据，使用本地执行记录 UUID 定位。每个 Store 的 Core 调用共用一个缓存实例；读取与回收互斥，运行中日志预留容量，不跨任务读取，不接受缓存路径或链接。单条 10 MiB、7 天保留、总量 256 MiB；达到单条上限保存前缀并标记 artifactTruncated，容量不足在执行前报错。
- read 日志模式复用行分页，支持中文、BOM、混合换行和终端控制字符。超长行提供 nextByteOffset，字节模式每次最多 50 KiB，日志可重组至缓存末尾。项目文件仍拒绝二进制控制字符和超长单行，不放宽路径边界。
- shell 暂停两路管道等待日志和进度交付，避免无界排队。取消、超时和回调失败等待进程树停止及在途写入结束。日志写入失败保留实际退出信息、尾部输出和 logError，不自动重跑；未发布日志关闭并清理。
- tool.progress 贯通 Core → Server → Protocol → React，只替换临时预览。正式结果保存后清除预览；旧历史查询、错误任务/调用标识和迟到进度不会覆盖结果。Core 进度交付失败时停止命令，保存实际结果，为后续工具保存 not_executed，再结束轮次并向宿主传播错误。
- 桌面展示实时临时输出、耗时、退出码、截断、缓存上限和日志错误，旧结果继续原样展示。无需数据库迁移；日志失效不修改已保存的命令结果。

验证：Tool 41 项、Core 13 项、Context 10 项、Server 17 项、Store 21 项、桌面 18 项，共 120 项相关测试通过；全项目类型检查和前端构建通过。覆盖真实 PowerShell、慢写入取消、日志保存故障及命令副作用、进度回调故障后的子进程清理、日志过期/容量/归属/链接、跨实例续读，以及中文与 emoji 超长行的逐字节重组。浏览器使用内存模拟服务核对执行中的临时输出和完成后的耗时、退出码、日志提示；未调用真实模型，原生窗口完整联调仍待验收。前端构建仍有已有的单包超过 500 kB 提示。

后续 B1 的实施结果见第 15 节；网络搜索验证在 B2 进行。

## 15. B1 实施记录

2026-10-01 完成：

- 新增 ls.ts、find.ts、grep.ts，每个模块就地声明工具描述、参数及执行逻辑；createToolSet 将三者加入同一轮声明、预算和分发清单，普通任务仍不开放本地工具。
- ls 用 Node readdir/lstat，包含隐藏项，链接只列名称和类型。find/grep 共用 ripgrep.ts 和搜索结果预算；原生 glob 与忽略规则取交集，排序比较按 UTF-8 字节进行，中文、emoji 和补充字符路径也能正确合并。
- rg 通过参数数组启动，关闭个人 rg 配置，不经 PowerShell；隐藏运行，流读取提供背压，错误或停止后等待进程退出。grep 文件分批执行，保留 CRLF 行号和来自同一份输出的上下文；文本、JSON 总量和单条记录均有界。
- 桌面显示中文工具名、模式、目录和文件列表、匹配/上下文行号、空结果和截断提示，文本不解释为 HTML，未知历史结构继续显示原始结果。浏览器验收样例只位于 tests 中。
- 开发者确认开发使用本机 rg、打包内置；实现 TILOT_RG_PATH/PATH 发现，不增加 fd、glob 库或自动下载。没有改变数据库、Core 循环或网络配置结构。

验证：Tool 49 项、Core 14 项、Context 10 项、Server 17 项、桌面 20 项，共 110 项相关测试通过；全项目类型检查与前端构建通过。覆盖真实 rg 的嵌套忽略、非 Git 项目、隐藏/中文/特殊字符路径、LF/CRLF 和 BOM、显式读取被忽略文件、名为 - 的文件、.git 大小写别名、正则错误、空匹配、UTF-8 截断、JSON 上限、超长记录、链接边界以及取消/提前结束后所有进程退出；Core 验证搜索结果落库、配对回放及用返回路径/行号继续 read。浏览器复用已有预览服务，验收新增工具结果；未请求真实模型，rg 打包和原生窗口完整验收仍待后续阶段。前端构建仍有已有的单包超过 500 kB 提示。

开发者随后调整顺序，先实施 B3a 的 web_fetch；B2 与 B3b 暂缓，见第 16 节。

## 16. B3a 网页读取实施记录

2026-10-02 实现：

- web-fetch.ts 就地声明参数、说明与执行；web-http.ts 负责匿名 HTTP、环境代理/直连、重定向、压缩、解码及限额；直连固定已验证 DNS 地址。web-markdown.ts 用 Turndown 转换 HTML，模型无需额外搜索服务或模型请求。
- OutputCache 元数据增加 shell/web 类型和固定网页来源，readCachedPage 共用行分页与长行续读。网页缓存按任务和类型隔离，旧命令日志仍可读取；续读与重开不重新联网。
- Core 在两种对话中声明 web_fetch，项目对话另有七个本地工具；请求声明、预算及分发仍使用同一集合。普通对话尝试本地工具得到配对错误。
- 桌面显示网页名称、标题、来源链接、抓取时间、正文及续读提示。正文按文本展示，不执行 HTML 或自动加载图片；来源链接复用系统浏览器打开逻辑。模拟验收样例区分普通与项目对话。
- 未接入 web_search、搜索凭据或额外模型调用；未改变数据库及桌面通信协议。

验证：Tool 61 项、Core 15 项、Context 10 项、Server 17 项、桌面 21 项，共 124 项相关测试通过。HTTP 测试保留真实本地服务、流、压缩与断连，仅替换直连公开目标的 DNS/连接边界；代理测试使用真实本地 HTTP 代理及 CONNECT。覆盖 IPv4/IPv6、DNS64、全部 DNS 答案、逐跳重定向、字符编码、压缩及下载/解压/转换超限、取消/总超时、隐藏表格内容、长行完整续读、缓存隔离与旧日志兼容，以及代理变量优先级、NO_PROXY、代理认证、错误脱敏和 CONNECT 建连取消。Core 验证网页结果落库、来源固定、缓存驱动后续工具调用及配对回放。

按开发者选择完成自动代理后，真实抓取 https://example.com 和 https://nodejs.org/en/about 均成功，读取到标题及正文并验证缓存续读一致，耗时约 1.1 秒及 0.7 秒。全项目类型检查与前端构建通过，构建仍有已有的 500 kB 单包提示。前端界面按 UI 规范由开发者验收，本批未启动预览或原生桌面，也未调用真实模型。
