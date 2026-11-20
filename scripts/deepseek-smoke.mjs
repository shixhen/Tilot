import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { EventEmitter, once } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { Store } from "@tilot/store";
import { CredentialStore } from "../packages/store/src/credentials.ts";

const repository = resolve(dirname(fileURLToPath(import.meta.url)), "..");
let apiKey = "";
const expectedReasoning = new Map();

/** 联调输出只保留验证结果，任何错误文本也先去掉密钥。 */
export function log(value) {
  const text = JSON.stringify(value);
  console.log(apiKey ? text.replaceAll(apiKey, "[redacted]") : text);
}

/** 只读用户保存的官方 DeepSeek 配置；联调不迁移或修改用户数据库。 */
export function loadConnection() {
  assert.equal(process.platform, "win32", "联调包含真实 PowerShell，需要 Windows。");
  assert.ok(process.env.LOCALAPPDATA, "未找到 Windows 应用数据目录。");
  const directory = join(process.env.LOCALAPPDATA, "Tilot");
  const db = new Database(join(directory, "tilot.sqlite"), { readonly: true, fileMustExist: true });
  try {
    const config = db.prepare("SELECT providerId, model, reasoningEffort, maxAutomaticRetries FROM app_config WHERE id = 1").get();
    assert.ok(config, "请先在 Tilot 中保存模型配置。");
    const provider = db.prepare("SELECT id, name, baseURL FROM providers WHERE id = ?").get(config.providerId);
    assert.ok(provider, "默认模型服务不存在。");
    const url = new URL(provider.baseURL);
    assert.equal(url.origin, "https://api.deepseek.com", "此脚本只联调默认配置中的官方 DeepSeek 服务。");
    assert.ok(url.pathname === "/" || url.pathname === "/v1" || url.pathname === "/v1/", "不支持此服务路径。");
    provider.models = db.prepare("SELECT id FROM provider_models WHERE providerId = ? ORDER BY rowid").all(provider.id);
    apiKey = new CredentialStore(directory).getApiKey(provider.id, provider.baseURL) ?? "";
    assert.ok(apiKey, "请先在 Tilot 中为当前服务保存 API Key。");
    return { ...config, providers: [provider], defaultPermissionMode: "workspace-write" };
  } finally {
    db.close();
  }
}

/** 使用正式 Server 子进程及 JSON Lines 协议，保留事件供断言，不模拟模型或工具。 */
export class Session {
  messages = [];
  notifications = new EventEmitter();
  stderr = "";
  ended = false;
  requestSequence = 0;
  eventSequence = 0;
  onMessage;

  constructor(directory) {
    this.child = spawn(process.execPath, [join(repository, "packages/server/src/main.ts"), directory], {
      cwd: repository, windowsHide: true, stdio: ["pipe", "pipe", "pipe"],
    });
    this.child.on("error", (error) => { this.stderr += error.message; });
    this.child.on("close", () => { this.ended = true; this.notifications.emit("message"); });
    this.child.stderr.setEncoding("utf8").on("data", (text) => { this.stderr += text; });
    this.lines = createInterface({ input: this.child.stdout, crlfDelay: Infinity });
    this.lines.on("line", (line) => {
      const message = JSON.parse(line);
      if ("event" in message) assert.equal(message.seq, ++this.eventSequence, "服务事件乱序。");
      this.messages.push(message);
      this.onMessage?.(message);
      this.notifications.emit("message");
    });
  }

  /** 按条件等待历史或新消息，同时检查连接退出和超时。 */
  async waitFor(predicate, timeout = 180_000) {
    const signal = AbortSignal.timeout(timeout);
    while (true) {
      const message = this.messages.find(predicate);
      if (message) return message;
      assert.ok(!this.ended, `Server 提前退出：${this.stderr}`);
      await once(this.notifications, "message", { signal });
    }
  }

  /** 请求管理接口时不阻塞同时到达的模型和工具事件。 */
  async request(method, params = {}) {
    const id = `live-${++this.requestSequence}`;
    this.child.stdin.write(JSON.stringify({ id, method, params }) + "\n", "utf8");
    const message = await this.waitFor((message) => message.id === id && "success" in message, 20_000);
    assert.ok(message.success, `${method}：${message.error?.message}`);
    return message.result;
  }

