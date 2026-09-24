# Tilot UI 规范

## 基准

采用 [shadcn sidebar-07](https://ui.shadcn.com/blocks/sidebar#sidebar-07) 的页面与侧栏组合，保留默认 Neutral 深色主题。大体使用 Codex 的任务侧栏、对话正文、底部输入结构，不再复刻截图中的具体颜色和尺寸。

遵循 [官方主题规范](https://ui.shadcn.com/docs/theming) 和 [Sidebar 组合规范](https://ui.shadcn.com/docs/components/sidebar)。官方也提供 [shadcn 技能](https://ui.shadcn.com/docs/skills)，本项目当前采用其公开规范，没有安装额外全局技能。

## 约束

- 优先使用 `components/ui` 中的官方组件；页面组合在 `workspace`，业务状态在 hooks。不得把旧页面作为新页面的包装层。
- 颜色只使用 background、card、muted、accent、border 等语义变量。禁止独立蓝色气泡、渐变侧栏、逐组件硬编码颜色。
- 字号：正文与导航 14px，辅助文案 12px，空状态标题 24px。布局使用 Tailwind 默认间距，常用 8、16、24、32px。
- 圆角、按钮高度、表单边框和焦点样式沿用官方默认值；不通过全局选择器覆盖组件内部结构。
- 图标只用 Lucide，图标按钮必须有中文可访问名称；只展示真实可用的功能。
- 使用官方 Sidebar 的响应式抽屉与 Dialog 的焦点管理。桌面、窄窗口、长任务名、长代码块均需核对溢出。
- Markdown 样式只约束模型内容，不控制应用布局；不执行 HTML，不自动请求模型图片。
- 预览仅使用模拟服务。验证结束关闭本轮启动的进程，释放端口。

## Windows 原生材质

Windows 11 桌面窗口启用深色主题及 Mica，保留系统标题栏与窗口按钮。WebView 和桌面侧栏底层透明，透出同一个系统背景；中央对话面板、设置弹窗和窄窗口抽屉仍使用实色主题。浏览器预览保持默认实色，不模拟系统材质。Mica 外观受系统壁纸、窗口激活状态及透明效果设置影响，需在桌面程序中验收。

## 模板适配边界

保留 SidebarProvider、SidebarInset、SidebarHeader/Content/Footer 及可折叠菜单结构。将示例团队切换、账户资料、项目链接替换为本地工作区、真实任务和连接设置；模板内容占位块替换为对话和 Card 输入区。基础组件来自官方 New York v4 注册表，保留 MIT 许可；仅移除未使用的辅助组件、改为独立 Radix 包导入，并补充注释与中文无障碍文案。
