import { useLayoutEffect, useRef, useState } from "react";
import { ArrowUp, LoaderCircle, Plus, Square, X } from "lucide-react";
import type { WorkspaceState } from "../hooks/use-workspace";
import { Button } from "../components/ui/button";
import { Card, CardContent, CardFooter } from "../components/ui/card";
import { Textarea } from "../components/ui/textarea";
import { ModelPicker } from "./model-picker";
import { PendingInputs } from "./pending-inputs";
import { PermissionPicker } from "./permission-picker";
import { ApprovalPanel } from "./approval-panel";
import { QuestionPanel } from "./question-panel";
import { ImageGallery } from "./images";
import { Popover, PopoverContent, PopoverTrigger } from "../components/ui/popover";

/** Codex 风格输入框：圆角卡片内上方输入、下方工具栏，保留中文输入法和多行编辑行为。 */
export function Composer({ state }: { state: WorkspaceState }) {
  const editor = useRef<HTMLTextAreaElement>(null);
  const [menu, setMenu] = useState(false);

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

  return <div className="min-w-0 w-full" onPaste={(event) => {
    const files = Array.from(event.clipboardData.files).filter((file) => file.type.startsWith("image/"));
    if (files.length) { event.preventDefault(); state.addImages(files); }
  }}>
    <PendingInputs queue={state.chat.queue} running={!!state.running} connected={state.chat.connected}
      onSteer={(id) => void state.chat.steer(id)} onRemove={state.chat.removeQueued} onResume={state.chat.resumeQueue} />
    <QuestionPanel state={state.chat.question} connected={state.chat.connected} onEdit={state.chat.editQuestion}
      onSubmit={state.chat.submitQuestion} onClose={state.chat.closeQuestion} onRetry={state.chat.retryQuestion} />
    <ApprovalPanel approval={state.chat.approvals[0]} disabled={!state.chat.connected || state.chat.approvalBusy}
      onRespond={(allowed) => void state.chat.respondApproval(state.chat.approvals[0]!.id, allowed)} />
    <form onSubmit={(event) => void state.submit(event)}><Card className="min-w-0 gap-0 rounded-[20px] border-0 py-0 shadow-lg shadow-black/20">
      <CardContent className="min-w-0 px-4 pt-3.5 pb-1">
        {state.attachments.length > 0 && <div aria-label="图片附件" className="mb-3 flex max-h-44 flex-wrap gap-2 overflow-auto">
          {state.attachments.map((attachment) => <div key={attachment.id} className="relative rounded-lg border p-1">
            {attachment.image ? <ImageGallery images={[attachment.image]} /> : <div className="flex min-h-20 w-40 flex-col justify-center gap-1 px-2 text-xs">
              <span className="truncate">{attachment.name}</span>
              {attachment.error ? <><span role="alert" className="break-all text-destructive">{attachment.error}</span><Button type="button" variant="ghost" size="sm" disabled={!state.chat.connected} onClick={() => state.retryImage(attachment.id)}>重试</Button></>
                : <span className="flex items-center gap-1 text-muted-foreground"><LoaderCircle className="size-3 animate-spin" />正在添加…</span>}
            </div>}
            <Button type="button" size="icon-xs" variant="secondary" className="absolute top-0 right-0 rounded-full" aria-label={`移除图片 ${attachment.name}`} onClick={() => state.removeImage(attachment.id)}><X /></Button>
          </div>)}
        </div>}
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
      <CardFooter className="flex flex-wrap items-center justify-between gap-2 px-2.5 pt-0 pb-2.5">
        <div className="flex min-w-0 items-center gap-1">
          <Popover open={menu} onOpenChange={setMenu}><PopoverTrigger asChild><Button type="button" variant="ghost" size="icon-sm" className="rounded-full hover:bg-white/10!" aria-label="添加" title="添加" disabled={state.busy || !state.chat.connected}><Plus className="size-5" /></Button></PopoverTrigger>
            <PopoverContent align="start" side="top" className="grid w-40 gap-1 p-1">
              <Button type="button" variant="ghost" className="justify-start" onClick={() => { setMenu(false); void state.chooseImages(); }}>上传图片</Button>
              <Button type="button" variant="ghost" className="justify-start" onClick={() => { setMenu(false); state.select(null, state.projectPath); }}>新建对话</Button>
              <Button type="button" variant="ghost" className="justify-start" onClick={() => { setMenu(false); void state.chooseProject(); }}>选择项目</Button>
            </PopoverContent></Popover>
          <PermissionPicker mode={state.permissionMode} project={state.projectPath !== null}
            locked={state.thread?.permissionLockedAt != null} disabled={state.busy || !state.chat.connected}
            onChange={(mode) => void state.chat.choosePermission(mode)} />
        </div>
        <div className="ml-auto flex shrink-0 items-center gap-1.5">
          {/* 已有任务显示它自己的模型，新对话显示默认值。 */}
          {state.choice && state.chat.config
            ? <ModelPicker providerId={state.choice.providerId} model={state.choice.model} reasoningEffort={state.choice.reasoningEffort}
              providers={state.chat.config.providers} onChange={state.chooseModel} />
            : <span className="px-2.5 text-sm text-muted-foreground">{state.chat.error ? "未连接" : "连接中"}</span>}
          {state.running && <Button type="button" size="icon-sm" className="rounded-full bg-foreground text-background hover:bg-foreground/85" aria-label="停止生成" title="停止生成" disabled={!state.chat.connected} onClick={() => void state.chat.stop(state.running!.turn.id)}><Square className="size-3 fill-current" /></Button>}
          {(!state.running || state.canSend) && <Button type="submit" size="icon-sm" className="rounded-full bg-brand text-white hover:bg-brand/90 disabled:bg-white/10 disabled:text-muted-foreground disabled:opacity-100" aria-label={state.running ? "加入等待区" : "发送消息"} title={state.running ? "加入等待区 (Enter)" : "发送 (Enter)"} disabled={!state.canSend}>{state.busy ? <LoaderCircle className="animate-spin" /> : <ArrowUp />}</Button>}
        </div>
      </CardFooter>
    </Card></form>
  </div>;
}
