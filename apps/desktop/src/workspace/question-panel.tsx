import { memo, useState } from "react";
import { Questionnaire } from "@shadcn/react/questionnaire";
import { X } from "lucide-react";
import type { QuestionAnswer, QuestionDraft } from "@tilot/protocol";
import type { QuestionState } from "../questions";
import { Button } from "../components/ui/button";
import { Card } from "../components/ui/card";
import { Textarea } from "../components/ui/textarea";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "../components/ui/dialog";

/** 使用官方 Questionnaire 的语义、选项和输入控件；持久草稿是答题状态的唯一来源。 */
export const QuestionPanel = memo(function QuestionPanel({ state, connected, onEdit, onSubmit, onClose, onRetry }: {
  state: QuestionState | null; connected: boolean;
  onEdit: (draft: QuestionDraft) => void; onSubmit: () => void; onClose: () => void; onRetry: () => void;
}) {
  const [confirmClose, setConfirmClose] = useState(false);
  if (!state) return null;
  const { question, draft, busy, error } = state;
  const last = draft.activeIndex === question.questions.length - 1;
  const current = draft.answers[draft.activeIndex]!;
  const answered = (answer: QuestionAnswer) => answer.mode !== "unanswered";
  const complete = draft.answers.every(answered);
  const items = question.questions.map((q, index) => ({ name: String(index), choices: q.options.map((_, i) => ({ value: String(i), disabled: busy })) }));
  function editAnswer(index: number, answer: QuestionAnswer, advance = false): void {
    const answers = draft.answers.map((old, i) => i === index ? answer : old);
    onEdit({ activeIndex: advance ? Math.min(index + 1, answers.length - 1) : index, answers });
  }
  function next(): void { if (answered(current) && !last) onEdit({ ...draft, activeIndex: draft.activeIndex + 1 }); }
  function close(): void {
    if (draft.answers.some((answer) => answer.mode !== "unanswered" || answer.text.length > 0)) setConfirmClose(true);
    else onClose();
  }
  return <>
    <Card className="mb-3 max-h-[50dvh] min-h-0 gap-0 overflow-hidden py-0" aria-label="待回答问题">
      <Questionnaire.Root items={items} item={String(draft.activeIndex)}
        onItemChange={(item) => onEdit({ ...draft, activeIndex: Number(item) })}
        className="flex min-h-0 flex-col text-sm"
        onSubmitCapture={(event) => { event.preventDefault(); event.stopPropagation(); if (complete && connected && !busy) onSubmit(); }}>
        <div className="flex shrink-0 items-center justify-between border-b px-3 py-2">
          <Questionnaire.Progress aria-label="答题进度">第 {draft.activeIndex + 1}／{items.length} 题</Questionnaire.Progress>
          <Button type="button" variant="ghost" size="icon-xs" aria-label="关闭本组问题" disabled={busy || !connected} onClick={close}><X /></Button>
        </div>
        <div className="min-h-0 overflow-y-auto px-3 py-3">
          {question.questions.map((q, index) => {
            const answer = draft.answers[index]!;
            const order = q.options.map((text, i) => ({ text, i }));
            if (q.recommendedIndex !== undefined) order.unshift(...order.splice(q.recommendedIndex, 1));
            return <Questionnaire.Item key={index} name={String(index)} className="min-w-0 border-0 p-0">
              <Questionnaire.Title className="mb-3 w-full whitespace-pre-wrap break-words font-medium">{q.title}</Questionnaire.Title>
              <Questionnaire.Choices className="grid min-w-0 gap-2">
                {order.map(({ text, i }, position) => <Questionnaire.Choice key={i} value={String(i)} disabled={busy} checked={answer.mode === "option" && answer.optionIndex === i}
                  onChange={() => editAnswer(index, { ...answer, mode: "option", optionIndex: i }, true)}
                  onClick={() => { if (answer.mode === "option" && answer.optionIndex === i) next(); }}
                  className={`flex cursor-pointer items-start gap-2 rounded-md border p-2.5 has-focus-visible:ring-2 has-focus-visible:ring-ring ${answer.mode === "option" && answer.optionIndex === i ? "border-ring bg-accent" : answer.mode === "unanswered" && position === 0 ? "bg-muted/50" : "hover:bg-accent/50"}`}>
                  <Questionnaire.ChoiceInput className="mt-1 shrink-0 accent-current" />
                  <Questionnaire.ChoiceLabel className="min-w-0 whitespace-pre-wrap break-words">{text}{q.recommendedIndex === i && <span className="ml-2 text-xs text-muted-foreground">推荐</span>}</Questionnaire.ChoiceLabel>
                </Questionnaire.Choice>)}
                <Questionnaire.Input render={<Textarea rows={2} />} disabled={busy} aria-label={`第 ${index + 1} 题的自定义答案`} placeholder="输入自己的答案…"
                  value={answer.mode === "text" ? answer.text : ""}
                  onFocus={() => { if (answer.mode !== "text" && answer.text.trim()) editAnswer(index, { ...answer, mode: "text" }); }}
                  onChange={(event) => editAnswer(index, { ...answer, mode: event.target.value.trim() ? "text" : "unanswered", text: event.target.value })}
                  onKeyDown={(event) => {
                    if (event.key !== "Enter") return;
                    event.stopPropagation();
                    if (event.ctrlKey && !event.nativeEvent.isComposing) {
                      event.preventDefault();
                      if (last) { if (complete && connected && !busy) onSubmit(); }
                      else next();
                    }
                  }} className="min-h-18 max-h-36 resize-none" />
              </Questionnaire.Choices>
            </Questionnaire.Item>;
          })}
        </div>
        {error && <div role="alert" className="flex shrink-0 items-center gap-2 px-3 pb-2 text-xs text-destructive"><span className="min-w-0 break-words">{error}</span><Button type="button" variant="ghost" size="xs" disabled={!connected || busy} onClick={onRetry}>重试</Button></div>}
        <div className="flex shrink-0 items-center gap-2 border-t px-3 py-2">
          <Button type="button" variant="outline" size="sm" disabled={busy || draft.activeIndex === 0} onClick={() => onEdit({ ...draft, activeIndex: draft.activeIndex - 1 })}>上一题</Button>
          <div className="flex-1" />
          <Button type="button" variant="ghost" size="sm" disabled={busy} onClick={() => editAnswer(draft.activeIndex, { ...current, mode: "skipped" }, true)}>跳过此题</Button>
          {last ? <Button type="button" size="sm" disabled={!connected || busy || !complete} onClick={onSubmit}>{busy ? "提交中…" : "提交答案"}</Button>
            : <Button type="button" size="sm" disabled={busy || !answered(current)} onClick={next}>下一题</Button>}
        </div>
      </Questionnaire.Root>
    </Card>
    <Dialog open={confirmClose} onOpenChange={setConfirmClose}><DialogContent>
      <DialogTitle>放弃这组问题？</DialogTitle><DialogDescription>已填写的答案不会发送，关闭后不能继续提交这组问题。</DialogDescription>
      <div className="flex justify-end gap-2"><Button type="button" variant="outline" onClick={() => setConfirmClose(false)}>继续填写</Button><Button type="button" disabled={busy || !connected} onClick={() => { setConfirmClose(false); onClose(); }}>放弃本组</Button></div>
    </DialogContent></Dialog>
  </>;
});
