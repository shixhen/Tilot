import { useState, type FormEvent } from "react";
import { LoaderCircle, Trash2, X } from "lucide-react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "./components/ui/dialog";
import { NativeSelect, NativeSelectOption } from "./components/ui/native-select";
import type { AppConfig } from "@tilot/protocol";
import type { Request } from "./client";
import { Button } from "./components/ui/button";
import { Input } from "./components/ui/input";

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

  return <Dialog open onOpenChange={(open) => { if (!open && !busy) onClose(); }}>
    <DialogContent showCloseButton={false} className="max-h-[calc(100dvh-2rem)] overflow-y-auto rounded-2xl sm:max-w-md">
      <DialogHeader className="pr-8 text-left">
        <DialogTitle>连接设置</DialogTitle>
        <DialogDescription>连接兼容 Responses API 的模型服务。</DialogDescription>
      </DialogHeader>
      <Button variant="ghost" type="button" size="icon-sm" className="absolute right-4 top-3" aria-label="关闭设置" disabled={busy} onClick={onClose}><X /></Button>
      <form onSubmit={(event) => void save(event)} className="space-y-6">
        <fieldset disabled={busy} className="space-y-5 [&>label]:grid [&>label]:gap-2 [&>label]:text-sm">
          <label>Base URL<Input required type="url" value={draft.baseURL} onChange={(event) => setDraft({ ...draft, baseURL: event.target.value })} /></label>
          <label>模型<Input required value={draft.model} onChange={(event) => setDraft({ ...draft, model: event.target.value })} /></label>
          <label>推理强度<NativeSelect value={draft.reasoningEffort} onChange={(event) => setDraft({ ...draft, reasoningEffort: event.target.value as AppConfig["reasoningEffort"] })}>
            <NativeSelectOption value="none">关闭</NativeSelectOption><NativeSelectOption value="low">低</NativeSelectOption><NativeSelectOption value="high">高</NativeSelectOption><NativeSelectOption value="max">最高</NativeSelectOption>
          </NativeSelect></label>
          <label>API Key<Input type="password" autoComplete="off" value={apiKey} placeholder="留空保留已存密钥" onChange={(event) => setApiKey(event.target.value)} /></label>
          <p className="text-xs leading-6 text-muted-foreground">{configured ? "当前已保存地址的密钥已配置。" : "当前已保存地址尚未配置密钥。"} 更换地址需要填写对应密钥。密钥以明文保存在本机 credentials.json。</p>
        </fieldset>
        {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
        <div className="flex justify-between gap-2 border-t pt-4">
          <Button variant="ghost" type="button" size="sm" disabled={busy} onClick={() => void removeKey()}><Trash2 />删除密钥</Button>
          <Button size="sm" disabled={busy}>{busy && <LoaderCircle className="animate-spin" />}{busy ? "正在保存…" : "保存设置"}</Button>
        </div>
      </form>
    </DialogContent>
  </Dialog>;
}
