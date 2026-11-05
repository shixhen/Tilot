import assert from "node:assert/strict";
import { access, mkdir, readFile, rename, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { createToolSet, openWorkspace, OutputCache, type ApprovalInput } from "../src/index.ts";
import { temporaryDirectory } from "./helpers.ts";

test("只读只声明五种读取工具，并在执行层拒绝伪造的修改和命令调用；项目外文件可读", async (context) => {
  const directory = await temporaryDirectory(context);
  const project = join(directory, "project");
  await mkdir(project);
  await writeFile(join(directory, "outside.txt"), "外部", "utf8");
  let approvals = 0;
  const tools = createToolSet(await openWorkspace(project), { outputs: new OutputCache(directory), threadId: "thread" }, {
    mode: "read-only", approve: async () => { approvals++; return true; },
  });
  assert.deepEqual(tools.definitions.map((tool) => tool.name), ["read", "ls", "find", "grep", "web_fetch"]);
  for (const [name, input] of [["write", { path: "new.txt", content: "坏" }], ["edit", { path: "../outside.txt", edits: [] }], ["shell", { command: "Write-Output blocked" }]] as const) {
    const result = JSON.parse(String(await tools.execute(name, JSON.stringify(input), undefined, { executionId: name })));
    assert.match(result.error, /只读模式禁止/);
  }
  const result = JSON.parse(String(await tools.execute("read", JSON.stringify({ path: "../outside.txt" }))));
  assert.equal(result.data.content, "外部");
  assert.equal(approvals, 0);
  await assert.rejects(access(join(project, "new.txt")), { code: "ENOENT" });
});

test("项目内自动写入，外部调用逐次审批，拒绝时连父目录也不创建，完全访问工具声明保持相同", async (context) => {
  const directory = await temporaryDirectory(context);
  const project = join(directory, "project");
  await mkdir(project);
  const workspace = await openWorkspace(project);
  const requests: ApprovalInput[] = [];
  let allow = false;
  const policy = { mode: "workspace-write" as const, approve: async (request: ApprovalInput) => {
    requests.push(request);
    await assert.rejects(access(join(directory, "new")), { code: "ENOENT" });
    return allow;
  } };
  const tools = createToolSet(workspace, undefined, policy);
  const execute = (path: string) => tools.execute("write", JSON.stringify({ path, content: "新文件" }), undefined, { executionId: String(requests.length) });
  assert.equal(JSON.parse(String(await execute("inside.txt"))).status, "ok");
  assert.equal(requests.length, 0);
  const outside = join(directory, "new", "nested", "outside.txt");
  assert.match(JSON.parse(String(await execute(outside))).error, /用户拒绝/);
  await assert.rejects(access(join(directory, "new")), { code: "ENOENT" });
  allow = true;
  assert.equal(JSON.parse(String(await execute(outside))).status, "ok");
  assert.equal(await readFile(outside, "utf8"), "新文件");
  assert.equal(requests.length, 2);
  assert.equal(requests[0]!.resolvedPath, outside);
  assert.deepEqual(tools.definitions, createToolSet(workspace, undefined, { mode: "full-access" }).definitions);
  const full = createToolSet(workspace, undefined, { mode: "full-access", approve: async () => { throw new Error("不应审批"); } });
  assert.equal(JSON.parse(String(await full.execute("write", JSON.stringify({ path: outside, content: "完全访问" })))).status, "ok");
  assert.equal(await readFile(outside, "utf8"), "完全访问");
});

test("目录链接按真实目标审批，等待期间替换链接不会写入新的位置", async (context) => {
  const directory = await temporaryDirectory(context);
  const project = join(directory, "project");
  const outside = join(directory, "outside");
  await mkdir(project); await mkdir(outside);
  await mkdir(join(project, "inside"));
  await symlink(outside, join(project, "linked"), "junction");
  const tools = createToolSet(await openWorkspace(project), undefined, { mode: "workspace-write", approve: async (request) => {
    assert.equal(request.resolvedPath, join(outside, "file.txt"));
    await rename(join(project, "linked"), join(project, "previous"));
    await symlink(join(project, "inside"), join(project, "linked"), "junction");
    return true;
  } });
  assert.equal(JSON.parse(String(await tools.execute("write", '{"path":"linked/file.txt","content":"不会写入"}', undefined, { executionId: "link" }))).status, "error");
  await assert.rejects(access(join(outside, "file.txt")), { code: "ENOENT" });
  await assert.rejects(access(join(project, "inside", "file.txt")), { code: "ENOENT" });
});

test("项目模式每次 shell 都等待审批；取消审批后不启动命令或计时", async (context) => {
  const workspace = await openWorkspace(await temporaryDirectory(context));
  let calls = 0;
  let starts = 0;
  const controller = new AbortController();
  const tools = createToolSet(workspace, undefined, { mode: "workspace-write", approve: async () => { calls++; controller.abort(); return true; } });
  const result = JSON.parse(String(await tools.execute("shell", '{"command":"Write-Output blocked"}', controller.signal, { executionId: "shell", onStart: () => { starts++; } })));
  assert.equal(result.status, "cancelled");
  assert.equal(calls, 1);
  assert.equal(starts, 0);
});
