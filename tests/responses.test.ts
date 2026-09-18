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

test("客户端默认使用 DeepSeek，并拒绝无效连接配置", () => {
  const client = createResponsesClient({ apiKey: "local-test-placeholder" });
  assert.equal(new URL(client.baseURL).origin, "https://api.deepseek.com");
  assert.throws(() => createResponsesClient({ apiKey: " " }), /API Key 不能为空/);
  for (const baseURL of ["invalid", "file:///tmp", "https://example.com/?key=value"]) {
    assert.throws(() => createResponsesClient({ apiKey: "local-test-placeholder", baseURL }));
  }
});

test("流式请求保留推理和工具事件，并使用自定义地址的路径前缀", async () => {
  const events = [
    { type: "response.reasoning_text.delta", delta: "思考", sequence_number: 1 },
    { type: "response.output_text.delta", delta: "正文", sequence_number: 2 },
    { type: "response.function_call_arguments.delta", delta: "{}", sequence_number: 3 },
    { type: "response.completed", response: { status: "completed", output: [] }, sequence_number: 4 },
  ];
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
    const event = { type: `response.${status}`, response: { status }, sequence_number: 1 };
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
  const { client, requests } = mockClient([
    { type: "response.output_text.delta", delta: "部分正文", sequence_number: 1 },
  ]);
  const controller = new AbortController();
  const stream = streamResponse(client, { model: "deepseek-flash", input: "test" }, controller.signal);
  await stream.next();
  controller.abort();
  await assert.rejects(stream.next(), { name: "AbortError" });
  assert.equal(requests[0]!.options.signal?.aborted, true);
});

test("调用方提前停止遍历，也会关闭请求", async () => {
  const { client, requests } = mockClient([
    { type: "response.output_text.delta", delta: "部分正文", sequence_number: 1 },
  ]);
  for await (const event of streamResponse(client, { model: "deepseek-flash", input: "test" })) {
    assert.equal(event.type, "response.output_text.delta");
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
