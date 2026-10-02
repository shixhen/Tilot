import { lstat, mkdir, open, readFile, readdir, rename, unlink, writeFile, type FileHandle } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { isAbsolute, join } from "node:path";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const METADATA_RESERVE_BYTES = 1024;
const MISSING_OUTPUT = "日志已过期或不存在，不能读取其他任务的日志。";

/** 输出正文限额与回收策略；仅宿主和测试设置，不由模型修改。 */
export interface OutputCacheLimits { artifactBytes: number; cacheBytes: number; retentionMs: number }
const DEFAULT_LIMITS: OutputCacheLimits = { artifactBytes: 10 * 1024 * 1024, cacheBytes: 256 * 1024 * 1024, retentionMs: 7 * 24 * 60 * 60 * 1000 };

/** 输出缓存结果；截断表示保存的只是输出前缀。 */
export interface OutputArtifact { outputId: string; bytesWritten: number; artifactTruncated: boolean }
/** 网页正文的固定来源，分页继续使用同一份抓取结果。 */
export interface WebSource { url: string; finalUrl: string; fetchedAt: number; title?: string }
interface OutputMetadata extends OutputArtifact { threadId: string; finishedAt: number; kind?: "shell" | "web"; source?: WebSource }

/** 宿主数据目录中的输出缓存；一份服务共用一个实例，清理与读取串行。 */
export class OutputCache {
  private readonly directory: string;
  private readonly limits: OutputCacheLimits;
  private readonly active = new Map<string, number>();
  private queue = Promise.resolve();

  constructor(dataDirectory: string, limits: Partial<OutputCacheLimits> = {}) {
    if (!isAbsolute(dataDirectory)) throw new Error("输出缓存必须位于宿主指定的绝对数据目录。");
    this.directory = join(dataDirectory, "outputs");
    this.limits = { ...DEFAULT_LIMITS, ...limits };
    if (Object.values(this.limits).some((value) => !Number.isSafeInteger(value) || value <= 0) ||
      this.limits.cacheBytes < this.limits.artifactBytes + METADATA_RESERVE_BYTES) throw new Error("输出缓存容量或保留时长无效。");
  }

  /** 不透明 id 定位正文，打开前预留单条上限及来源元数据容量。 */
  async create(threadId: string, executionId: string = randomUUID(), source?: WebSource): Promise<OutputLog> {
    if (!UUID.test(executionId) || !threadId) throw new Error("输出标识或任务归属无效。");
    return this.exclusive(async () => {
      await mkdir(this.directory, { recursive: true });
      await this.checkDirectory();
      if ((await readdir(this.directory)).some((name) => name.startsWith(`${executionId}.`))) throw new Error("该标识已有缓存，不能覆盖。");
      const reserve = this.limits.artifactBytes + METADATA_RESERVE_BYTES + (source ? Buffer.byteLength(JSON.stringify(source)) : 0);
      await this.prune(reserve);
      const file = await open(join(this.directory, `${executionId}.pending`), "wx");
      this.active.set(executionId, reserve);
      return new OutputLog(file, this.limits.artifactBytes, executionId, async (artifact) => {
        await this.exclusive(async () => {
          try {
            if (artifact === null) await this.remove(executionId);
            else {
              await rename(join(this.directory, `${executionId}.pending`), join(this.directory, `${executionId}.log`));
              const metadata: OutputMetadata = { ...artifact, threadId, finishedAt: Date.now(), kind: source ? "web" : "shell", ...(source ? { source } : {}) };
              await writeFile(join(this.directory, `${executionId}.json`), JSON.stringify(metadata), { encoding: "utf8", flag: "wx" });
            }
          } finally { this.active.delete(executionId); }
        });
      });
    });
  }

  /** 验证标识与任务归属后读取；持锁期间日志不能被容量回收删除。 */
  async read<T>(threadId: string, outputId: string, operation: (path: string, artifact: OutputArtifact, source?: WebSource) => Promise<T>, kind: "shell" | "web" = "shell"): Promise<T> {
    const missing = kind === "shell" ? MISSING_OUTPUT : "网页正文已过期或不存在，不能读取其他任务的网页缓存。";
    if (!UUID.test(outputId)) throw new Error("outputId 必须是工具返回的缓存标识，不能是路径。");
    return this.exclusive(async () => {
      try {
        await this.checkDirectory();
        const metadata = await this.metadata(outputId);
        if (metadata.threadId !== threadId || (metadata.kind ?? "shell") !== kind || Date.now() - metadata.finishedAt > this.limits.retentionMs) throw new Error(missing);
        const path = join(this.directory, `${outputId}.log`);
        if (!(await lstat(path)).isFile()) throw new Error(missing);
        return await operation(path, { outputId, bytesWritten: metadata.bytesWritten, artifactTruncated: metadata.artifactTruncated }, metadata.source);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new Error(missing);
        throw error;
      }
    });
  }

