# 开发计划与验收

适用版本：v0.1 · 更新日期：2026-09-14 · 范围：代码读写

## 1. 里程碑

估算 22–35 个开发日；按单人全职、预留 20% 余量计，约 6–9 周。假设具备 TypeScript 开发能力，Tauri、原生依赖及协议适配成本在 M0 后复核。

| 阶段 | 工作量 | 交付 | 验收条件 |
| --- | --- | --- | --- |
| M0 平台原型 | 5–7 日 | workspaces、Core 接口、Node sidecar、RPC、SQLite、安装包 | 无开发环境可运行；Runtime 可独立测试，事务与退出通过 |
| M1 Client/Runtime | 4–6 日 | SDK、任务服务、事件同步、项目读取与 FakeProvider | Client 刷新后接回同一 Run，无重复动作 |
| M2 Responses | 4–7 日 | Provider、输出项存储、SSE、工具循环与取消 | 真实服务完成多轮代码查找，DS 契约通过 |
| M3 修改与撤销 | 5–8 日 | 新建、编辑、差异、批次确认及备份 | 冲突、部分成功、取消和撤销结果明确 |
| M4 恢复与发布 | 4–7 日 | 故障恢复、压缩、迁移、评测、安装升级 | 发布门槛及干净环境验收通过 |

按 M0 → M4 执行。持久 ID、事件和文件指纹从对应功能首次实现建立。首版不并行维护 Chat Completions Provider。

### M0 实施进度（2026-09-15）

| 批次 | 内容 | 状态 |
| --- | --- | --- |
| M0.1 | Core 接口、内存工具循环、FakeProvider、测试及设计讲解 | 已完成，38 项测试、类型检查、构建和演示通过 |
| M0.2 | 独立 Runtime、最小握手、Store Worker、SQLite | 待开发 |
| M0.3 | 最小桌面、自带 Node/SQLite 的分发原型 | 待开发 |
| M0.4 | SDK、去重、同步、背压、权限、凭据和进程生命周期 | 待开发 |
| M0.5 | 干净 Windows 环境及故障验收 | 待验证 |

M0.1 仅验证固定内存项目；实现、运行方式及限制见 [首批讲解](08-m0-core-implementation.md)。它不代表独立 Runtime、数据库事务或安装包已通过 M0 验收。按批交付并控制改动规模，较大批次继续拆分后验收。

## 2. M0 验证清单

1. Core 独立类型检查，不引入 DOM/Node 类型和平台模块；以 FakeProvider、内存 Journal 运行一次完整工具循环。
2. 独立启动 Runtime，通过测试 Client 调用；进程启动不要求 WebView，工具、HTTP 和数据库不通过桌面插件。
3. 验证 Runtime 请求去重、协议分片、队列背压和 Client 快照重连。
4. 验证 Store Worker 的同连接事务：中途失败整体回滚，状态、事件和请求结果一致。
5. 将固定 Node、Runtime JavaScript、Worker 入口和 SQLite 原生模块打包，验证中文/空格路径及资源定位。
6. 验证 Host/Runtime 退出、管道断开、Job Object、凭据通道和无开发环境安装。
7. 验证全部 Host command 均纳入应用权限清单；主 WebView 获授权后可调用，移除授权或换用未授权 WebView 时被拒绝。另验证 Rust 来源、参数校验及 Channel 绑定。

Node/SQLite 生产包兼容性与进程生命周期为 M0 阻断项。开发机可运行或浏览器 mock 通过，不能代替真实安装验收。

锁定 package-lock.json、Cargo.lock、Node 下载校验和及原生模块构建记录。桌面、SDK、Core 和 Runtime 同版发布。

## 3. 测试分层

| 层级 | 工具与范围 |
| --- | --- |
| Core | Vitest、独立类型检查；内存替身验证循环、状态、取消与上下文 |
| Runtime | Vitest；真实 Node 文件、SQLite、HTTP 和 stdio 故障注入 |
| Protocol / Client | schema 兼容、重复请求、重连、旧事件及背压 |
| Rust Host | cargo test、fmt、clippy；命令权限、来源与参数校验、RPC 白名单、凭据及进程生命周期 |
| Desktop | WebdriverIO + @wdio/tauri-service；真实 Client/Runtime 交互 |
| 服务契约 | 真实 DeepSeek Responses，单独启用并记录配置 |
| 安装 | 普通 Windows 账户下安装、升级、卸载及数据保留 |

