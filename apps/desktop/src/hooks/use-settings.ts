import { useEffect, useRef, useState, type FormEvent } from "react";
import { DEFAULT_CONTEXT_TOKENS, type AppConfig, type ModelInfo } from "@tilot/protocol";
import type { Request } from "../client";

/** 设置操作所需的服务入口与保存回调。 */
export interface SettingsOptions {
  config: AppConfig;
  /** 已配置密钥的服务 id。 */
  configured: string[];
  /** 仍被对话使用、不能删除的服务 id。 */
  used: string[];
  request: Request;
  onSaved: () => Promise<void>;
  onClose: () => void;
}

/** 正在编辑的服务；loadedURL 记录 models 是从哪个地址加载的，地址改了必须重新加载才能保存。 */
export interface ProviderDraft {
  id: string;
  name: string;
  baseURL: string;
  apiKey: string;
  models: ModelInfo[];
  loadedURL: string;
}

/** 管理服务列表的编辑与保存，独立于弹窗布局；模型加载由每个服务卡片的 useModelLoader 负责。 */
export function useSettings({ config, request, onSaved, onClose }: SettingsOptions) {
  const [drafts, setDrafts] = useState<ProviderDraft[]>(() => config.providers.map((provider) => ({ ...provider, apiKey: "", loadedURL: provider.baseURL })));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const ready = drafts.every((draft) => draft.loadedURL === draft.baseURL.trim() && draft.models.length > 0);

  /** 用函数修改指定服务，避免异步加载完成时覆盖期间的其他输入。 */
  function update(id: string, change: (draft: ProviderDraft) => ProviderDraft): void {
    setDrafts((current) => current.map((draft) => draft.id === id ? change(draft) : draft));
  }

  /** 添加一个空白服务。 */
  function add(): void {
    setDrafts((current) => [...current, { id: crypto.randomUUID(), name: "", baseURL: "", apiKey: "", models: [], loadedURL: "" }]);
  }

  /** 移除一个服务，保存后它的密钥也会一并删除。 */
  function remove(id: string): void {
    setDrafts((current) => current.filter((draft) => draft.id !== id));
  }

  /** 先保存服务和模型列表，再保存新填写的密钥；默认模型不在新列表中时改用第一个服务的第一个模型。部分成功时刷新真实状态并说明失败。 */
  async function save(event: FormEvent): Promise<void> {
    event.preventDefault();
    setBusy(true);
    setError("");
    // 名称留空时使用地址的域名。
    const providers = drafts.map((draft) => ({ id: draft.id, name: draft.name.trim() || new URL(draft.loadedURL).hostname, baseURL: draft.loadedURL, models: draft.models }));
    const kept = providers.find((provider) => provider.id === config.providerId)?.models.some((model) => model.id === config.model);
    const defaults = kept ? { providerId: config.providerId, model: config.model } : { providerId: providers[0]!.id, model: providers[0]!.models[0]!.id };
    let configSaved = false;
    try {
      await request("config.set", { config: { ...config, ...defaults, providers } });
      configSaved = true;
      for (const draft of drafts) {
        if (draft.apiKey.trim()) await request("credentials.set", { providerId: draft.id, apiKey: draft.apiKey.trim() });
      }
      await onSaved();
      onClose();
    } catch (error) {
      setError(`${configSaved ? "服务列表已保存；保存密钥失败：" : ""}${String(error)}`);
      if (configSaved) {
        try { await onSaved(); }
        catch (refreshError) { setError(`服务列表已保存，但无法刷新连接状态：${String(refreshError)}`); }
      }
    } finally { setBusy(false); }
  }

  return { drafts, update, add, remove, ready, busy, error, save };
}

/**
 * 加载一个服务的模型列表：地址有效且有密钥（本次填写，或该地址已保存）时，停止输入 0.5 秒后自动加载。
 * 同一地址保留已设置的上下文，换了地址整体替换；只采用最后一次请求的结果。
 */
export function useModelLoader(draft: ProviderDraft, savedKey: boolean, request: Request, update: ReturnType<typeof useSettings>["update"]) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const latest = useRef(0);
  const url = draft.baseURL.trim();
  const loadable = /^https?:\/\/\S+$/i.test(url) && (!!draft.apiKey.trim() || savedKey);

  /** 请求服务的模型名称并合并到草稿。 */
  async function load(): Promise<void> {
    const id = ++latest.current;
    setLoading(true);
    setError("");
    try {
      const ids = await request("models.fetch", { providerId: draft.id, baseURL: url, apiKey: draft.apiKey.trim() });
      if (id !== latest.current) return;
      update(draft.id, (current) => ({ ...current, loadedURL: url, models: ids.map((model) =>
        (current.loadedURL === url ? current.models : []).find((item) => item.id === model) ?? { id: model, contextTokens: DEFAULT_CONTEXT_TOKENS }) }));
    } catch (error) {
      if (id === latest.current) setError(String(error));
    } finally {
      if (id === latest.current) setLoading(false);
    }
  }

  // 打开设置时已加载的服务不重复请求；修改地址或填写新密钥后才自动加载。
  useEffect(() => {
    if (!loadable || (url === draft.loadedURL && !draft.apiKey.trim())) return;
    const timer = setTimeout(() => void load(), 500);
    return () => clearTimeout(timer);
  }, [draft.baseURL, draft.apiKey]);

  return { loadable, loading, error, load };
}
