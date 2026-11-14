import { useState, type ReactNode } from "react";
import { ChevronDown, Ellipsis, Folder, FolderOpen, Plus, Settings, SquarePen, Trash2 } from "lucide-react";
import type { Thread } from "@tilot/protocol";
import type { WorkspaceState } from "../hooks/use-workspace";
import { groupThreads, projectName } from "../projects";
import { Button } from "../components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "../components/ui/collapsible";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "../components/ui/dialog";
import { Popover, PopoverContent, PopoverTrigger } from "../components/ui/popover";
import { Sidebar, SidebarContent, SidebarFooter, SidebarGroup, SidebarHeader, SidebarMenu, SidebarMenuAction, SidebarMenuButton, SidebarMenuItem } from "../components/ui/sidebar";

/** 按项目组织的真实任务导航。 */
interface TaskNavigationProps {
  threads: Thread[];
  selected: string | null;
  disabled: boolean;
  onSelect: (id: string) => void;
  onNew: (path: string | null) => void;
  onOpenProject: () => void;
  onDelete: (thread: Thread) => Promise<void>;
}

/** 可折叠的分组标题：灰色小字，悬停时显示折叠箭头和右侧操作。 */
function GroupSection({ label, action, children }: { label: string; action: ReactNode; children: ReactNode }) {
  return <SidebarGroup className="py-1">
    <Collapsible defaultOpen className="group/section">
      <div className="group/header flex h-[30px] items-center gap-1 px-2">
        <CollapsibleTrigger className="flex items-center gap-1 rounded-sm text-sm text-sidebar-foreground/45 outline-none transition-colors hover:text-sidebar-foreground/70 focus-visible:ring-2 focus-visible:ring-sidebar-ring">
          {label}
          <ChevronDown className="disclosure-icon size-3.5 opacity-0 transition-[opacity,rotate] group-hover/header:opacity-100 group-data-[state=closed]/section:-rotate-90" />
        </CollapsibleTrigger>
        {action}
      </div>
      <CollapsibleContent>{children}</CollapsibleContent>
    </Collapsible>
  </SidebarGroup>;
}

/** 分组标题右侧的 + 按钮，只在悬停或键盘聚焦时显示。 */
function HeaderAction({ label, disabled, onClick }: { label: string; disabled: boolean; onClick: () => void }) {
  return <Button variant="ghost" size="icon-xs" className="ml-auto text-sidebar-foreground/60 opacity-0 group-hover/header:opacity-100 focus-visible:opacity-100" disabled={disabled} aria-label={label} title={label} onClick={onClick}><Plus className="size-3.5" /></Button>;
}

/** 单条任务；选中项用浅色底突出，标题过长时截断。 */
function ThreadItem({ thread, selected, disabled, indent, onSelect, onDelete }: { thread: Thread; selected: boolean; disabled: boolean; indent: boolean; onSelect: (id: string) => void; onDelete: (thread: Thread) => void }) {
  const [open, setOpen] = useState(false);
  return <SidebarMenuItem className="group/thread">
    <SidebarMenuButton asChild isActive={selected} className={indent ? "pl-8" : undefined}>
      <button title={thread.title} aria-current={selected ? "page" : undefined} disabled={disabled} onClick={() => onSelect(thread.id)}>
        <span className="min-w-0 flex-1 truncate">{thread.title}</span>
      </button>
    </SidebarMenuButton>
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild><SidebarMenuAction type="button" disabled={disabled} aria-label={`对话操作：${thread.title}`} title="对话操作"
        className="text-sidebar-foreground/60 opacity-0 transition-[color,opacity]
          peer-hover/menu-button:text-sidebar-foreground/60 group-hover/thread:opacity-100 focus-visible:opacity-100
          hover:bg-transparent data-[state=open]:text-sidebar-accent-foreground data-[state=open]:opacity-100"><Ellipsis /></SidebarMenuAction></PopoverTrigger>
      <PopoverContent align="start" side="right" className="w-36 p-1">
        <Button type="button" variant="ghost" size="sm" className="w-full justify-start text-destructive hover:text-destructive"
          onClick={() => { setOpen(false); onDelete(thread); }}><Trash2 />删除对话</Button>
      </PopoverContent>
    </Popover>
  </SidebarMenuItem>;
}

