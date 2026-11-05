import { isImageRef, type ImageImport, type ImageRef } from "@tilot/protocol";
import type { Request } from "./client";

export interface Attachment { id: string; name: string; image?: ImageRef; source?: ImageImport; error?: string }
export interface ComposerDraft { text: string; attachments: Attachment[]; submission?: { id: string; text: string; attachmentIds: string[] } }
export type ImageSource = ImageImport | File;

/** 草稿仅保存图片副本引用；文件选择、拖拽和粘贴共用同一导入流程。 */
export class ImageDrafts {
  private readonly drafts: Record<string, ComposerDraft> = {};
  private readonly sources = new Map<string, ImageSource>();
  private readonly request: Request;
  private readonly storage: Pick<Storage, "getItem" | "setItem">;
  private readonly changed: () => void;
  private unreadable = false;
  error = "";
  constructor(request: Request, storage: Pick<Storage, "getItem" | "setItem">, changed: () => void) {
    this.request = request; this.storage = storage; this.changed = changed;
    try {
      const saved = JSON.parse(storage.getItem("tilot.composer-drafts.v1") ?? "{}");
      if (!saved || typeof saved !== "object" || Array.isArray(saved) || !Object.values(saved).every((value) => {
        const draft = value as ComposerDraft;
        return draft && typeof draft.text === "string" && Array.isArray(draft.attachments) && draft.attachments.every((a) => a && typeof a.id === "string" && typeof a.name === "string" && (a.image === undefined || isImageRef(a.image)));
      })) throw new Error("草稿结构无效");
      Object.assign(this.drafts, saved);
    } catch { this.unreadable = true; this.error = "无法读取草稿存档，原存档未覆盖；新草稿暂时无法保存。"; }
    for (const draft of Object.values(this.drafts)) for (const attachment of draft.attachments) {
      if (attachment.source) this.sources.set(attachment.id, attachment.source);
      if (!attachment.image && !attachment.error) attachment.error = "上次图片导入未完成，请重试或重新添加。";
    }
  }
  view(key: string): ComposerDraft {
    const draft = this.drafts[key];
    return draft ? { ...draft, attachments: draft.attachments.map((attachment) => ({ ...attachment })) } : { text: "", attachments: [] };
  }
  edit(key: string, text: string): void { this.drafts[key] = { ...this.view(key), text }; this.save(); }
  add(key: string, sources: ImageSource[]): void {
    const attachments = sources.map((source) => {
      const id = crypto.randomUUID(); this.sources.set(id, source);
      return { id, name: "name" in source ? source.name : "path" in source ? source.path.split(/[\\/]/).at(-1)! : source.url,
        ...("path" in source || "url" in source ? { source } : {}) };
    });
    this.drafts[key] = { ...this.view(key), attachments: [...this.view(key).attachments, ...attachments] };
    this.save();
    for (const attachment of attachments) void this.retry(attachment.id);
  }
  remove(key: string, id: string): void {
    this.drafts[key] = { ...this.view(key), attachments: this.view(key).attachments.filter((attachment) => attachment.id !== id) };
    this.sources.delete(id); this.save();
  }
  async retry(id: string): Promise<void> {
    const source = this.sources.get(id);
    this.update(id, (attachment) => { delete attachment.error; });
    try {
      if (!source) throw new Error("原文件未成功保存，请移除后重新添加图片。");
      const input = "size" in source ? { base64: await fileBase64(source), name: source.name } : source;
      const image = await this.request("image.import", input);
      this.update(id, (attachment) => { attachment.image = image; delete attachment.error; delete attachment.source; });
      this.sources.delete(id);
    } catch (error) { this.update(id, (attachment) => { attachment.error = error instanceof Error ? error.message : String(error); }); }
  }

  /** 先记录草稿交付身份，避免“已入队、未清空草稿”时退出后出现两份待发送内容。 */
  prepare(key: string, snapshot: ComposerDraft): string | null {
    const id = crypto.randomUUID();
    this.drafts[key] = { ...this.view(key), submission: { id, text: snapshot.text, attachmentIds: snapshot.attachments.filter((attachment) => attachment.image).map((attachment) => attachment.id) } };
    this.save();
    return this.error ? null : id;
  }
  async recover(known: (ids: string[]) => Promise<string[]>): Promise<void> {
    const pending = Object.entries(this.drafts).filter(([, draft]) => draft.submission);
    if (!pending.length) return;
    const received = new Set(await known(pending.map(([, draft]) => draft.submission!.id)));
    for (const [key, draft] of pending) {
      const marker = draft.submission!;
      const current = this.view(key);
      if (received.has(marker.id)) {
        if (current.text === marker.text) current.text = "";
        current.attachments = current.attachments.filter((attachment) => !marker.attachmentIds.includes(attachment.id));
      }
      delete current.submission; this.drafts[key] = current;
    }
    this.save();
  }
  /** 仅清除实际发送的部分；失败附件、期间新增内容和未接受的消息均保留。 */
  settle(key: string, target: string, snapshot: ComposerDraft, accepted: boolean): void {
    const current = this.view(key);
    const sent = new Set(accepted ? snapshot.attachments.filter((attachment) => attachment.image).map((attachment) => attachment.id) : []);
    this.drafts[target] = { text: accepted && current.text === snapshot.text ? "" : current.text,
      attachments: current.attachments.filter((attachment) => !sent.has(attachment.id)) };
    if (target !== key) delete this.drafts[key];
    this.save();
  }
  private update(id: string, update: (attachment: Attachment) => void): void {
    for (const draft of Object.values(this.drafts)) {
      const attachment = draft.attachments.find((item) => item.id === id);
      if (attachment) { update(attachment); this.save(); return; }
    }
  }
  private save(): void {
    if (this.unreadable) { this.changed(); return; }
    try { this.storage.setItem("tilot.composer-drafts.v1", JSON.stringify(this.drafts)); this.error = ""; }
    catch { this.error = "草稿保存失败，请先保留尚未发送的内容。"; }
    this.changed();
  }
}

function fileBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(",", 2)[1]!);
    reader.onerror = () => reject(reader.error ?? new Error("读取图片失败。"));
    reader.onabort = () => reject(new Error("图片读取已取消。"));
    reader.readAsDataURL(file);
  });
}

/** 网页拖拽只识别明确的图片元素或网址列表；普通粘贴网址保持文字。 */
export function droppedImages(data: DataTransfer): ImageSource[] {
  if (data.files.length) return Array.from(data.files);
  const html = data.getData("text/html");
  const url = html ? new DOMParser().parseFromString(html, "text/html").querySelector("img")?.getAttribute("src") : undefined;
  return (url && /^https?:\/\//i.test(url) ? [url] : data.getData("text/uri-list").split(/\r?\n/).filter((line) => line && !line.startsWith("#")))
    .filter((value) => /^https?:\/\//i.test(value)).map((url) => ({ url }));
}
