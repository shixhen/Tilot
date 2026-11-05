import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { createToolSet, openWorkspace, OutputCache } from "../src/index.ts";
import { ImageStore } from "../../store/src/images.ts";
import { temporaryDirectory } from "./helpers.ts";
import { httpFixture } from "./http-fixture.ts";
import { png } from "./image-fixture.ts";

test("view_image 所有权限均可读项目外图片，真实结果含图片，路径和网址互斥", async (context) => {
  const directory = await temporaryDirectory(context); await mkdir(join(directory, "project")); const workspace = await openWorkspace(join(directory, "project"));
  const images = new ImageStore(directory); const host = { images, threadId: "test", outputs: new OutputCache(directory) };
  const path = join(directory, "original.png"); await writeFile(path, png);
  for (const mode of ["read-only", "workspace-write", "full-access"] as const) {
    const tools = createToolSet(workspace, host, { mode });
    assert.ok(tools.definitions.some((tool) => tool.name === "view_image"));
    const output = await tools.execute("view_image", JSON.stringify({ path }));
    assert.ok(Array.isArray(output)); assert.equal(output[1]!.type, "input_image");
    assert.equal(JSON.parse(output[0]!.type === "input_text" ? output[0]!.text : "").status, "ok");
    for (const input of [{}, { path, url: "https://image.test/a.png" }, { path: 5 }, { path, unsupported: true }]) {
      assert.equal(JSON.parse(String(await tools.execute("view_image", JSON.stringify(input)))).status, "error");
    }
  }
});

test("网络图片沿用重定向与代理通道，超过文本抓取限制仍原样保存，不把错误页当图片", async (context) => {
  const directory = await temporaryDirectory(context); const images = new ImageStore(directory);
  const bytes = Buffer.concat([png, Buffer.alloc(3 * 1024 * 1024)]);
  const network = await httpFixture(context, (request, response) => {
    if (request.url === "/redirect") response.writeHead(302, { location: "/actual.png" }).end();
    else if (request.url === "/actual.png") response.writeHead(200, { "content-type": "image/png" }).end(bytes);
    else response.writeHead(200, { "content-type": "text/html" }).end("<html>错误页</html>");
  });
  const tools = createToolSet(await openWorkspace(directory), { images, threadId: "test", outputs: new OutputCache(directory) });
  const output = await tools.execute("view_image", '{"url":"https://image.test/redirect"}');
  assert.ok(Array.isArray(output));
  const hydrated = await images.hydrate([{ type: "function_call_output", call_id: "call", output }]);
  assert.ok(JSON.stringify(hydrated).includes(bytes.toString("base64")));
  assert.equal(network.calls.length, 2);
  assert.equal(JSON.parse(String(await tools.execute("view_image", '{"url":"https://image.test/error"}'))).status, "error");
});
