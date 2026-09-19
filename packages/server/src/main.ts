import { Store } from "@tilot/store";
import { getDefaultDataDirectory } from "./data-directory.ts";
import { serveStdio } from "./stdio.ts";

/** 启动本地服务；可通过首个参数指定绝对数据目录，标准输出仅用于协议。 */
async function main(): Promise<void> {
  const store = new Store(process.argv[2] ?? getDefaultDataDirectory());
  try {
    await serveStdio(store, process.stdin, process.stdout);
  } finally {
    store.close();
  }
}

// 当前入口不恢复运行状态；恢复必须等桌面宿主确认旧执行进程已停止。
main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : "服务异常退出。"}\n`);
  process.exitCode = 1;
});
