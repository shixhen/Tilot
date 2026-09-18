import assert from "node:assert/strict";
import { test } from "node:test";
import { createResponsesClient, streamResponse } from "@tilot/responses";

/** 使用本地 SSE 数据替代网络请求，并记录 SDK 实际生成的请求。 */
function mockClient(events: Record<string, unknown>[]) {
  const requests: { url: string; options: RequestInit }[] = [];
  const client = createResponsesClient({
    apiKey: "local-test-placeholder",
    baseURL: "http://localhost:1234/v1",
  }).withOptions({
    fetch: async (url, options) => {
      requests.push({ url: String(url), options: options ?? {} });
      const body = events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join("");
      return new Response(body, { headers: { "content-type": "text/event-stream" } });
    },
  });
  return { client, requests };
}

/** 构造正文、推理和两个交错工具调用的完整流；序号留间隔以验证无需连续。 */
function sampleEvents(): Record<string, unknown>[] {
  const reasoning = { type: "reasoning", id: "reason_1", summary: [], content: [{ type: "reasoning_text", text: "思考" }], status: "completed" };
  const message = { type: "message", id: "msg_1", role: "assistant", content: [{ type: "output_text", text: "正文", annotations: [] }], status: "completed" };
  const calls = [0, 1].map((i) => ({ type: "function_call", id: `item_${i}`, call_id: `call_${i}`, name: "read_file", arguments: `{"path":"${i}.ts"}`, status: "completed" }));
  const output = [reasoning, message, ...calls];
  const events = [
    { type: "response.created", response: { id: "resp_1", status: "in_progress" } },
    ...output.map((item, output_index) => ({
      type: "response.output_item.added", output_index,
      item: { ...item, status: "in_progress", ...("arguments" in item ? { arguments: "" } : { content: [] }) },
    })),
    { type: "response.reasoning_text.delta", output_index: 0, item_id: "reason_1", content_index: 0, delta: "思考" },
    { type: "response.output_text.delta", output_index: 1, item_id: "msg_1", content_index: 0, delta: "正文" },
    ...calls.map((item, i) => ({ type: "response.function_call_arguments.delta", output_index: i + 2, item_id: item.id, delta: item.arguments })),
    ...calls.map((item, i) => ({ type: "response.function_call_arguments.done", output_index: i + 2, item_id: item.id, arguments: item.arguments })),
    ...output.map((item, output_index) => ({ type: "response.output_item.done", output_index, item })),
    { type: "response.completed", response: { id: "resp_1", status: "completed", output } },
  ];
  return events.map((event, index) => ({ ...event, sequence_number: index * 2 }));
}

/** 从本地模拟流读取所有事件，检查与正式请求相同的校验路径。 */
async function readEvents(events: Record<string, unknown>[]) {
  const { client } = mockClient(events);
  const received = [];
  for await (const event of streamResponse(client, { model: "deepseek-flash", input: "test" })) {
    received.push(event);
  }
  return received;
}

test("客户端默认使用 DeepSeek，并拒绝无效连接配置", () => {
  const client = createResponsesClient({ apiKey: "local-test-placeholder" });
  assert.equal(new URL(client.baseURL).origin, "https://api.deepseek.com");
  assert.throws(() => createResponsesClient({ apiKey: " " }), /API Key 不能为空/);
  for (const baseURL of ["invalid", "file:///tmp", "https://example.com/?key=value"]) {
    assert.throws(() => createResponsesClient({ apiKey: "local-test-placeholder", baseURL }));
  }
});

test("流式请求保留推理和工具事件，并使用自定义地址的路径前缀", async () => {
  const events = sampleEvents();
  const { client, requests } = mockClient(events);
  const received = [];
  for await (const event of streamResponse(client, { model: "deepseek-flash", input: "你好" })) {
    received.push(event);
  }
  assert.deepEqual(received, events);
  assert.equal(requests.length, 1);
  const request = requests[0]!;
  assert.equal(request.url, "http://localhost:1234/v1/responses");
  assert.equal(request.options.redirect, "error");
  assert.deepEqual(JSON.parse(String(request.options.body)), {
    model: "deepseek-flash", input: "你好", stream: true,
  });
  assert.equal(request.options.signal?.aborted, true);
});

