import { MAX_OUTPUT_BYTES, type TruncationReason } from "./text.ts";

export const MAX_OUTPUT_LINES = 2000;

/** 有界尾部快照与累计统计；不把完整进程输出保存在内存。 */
export interface OutputSnapshot {
  output: string;
  truncated: boolean;
  truncatedBy: TruncationReason;
  partialLine: boolean;
  outputBytes: number;
  outputLines: number;
}

/** 参考 Pi 的输出收集器，同时限制 UTF-8 字节和行数。 */
export class OutputAccumulator {
  private output = "";
  private bytes = 0;
  private newlines = 0;
  private endsWithNewline = false;
  private truncatedBy: TruncationReason = null;
  private partialLine = false;

  append(chunk: string): void {
    if (!chunk) return;
    this.bytes += Buffer.byteLength(chunk, "utf8");
    this.newlines += chunk.split("\n").length - 1;
    this.endsWithNewline = chunk.endsWith("\n");
    const bytes = Buffer.from(this.output + chunk, "utf8");
    let start = Math.max(0, bytes.length - MAX_OUTPUT_BYTES);
    while (start < bytes.length && (bytes[start]! & 0xc0) === 0x80) start++;
    if (start > 0) {
      this.truncatedBy = "bytes";
      this.partialLine = bytes[start - 1] !== 0x0a;
    }
    this.output = bytes.subarray(start).toString("utf8");
    const lines = this.output.split("\n");
    const count = lines.length - (this.output.endsWith("\n") ? 1 : 0);
    if (count > MAX_OUTPUT_LINES) {
      this.output = lines.slice(count - MAX_OUTPUT_LINES).join("\n");
      this.truncatedBy = "lines";
      this.partialLine = false;
    }
  }

  snapshot(): OutputSnapshot {
    return { output: this.output, truncated: this.truncatedBy !== null, truncatedBy: this.truncatedBy,
      partialLine: this.partialLine, outputBytes: this.bytes,
      outputLines: this.bytes === 0 ? 0 : this.newlines + (this.endsWithNewline ? 0 : 1) };
  }
}
