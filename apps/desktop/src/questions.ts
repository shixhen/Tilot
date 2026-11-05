import { parseQuestionDraft, type QuestionDraft, type QuestionGroup, type QuestionDelivery } from "@tilot/protocol";
import type { Request } from "./client";

export interface QuestionState { question: QuestionGroup; draft: QuestionDraft; busy: boolean; error: string }
interface Session extends QuestionState {
  dirty: boolean; saving: Promise<void> | undefined; timer: ReturnType<typeof setTimeout> | undefined;
  failed: "save" | "submit" | "close" | undefined;
}
type DraftStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

/** 离线草稿先留在桌面，在线保存串行合并；普通消息框的草稿不受影响。 */
export class QuestionSession {
  private readonly states = new Map<string, Session>();
  private readonly revisions = new Map<string, number>();
  private connected = false;
  private readonly request: Request;
  private readonly storage: DraftStorage;
  private readonly changed: (threadId: string, state: QuestionState | null) => void;
  private readonly deliver: (threadId: string, action: () => Promise<QuestionDelivery>) => Promise<void>;

  constructor(request: Request, storage: DraftStorage, changed: QuestionSession["changed"], deliver: QuestionSession["deliver"]) {
    this.request = request; this.storage = storage; this.changed = changed; this.deliver = deliver;
  }

  setConnected(value: boolean): void { this.connected = value; }

  async refresh(threadId: string): Promise<void> {
    const revision = this.revisions.get(threadId);
    const group = await this.request("question.pending", { threadId });
    if (revision === this.revisions.get(threadId)) this.receive(threadId, group);
  }

  receive(threadId: string, group: QuestionGroup | null): void {
    this.revisions.set(threadId, (this.revisions.get(threadId) ?? 0) + 1);
    const previous = this.states.get(threadId);
    if (!group || group.status !== "pending") {
      if (group && previous && group.id !== previous.question.id) return;
      if (previous) { clearTimeout(previous.timer); this.removeLocal(previous); }
      this.states.delete(threadId); this.changed(threadId, null); return;
    }
    const state: Session = previous?.question.id === group.id ? previous : {
      question: group, draft: structuredClone(group.draft), busy: false, error: "", dirty: false, saving: undefined, timer: undefined, failed: undefined,
    };
    state.question = group;
    if (!state.dirty && !state.saving) state.draft = structuredClone(group.draft);
    try {
      const saved = this.storage.getItem(this.key(group.id));
      if (saved && !state.dirty) { state.draft = parseQuestionDraft(JSON.parse(saved), group.questions); state.dirty = true; }
    } catch { state.error = "本机草稿读取失败，已加载服务端保存的答案。"; }
    this.states.set(threadId, state); this.notify(state);
    if (state.dirty) void this.save(threadId);
  }

  edit(threadId: string, draft: QuestionDraft): void {
    const state = this.states.get(threadId);
    if (!state || state.busy) return;
    state.draft = parseQuestionDraft(draft, state.question.questions); state.dirty = true;
    try { this.storage.setItem(this.key(state.question.id), JSON.stringify(state.draft)); }
    catch { state.error = "本机草稿保存失败，请保持窗口打开并重试。"; }
    clearTimeout(state.timer); state.timer = setTimeout(() => void this.save(threadId), 300);
    this.notify(state);
  }

  async save(threadId: string): Promise<void> {
    const state = this.states.get(threadId);
    if (!state) return;
    if (state.saving) return state.saving;
    if (!this.connected || !state.dirty || state.busy) return;
    const sent = JSON.stringify(state.draft);
    let saved = false;
    state.saving = this.request("question.draft", { questionId: state.question.id, draft: JSON.parse(sent) }).then((group) => {
      state.question = group; state.dirty = sent !== JSON.stringify(state.draft); saved = true; state.error = ""; state.failed = undefined;
      if (!state.dirty) this.removeLocal(state);
    }).catch((error: unknown) => { state.error = this.message(error); state.failed = "save"; }).finally(() => {
      state.saving = undefined;
      if (this.states.get(threadId) !== state) return;
      this.notify(state);
      if (saved && state.dirty) void this.save(threadId);
    });
    return state.saving;
  }

  async submit(threadId: string): Promise<void> {
    const state = this.states.get(threadId);
    if (!state || state.busy || !this.connected) return;
    try { parseQuestionDraft(state.draft, state.question.questions, true); }
    catch (error) { state.error = this.message(error); this.notify(state); return; }
    state.busy = true; state.error = ""; clearTimeout(state.timer); this.notify(state);
    try {
      await state.saving;
      await this.deliver(threadId, () => this.request("question.submit", { questionId: state.question.id, draft: structuredClone(state.draft) }));
      this.receive(threadId, { ...state.question, status: "answered" });
    } catch (error) { state.error = this.message(error); state.failed = "submit"; }
    finally { state.busy = false; if (this.states.get(threadId) === state) this.notify(state); }
  }

  async close(threadId: string): Promise<void> {
    const state = this.states.get(threadId);
    if (!state || state.busy || !this.connected) return;
    state.busy = true; clearTimeout(state.timer); this.notify(state);
    try { await state.saving; this.receive(threadId, await this.request("question.close", { questionId: state.question.id })); }
    catch (error) { state.error = this.message(error); state.failed = "close"; }
    finally { state.busy = false; if (this.states.get(threadId) === state) this.notify(state); }
  }

  retry(threadId: string): void {
    const failed = this.states.get(threadId)?.failed;
    if (failed === "submit") void this.submit(threadId);
    else if (failed === "close") void this.close(threadId);
    else void this.save(threadId);
  }
  dispose(): void { this.connected = false; for (const state of this.states.values()) clearTimeout(state.timer); }
  private key(id: string): string { return `tilot.question.${id}`; }
  private removeLocal(state: Session): void {
    try { this.storage.removeItem(this.key(state.question.id)); }
    catch { state.error = "本机草稿清理失败，服务端记录已保存。"; }
  }
  private notify(state: Session): void {
    this.changed(state.question.threadId, structuredClone({ question: state.question, draft: state.draft, busy: state.busy, error: state.error }));
  }
  private message(error: unknown): string { return error instanceof Error ? error.message : "操作失败，答案仍保留，请重试。"; }
}