  /** 等待正式轮次终态，然后通过生产历史查询取得工具和用量。 */
  async finish(turn) {
    const message = await this.waitFor((message) => message.event === "turn.finished" && message.turn.id === turn.id);
    const attempts = await this.request("turn.attempts", { turnId: turn.id });
    return { turn: message.turn, attempts };
  }

  /** 正常退出等待 Core 保存状态；强制退出用于检验实际进程中断后的恢复。 */
  async close(force = false) {
    if (this.ended) return;
    const closed = once(this.child, "close", { signal: AbortSignal.timeout(10_000) });
    if (force) this.child.kill();
    else this.child.stdin.end();
    try { await closed; }
    catch (error) { this.child.kill(); throw error; }
    this.lines.close();
  }
}

/** 从成功历史取得可展示的最终正文，不输出模型推理全文。 */
export function answer(attempts) {
  return attempts.flatMap((attempt) => attempt.messages.flatMap((message) => message.parts))
    .filter((part) => part.kind === "text").map((part) => part.text).join("\n");
}

/** 已保存工具结果必须完整配对；错误与未执行结果会让本轮验收失败。 */
function tools(attempts) {
  return attempts.flatMap((attempt) => attempt.tools).map((tool) => {
    assert.ok(tool.output !== null, `${tool.name} 缺少结果。`);
    const result = JSON.parse(tool.output);
    assert.equal(result.status, "ok", `${tool.name}：${JSON.stringify(result)}`);
    return { ...tool, result };
  });
}

/** 逐轮保留简洁证据，取消或中断没有 usage 时明确标记为未知。 */
function summarize(name, result, session) {
  for (const attempt of result.attempts) if (attempt.status === "completed") {
    expectedReasoning.set(attempt.id, attempt.messages.flatMap((message) => message.parts)
      .filter((part) => part.kind === "reasoning").map((part) => part.text));
  }
  const events = session.messages.filter((message) => message.turnId === result.turn.id);
  return {
    name, status: result.turn.status, error: result.turn.error,
    durationMs: result.turn.finishedAt - result.turn.createdAt,
    attempts: result.attempts.map((attempt) => ({
      status: attempt.status, tools: attempt.tools.map((tool) => tool.name), metrics: attempt.metrics,
    })),
    reasoningDeltas: events.filter((event) => event.event === "message.delta" && event.kind === "reasoning").length,
    textDeltas: events.filter((event) => event.event === "message.delta" && event.kind === "text").length,
    shellProgressEvents: events.filter((event) => event.event === "tool.progress").length,
  };
}

/** 在临时项目创建明确有缺陷的代码、独立测试及需要按需读取的技能。 */
function seedProject(project) {
  mkdirSync(join(project, "src"), { recursive: true });
  mkdirSync(join(project, "skills/math-checks"), { recursive: true });
  writeFileSync(join(project, "AGENTS.md"), "所有文件使用 UTF-8。只修改 src/math.mjs 和 CHANGELOG.md。修复完成的最终回答必须包含 TILOT_UTF8_你好🙂。\n", "utf8");
  writeFileSync(join(project, "skills/math-checks/SKILL.md"), "---\nname: math-checks\ndescription: 修复加法函数时运行项目自带验证。\n---\n修改前先读取 src/math.mjs 和 verify.mjs；使用 shell 执行 node verify.mjs。最终回答还需包含 SKILL_BODY_OK。\n", "utf8");
  writeFileSync(join(project, "src/math.mjs"), "// 加法函数：支持整数、负数和小数。\r\nexport function add(a, b) {\r\n  return a - b;\r\n}\r\n", "utf8");
  writeFileSync(join(project, "verify.mjs"), "import assert from 'node:assert/strict';\nimport { add } from './src/math.mjs';\nassert.equal(add(2, 3), 5);\nassert.equal(add(-2, 3), 1);\nassert.equal(add(0, 0), 0);\nassert.equal(add(0.5, 0.25), 0.75);\nconsole.log('VERIFY_OK 中文🙂');\n", "utf8");
}

