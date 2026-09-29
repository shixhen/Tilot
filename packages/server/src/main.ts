import { acquireServiceLock, Store } from "@tilot/store";
import { getDefaultDataDirectory } from "./data-directory.ts";
import { serveStdio } from "./stdio.ts";

/** 启动本地服务；可通过首个参数指定绝对数据目录，标准输出仅用于协议。 */
async function main(): Promise<void> {
  const directory = process.argv[2] ?? getDefaultDataDirectory();
  const unlock = acquireServiceLock(directory);
  try {
    const store = new Store(directory);
    try {
      store.recoverInterruptedTurns();
      await serveStdio(store, process.stdin, process.stdout);
    } finally { store.close(); }
  } finally {
    unlock();
  }
}

// 仅取得服务排他锁后恢复，不能将其他服务正在执行的轮次标记为中断。
main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : "服务异常退出。"}\n`);
  process.exitCode = 1;
});
