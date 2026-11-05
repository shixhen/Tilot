import type { Turn, TurnInput } from "./protocol.ts";

export interface UserQuestion { title: string; options: string[]; recommendedIndex?: number }
export interface QuestionAnswer { mode: "option" | "text" | "unanswered" | "skipped"; optionIndex: number | null; text: string }
export interface QuestionDraft { activeIndex: number; answers: QuestionAnswer[] }
export interface QuestionGroup {
  id: string; threadId: string; turnId: string; questions: UserQuestion[]; draft: QuestionDraft;
  status: "pending" | "answered" | "closed"; inputId: number | null; createdAt: number;
}
export interface QuestionDelivery { question: QuestionGroup; input: TurnInput; turn: Turn }

/** 通信边界和工具共用校验；不静默截断模型问题或用户答案。 */
export function parseQuestions(value: unknown): UserQuestion[] {
  if (!Array.isArray(value) || !value.length) throw new Error("questions 必须是非空数组。");
  return value.map((item: unknown) => {
    if (!item || typeof item !== "object") throw new Error("问题格式无效。");
    const q = item as Record<string, unknown>;
    if (Object.keys(q).some((key) => !["title", "options", "recommendedIndex"].includes(key))) throw new Error("问题包含未支持的字段。");
    if (typeof q.title !== "string" || !q.title.trim()) throw new Error("问题正文不能为空。");
    const options = q.options ?? [];
    if (!Array.isArray(options) || options.length > 4 || options.some((v) => typeof v !== "string" || !v.trim())) throw new Error("每题允许 0–4 个非空文字选项。");
    const recommended = q.recommendedIndex;
    if (recommended !== undefined && (!Number.isInteger(recommended) || (recommended as number) < 0 || (recommended as number) >= options.length)) throw new Error("recommendedIndex 必须指向一个有效选项。");
    return { title: q.title, options: [...options], ...(recommended === undefined ? {} : { recommendedIndex: recommended as number }) };
  });
}

export function emptyQuestionDraft(questions: UserQuestion[]): QuestionDraft {
  return { activeIndex: 0, answers: questions.map(() => ({ mode: "unanswered", optionIndex: null, text: "" })) };
}

export function parseQuestionDraft(value: unknown, questions: UserQuestion[], complete = false): QuestionDraft {
  if (!value || typeof value !== "object") throw new Error("答案草稿无效。");
  const draft = value as QuestionDraft;
  if (!Number.isInteger(draft.activeIndex) || draft.activeIndex < 0 || draft.activeIndex >= questions.length ||
      !Array.isArray(draft.answers) || draft.answers.length !== questions.length) throw new Error("答案数量或当前题号无效。");
  const answers = draft.answers.map((answer, index) => {
    if (!answer || typeof answer.text !== "string" || !["option", "text", "unanswered", "skipped"].includes(answer.mode) ||
        (answer.optionIndex !== null && (!Number.isInteger(answer.optionIndex) || answer.optionIndex < 0 || answer.optionIndex >= questions[index]!.options.length))) throw new Error("答案格式或选项无效。");
    if (answer.mode === "option" && answer.optionIndex === null) throw new Error("请选择一个选项。");
    if (answer.mode === "text" && !answer.text.trim()) throw new Error("文字答案不能为空。");
    if (complete && answer.mode === "unanswered") throw new Error(`第 ${index + 1} 题尚未回答，请回答或明确跳过。`);
    return { mode: answer.mode, optionIndex: answer.optionIndex, text: answer.text };
  });
  return { activeIndex: draft.activeIndex, answers };
}

/** 整组作为一条正式用户消息，使用稳定组标识关联原问题；不发送未选用的文字草稿。 */
export function questionReply(group: QuestionGroup, draft: QuestionDraft): string {
  const answers = parseQuestionDraft(draft, group.questions, true).answers;
  return `对提问 ${group.id} 的回答：\n\n` + group.questions.map((question, index) => {
    const answer = answers[index]!;
    const text = answer.mode === "skipped" ? "已跳过" : answer.mode === "text" ? answer.text : question.options[answer.optionIndex!]!;
    return `问题 ${index + 1}：${question.title}\n回答：${text}`;
  }).join("\n\n");
}
