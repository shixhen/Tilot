import { LoaderCircle, Plus, RefreshCw, Trash2, X } from "lucide-react";
import type { Request } from "../client";
import { useModelLoader, useSettings, type ProviderDraft, type SettingsOptions } from "../hooks/use-settings";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "../components/ui/dialog";

interface ProviderCardProps {
  draft: ProviderDraft;
  /** 该服务当前地址已保存密钥。 */
  savedKey: boolean;
  /** 不能删除的原因；可以删除时为空。 */
  lockReason: string;
  request: Request;
  update: ReturnType<typeof useSettings>["update"];
  remove: (id: string) => void;
}

/** 一个服务：名称、地址、密钥，以及从它加载的模型。 */
function ProviderCard({ draft, savedKey, lockReason, request, update, remove }: ProviderCardProps) {
  const loader = useModelLoader(draft, savedKey, request, update);
  const url = draft.baseURL.trim();
  const loaded = draft.loadedURL === url && draft.models.length > 0;
  const status = loader.loading || (loader.loadable && !loaded && !loader.error) ? "正在加载模型…" : loader.error
    || (!loader.loadable ? "填写 Base URL 和 API Key 后自动加载模型。" : loaded ? `共 ${draft.models.length} 个模型` : "该服务没有返回可用模型。");
  const hostname = URL.canParse(url) ? new URL(url).hostname : "服务名称";
  const field = (name: string) => `${draft.id}-${name}`;

  return <section aria-label={draft.name || hostname} className="grid gap-3 rounded-xl border p-4">
    <div className="flex items-center gap-2">
      <Input aria-label="服务名称" placeholder={hostname} className="h-8 border-transparent bg-transparent! px-1 font-medium shadow-none hover:border-input focus-visible:border-input"
        value={draft.name} onChange={(event) => update(draft.id, (current) => ({ ...current, name: event.target.value }))} />
      <Button type="button" variant="ghost" size="icon-sm" className="text-muted-foreground" aria-label="删除服务" title={lockReason || "删除服务"}
        disabled={!!lockReason} onClick={() => remove(draft.id)}><Trash2 /></Button>
    </div>
    <div className="grid gap-3 sm:grid-cols-2">
      <div className="grid gap-1.5"><label className="text-xs text-muted-foreground" htmlFor={field("url")}>Base URL</label>
        <Input id={field("url")} required type="url" placeholder="https://api.deepseek.com" value={draft.baseURL}
          onChange={(event) => update(draft.id, (current) => ({ ...current, baseURL: event.target.value }))} /></div>
      <div className="grid gap-1.5"><label className="text-xs text-muted-foreground" htmlFor={field("key")}>API Key</label>
        <Input id={field("key")} type="password" autoComplete="off" placeholder={savedKey ? "留空保留已有密钥" : "sk-…"} value={draft.apiKey}
          onChange={(event) => update(draft.id, (current) => ({ ...current, apiKey: event.target.value }))} /></div>
    </div>
    <div className="flex items-center justify-between gap-3">
      <p role="status" className={`text-xs ${loader.error ? "text-destructive" : "text-muted-foreground"}`}>{status}</p>
      <Button type="button" variant="ghost" size="icon-xs" aria-label="重新加载模型" title="重新加载模型" disabled={!loader.loadable || loader.loading} onClick={() => void loader.load()}>
        {loader.loading ? <LoaderCircle className="animate-spin" /> : <RefreshCw />}
      </Button>
    </div>
    {loaded && <ul className="max-h-48 divide-y overflow-y-auto rounded-lg border">
      {draft.models.map((model) => <li key={model.id} className="flex items-center gap-3 px-3 py-1.5 text-sm">
        <span className="min-w-0 flex-1 truncate" title={model.id}>{model.id}</span>
      </li>)}
    </ul>}
  </section>;
}

/** 连接设置：可添加多个服务，每个服务填写地址和密钥后自动加载模型。 */
export function SettingsDialog(props: SettingsOptions) {
  const form = useSettings(props);

  return <Dialog open onOpenChange={(open) => { if (!open && !form.busy) props.onClose(); }}>
    <DialogContent showCloseButton={false} className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-xl">
      <DialogHeader className="pr-8 text-left"><DialogTitle>连接设置</DialogTitle>
        <DialogDescription>添加模型服务，填写地址和 API Key 后自动加载可用模型。密钥明文保存在本机 credentials.json。</DialogDescription></DialogHeader>
      <Button type="button" variant="ghost" size="icon-sm" className="absolute top-4 right-4" aria-label="关闭设置" disabled={form.busy} onClick={props.onClose}><X /></Button>
      <form className="grid gap-5" onSubmit={(event) => void form.save(event)}>
        <fieldset disabled={form.busy} className="grid gap-3">
          {form.drafts.map((draft) => {
            const original = props.config.providers.find((provider) => provider.id === draft.id);
            return <ProviderCard key={draft.id} draft={draft} request={props.request} update={form.update} remove={form.remove}
              savedKey={props.configured.includes(draft.id) && original?.baseURL === draft.baseURL.trim()}
              lockReason={props.used.includes(draft.id) ? "仍有对话在使用这个服务，不能删除" : form.drafts.length === 1 ? "至少保留一个服务" : ""} />;
          })}
          <Button type="button" variant="outline" className="border-dashed" onClick={form.add}><Plus />添加服务</Button>
        </fieldset>
        {form.error && <p role="alert" className="rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">{form.error}</p>}
        <div className="flex justify-end border-t pt-5">
          <Button disabled={form.busy || !form.ready}>{form.busy && <LoaderCircle className="animate-spin" />}保存设置</Button>
        </div>
      </form>
    </DialogContent>
  </Dialog>;
}
