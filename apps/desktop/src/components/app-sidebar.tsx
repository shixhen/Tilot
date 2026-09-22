import { FolderPlus, Settings2, SquarePen, Wifi, WifiOff } from "lucide-react";
import type { Thread } from "@tilot/protocol";
import { TaskList } from "../task-list";
import { Sidebar, SidebarContent, SidebarFooter, SidebarHeader, SidebarMenu, SidebarMenuButton, SidebarMenuItem, SidebarTrigger, useSidebar } from "./ui/sidebar";

/** 侧栏接收任务和导航回调，不持有对话业务状态。 */
interface AppSidebarProps {
  threads: Thread[];
  selected: string | null;
  busy: boolean;
  connected: boolean;
  canConfigure: boolean;
  onSelect: (id: string) => void;
  onNew: (path: string | null) => void;
  onChooseProject: () => void;
  onSettings: () => void;
}

/** 基于 shadcn sidebar-07 的布局，替换模板示例数据为真实任务。 */
export function AppSidebar(props: AppSidebarProps) {
  const { setOpenMobile } = useSidebar();

  /** 执行导航并收起窄窗口抽屉，让用户看到目标页面。 */
  function navigate(action: () => void): void {
    setOpenMobile(false);
    action();
  }

  return <Sidebar variant="sidebar" collapsible="offcanvas" className="app-sidebar border-0!">
    <SidebarHeader className="px-3 pb-2 pt-4">
      <div className="mb-5 flex h-10 items-center justify-between px-2">
        <span className="text-[22px] font-semibold tracking-tight">Tilot</span>
        <SidebarTrigger aria-label="收起侧栏" className="text-muted-foreground" />
      </div>
      <SidebarMenu>
        <SidebarMenuItem><SidebarMenuButton className="h-10 gap-3 rounded-lg px-2 text-base [&>svg]:size-5" disabled={props.busy} onClick={() => navigate(() => props.onNew(null))}><SquarePen /><span>新对话</span></SidebarMenuButton></SidebarMenuItem>
        <SidebarMenuItem><SidebarMenuButton className="h-10 gap-3 rounded-lg px-2 text-base [&>svg]:size-5" disabled={props.busy || !props.connected} onClick={() => navigate(props.onChooseProject)}><FolderPlus /><span>选择项目</span></SidebarMenuButton></SidebarMenuItem>
      </SidebarMenu>
    </SidebarHeader>
    <SidebarContent className="px-1 pt-6">
      <TaskList threads={props.threads} selected={props.selected} disabled={props.busy} onSelect={(id) => navigate(() => props.onSelect(id))} onNew={(path) => navigate(() => props.onNew(path))} />
    </SidebarContent>
    <SidebarFooter className="border-t border-sidebar-border p-3">
      <SidebarMenu><SidebarMenuItem>
        <SidebarMenuButton className="h-10 gap-3 text-[15px] [&>svg]:size-5" disabled={!props.canConfigure} onClick={() => navigate(props.onSettings)}>
          <Settings2 /><span className="flex-1">连接设置</span>
          {props.connected ? <Wifi className="text-emerald-400/70" aria-label="服务已连接" /> : <WifiOff className="text-muted-foreground" aria-label="服务未连接" />}
        </SidebarMenuButton>
      </SidebarMenuItem></SidebarMenu>
    </SidebarFooter>
  </Sidebar>;
}
