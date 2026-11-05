import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdir, open, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { isImageRef, type ImageRef } from "@tilot/protocol";
import type { ResponseInputItem } from "openai/resources/responses/responses";

/** 原始字节按内容寻址保存；不转换、压缩或按缓存期限删除。 */
export class ImageStore {
  private readonly directory: string;
  constructor(dataDirectory: string) { this.directory = join(dataDirectory, "images"); }

  async importFile(path: string, signal?: AbortSignal): Promise<ImageRef> {
    signal?.throwIfAborted();
    const file = await open(path, "r");
    try {
      if (!(await file.stat()).isFile()) throw new Error("图片来源必须是普通文件。");
      return await this.save(await file.readFile({ signal }), basename(path), signal);
    } finally { await file.close(); }
  }

  async importBase64(data: string, name: string, signal?: AbortSignal): Promise<ImageRef> {
    signal?.throwIfAborted();
    const encoded = data.replace(/\s/g, "");
    const bytes = Buffer.from(encoded, "base64");
    if (bytes.toString("base64") !== encoded) throw new Error("图片不是有效的 Base64 数据。");
    return this.save(bytes, name, signal);
  }

  async save(data: Uint8Array, name: string, signal?: AbortSignal): Promise<ImageRef> {
    signal?.throwIfAborted();
    const bytes = Buffer.from(data);
    const mimeType = imageMime(bytes);
    const image: ImageRef = { id: createHash("sha256").update(bytes).digest("hex"), mimeType, bytes: bytes.length, name };
    await mkdir(this.directory, { recursive: true });
    await this.atomic(join(this.directory, `${image.id}.bin`), bytes, signal);
    await this.atomic(join(this.directory, `${image.id}.json`), Buffer.from(JSON.stringify(image), "utf8"), signal);
    return image;
  }

  get(id: string): ImageRef {
    if (!/^[a-f0-9]{64}$/.test(id)) throw new Error("图片标识无效。");
    const image: unknown = JSON.parse(readFileSync(join(this.directory, `${id}.json`), "utf8"));
    if (!isImageRef(image) || image.id !== id) throw new Error("已保存的图片信息损坏。");
    return image;
  }

  references(value: unknown): ImageRef[] {
    if (!Array.isArray(value) || !value.every(isImageRef)) throw new Error("图片引用格式无效。");
    return value.map((image) => ({ ...this.get(image.id), name: image.name }));
  }

  async dataUrl(id: string, signal?: AbortSignal): Promise<string> {
    signal?.throwIfAborted();
    const image = this.get(id);
    const bytes = await readFile(join(this.directory, `${id}.bin`), { signal });
    if (createHash("sha256").update(bytes).digest("hex") !== id || bytes.length !== image.bytes) throw new Error("已保存的图片副本损坏，不能替换或忽略后继续请求。");
    return `data:${image.mimeType};base64,${bytes.toString("base64")}`;
  }

  /** 不修改持久记录；同一请求中同图只读取一次，展开用户和工具结果里的图片引用。 */
  async hydrate(input: ResponseInputItem[], signal?: AbortSignal): Promise<ResponseInputItem[]> {
    const loaded = new Map<string, Promise<string>>();
    const parts = async <T extends { type: string }>(content: T[]): Promise<T[]> => Promise.all(content.map(async (part) => {
      if (part.type !== "input_image" || !("image_url" in part) || typeof part.image_url !== "string" || !part.image_url.startsWith("tilot-image:")) return part;
      const id = part.image_url.slice("tilot-image:".length);
      let data = loaded.get(id);
      if (!data) { data = this.dataUrl(id, signal); loaded.set(id, data); }
      return { ...part, image_url: await data };
    }));
    return Promise.all(input.map(async (item) => {
      signal?.throwIfAborted();
      if (item.type === "function_call_output" && Array.isArray(item.output)) return { ...item, output: await parts(item.output) };
      if ("role" in item && (item.role === "user" || item.role === "developer") && "content" in item && Array.isArray(item.content)) return { ...item, content: await parts(item.content) };
      return item;
    }));
  }

  private async atomic(path: string, bytes: Buffer, signal?: AbortSignal): Promise<void> {
    const temporary = join(this.directory, `.${randomUUID()}.tmp`);
    try {
      await writeFile(temporary, bytes, { signal });
      signal?.throwIfAborted();
      await rename(temporary, path);
    } finally { await unlink(temporary).catch((error: NodeJS.ErrnoException) => { if (error.code !== "ENOENT") throw error; }); }
  }
}

function imageMime(bytes: Buffer): ImageRef["mimeType"] {
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return "image/png";
  if (bytes.length >= 3 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return "image/jpeg";
  if (bytes.length >= 12 && bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WEBP") return "image/webp";
  throw new Error("不支持的图片内容，仅支持 PNG、JPEG、WebP；文件后缀不能代替实际格式。");
}
