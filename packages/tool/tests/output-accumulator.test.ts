import assert from "node:assert/strict";
import { test } from "node:test";
import { OutputAccumulator } from "../src/output-accumulator.ts";

test("尾部同时受行数和 UTF-8 字节限制，统计包括被丢弃的输出", () => {
  const lines = new OutputAccumulator();
  const original = Array.from({ length: 5000 }, (_, index) => `${index}\n`).join("");
  for (let offset = 0; offset < original.length; offset += 150) lines.append(original.slice(offset, offset + 150));
  const result = lines.snapshot();
  assert.equal(result.output, original.split("\n").slice(3000).join("\n"));
  assert.equal(result.outputLines, 5000);
  assert.equal(result.outputBytes, Buffer.byteLength(original));
  assert.equal(result.truncatedBy, "lines");
  assert.equal(result.partialLine, false);
  const bytes = new OutputAccumulator();
  bytes.append("中文🙂".repeat(20000));
  bytes.append("END");
  const tail = bytes.snapshot();
  assert.equal(tail.outputLines, 1);
  assert.equal(tail.outputBytes, 200003);
  assert.equal(tail.truncatedBy, "bytes");
  assert.equal(tail.partialLine, true);
  assert.ok(Buffer.byteLength(tail.output) <= 50 * 1024);
  assert.ok(tail.output.endsWith("END") && !tail.output.includes("\ufffd"));
});
