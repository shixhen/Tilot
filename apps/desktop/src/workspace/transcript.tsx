import { ChevronRight, CircleAlert, LoaderCircle, Square } from "lucide-react";
import type { MessagePart } from "@tilot/protocol";
import type { TurnRecord } from "../conversation";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "../components/ui/collapsible";
import { MessageMarkdown } from "./markdown";

/** 渲染同一条回答的推理、正文和拒绝信息。 */
function MessageParts({ parts }: { parts: MessagePart[] }) {
  return <div className="grid gap-4">{parts.map((part, index) => part.kind === "reasoning"
    ? <Collapsible key={index} className="text-sm text-muted-foreground">
      <CollapsibleTrigger className="group flex items-center gap-2 rounded-md py-1 outline-none focus-visible:ring-2 focus-visible:ring-ring"><ChevronRight className="size-3.5 transition-transform group-data-[state=open]:rotate-90" />思考过程</CollapsibleTrigger>
      <CollapsibleContent className="mt-3 border-l pl-4"><MessageMarkdown text={part.text} /></CollapsibleContent>
    </Collapsible>
    : <div key={index} className={part.kind === "refusal" ? "text-muted-foreground" : undefined}><MessageMarkdown text={part.text} /></div>)}</div>;
}

/** 用户消息使用主题的次级背景，不再使用独立蓝色气泡。 */
function UserMessage({ text }: { text: string }) {
  return <div className="ml-auto max-w-[85%] rounded-xl bg-muted px-4 py-3 text-sm leading-7 whitespace-pre-wrap wrap-anywhere">{text}</div>;
}

/** 按模型请求的输入边界显示正式历史与实时预览，不改变消息顺序。 */
export function TurnMessages({ record }: { record: TurnRecord }) {
  let throughId = 0;
  const history = record.attempts.map((attempt) => {
    const inputs = record.inputs.filter((input) => input.id > throughId && input.id <= attempt.inputThroughId);
    throughId = attempt.inputThroughId;
    return <div key={attempt.id} className="grid gap-6">
      {inputs.map((input) => <UserMessage key={input.id} text={input.content} />)}
      {attempt.messages.map((message) => <article key={message.itemId}><MessageParts parts={message.parts} /></article>)}
    </div>;
  });
  const status = record.turn.status;
  const labels = { running: "正在生成", completed: "已完成", cancelled: "已停止", interrupted: "运行已中断", failed: "生成失败" };
  return <section aria-label="对话轮次" className="grid gap-6">
    {history}
    {record.inputs.filter((input) => input.id > throughId).map((input) => <UserMessage key={input.id} text={input.content} />)}
    {record.previews.map((preview) => <article key={preview.itemId}><MessageParts parts={preview.parts} /></article>)}
    {status !== "running" && record.previews.some((preview) => !preview.complete) && <p className="text-xs text-muted-foreground">未保存的生成片段仅作临时预览。</p>}
    {status !== "completed" && <p role="status" className={`flex items-center gap-2 text-xs ${status === "failed" ? "text-destructive" : "text-muted-foreground"}`}>
      {status === "running" ? <LoaderCircle className="size-3.5 animate-spin" /> : status === "cancelled" ? <Square className="size-3" /> : <CircleAlert className="size-3.5" />}
      {labels[status]}{record.turn.error && ` · ${record.turn.error}`}
    </p>}
  </section>;
}
