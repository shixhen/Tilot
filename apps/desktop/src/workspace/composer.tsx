import { useLayoutEffect, useRef } from "react";
import { ArrowUp, Folder, LoaderCircle, Plus, Square, X } from "lucide-react";
import type { WorkspaceState } from "../hooks/use-workspace";
import { projectName } from "../projects";
import { Button } from "../components/ui/button";
import { Card, CardContent, CardFooter } from "../components/ui/card";
import { Textarea } from "../components/ui/textarea";
import { ModelPicker } from "./model-picker";

/** Codex 风格输入框：圆角卡片内上方输入、下方工具栏，保留中文输入法和多行编辑行为。 */
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
    <Card className="min-w-0 gap-0 rounded-[20px] border-0 py-0 shadow-lg shadow-black/20">
      <CardContent className="min-w-0 px-4 pt-3.5 pb-1">
        <Textarea ref={editor} rows={1} value={state.draft} disabled={state.busy} aria-label="消息" placeholder="描述任务，或提出一个问题…"
          className="field-sizing-fixed min-h-9 max-h-50 min-w-0 w-full resize-none overflow-x-hidden overflow-y-auto rounded-none border-0 bg-transparent! p-0 text-[15px] leading-6 [overflow-wrap:anywhere] shadow-none placeholder:text-[#686868] focus-visible:ring-0"
          onChange={(event) => state.editDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing && event.keyCode !== 229) {
              event.preventDefault();
              event.currentTarget.form?.requestSubmit();
            }
          }} />
      </CardContent>
      <CardFooter className="flex items-center justify-between gap-2 px-2.5 pt-0 pb-2.5">
        <div className="flex min-w-0 items-center gap-1">
          <Button type="button" variant="ghost" size="icon-sm" className="rounded-full hover:bg-white/10!" aria-label={state.chat.selected ? "新建对话" : "选择项目"} title={state.chat.selected ? "新建对话" : "选择项目"}
            disabled={state.busy || !state.chat.connected} onClick={() => state.chat.selected ? state.select(null, state.projectPath) : void state.chooseProject()}><Plus className="size-5" /></Button>
          {state.projectPath && <span className="flex h-7 min-w-0 items-center gap-1.5 rounded-full px-2 text-sm text-muted-foreground" title={state.projectPath}>
            <Folder className="size-4 shrink-0" /><span className="max-w-40 truncate">{projectName(state.projectPath)}</span>
            {!state.chat.selected && <Button type="button" variant="ghost" size="icon-xs" className="size-5 rounded-full" aria-label="取消选择项目" disabled={state.busy} onClick={() => state.select(null)}><X /></Button>}
          </span>}
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          {/* 已有任务显示它自己的模型，新对话显示默认值。 */}
          {state.choice && state.chat.config
            ? <ModelPicker providerId={state.choice.providerId} model={state.choice.model} reasoningEffort={state.choice.reasoningEffort}
              providers={state.chat.config.providers} onChange={state.chooseModel} />
            : <span className="px-2.5 text-sm text-muted-foreground">{state.chat.error ? "未连接" : "连接中"}</span>}
          {state.running
            ? <Button type="button" size="icon-sm" className="rounded-full bg-foreground text-background hover:bg-foreground/85" aria-label="停止生成" title="停止生成" disabled={!state.chat.connected} onClick={() => void state.chat.stop(state.running!.turn.id)}><Square className="size-3 fill-current" /></Button>
            : <Button type="submit" size="icon-sm" className="rounded-full bg-brand text-white hover:bg-brand/90 disabled:bg-white/10 disabled:text-muted-foreground disabled:opacity-100" aria-label="发送消息" title="发送 (Enter)" disabled={!state.canSend}>{state.busy ? <LoaderCircle className="animate-spin" /> : <ArrowUp />}</Button>}
        </div>
      </CardFooter>
    </Card>
  </form>;
}
