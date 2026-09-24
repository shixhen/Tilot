import { useState, type FormEvent } from "react";
import type { AppConfig } from "@tilot/protocol";
import type { Request } from "../client";

/** 设置操作所需的服务入口与保存回调。 */
export interface SettingsOptions {
  config: AppConfig;
  configured: boolean;
  request: Request;
  onSaved: () => Promise<void>;
  onClose: () => void;
}

/** 管理设置保存和密钥删除，独立于弹窗布局。 */
export function useSettings({ config, request, onSaved, onClose }: SettingsOptions) {
  const [draft, setDraft] = useState(config);
  const [apiKey, setApiKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  /** 先保存普通配置，再按需替换密钥；部分成功时刷新真实状态并说明失败。 */
  async function save(event: FormEvent): Promise<void> {
    event.preventDefault();
    setBusy(true);
    setError("");
    let configSaved = false;
    try {
      const saved = await request("config.set", { config: draft });
      configSaved = true;
      if (apiKey.trim()) await request("credentials.set", { baseURL: saved.baseURL, apiKey: apiKey.trim() });
      setApiKey("");
      await onSaved();
      onClose();
    } catch (error) {
      setError(`${configSaved ? "普通配置已保存；后续操作失败：" : ""}${String(error)}`);
      if (configSaved) {
        try { await onSaved(); }
        catch (refreshError) { setError(`普通配置已保存，但无法刷新连接状态：${String(refreshError)}`); }
      }
    } finally { setBusy(false); }
  }

  /** 删除本地已存密钥，完成后更新配置状态。 */
  async function removeKey(): Promise<void> {
    setBusy(true);
    setError("");
    try { await request("credentials.delete", {}); setApiKey(""); await onSaved(); }
    catch (error) { setError(String(error)); }
    finally { setBusy(false); }
  }

  return { draft, setDraft, apiKey, setApiKey, busy, error, save, removeKey };
}
