import { createInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";
import type { Store } from "@tilot/store";
import { handleRpcLine } from "./rpc.ts";

/** 按 UTF-8 JSON Lines 收发请求，串行处理管理操作；输入关闭时读完已收到的请求。 */
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
  try {
    for await (const line of lines) {
      if (transportError) throw transportError;
      const response = await handleRpcLine(store, line);
      // 等待写入完成，避免桌面端读取较慢时无界积压响应。
      await new Promise<void>((resolve, reject) => {
        output.write(`${JSON.stringify(response)}\n`, "utf8", (error) => error ? reject(error) : resolve());
      });
    }
    if (transportError) throw transportError;
  } finally {
    lines.close();
    input.off("error", onError);
    output.off("error", onError);
  }
}