/** 少量真实付费请求；先验证普通对话，再覆盖全部工具、跨进程历史、取消及恢复。 */
async function main() {
  const config = loadConnection();
  const root = mkdtempSync(join(tmpdir(), "tilot-deepseek-live-"));
  const directory = join(root, "data");
  const project = join(root, "project");
  const results = [];
  let session;
  try {
    seedProject(project);
    const setup = new Store(directory);
    try {
      setup.saveConfig({ ...config, maxAutomaticRetries: 0 });
      setup.credentials.saveApiKey(config.providerId, config.providers[0].baseURL, apiKey);
    } finally { setup.close(); }
    session = new Session(directory);
    const models = await session.request("models.fetch", { providerId: config.providerId, baseURL: config.providers[0].baseURL, apiKey: "" });
    assert.ok(models.includes(config.model), "默认模型未由服务提供。");
    log({ stage: "models", model: config.model, models });

    const ordinary = await session.request("thread.create", { title: "网页真实联调" });
    const webTurn = await session.request("turn.start", { threadId: ordinary.id, input: "请调用 web_fetch 读取 https://example.com/ ，第一次 limit=2。再使用返回的 outputId 和 nextOffset 续读。最后告诉我网页标题和用途，必须以实际抓取结果为依据。" });
    const web = await session.finish(webTurn);
    results.push(summarize("ordinary-web-fetch-and-pagination", web, session));
    log(results.at(-1));
    assert.equal(web.turn.status, "completed", web.turn.error ?? "网页轮次未完成。");
    const fetched = tools(web.attempts);
    assert.ok(fetched.length >= 2 && fetched.every((tool) => tool.name === "web_fetch"));
    assert.equal(fetched[0].result.data.title, "Example Domain");
    assert.equal(fetched[1].result.data.outputId, fetched[0].result.data.outputId);
    assert.equal(fetched[1].result.data.fetchedAt, fetched[0].result.data.fetchedAt);
    assert.match(answer(web.attempts), /Example Domain/i);

    const coding = await session.request("thread.create", { title: "代码真实联调", projectPath: project, permissionMode: "full-access" });
    const codingTurn = await session.request("turn.start", { threadId: coding.id, input: "使用 math-checks 技能修复项目中的 add 加法函数。为联调覆盖，请分别调用 ls 查看根目录、find 寻找 *.mjs、grep 搜索 add、read 读取技能与相关源码和测试。然后用 edit 修复 src/math.mjs，用 shell 执行 node verify.mjs 并确认成功；最后用 write 创建 CHANGELOG.md，以中文记录修复和验证。只能在当前临时项目内操作，不能改测试或其他文件，不要调用网络。" });
    const codingResult = await session.finish(codingTurn);
    results.push(summarize("project-seven-tools-and-skill", codingResult, session));
    log(results.at(-1));
    assert.equal(codingResult.turn.status, "completed", codingResult.turn.error ?? "代码轮次未完成。");
    const localTools = tools(codingResult.attempts);
    for (const name of ["ls", "find", "grep", "read", "edit", "shell", "write"]) assert.ok(localTools.some((tool) => tool.name === name), `未覆盖 ${name}。`);
    assert.ok(localTools.some((tool) => tool.name === "read" && JSON.parse(tool.arguments).path === "skills/math-checks/SKILL.md"));
    assert.match(answer(codingResult.attempts), /TILOT_UTF8_你好🙂/);
    assert.match(answer(codingResult.attempts), /SKILL_BODY_OK/);
    assert.ok(localTools.some((tool) => tool.name === "shell" && tool.result.data.exitCode === 0 && tool.result.data.output.includes("VERIFY_OK 中文🙂")));
    assert.ok(existsSync(join(project, "CHANGELOG.md")));
    const verification = spawn(process.execPath, ["verify.mjs"], { cwd: project, windowsHide: true, stdio: "pipe" });
    const [code] = await once(verification, "close");
    assert.equal(code, 0, "独立运行原始测试失败。");

    // 关闭正式服务进程后重开，检查多轮历史及网页缓存实际持久化。
    await session.close();
    session = new Session(directory);
    const oldAttempts = await session.request("turn.attempts", { turnId: codingTurn.id });
    assert.equal(answer(oldAttempts), answer(codingResult.attempts));
    const nextTurn = await session.request("turn.start", { threadId: coding.id, input: "请沿用上轮修复记录。用 read 读取 CHANGELOG.md，再用 read 的 outputId 读取上轮 shell 保存的日志，确认其中的中文成功标记。不要改文件、不要重新执行命令，最后给出原验证命令和结果。" });
    const continued = await session.finish(nextTurn);
    results.push(summarize("restart-history-and-shell-log", continued, session));
    log(results.at(-1));
    assert.equal(continued.turn.status, "completed", continued.turn.error ?? "重启继续失败。");
    const continuedTools = tools(continued.attempts);
    assert.ok(continuedTools.every((tool) => tool.name === "read"));
    assert.ok(continuedTools.some((tool) => tool.result.data.outputId && tool.result.data.content.includes("VERIFY_OK 中文🙂")));
    const cachedTurn = await session.request("turn.start", { threadId: ordinary.id, input: "请只用 web_fetch 的 outputId 重新读取刚才保存的网页缓存，limit=10，不要再传 url。然后报告标题。" });
    const cached = await session.finish(cachedTurn);
    results.push(summarize("restart-web-cache", cached, session));
    log(results.at(-1));
    assert.equal(cached.turn.status, "completed", cached.turn.error ?? "网页缓存恢复失败。");
    assert.ok(tools(cached.attempts).every((tool) => tool.name === "web_fetch" && JSON.parse(tool.arguments).url === undefined));
    assert.equal(tools(cached.attempts)[0].result.data.fetchedAt, fetched[0].result.data.fetchedAt);

    const cancelThread = await session.request("thread.create", { title: "流式取消联调" });
    const cancelTurn = await session.request("turn.start", { threadId: cancelThread.id, input: "请详细推导并逐项列出从 1 到 1000 的整数平方，不用工具。" });
    await session.waitFor((message) => message.event === "message.delta" && message.turnId === cancelTurn.id);
    const cancellationStarted = Date.now();
    assert.equal((await session.request("turn.interrupt", { turnId: cancelTurn.id })).interrupted, true);
    const cancelled = await session.finish(cancelTurn);
    results.push({ ...summarize("real-stream-cancellation", cancelled, session), cancellationMs: Date.now() - cancellationStarted });
    log(results.at(-1));
    assert.equal(cancelled.turn.status, "cancelled");
    assert.ok(cancelled.attempts.every((attempt) => attempt.messages.length === 0));

    const recoveryThread = await session.request("thread.create", { title: "进程中断恢复联调", projectPath: project, permissionMode: "full-access" });
    let killed = false;
    session.onMessage = (message) => {
      if (!killed && message.event === "attempt.updated" && message.threadId === recoveryThread.id && message.attempt.tools.some((tool) => tool.name === "write" && tool.output !== null)) {
        killed = true;
        session.child.kill();
      }
    };
    const interruptedTurn = await session.request("turn.start", { threadId: recoveryThread.id, input: '本次任务额外允许创建 checkpoint.txt。用 write 写入内容，对应 JSON 字符串 "CHECKPOINT_READY\\n"（必须包含末尾的一个 LF 换行），然后用 read 读回确认，最后回答 CHECKPOINT_CONFIRMED。checkpoint.txt 只需写入一次，若继续任务时文件已经存在且内容正确，只读取核实即可，不要再写。' });
    await once(session.child, "close", { signal: AbortSignal.timeout(180_000) });
    assert.ok(killed, "没有观察到真实 write 保存后的进程中断。");
    const checkpoint = join(project, "checkpoint.txt");
    assert.equal(readFileSync(checkpoint, "utf8"), "CHECKPOINT_READY\n");
    const checkpointModified = statSync(checkpoint).mtimeMs;
    session = new Session(directory);
    const interrupted = await session.request("turn.read", { turnId: interruptedTurn.id });
    assert.equal(interrupted.status, "interrupted");
    const interruptedAttempts = await session.request("turn.attempts", { turnId: interruptedTurn.id });
    const resumedTurn = await session.request("turn.resume", { turnId: interruptedTurn.id });
    const resumed = await session.finish(resumedTurn);
    results.push({ ...summarize("crash-and-resume-without-rewriting", resumed, session),
      interruptedStatus: interrupted.status,
      pendingToolResults: interruptedAttempts.flatMap((attempt) => attempt.tools).filter((tool) => tool.output === null).length,
    });
    log(results.at(-1));
    assert.equal(resumed.turn.status, "completed", resumed.turn.error ?? "中断恢复失败。");
    assert.ok(tools(resumed.attempts).some((tool) => tool.name === "read"));
    assert.ok(tools(resumed.attempts).every((tool) => tool.name !== "write" && tool.name !== "edit"));
    assert.equal(statSync(checkpoint).mtimeMs, checkpointModified, "恢复重复写入了已完成文件。");
    assert.equal(readFileSync(checkpoint, "utf8"), "CHECKPOINT_READY\n", "恢复改变了已经保存的文件内容。");
    assert.match(answer(resumed.attempts), /CHECKPOINT_CONFIRMED/);

    const quickThread = await session.request("thread.create", { title: "真实非推理联调" });
    await session.request("thread.update", { threadId: quickThread.id, providerId: config.providerId, model: config.model, reasoningEffort: "none" });
    const quickTurn = await session.request("turn.start", { threadId: quickThread.id, input: "不要调用工具，请只回答 QUICK_CONFIRMED。" });
    const quick = await session.finish(quickTurn);
    results.push(summarize("without-reasoning", quick, session));
    log(results.at(-1));
    assert.equal(quick.turn.status, "completed", quick.turn.error ?? "非推理请求失败。");
    assert.match(answer(quick.attempts), /QUICK_CONFIRMED/);

    await session.close();
    const stored = new Store(directory);
    const responseModels = new Set();
    const usage = { inputTokens: 0, cachedTokens: 0, outputTokens: 0, attemptsWithoutUsage: 0 };
    let attemptCount = 0;
    let reasoningItems = 0;
    try {
      for (const thread of stored.listThreads()) for (const turn of stored.listTurns(thread.id)) for (const attempt of stored.history.listAttempts(turn.id)) {
        attemptCount++;
        if (attempt.response?.model) responseModels.add(attempt.response.model);
        if (attempt.response?.usage) {
          usage.inputTokens += attempt.response.usage.input_tokens;
          usage.cachedTokens += attempt.response.usage.input_tokens_details.cached_tokens;
          usage.outputTokens += attempt.response.usage.output_tokens;
        } else usage.attemptsWithoutUsage++;
        if (attempt.status !== "completed") continue;
        const reasoning = attempt.response.output.filter((item) => item.type === "reasoning");
        reasoningItems += reasoning.filter((item) => item.content?.length).length;
        // 服务可能直接返回工具调用而没有推理正文；只核对它实际提供的文本。
        if (expectedReasoning.has(attempt.id)) assert.deepEqual(reasoning.flatMap((item) => (item.content ?? []).map((part) => part.text)), expectedReasoning.get(attempt.id));
        for (const call of stored.history.listToolCalls(attempt.id)) if (call.result) {
          assert.equal(call.result.call_id, call.callId);
        }
      }
    } finally { stored.close(); }
    assert.ok(reasoningItems > 0, "本次没有验证到任何真实推理正文。");
    assert.deepEqual([...responseModels], [config.model], "服务返回的模型与所选模型不一致。");
    log({ status: "passed", endpoint: "https://api.deepseek.com", model: config.model, responseModels: [...responseModels], reasoningEffort: config.reasoningEffort, attemptCount, reasoningItems, usage, results });
  } finally {
    if (session) await session.close(true);
    // 删除前验证绝对目录确实由本次在系统临时目录中创建；临时密钥随之清理。
    assert.equal(dirname(resolve(root)), resolve(tmpdir()));
    assert.ok(root.startsWith(join(tmpdir(), "tilot-deepseek-live-")));
    rmSync(root, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => { log({ status: "failed", error: error.message }); process.exitCode = 1; });
}