Windows E2E 使用 tauri-service 的 external 模式，通过 tauri-driver 和匹配的 Edge WebDriver 控制应用；生产包不含嵌入式测试服务或后端 mock 插件。[官方测试指南](https://v2.tauri.app/develop/tests/webdriver/)

测试验证 Tilot 自身，不向应用添加执行用户项目代码、构建或测试命令的能力。

### 关键用例

| 编号 | 场景 | 通过条件 |
| --- | --- | --- |
| R-01 | UTF-8、BOM、CRLF、中文路径 | 未修改部分字节保持一致，差异与落盘一致 |
| R-02 | 越界、设备路径、junction、ADS、UNC | 拒绝越界及不支持的路径 |
| R-03 | 忽略目录、凭据、二进制、超大文件 | 不误读，不静默转换 |
| R-04 | 分页、截断、重复文本 | 定位正确，编辑不在多重匹配时猜测 |
| R-05 | Client 重载、重复 RPC、事件缺号 | 接回同一 Run，副作用不重复 |
| R-06 | 预览后文件变化、重名、占用 | 检测到冲突时阻止写入 |
| R-07 | 写前/写后取消、迟到确认、部分完成 | 停止新动作，保留准确逐项结果 |
| R-08 | 写入后、数据库提交前杀死 Runtime | 重启先核对哈希，不盲目重试 |
| R-09 | 撤销冲突、新文件撤销 | 不覆盖外部修改；删除仅限匹配记录的新建文件 |
| R-10 | 事务失败、磁盘满、迁移失败 | 数据库回滚，外部文件按操作记录核对 |
| R-11 | 恶意源码、预览、Client 越权消息 | 工具不扩权，不泄露持久凭据 |
| R-12 | Responses 失败、压缩、usage、取消 | 遵守 [DS 契约](04-deepseek-integration.md#8-契约测试) |
| R-13 | Host 崩溃、管道关闭、重复启动 | 无残留执行进程，无第二个写入者 |
| R-14 | 核心迁移至内存测试宿主 | 无需 DOM、Tauri、SQLite 或真实模型即可运行 |

M3 测试编辑器同时保存、替换时占用及外部修改竞态，记录已知限制，不把哈希检查表述为 OS 写锁。

## 4. 任务评测

建立 10 个固定代码任务，每个运行 3 次：

| 类别 | 数量 | 样例 |
| --- | --- | --- |
| 读取与定位 | 3 | 查找函数、跨文件关系、解释配置 |
| 新建 | 2 | 在现有目录创建模块、目标重名 |
| 修改 | 3 | 单点修复、多文件接口调整、保留 BOM/换行 |
| 异常处理 | 2 | 文件版本变化、批次拒绝或部分失败 |

每项记录输入、预期文件/行号或差异、允许修改范围、模型配置和判定方法。检查最终字节、无关文件未变及说明与实际结果一致。

至少 9/10 项在三次中通过两次；权限、重复写入、已检测冲突及撤销保护用例须全部通过。记录耗时、请求数、工具数、usage 和人工干预，并满足 [产品验收目标](02-product-plan.md#6-验收目标)。当前尚无实测结果。

## 5. Windows 分发

采用 Tauri NSIS、Windows x64、按用户安装、手动升级。Node 可执行文件通过 externalBin 分发，Runtime、Store Worker 和原生依赖作为资源附带；生产包不依赖系统 Node、Rust 或编译器。[Node sidecar](https://v2.tauri.app/learn/sidecar-nodejs/)

构建时使用 x86_64-pc-windows-msvc 目标对应的 sidecar 命名；锁定 Node 版本与 SQLite 原生模块 ABI。原生模块保留为独立资源并通过固定路径加载，不能遗漏在 JavaScript bundle 外的依赖。

Windows 界面依赖 WebView2；首版使用 downloadBootstrapper，缺失时联网安装。已有运行环境时可离线打开历史，模型调用仍需联网。[安装器](https://v2.tauri.app/distribute/windows-installer/)

安装验收覆盖普通账户、中文路径、125%/150% 缩放、WebView2 已有/缺失、代理失败及 Runtime 崩溃。升级验证数据与操作备份恢复；卸载保留任务数据，不触碰项目代码。

公开发布验证应用与安装器签名，附依赖及许可证清单。[Windows 签名](https://v2.tauri.app/distribute/sign/windows/)

后续能力不在本轮排期；完成代码读写和可靠性验收后再确定下一步。
