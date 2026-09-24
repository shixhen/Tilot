MIT License

Copyright (c) 2023 shadcn

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

## 来源与本项目适配

基础组件从 [New York v4 注册表](https://ui.shadcn.com/r/styles/new-york-v4/sidebar-07.json) 重新引入（2026-09-22）。页面与导航以官方 sidebar-07 为基础，布局组合见 workspace/page.tsx 与 workspace/navigation.tsx。将示例内容替换为真实任务、模型设置和对话，沿用默认组件样式与 Neutral 深色主题。

保留所用组件；移除未使用的 Sidebar、Sheet、Dialog 辅助函数和不读取的 cookie 写入；导入调整为独立 Radix 包，补充注释与中文可访问名称。输入区为官方 Card / Textarea / Button 的组合。旧的应用 UI 与样式已删除。项目规范见 docs/ui-guidelines.md。
