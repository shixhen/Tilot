import { ArrowUp, ChevronDown, Folder, LoaderCircle, Plus, Square, X } from "lucide-react";
import type { WorkspaceState } from "../hooks/use-workspace";
import { projectName } from "../projects";
import { Button } from "../components/ui/button";
import { Card, CardContent, CardFooter } from "../components/ui/card";
import { Textarea } from "../components/ui/textarea";

/** 使用标准 Card、Textarea 和 Button 组合输入区，保留中文输入法和多行编辑行为。 */
export function Composer({ state }: { state: WorkspaceState }) {
  const editor = useRef<HTMLTextAreaElement>(null);

  /** 固定宽度后按实际换行测量高度，最多 200px，删减内容时同步缩小。 */
  function resizeEditor(): void {
    const node = editor.current;
    if (!node) return;
    node.style.height = "0px";
    node.style.height = `${Math.min(node.scrollHeight, 200)}px`;
  }

  useLayoutEffect(resizeEditor, [state.draft]);
  useLayoutEffect(() => {
    const node = editor.current!;
    let width = node.clientWidth;
    // 只响应宽度变化，避免自身高度更新反复触发测量。
    const observer = new ResizeObserver(() => {
      if (node.clientWidth === width) return;
      width = node.clientWidth;
      resizeEditor();
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  return <form className="min-w-0 w-full" onSubmit={(event) => void state.submit(event)}>
    <Card className="min-w-0 gap-0 py-0 shadow-sm">
      <CardContent className="min-w-0 p-2">
        <Textarea ref={editor} rows={1} value={state.draft} disabled={state.busy} aria-label="消息" placeholder="描述任务，或提出一个问题…"
          className="field-sizing-fixed min-h-10 max-h-50 min-w-0 max-w-full resize-none overflow-x-hidden overflow-y-auto border-0 bg-transparent! leading-6 [overflow-wrap:anywhere] shadow-none focus-visible:ring-0"
          onChange={(event) => state.editDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing && event.keyCode !== 229) {
              event.preventDefault();
              event.currentTarget.form?.requestSubmit();
            }
          }} />
      </CardContent>
      <CardFooter className="flex-wrap justify-between gap-2 px-3 py-2!">
        <div className="flex min-w-0 items-center gap-1">
          <Button type="button" variant="ghost" size="icon-sm" aria-label={state.chat.selected ? "新建对话" : "选择项目"} title={state.chat.selected ? "新建对话" : "选择项目"}
            disabled={state.busy || !state.chat.connected} onClick={() => state.chat.selected ? state.select(null, state.projectPath) : void state.chooseProject()}><Plus /></Button>
          {state.projectPath && <>
            <span className="flex min-w-0 max-w-40 items-center gap-2 text-xs text-muted-foreground" title={state.projectPath}><Folder className="size-3.5 shrink-0" /><span className="truncate">{projectName(state.projectPath)}</span></span>
            {!state.chat.selected && <Button type="button" variant="ghost" size="icon-xs" aria-label="取消选择项目" disabled={state.busy} onClick={() => state.select(null)}><X /></Button>}
          </>}
        </div>
        <div className="ml-auto flex min-w-0 items-center gap-2">
          <Button type="button" variant="ghost" size="sm" className="max-w-44 min-w-0 font-normal" disabled={!state.chat.config} onClick={() => state.setSettingsOpen(true)}>
            <span className="truncate">{state.chat.config?.model ?? (state.chat.error ? "未连接" : "连接中")}</span><ChevronDown />
          </Button>
          {state.running
            ? <Button type="button" size="icon-sm" className="rounded-full" aria-label="停止生成" disabled={!state.chat.connected} onClick={() => void state.chat.stop(state.running!.turn.id)}><Square className="size-3 fill-current" /></Button>
            : <Button type="submit" size="icon-sm" className="rounded-full" aria-label="发送消息" disabled={!state.canSend}>{state.busy ? <LoaderCircle className="animate-spin" /> : <ArrowUp />}</Button>}
        </div>
      </CardFooter>
    </Card>
  </form>;
}
import { useLayoutEffect, useRef } from "react";
