import assert from "node:assert/strict";
import { writeFile, unlink } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import Database from "better-sqlite3";
import { imageContent } from "@tilot/protocol";
import { Store } from "@tilot/store";
import { temporaryDirectory } from "./helpers.ts";
import { png } from "../../tool/tests/image-fixture.ts";

test("原图副本随纯图输入保存，源文件删除和重启不改变回放，补充输入保持顺序", async (context) => {
  const directory = temporaryDirectory(context);
  let store = new Store(directory);
  const source = join(directory, "截图.png");
  await writeFile(source, png);
  const first = await store.images.importFile(source);
  const second = await store.images.save(Buffer.concat([png, Buffer.from("原始附加字节")]), "第二张.png");
  const thread = store.createThread("图片历史");
  const turn = store.startTurn(thread.id, "", [first, second]);
  const steer = store.appendTurnInput(turn.id, "比较第二张", [second]);
  assert.deepEqual(store.getLatestTurnInput(turn.id), steer);
  store.finishTurn(turn.id, "cancelled");
  await unlink(source);
  store.close();
  store = new Store(directory);
  try {
    assert.deepEqual(store.listTurnInputs(turn.id).map((input) => input.images), [[first, second], [second]]);
    assert.equal(await store.images.dataUrl(first.id), `data:image/png;base64,${png.toString("base64")}`);
    const local = [{ role: "user" as const, content: [imageContent(second), imageContent(first)] },
      { type: "function_call_output" as const, call_id: "call", output: [{ type: "input_text" as const, text: "图片结果" }, imageContent(first)] }];
    const hydrated = await store.images.hydrate(local);
    assert.ok(JSON.stringify(hydrated).includes(png.toString("base64")));
    assert.ok(!JSON.stringify(hydrated).includes("tilot-image:"));
    assert.ok(JSON.stringify(local).includes("tilot-image:"));
    assert.equal(store.getTurn(turn.id)!.status, "cancelled");
  } finally { store.close(); }
});

test("按图片字节判断格式，拒绝假后缀、错误编码、丢失与损坏副本；取消导入不生成可用图片", async (context) => {
  const directory = temporaryDirectory(context); const store = new Store(directory);
  try {
    await assert.rejects(store.images.save(Buffer.from("<svg></svg>"), "fake.png"), /仅支持/);
    await assert.rejects(store.images.importBase64("not base64!", "fake.png"), /Base64/);
    await assert.rejects(store.images.save(png, "cancel.png", AbortSignal.abort()), { name: "AbortError" });
    assert.throws(() => store.images.get("../outside"), /标识无效/);
    const image = await store.images.save(png, "original.png");
    await writeFile(join(directory, "images", `${image.id}.bin`), Buffer.from("损坏"));
    await assert.rejects(store.images.dataUrl(image.id), /副本损坏/);
    assert.throws(() => store.startTurn(store.createThread("错误引用").id, "", [{ ...image, id: "a".repeat(64) }]));
    assert.equal(store.listTurns(store.listThreads()[0]!.id).length, 0);
  } finally { store.close(); }
});

test("版本 13 迁移不改变旧文字输入和任务状态", (context) => {
  const directory = temporaryDirectory(context); const store = new Store(directory);
  const turn = store.startTurn(store.createThread("旧对话").id, "原始文字🙂");
  const inputs = store.listTurnInputs(turn.id); store.finishTurn(turn.id, "completed"); store.close();
  const legacy = new Database(join(directory, "tilot.sqlite"));
  legacy.exec("DROP TABLE context_compactions; ALTER TABLE model_attempts DROP COLUMN estimatedInputTokens; ALTER TABLE threads DROP COLUMN autoTitle; ALTER TABLE provider_models DROP COLUMN contextTokens; ALTER TABLE turn_inputs DROP COLUMN imagesJson; DROP INDEX inputs_delivery; ALTER TABLE turn_inputs DROP COLUMN deliveryId; PRAGMA user_version = 13;"); legacy.close();
  const migrated = new Store(directory);
  try { assert.deepEqual(migrated.listTurnInputs(turn.id), inputs); assert.equal(migrated.getTurn(turn.id)!.status, "completed"); }
  finally { migrated.close(); }
});
