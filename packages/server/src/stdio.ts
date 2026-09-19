import { createInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";
import type { Store } from "@tilot/store";
import type { ServerMessage } from "@tilot/protocol";
import { handleRpcLine } from "./rpc.ts";
import { TurnManager } from "./turn-manager.ts";

/** 按 UTF-8 JSON Lines 收发请求及事件；启动请求不等待模型，输入关闭后取消活动轮次。 */
export async function serveStdio(store: Store, input: Readable, output: Writable): Promise<void> {
  const lines = createInterface({ input, crlfDelay: Infinity });
  let transportError: Error | undefined;
  /** 连接出错时结束读取，使调用方能关闭数据库；不将传输错误写回已损坏的连接。 */
  const onError = (error: Error): void => {
    transportError = error;
    lines.close();
  };
  input.on("error", onError);
  output.on("error", onError);
  let writes = Promise.resolve();
  /** 共用写入队列保持请求应答与并行轮次事件完整，写入失败会停止连接。 */
  const send = (message: ServerMessage): Promise<void> => {
    const next = writes.then(() => {
      if (transportError) throw transportError;
      return new Promise<void>((resolve, reject) => {
        output.write(`${JSON.stringify(message)}\n`, "utf8", (error) => error ? reject(error) : resolve());
      });
    });
    writes = next.catch(onError);
    return next;
  };
  const turns = new TurnManager(store, send, onError);
  try {
    for await (const line of lines) {
      if (transportError) throw transportError;
      const response = await handleRpcLine(store, line, turns);
      await send(response);
    }
    if (transportError) throw transportError;
  } finally {
    lines.close();
    await turns.close();
    await writes;
    input.off("error", onError);
    output.off("error", onError);
  }
  if (transportError) throw transportError;
}
