# 开发环境

核查日期：2026-09-15 · 平台：Windows x64

当前已完成依赖工作区初始化和 M0.1 内存内核闭环。React 页面、Tauri 启动入口、Host command、独立 Runtime 进程尚未实现。可运行 `npm run demo:core` 查看内存演示，首批实现与验证见 [M0 首批实现讲解](08-m0-core-implementation.md)。

## 1. 本机工具

| 工具 | 版本或组件 | 状态 |
| --- | --- | --- |
| Node.js / npm | 24.14.0 / 11.9.0 | 原有安装，可用 |
| Rust / Cargo | 1.98.1，x86_64-pc-windows-msvc | 原有安装，含 rustfmt、clippy |
| Visual Studio Build Tools | 2026 18.10，MSVC x64/x86 | 原有安装，已通过编译检查 |
| Windows SDK | 10.0.26100.0 | 原有安装 |
| WebView2 Runtime | 153.0.4234.32 | 原有安装 |
| tauri-driver | 2.0.6 | 本次安装至 `%USERPROFILE%\.cargo\bin` |
| Edge WebDriver | 153.0.4234.32，win64 | 本次安装，微软签名验证通过 |

Rust 的用户 PATH 已配置，但当前应用进程仍保留旧环境。若终端无法识别 `cargo`，重启 Codex 或 VS Code；无需重装 Rust。Windows 前置条件见 [Tauri 官方文档](https://v2.tauri.app/start/prerequisites/#windows)。

## 2. 项目依赖

npm workspaces 按架构分包，直接依赖使用精确版本，完整依赖树由根目录 `package-lock.json` 锁定。Rust 依赖及锁文件位于 `apps/desktop/src-tauri`。

| 位置 | 主要依赖 | 用途 |
| --- | --- | --- |
| apps/desktop | React / React DOM 19.3.0、Vite 8.3.0、React 插件 6.1.1 | 界面及前端构建 |
| apps/desktop | Tauri API 2.11.1、CLI 2.11.4 | 前端通信及桌面开发工具 |
| packages/agent-core、protocol | Zod 4.6.5 | 参数及协议校验 |
| packages/client | 本地 protocol 包 | 客户端 SDK 的依赖边界 |
| packages/runtime | better-sqlite3 13.0.3 | SQLite 原生驱动，随驱动包含 SQLite |
| packages/runtime | eventsource-parser 4.1.0 | SSE 分片解析 |
| packages/runtime | ignore 7.0.9、diff 9.0.0 | 忽略规则及文本差异 |
| 根目录开发依赖 | TypeScript 7.0.2、tsx 4.23.13、Vitest 5.0.0 | 类型检查、开发执行及单元测试 |
| 根目录开发依赖 | WebdriverIO 9.31.9、Jasmine 适配器、tauri-service 1.4.0 | 桌面自动化测试 |
| src-tauri | tauri 2.11.5、tauri-build 2.6.3、dialog 2.7.3、single-instance 2.4.4 | Windows Host 及系统选择器 |
| src-tauri | serde 1.0.229、serde_json 1.0.151、windows 0.62.2 | 序列化、DPAPI 和进程资源管理 |

React、Node 和 SQLite 的类型声明已安装。Node 类型固定为 24 系列。HTTP 使用 Node 内置 fetch；本次没有增加模型 SDK 或 Agent 框架。

桌面测试依赖使用两处临时 `overrides`：将 tauri-service 的 WebdriverIO/globals 对齐至当前 9.x，并将其下载工具链中的 `@puppeteer/browsers` 固定为 3.2.2，移除存在已知漏洞的旧依赖。后者要求 Node 22.12+ 和 ESM，本项目采用 Node 24；已验证模块加载及所用导出，完整 E2E 在应用实现后验证。上游更新后复核并移除覆盖配置。[上游变更记录](https://github.com/puppeteer/puppeteer/blob/main/packages/browsers/CHANGELOG.md)

## 3. 恢复安装与检查

在项目根目录运行：

```powershell
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$OutputEncoding = [Console]::OutputEncoding
npm ci
cargo fetch --locked --manifest-path apps/desktop/src-tauri/Cargo.toml
cargo check --locked --manifest-path apps/desktop/src-tauri/Cargo.toml
npm ls --depth=0
```

新开发机还需安装系统前置工具，以及桌面测试驱动：

```powershell
cargo install tauri-driver --version 2.0.6 --locked
```

本机 Edge WebDriver 位于 `.tools/edgedriver/153.0.4234.32/msedgedriver.exe`，不提交 Git。启用桌面测试时将其目录加入测试进程 PATH，或向 tauri-driver 传入 `--native-driver`。WebView2 升级后应重新匹配驱动版本；也可由 tauri-service 的 `autoDownloadEdgeDriver` 管理。[官方驱动说明](https://webdriver.io/docs/desktop-testing/tauri/edge-webdriver-windows/)

`node_modules`、Rust `target`、本地驱动和验证缓存均已加入忽略规则。恢复安装不需要全局安装 Vite、TypeScript 或 Tauri CLI。

## 4. 本次验证

| 检查 | 结果 |
| --- | --- |
| npm 依赖树 | 无缺失或版本冲突 |
| React、TSX、Vite | 最小入口在内存中构建通过 |
| TypeScript、Vitest、Tauri CLI、WebdriverIO CLI | 可执行，版本符合锁定配置 |
| Rust Host 依赖 | cargo check、cargo fmt 检查通过 |
| better-sqlite3 | Worker 内建表、UTF-8 读写、事务提交及回滚通过；SQLite 3.53.4 |
| SSE、Zod、ignore、diff | 基础调用通过 |
| WebdriverIO、Jasmine、Tauri service | 模块加载及外置驱动配置构造通过 |
| Edge WebDriver | 可执行，微软签名有效 |
| npm audit | 0 项已知漏洞；使用 npm 官方 registry 核查 |

以上是依赖与工具链验证，不代表 M0、桌面 E2E 或安装包验收已完成。
