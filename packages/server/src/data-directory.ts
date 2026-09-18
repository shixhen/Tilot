import { isAbsolute, join } from "node:path";

/** 获取 Windows 用户的默认应用数据目录；由 Server 将该路径传给 Store。 */
export function getDefaultDataDirectory(): string {
  const localAppData = process.env.LOCALAPPDATA;
  if (!localAppData || !isAbsolute(localAppData)) {
    throw new Error("无法确定 Windows 本地应用数据目录。");
  }
  return join(localAppData, "Tilot");
}
