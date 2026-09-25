import { ChevronRight, Folder, FolderPlus, MessageSquare, Plus, Settings2, SquarePen, Terminal } from "lucide-react";
import type { Thread } from "@tilot/protocol";
import type { WorkspaceState } from "../hooks/use-workspace";
import { groupThreads, projectName } from "../projects";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "../components/ui/collapsible";
import { Sidebar, SidebarContent, SidebarFooter, SidebarGroup, SidebarGroupLabel, SidebarHeader, SidebarMenu, SidebarMenuAction, SidebarMenuButton, SidebarMenuItem, SidebarMenuSub, SidebarMenuSubButton, SidebarMenuSubItem, useSidebar } from "../components/ui/sidebar";

/** 按项目组织的真实任务导航。 */
interface TaskNavigationProps {
  threads: Thread[];
  selected: string | null;
  disabled: boolean;
  onSelect: (id: string) => void;
  onNew: (path: string | null) => void;
}

/** 沿用 sidebar-07 NavMain 的折叠菜单结构，用任务替换模板示例链接。 */
export function TaskNavigation({ threads, selected, disabled, onSelect, onNew }: TaskNavigationProps) {
  return <SidebarGroup>
    <SidebarGroupLabel>项目与对话</SidebarGroupLabel>
    <SidebarMenu>
      {groupThreads(threads).map((group) => <Collapsible key={group.path ?? "chats"} asChild defaultOpen className="group/collapsible">
        <SidebarMenuItem>
          <CollapsibleTrigger asChild>
            <SidebarMenuButton title={group.path ?? "普通对话"}>
              {group.path ? <Folder /> : <MessageSquare />}<span className="min-w-0 flex-1 truncate">{projectName(group.path)}</span>
              <ChevronRight className="transition-transform group-data-[state=open]/collapsible:rotate-90" />
            </SidebarMenuButton>
          </CollapsibleTrigger>
          <SidebarMenuAction showOnHover disabled={disabled} aria-label={`在${projectName(group.path)}中新建对话`} onClick={() => onNew(group.path)}><Plus /></SidebarMenuAction>
          <CollapsibleContent><SidebarMenuSub>
            {group.threads.map((thread) => <SidebarMenuSubItem key={thread.id}>
              <SidebarMenuSubButton asChild isActive={thread.id === selected} className="w-full">
                <button title={thread.title} aria-current={thread.id === selected ? "page" : undefined} disabled={disabled} onClick={() => onSelect(thread.id)}><span>{thread.title}</span></button>
              </SidebarMenuSubButton>
            </SidebarMenuSubItem>)}
          </SidebarMenuSub></CollapsibleContent>
        </SidebarMenuItem>
      </Collapsible>)}
    </SidebarMenu>
    {threads.length === 0 && <p className="px-2 py-4 text-xs leading-relaxed text-muted-foreground">开始对话后，任务会出现在这里。</p>}
  </SidebarGroup>;
}

/** sidebar-07 的品牌、导航、项目与底部账户区，适配为本地工作区。 */
export function WorkspaceNavigation({ state }: { state: WorkspaceState }) {
  const { setOpenMobile } = useSidebar();

  /** 选择目标后关闭移动抽屉，避免遮挡新的内容。 */
  function navigate(action: () => void): void {
    setOpenMobile(false);
    action();
  }

  return <Sidebar variant="inset">
    <SidebarHeader>
      <div className="flex items-center gap-2 px-2 py-2">
        <div className="flex size-8 items-center justify-center rounded-lg bg-sidebar-primary text-sidebar-primary-foreground"><Terminal className="size-4" /></div>
        <div className="grid flex-1 text-left text-sm leading-tight"><span className="font-semibold">Tilot</span><span className="text-xs text-muted-foreground">个人工作区</span></div>
      </div>
      <SidebarMenu>
        <SidebarMenuItem><SidebarMenuButton disabled={state.busy} onClick={() => navigate(() => state.select(null))}><SquarePen /><span>新对话</span></SidebarMenuButton></SidebarMenuItem>
        <SidebarMenuItem><SidebarMenuButton disabled={state.busy || !state.chat.connected} onClick={() => navigate(() => void state.chooseProject())}><FolderPlus /><span>打开项目</span></SidebarMenuButton></SidebarMenuItem>
      </SidebarMenu>
    </SidebarHeader>
    <SidebarContent><TaskNavigation threads={state.chat.threads} selected={state.chat.selected} disabled={state.busy}
      onSelect={(id) => navigate(() => state.select(id))} onNew={(path) => navigate(() => state.select(null, path))} /></SidebarContent>
    <SidebarFooter><SidebarMenu><SidebarMenuItem>
      <SidebarMenuButton size="lg" disabled={!state.chat.config} onClick={() => navigate(() => state.setSettingsOpen(true))}>
        <div className="flex size-8 items-center justify-center rounded-lg border bg-background"><Settings2 className="size-4" /></div>
        <div className="grid flex-1 text-left leading-tight"><span className="font-medium">连接设置</span><span className="text-xs text-muted-foreground">{state.chat.connected ? state.chat.config?.model : "服务未连接"}</span></div>
      </SidebarMenuButton>
    </SidebarMenuItem></SidebarMenu></SidebarFooter>
  </Sidebar>;
}
