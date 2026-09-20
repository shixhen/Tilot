import { useEffect, useRef, useState, type FormEvent } from "react";
import type { AppConfig } from "@tilot/protocol";
import type { Request } from "./client";

/** 设置面板的已保存配置、请求入口与关闭回调。 */
interface SettingsProps {
  config: AppConfig;
  configured: boolean;
  request: Request;
  onSaved: () => Promise<void>;
  onClose: () => void;
}

/** 编辑连接设置；密钥只写入，不从服务读回，不放入浏览器持久存储。 */
export function Settings({ config, configured, request, onSaved, onClose }: SettingsProps) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [draft, setDraft] = useState(config);
  const [apiKey, setApiKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => { dialog.current?.showModal(); }, []);

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

  return <dialog ref={dialog} className="settings" onCancel={(event) => { event.preventDefault(); if (!busy) onClose(); }}>
    <form onSubmit={(event) => void save(event)}>
      <header><h2>连接设置</h2><button type="button" className="icon-button" aria-label="关闭设置" disabled={busy} onClick={onClose}>×</button></header>
      <p className="muted">连接兼容 Responses API 的模型服务。</p>
      <fieldset disabled={busy}>
        <label>Base URL<input required type="url" value={draft.baseURL} onChange={(event) => setDraft({ ...draft, baseURL: event.target.value })} /></label>
        <label>模型<input required value={draft.model} onChange={(event) => setDraft({ ...draft, model: event.target.value })} /></label>
        <label>推理强度<select value={draft.reasoningEffort} onChange={(event) => setDraft({ ...draft, reasoningEffort: event.target.value as AppConfig["reasoningEffort"] })}>
          <option value="none">关闭</option><option value="low">低</option><option value="high">高</option><option value="max">最高</option>
        </select></label>
        <label>API Key<input type="password" autoComplete="off" value={apiKey} placeholder="留空保留已存密钥" onChange={(event) => setApiKey(event.target.value)} /></label>
        <p className="muted">{configured ? "当前已保存地址的密钥已配置。" : "当前已保存地址尚未配置密钥。"} 更换地址需要填写对应密钥。</p>
        <p className="muted">密钥以明文保存在本机 credentials.json。</p>
      </fieldset>
      {error && <p role="alert" className="error">{error}</p>}
      <footer><button type="button" disabled={busy} onClick={() => void removeKey()}>删除已存密钥</button><button className="primary" disabled={busy}>{busy ? "正在保存…" : "保存设置"}</button></footer>
    </form>
  </dialog>;
}
