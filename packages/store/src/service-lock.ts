import { mkdirSync } from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";

/** 持有独立 SQLite 排他锁，防止两个服务同时恢复同一数据目录；进程退出后系统自动释放。 */
export function acquireServiceLock(directory: string): () => void {
  mkdirSync(directory, { recursive: true });
  const lock = new Database(join(directory, "service-lock.sqlite"));
  try {
    lock.pragma("busy_timeout = 0");
    lock.exec("BEGIN EXCLUSIVE");
  } catch (error) {
    lock.close();
    if ((error as { code?: string }).code === "SQLITE_BUSY") throw new Error("该数据目录已有本地服务在运行，请先关闭原服务。");
    throw error;
  }
  return () => lock.close();
}
