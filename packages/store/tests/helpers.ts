import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { TestContext } from "node:test";

/** 创建测试专用数据目录并注册清理；调用方须在清理前关闭数据库连接。 */
export function temporaryDirectory(context: TestContext): string {
  const directory = mkdtempSync(join(tmpdir(), "tilot-store-test-"));
  context.after(() => {
    assert.equal(dirname(directory), resolve(tmpdir()));
    rmSync(directory, { recursive: true, force: true });
  });
  return directory;
}
