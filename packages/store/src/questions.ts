import type Database from "better-sqlite3";
import { emptyQuestionDraft, parseQuestionDraft, parseQuestions, questionReply, type QuestionDraft, type QuestionGroup, type TurnInput, type UserQuestion } from "@tilot/protocol";

interface QuestionRow extends Omit<QuestionGroup, "questions" | "draft"> { questionsJson: string; draftJson: string }

/** 问题、草稿与最终输入共用 SQLite 事务；一组提交只产生一条用户输入。 */
export class QuestionStore {
  private readonly database: Database.Database;
  constructor(database: Database.Database) { this.database = database; }

  get(id: string): QuestionGroup | undefined {
    const row = this.database.prepare<[string], QuestionRow>("SELECT * FROM user_questions WHERE id = ?").get(id);
    if (!row) return undefined;
    const { questionsJson, draftJson, ...group } = row;
    return { ...group, questions: JSON.parse(questionsJson), draft: JSON.parse(draftJson) };
  }

  pending(threadId: string): QuestionGroup | null {
    const row = this.database.prepare<[string], { id: string }>("SELECT id FROM user_questions WHERE threadId = ? AND status = 'pending'").get(threadId);
    return row ? this.get(row.id)! : null;
  }

  create(toolId: string, questions: UserQuestion[]): QuestionGroup {
    return this.database.transaction(() => {
      const existing = this.get(toolId);
      if (existing) return existing;
      const owner = this.database.prepare<[string], { threadId: string; turnId: string }>(`
        SELECT turns.threadId, turns.id AS turnId FROM tool_calls
        JOIN model_attempts ON model_attempts.id = tool_calls.attemptId JOIN turns ON turns.id = model_attempts.turnId
        WHERE tool_calls.id = ? AND tool_calls.startedAt IS NOT NULL AND tool_calls.resultJson IS NULL
          AND model_attempts.status = 'completed' AND turns.status = 'running'
      `).get(toolId);
      if (!owner) throw new Error("问题只能由已开始执行的完整工具调用提出。");
      const pending = this.pending(owner.threadId);
      if (pending) throw new Error(`已有待回答问题 ${pending.id}，不能重复提问。请继续不依赖答案的工作；没有独立工作时结束本轮。`);
      const parsed = parseQuestions(questions);
      this.database.prepare(`INSERT INTO user_questions (id, threadId, turnId, questionsJson, draftJson, status, createdAt)
        VALUES (?, ?, ?, ?, ?, 'pending', ?)`).run(toolId, owner.threadId, owner.turnId, JSON.stringify(parsed), JSON.stringify(emptyQuestionDraft(parsed)), Date.now());
      return this.get(toolId)!;
    }).immediate();
  }

  saveDraft(id: string, value: unknown): QuestionGroup {
    const group = this.requirePending(id);
    const draft = parseQuestionDraft(value, group.questions);
    this.database.prepare("UPDATE user_questions SET draftJson = ? WHERE id = ? AND status = 'pending'").run(JSON.stringify(draft), id);
    return this.get(id)!;
  }

  close(id: string): QuestionGroup {
    const group = this.get(id);
    if (!group) throw new Error("问题不存在。");
    if (group.status === "answered") throw new Error("该组答案已提交。");
    this.database.prepare("UPDATE user_questions SET status = 'closed' WHERE id = ? AND status = 'pending'").run(id);
    return this.get(id)!;
  }

  submit(id: string, value: QuestionDraft, write: (threadId: string, content: string) => TurnInput): { question: QuestionGroup; input: TurnInput } {
    return this.database.transaction(() => {
      const group = this.get(id);
      if (!group || group.status === "closed") throw new Error("问题不存在或已关闭。");
      const draft = parseQuestionDraft(value, group.questions, true);
      const content = questionReply(group, draft);
      if (group.status === "answered") {
        const input = this.database.prepare<[number], TurnInput>("SELECT id, turnId, content, createdAt FROM turn_inputs WHERE id = ?").get(group.inputId!)!;
        if (input.content !== content) throw new Error("该组答案已提交，请通过普通消息更正。");
        return { question: group, input };
      }
      const input = write(group.threadId, content);
      this.database.prepare("UPDATE user_questions SET status = 'answered', draftJson = ?, inputId = ? WHERE id = ?")
        .run(JSON.stringify(draft), input.id, id);
      return { question: this.get(id)!, input };
    }).immediate();
  }

  private requirePending(id: string): QuestionGroup {
    const group = this.get(id);
    if (!group || group.status !== "pending") throw new Error("问题不存在或已处理。");
    return group;
  }
}