test("失败和截断终态原样返回，由调用方判断处理方式", async () => {
  for (const status of ["failed", "incomplete"]) {
    const event = { type: `response.${status}`, response: { id: "resp_1", status, output: [] }, sequence_number: 1 };
    const { client } = mockClient([event]);
    const received = [];
    for await (const item of streamResponse(client, { model: "deepseek-flash", input: "test" })) {
      received.push(item);
    }
    assert.deepEqual(received, [event]);
  }
});

test("没有终态的断流报错，并释放请求", async () => {
  const { client, requests } = mockClient([]);
  const stream = streamResponse(client, { model: "deepseek-flash", input: "test" });
  await assert.rejects(stream.next(), /终态事件前中断/);
  assert.equal(requests[0]!.options.signal?.aborted, true);
});

test("请求开始前取消，不发起请求", async () => {
  const { client, requests } = mockClient([]);
  const signal = AbortSignal.abort();
  const stream = streamResponse(client, { model: "deepseek-flash", input: "test" }, signal);
  await assert.rejects(stream.next(), { name: "AbortError" });
  assert.equal(requests.length, 0);
});

test("消费过程中取消，报告取消而不是普通断流", async () => {
  const { client, requests } = mockClient(sampleEvents());
  const controller = new AbortController();
  const stream = streamResponse(client, { model: "deepseek-flash", input: "test" }, controller.signal);
  await stream.next();
  controller.abort();
  await assert.rejects(stream.next(), { name: "AbortError" });
  assert.equal(requests[0]!.options.signal?.aborted, true);
});

test("调用方提前停止遍历，也会关闭请求", async () => {
  const { client, requests } = mockClient(sampleEvents());
  for await (const event of streamResponse(client, { model: "deepseek-flash", input: "test" })) {
    assert.equal(event.type, "response.created");
    break;
  }
  assert.equal(requests[0]!.options.signal?.aborted, true);
});

test("HTTP 失败直接交给调用方，不在 SDK 内自动重试", async () => {
  const { client } = mockClient([]);
  let requests = 0;
  const failingClient = client.withOptions({
    fetch: async () => {
      requests++;
      return new Response(JSON.stringify({ error: { message: "local test failure" } }), {
        status: 500,
        headers: { "content-type": "application/json" },
      });
    },
  });
  const stream = streamResponse(failingClient, { model: "deepseek-flash", input: "test" });
  await assert.rejects(stream.next(), { status: 500 });
  assert.equal(requests, 1);
});

test("相同事件去重，包括字段顺序不同和延迟到达的重复事件", async () => {
  const original = sampleEvents();
  const events = [...original];
  const duplicate = Object.fromEntries(Object.entries(events[1]!).reverse());
  events.splice(6, 0, duplicate);
  assert.deepEqual(await readEvents(events), original);
});

test("序号冲突、倒序及非法序号均拒绝", async () => {
  for (const sequence_number of [0, 1, -1, 1.5, undefined]) {
    const events = sampleEvents();
    events[2] = { ...events[2], sequence_number };
    await assert.rejects(readEvents(events), /序号/);
  }
});

test("工具交错时不能串用输出位置、item_id 或输出类型", async () => {
  for (const patch of [
    { item_id: "item_1" }, { output_index: 99 }, { output_index: -1 },
    { output_index: 1, item_id: "msg_1" },
  ]) {
    const events = sampleEvents();
    const index = events.findIndex((event) => event.type === "response.function_call_arguments.delta");
    events[index] = { ...events[index], ...patch };
    await assert.rejects(readEvents(events), /输出位置|function_call/);
  }
});

test("输出位置和 id 不能重复注册，完成后不能继续更新", async () => {
  for (const type of ["response.output_item.added", "response.output_item.done"]) {
    const events = sampleEvents();
    const index = events.findIndex((event) => event.type === type);
    events.splice(index + 1, 0, { ...events[index], sequence_number: Number(events[index]!.sequence_number) + 1 });
    await assert.rejects(readEvents(events), /重复注册|完成后/);
  }
});

