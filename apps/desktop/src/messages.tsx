import { ChevronRight, CircleAlert, LoaderCircle, Square } from "lucide-react";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "./components/ui/collapsible";
import type { MessagePart } from "@tilot/protocol";
import type { TurnRecord } from "./conversation";
import { MessageMarkdown } from "./markdown";

/** 展示正文、拒绝和可折叠推理，原文不经过 HTML 注入。 */
function Parts({ parts }: { parts: MessagePart[] }) {
  return <>{parts.map((part, index) => part.kind === "reasoning"
    ? <Collapsible className="my-5 text-sm text-muted-foreground" key={index}><CollapsibleTrigger className="group flex items-center gap-2 rounded py-1 focus-visible:outline-2"><ChevronRight className="size-3.5 transition-transform group-data-[state=open]:rotate-90" />思考过程</CollapsibleTrigger><CollapsibleContent className="mt-3 border-l-2 pl-4"><MessageMarkdown text={part.text} /></CollapsibleContent></Collapsible>
    : <div className={part.kind === "refusal" ? "muted" : ""} key={index}><MessageMarkdown text={part.text} /></div>)}</>;
}

/** 按请求的输入边界排列输入与回答，并标注未保存的中断预览。 */
export function TurnMessages({ record }: { record: TurnRecord }) {
  let throughId = 0;
  const content = record.attempts.map((attempt) => {
    const inputs = record.inputs.filter((input) => input.id > throughId && input.id <= attempt.inputThroughId);
    throughId = attempt.inputThroughId;
    return <div key={attempt.id}>
      {inputs.map((input) => <div className="user-message" key={input.id}>{input.content}</div>)}
      {attempt.messages.map((message) => <article className="assistant-message" key={message.itemId}><Parts parts={message.parts} /></article>)}
    </div>;
  });
  const labels = { running: "正在生成", completed: "已完成", failed: "生成失败", cancelled: "已停止", interrupted: "运行已中断" };
  return <section className="mb-10" aria-label="对话轮次">
    {content}
    {record.inputs.filter((input) => input.id > throughId).map((input) => <div className="user-message" key={input.id}>{input.content}</div>)}
    {record.previews.map((preview) => <article className="assistant-message" key={preview.itemId}>
      <Parts parts={preview.parts} />
    </article>)}
    {record.turn.status !== "running" && record.previews.some((preview) => !preview.complete) && <p className="muted">生成未完成，未保存的片段仅作临时预览。</p>}
    {record.turn.status !== "completed" && <p className={`flex items-center gap-2 text-xs leading-6 ${record.turn.status === "failed" ? "text-destructive" : "text-muted-foreground"}`}>
      {record.turn.status === "running" ? <LoaderCircle className="size-3.5 animate-spin" /> : record.turn.status === "cancelled" ? <Square className="size-3" /> : <CircleAlert className="size-3.5" />} {labels[record.turn.status]}{record.turn.error ? ` · ${record.turn.error}` : ""}
    </p>}
  </section>;
}
