import type { Thread } from "@tilot/protocol";
import { ChevronRight, Folder, MessageSquare, Plus } from "lucide-react";
import { groupThreads, projectName } from "./projects";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "./components/ui/collapsible";
import { SidebarGroup, SidebarGroupLabel, SidebarMenu, SidebarMenuAction, SidebarMenuButton, SidebarMenuItem, SidebarMenuSub, SidebarMenuSubButton, SidebarMenuSubItem } from "./components/ui/sidebar";

/** 项目分组与任务选择所需的数据和回调。 */
interface TaskListProps {
  threads: Thread[];
  selected: string | null;
  disabled: boolean;
  onSelect: (id: string) => void;
  onNew: (projectPath: string | null) => void;
}

/** 使用 sidebar-07 的可折叠菜单结构展示项目及任务，同名目录以完整路径区分。 */
export function TaskList({ threads, selected, disabled, onSelect, onNew }: TaskListProps) {
  return <SidebarGroup aria-label="历史任务">
    <SidebarGroupLabel className="mb-2 text-sm text-muted-foreground">项目</SidebarGroupLabel>
    <SidebarMenu>
      {groupThreads(threads).map((group) => <Collapsible key={group.path ?? "ordinary"} asChild defaultOpen className="group/collapsible">
        <SidebarMenuItem>
          <CollapsibleTrigger asChild>
            <SidebarMenuButton title={group.path ?? "普通对话"} className="h-9 gap-3 rounded-lg text-[15px] font-normal [&>svg]:size-[18px]">
              {group.path ? <Folder /> : <MessageSquare />}<span className="flex-1">{projectName(group.path)}</span>
              <ChevronRight className="size-3! text-muted-foreground transition-transform group-data-[state=open]/collapsible:rotate-90" />
            </SidebarMenuButton>
          </CollapsibleTrigger>
          <SidebarMenuAction showOnHover className="top-2" aria-label={`在${projectName(group.path)}中新建对话`} title="新对话" disabled={disabled} onClick={() => onNew(group.path)}><Plus /></SidebarMenuAction>
          <CollapsibleContent>
            <SidebarMenuSub className="mx-0 gap-0.5 border-0 px-0 py-1">
              {group.threads.map((thread) => <SidebarMenuSubItem key={thread.id}>
                <SidebarMenuSubButton asChild isActive={selected === thread.id} className="h-9 w-full rounded-xl pl-9 text-[15px] data-[active=true]:bg-white/[0.08]">
                  <button title={thread.title} aria-current={selected === thread.id ? "page" : undefined} disabled={disabled} onClick={() => onSelect(thread.id)}><span>{thread.title}</span></button>
                </SidebarMenuSubButton>
              </SidebarMenuSubItem>)}
            </SidebarMenuSub>
          </CollapsibleContent>
        </SidebarMenuItem>
      </Collapsible>)}
    </SidebarMenu>
    {threads.length === 0 && <p className="px-2 py-3 text-xs leading-6 text-muted-foreground">发送消息，开始第一个任务</p>}
  </SidebarGroup>;
}