test("工具参数完成值与输出项冲突、完成后继续发增量均拒绝", async () => {
  const inconsistent = sampleEvents();
  const index = inconsistent.findIndex((event) => event.type === "response.function_call_arguments.done");
  inconsistent[index] = { ...inconsistent[index], arguments: "{}" };
  await assert.rejects(readEvents(inconsistent), /参数完成值/);

  const lateDelta = sampleEvents();
  lateDelta.splice(index + 1, 0, {
    type: "response.function_call_arguments.delta", item_id: "item_0", output_index: 2,
    delta: "extra", sequence_number: Number(lateDelta[index]!.sequence_number) + 1,
  });
  await assert.rejects(readEvents(lateDelta), /参数完成后/);
});

test("工具从开始到完成时不能更换 call_id 或名称", async () => {
  for (const patch of [{ call_id: "other" }, { name: "write_file" }]) {
    const events = sampleEvents();
    const index = events.findIndex((event) => event.type === "response.output_item.done" && event.output_index === 2);
    events[index] = { ...events[index], item: { ...(events[index]!.item as object), ...patch } };
    await assert.rejects(readEvents(events), /call_id 或名称/);
  }
});

test("成功终态不能漏掉输出项、缺少 done 或改变完成内容", async () => {
  const missingDone = sampleEvents().filter((event) => !(event.type === "response.output_item.done" && event.output_index === 2));
  await assert.rejects(readEvents(missingDone), /最终响应/);

  const missingOutput = sampleEvents();
  missingOutput[missingOutput.length - 1] = {
    ...missingOutput.at(-1), response: { id: "resp_1", status: "completed", output: [] },
  };
  await assert.rejects(readEvents(missingOutput), /数量不一致/);

  const changedDone = sampleEvents();
  const index = changedDone.findIndex((event) => event.type === "response.output_item.done" && event.output_index === 1);
  changedDone[index] = {
    ...changedDone[index], item: { ...(changedDone[index]!.item as object), content: [{ type: "output_text", text: "被改变的正文", annotations: [] }] },
  };
  await assert.rejects(readEvents(changedDone), /已完成输出项不一致/);
});

test("终态响应 id 或状态冲突时，在传出终态前拒绝并关闭请求", async () => {
  for (const patch of [{ id: "other" }, { status: "failed" }]) {
    const events = sampleEvents();
    const last = events.at(-1)!;
    events[events.length - 1] = { ...last, response: { ...(last.response as object), ...patch } };
    const { client, requests } = mockClient(events);
    const received: string[] = [];
    await assert.rejects(async () => {
      for await (const event of streamResponse(client, { model: "deepseek-flash", input: "test" })) {
        received.push(event.type);
      }
    }, /不一致/);
    assert.equal(received.includes("response.completed"), false);
    assert.equal(requests[0]!.options.signal?.aborted, true);
  }
});

test("失败或截断可以终止尚未完成的工具项，不要求补齐 done", async () => {
  for (const status of ["failed", "incomplete"]) {
    const events = sampleEvents().slice(0, 5);
    events.push({ type: `response.${status}`, sequence_number: 99, response: { id: "resp_1", status, output: [] } });
    assert.deepEqual(await readEvents(events), events);
  }
});

test("参数 done 是完整值，不与增量字符串再次拼接", async () => {
  const events = sampleEvents();
  const index = events.findIndex((event) => event.type === "response.function_call_arguments.delta");
  events[index] = { ...events[index], delta: "{" };
  const received = await readEvents(events);
  assert.deepEqual(received, events);
});

test("多个工具交错输出中取消，后续终态不会传出", async () => {
  const { client, requests } = mockClient(sampleEvents());
  const controller = new AbortController();
  let completed = false;
  await assert.rejects(async () => {
    for await (const event of streamResponse(client, { model: "deepseek-flash", input: "test" }, controller.signal)) {
      if (event.type === "response.function_call_arguments.delta") {
        controller.abort();
      }
      if (event.type === "response.completed") {
        completed = true;
      }
    }
  }, { name: "AbortError" });
  assert.equal(completed, false);
  assert.equal(requests[0]!.options.signal?.aborted, true);
});