  /** 回收过期和超过容量的已结束日志，不回收当前仍在写入的日志。 */
  async cleanup(): Promise<void> {
    await this.exclusive(async () => {
      try { await this.checkDirectory(); await this.prune(0); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    });
  }

  private async checkDirectory(): Promise<void> {
    const stats = await lstat(this.directory);
    if (!stats.isDirectory() || stats.isSymbolicLink()) throw new Error("输出缓存目录必须是普通目录，不能是链接。");
  }

  private async metadata(outputId: string): Promise<OutputMetadata> {
    const path = join(this.directory, `${outputId}.json`);
    if (!(await lstat(path)).isFile()) throw new Error(MISSING_OUTPUT);
    const metadata = JSON.parse(await readFile(path, "utf8")) as OutputMetadata;
    if (metadata.outputId !== outputId || typeof metadata.threadId !== "string" || !Number.isSafeInteger(metadata.finishedAt) ||
      !Number.isSafeInteger(metadata.bytesWritten) || metadata.bytesWritten < 0 || typeof metadata.artifactTruncated !== "boolean") throw new Error("日志元数据损坏，无法读取。");
    if (metadata.kind !== undefined && !["shell", "web"].includes(metadata.kind)) throw new Error("缓存类型损坏，无法读取。");
    if (metadata.kind === "web" && (!metadata.source || typeof metadata.source.url !== "string" || typeof metadata.source.finalUrl !== "string" ||
      !Number.isSafeInteger(metadata.source.fetchedAt) || (metadata.source.title !== undefined && typeof metadata.source.title !== "string"))) throw new Error("网页来源元数据损坏，无法读取。");
    return metadata;
  }

  private async prune(reserve: number): Promise<void> {
    const reserved = [...this.active.values()].reduce((sum, bytes) => sum + bytes, reserve);
    if (reserved > this.limits.cacheBytes) throw new Error("输出缓存已被正在保存的输出占满，无法创建新缓存。");
    const entries = await readdir(this.directory);
    const names = new Set(entries);
    const logs: { id: string; finishedAt: number; bytes: number }[] = [];
    for (const name of entries) {
      const id = name.split(".")[0]!;
      if (!UUID.test(id) || this.active.has(id)) continue;
      const path = join(this.directory, name);
      if (name === `${id}.pending` || (name === `${id}.log` && !names.has(`${id}.json`))) {
        await unlink(path);
      } else if (name === `${id}.json`) {
        const metadata = await this.metadata(id);
        const logPath = join(this.directory, `${id}.log`);
        if (!names.has(`${id}.log`) || Date.now() - metadata.finishedAt > this.limits.retentionMs) {
          await this.remove(id);
        } else {
          const stats = await lstat(logPath);
          if (!stats.isFile()) throw new Error("日志缓存中存在非普通文件。");
          logs.push({ id, finishedAt: metadata.finishedAt, bytes: stats.size + (await lstat(path)).size });
        }
      }
    }
    let total = logs.reduce((sum, entry) => sum + entry.bytes, 0) + reserved;
    for (const entry of logs.sort((a, b) => a.finishedAt - b.finishedAt)) {
      if (total <= this.limits.cacheBytes) break;
      await this.remove(entry.id);
      total -= entry.bytes;
    }
    if (total > this.limits.cacheBytes) throw new Error("输出缓存已被正在保存的输出占满，无法创建新缓存。");
  }

  private async remove(id: string): Promise<void> {
    for (const extension of ["pending", "log", "json"]) {
      try { await unlink(join(this.directory, `${id}.${extension}`)); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    }
  }

  private async exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.queue;
    let release!: () => void;
    this.queue = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try { return await operation(); }
    finally { release(); }
  }
}

/** 按顺序等待写入，达到上限后丢弃后续正文；保留完整 UTF-8 前缀。 */
export class OutputLog {
  readonly outputId: string;
  private readonly file: FileHandle;
  private readonly limit: number;
  private readonly save: (artifact: OutputArtifact | null) => Promise<void>;
  private bytesWritten = 0;
  private truncated = false;
  private finished = false;
  private writeError: unknown;

  constructor(file: FileHandle, limit: number, outputId: string, save: (artifact: OutputArtifact | null) => Promise<void>) {
    this.file = file; this.limit = limit; this.outputId = outputId; this.save = save;
  }

  async append(text: string): Promise<void> {
    if (this.finished) throw new Error("日志已经关闭。");
    if (this.truncated || this.writeError !== undefined) return;
    const bytes = Buffer.from(text, "utf8");
    let end = Math.min(bytes.length, this.limit - this.bytesWritten);
    if (end < bytes.length) {
      while (end > 0 && (bytes[end]! & 0xc0) === 0x80) end--;
      this.truncated = true;
    }
    try { if (end > 0) await this.file.writeFile(bytes.subarray(0, end)); }
    catch (error) { this.writeError = error; throw error; }
    this.bytesWritten += end;
  }

  async finish(): Promise<OutputArtifact> {
    if (this.finished) throw new Error("日志已经关闭。");
    this.finished = true;
    const artifact = { outputId: this.outputId, bytesWritten: this.bytesWritten, artifactTruncated: this.truncated };
    try {
      await this.file.close();
      if (this.writeError !== undefined) throw this.writeError;
      await this.save(artifact);
      return artifact;
    } catch (error) {
      await this.save(null);
      throw error;
    }
  }

  /** 启动前取消或失败时关闭并删除未发布的日志，释放缓存预留容量。 */
  async discard(): Promise<void> {
    if (this.finished) return;
    this.finished = true;
    try { await this.file.close(); }
    finally { await this.save(null); }
  }
}