/** 项目在前、普通对话在后；项目内任务缩进显示在文件夹下方。 */
export function TaskNavigation({ threads, selected, disabled, onSelect, onNew, onOpenProject, onDelete }: TaskNavigationProps) {
  const [target, setTarget] = useState<Thread | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState("");
  const groups = groupThreads(threads);
  const projectGroups = groups.filter((group) => group.path !== null);
  const chatGroup = groups.find((group) => group.path === null);

  function askDelete(thread: Thread): void {
    setError("");
    setTarget(thread);
  }

  async function confirmDelete(): Promise<void> {
    if (!target || deleting) return;
    setDeleting(true);
    setError("");
    try { await onDelete(target); setTarget(null); }
    catch (failure) { setError(failure instanceof Error ? failure.message : "删除对话失败，请重试。"); }
    finally { setDeleting(false); }
  }

  return <>
    <GroupSection label="项目" action={<HeaderAction label="打开项目" disabled={disabled} onClick={onOpenProject} />}>
      <SidebarMenu>
        {projectGroups.map((group) => <Collapsible key={group.path!} asChild defaultOpen className="group/project">
          <SidebarMenuItem>
            <CollapsibleTrigger asChild>
              <SidebarMenuButton title={group.path!}>
                <Folder className="group-data-[state=open]/project:hidden" /><FolderOpen className="hidden group-data-[state=open]/project:block" />
                <span className="min-w-0 flex-1 truncate">{projectName(group.path)}</span>
              </SidebarMenuButton>
            </CollapsibleTrigger>
            <SidebarMenuAction showOnHover disabled={disabled} aria-label={`在${projectName(group.path)}中新建对话`} title="新建对话" onClick={() => onNew(group.path)}><SquarePen className="size-3.5!" /></SidebarMenuAction>
            <CollapsibleContent><SidebarMenu>
              {group.threads.map((thread) => <ThreadItem key={thread.id} thread={thread} selected={thread.id === selected} disabled={disabled} indent onSelect={onSelect} onDelete={askDelete} />)}
            </SidebarMenu></CollapsibleContent>
          </SidebarMenuItem>
        </Collapsible>)}
        {projectGroups.length === 0 && <SidebarMenuItem>
          <SidebarMenuButton className="text-sidebar-foreground/60" disabled={disabled} onClick={onOpenProject}><Plus /><span>打开项目</span></SidebarMenuButton>
        </SidebarMenuItem>}
      </SidebarMenu>
    </GroupSection>

    <GroupSection label="最近" action={<HeaderAction label="新建对话" disabled={disabled} onClick={() => onNew(null)} />}>
      <SidebarMenu>
        {chatGroup?.threads.map((thread) => <ThreadItem key={thread.id} thread={thread} selected={thread.id === selected} disabled={disabled} indent={false} onSelect={onSelect} onDelete={askDelete} />)}
      </SidebarMenu>
      {!chatGroup && <p className="px-2 py-1.5 text-xs leading-relaxed text-sidebar-foreground/45">未绑定项目的对话会出现在这里。</p>}
    </GroupSection>
    <Dialog open={target !== null} onOpenChange={(open) => { if (!open && !deleting) setTarget(null); }}>
      <DialogContent showCloseButton={false} className="sm:max-w-sm">
        <DialogHeader><DialogTitle>删除对话？</DialogTitle>
          <DialogDescription className="wrap-anywhere">「{target?.title}」的对话记录、草稿和待发送消息将永久删除。</DialogDescription>
        </DialogHeader>
        {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
        <div className="flex justify-end gap-2">
          <Button type="button" variant="outline" disabled={deleting} onClick={() => setTarget(null)}>取消</Button>
          <Button type="button" variant="destructive" disabled={deleting} onClick={() => void confirmDelete()}>{deleting ? "删除中…" : "删除对话"}</Button>
        </div>
      </DialogContent>
    </Dialog>
  </>;
}

/** Codex 风格侧栏：顶部品牌与新对话，中部任务列表，底部设置入口。 */
export function WorkspaceNavigation({ state }: { state: WorkspaceState }) {
  return <Sidebar variant="inset">
    <SidebarHeader className="gap-1 px-2 pt-1 pb-2">
      <div className="flex h-10 items-center px-2 text-lg font-semibold tracking-tight">Tilot</div>
      <SidebarMenu>
        <SidebarMenuItem><SidebarMenuButton disabled={state.busy} onClick={() => state.select(null)}><SquarePen /><span>新对话</span></SidebarMenuButton></SidebarMenuItem>
      </SidebarMenu>
    </SidebarHeader>
    <SidebarContent className="gap-0 px-0"><TaskNavigation threads={state.chat.threads} selected={state.chat.selected} disabled={state.busy}
      onSelect={(id) => state.select(id)} onNew={(path) => state.select(null, path)}
      onOpenProject={() => void state.chooseProject()} onDelete={state.deleteThread} /></SidebarContent>
    <SidebarFooter className="p-2">
      <SidebarMenu><SidebarMenuItem>
        <SidebarMenuButton disabled={!state.chat.config} onClick={() => state.setSettingsOpen(true)}>
          <Settings /><span className="flex-1">设置</span>
          {!state.chat.connected && <span className="text-xs text-sidebar-foreground/45">服务未连接</span>}
        </SidebarMenuButton>
      </SidebarMenuItem></SidebarMenu>
    </SidebarFooter>
  </Sidebar>;
}
