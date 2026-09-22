import { useEffect, useRef, type FormEvent } from "react";
import { ArrowUp, ChevronDown, Folder, Plus, ShieldAlert, Square, X } from "lucide-react";
import { projectName } from "../projects";
import { Button } from "./ui/button";
import { Textarea } from "./ui/textarea";

/** 输入区只接收当前草稿及操作，任务创建和请求状态由页面管理。 */
interface ChatComposerProps {
  value: string;
  model: string | undefined;
  projectPath: string | null;
  hasTask: boolean;
  connected: boolean;
  busy: boolean;
  running: boolean;
  canSend: boolean;
  onChange: (value: string) => void;
  onSubmit: (event: FormEvent) => void;
  onNew: () => void;
  onChooseProject: () => void;
  onClearProject: () => void;
  onSettings: () => void;
  onStop: () => void;
}

/** 组合 shadcn 输入和按钮，统一草稿编辑、项目上下文、模型与发送操作。 */
export function ChatComposer({ value, model, projectPath, hasTask, connected, busy, running, canSend, onChange, onSubmit, onNew, onChooseProject, onClearProject, onSettings, onStop }: ChatComposerProps) {
  const editor = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    if (!editor.current) return;
    editor.current.style.height = "auto";
    editor.current.style.height = `${Math.min(editor.current.scrollHeight, 220)}px`;
  }, [value]);

  return <form className="chat-composer" onSubmit={onSubmit}>
          <Textarea className="composer-editor" ref={editor} aria-label="消息" placeholder={projectPath ? "描述你想完成的任务" : "询问、讨论，或开始一个想法"} value={value} disabled={busy}
            onChange={(event) => onChange(event.target.value)}
            onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing && event.keyCode !== 229) { event.preventDefault(); event.currentTarget.form?.requestSubmit(); } }} />
          <div className="composer-toolbar"><div className="flex min-w-0 items-center gap-1">
            <Button type="button" variant="ghost" size="icon-sm" aria-label={hasTask ? (projectPath ? "在此项目新建对话" : "新建对话") : "选择项目"} title={hasTask ? (projectPath ? "在此项目新建对话" : "新建对话") : "选择项目"} disabled={busy || !connected} onClick={() => hasTask ? onNew() : onChooseProject()}><Plus /></Button>
            {projectPath && <><span className="flex max-w-40 items-center gap-1.5 text-xs text-muted-foreground" title={projectPath}><Folder size={14} /><span className="truncate">{projectName(projectPath)}</span></span>{!hasTask && <Button type="button" variant="ghost" size="icon-xs" aria-label="取消选择项目" onClick={() => onClearProject()} disabled={busy}><X /></Button>}<span className="access-label" title="命令和文件修改直接执行"><ShieldAlert size={15} />完全访问</span></>}
          </div><div className="ml-auto flex min-w-0 items-center gap-2">
            <Button type="button" variant="ghost" size="sm" className="model-selector" disabled={!model} onClick={() => onSettings()}><span>{model ?? "连接中…"}</span><ChevronDown size={14} /></Button>
            {running ? <Button type="button" size="icon" className="send-button" aria-label="停止生成" disabled={!connected} onClick={() => onStop()}><Square className="size-3 fill-current" /></Button>
              : <Button type="submit" size="icon" className="send-button" aria-label="发送消息" disabled={!canSend}><ArrowUp /></Button>}
          </div></div>
        </form>;
}
