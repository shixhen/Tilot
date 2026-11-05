import { CornerUpLeft, LoaderCircle, X } from "lucide-react";
import type { QueueView } from "../input-queue";
import { Button } from "../components/ui/button";
import { ImageGallery } from "./images";

/** 输入框上方的等待区；成功完成后逐条发送，引导只提交指定消息。 */
export function PendingInputs({ queue, running, connected, onSteer, onRemove, onResume }: {
  queue: QueueView; running: boolean; connected: boolean;
  onSteer: (id: string) => void; onRemove: (id: string) => void; onResume: () => void;
}) {
  if (!queue.messages.length) return null;
  return <section aria-label="等待发送的消息" className="mb-2 min-w-0 rounded-xl border bg-card px-3 py-2 text-sm">
    <div className="mb-1 flex items-center justify-between gap-2 text-xs text-muted-foreground">
      <span role="status">{queue.paused ? "等待已暂停" : "等待发送"} · {queue.messages.length}</span>
      {queue.paused && <Button type="button" variant="ghost" size="sm" className="h-6 px-2 text-xs" disabled={!connected || queue.busy} onClick={onResume}>继续发送</Button>}
    </div>
    <ol className="max-h-48 space-y-1 overflow-y-auto">
      {queue.messages.map((message) => <li key={message.id} className="flex min-w-0 items-start gap-2 rounded-lg px-1 py-1.5">
        <div className="min-w-0 flex-1">{message.content && <p className="whitespace-pre-wrap wrap-anywhere">{message.content}</p>}
          {!!message.images?.length && <ImageGallery images={message.images} />}</div>
        <div className="flex shrink-0 items-center gap-1">
          {message.status !== "waiting" ? <span className="flex items-center gap-1 text-xs text-muted-foreground"><LoaderCircle className="size-3 animate-spin" />{message.status === "steering" ? "提交引导" : "发送中"}</span>
            : <>
              <Button type="button" variant="ghost" size="sm" className="h-6 gap-1 px-2 text-xs" aria-label="引导当前轮次" disabled={!connected || !running || queue.busy} onClick={() => onSteer(message.id)}><CornerUpLeft className="size-3" />引导</Button>
              <Button type="button" variant="ghost" size="icon-xs" aria-label="移除等待消息" onClick={() => onRemove(message.id)}><X /></Button>
            </>}
        </div>
      </li>)}
    </ol>
  </section>;
}
