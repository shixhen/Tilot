import { LoaderCircle, Trash2, X } from "lucide-react";
import { useSettings, type SettingsOptions } from "../hooks/use-settings";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { NativeSelect, NativeSelectOption } from "../components/ui/native-select";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "../components/ui/dialog";

/** 采用 shadcn 标准 Dialog 与表单控件，保存行为由 useSettings 管理。 */
export function SettingsDialog(props: SettingsOptions) {
  const form = useSettings(props);
  return <Dialog open onOpenChange={(open) => { if (!open && !form.busy) props.onClose(); }}>
    <DialogContent showCloseButton={false} className="max-h-[calc(100dvh-2rem)] overflow-y-auto">
      <DialogHeader className="pr-8 text-left"><DialogTitle>连接设置</DialogTitle><DialogDescription>设置模型服务地址与本机访问密钥。</DialogDescription></DialogHeader>
      <Button type="button" variant="ghost" size="icon-sm" className="absolute right-3 top-3" aria-label="关闭设置" disabled={form.busy} onClick={props.onClose}><X /></Button>
      <form className="grid gap-6" onSubmit={(event) => void form.save(event)}>
        <fieldset disabled={form.busy} className="grid gap-4">
          <div className="grid gap-2"><label className="text-sm font-medium" htmlFor="base-url">Base URL</label><Input id="base-url" required type="url" value={form.draft.baseURL} onChange={(event) => form.setDraft({ ...form.draft, baseURL: event.target.value })} /></div>
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="grid gap-2"><label className="text-sm font-medium" htmlFor="model">模型</label><Input id="model" required value={form.draft.model} onChange={(event) => form.setDraft({ ...form.draft, model: event.target.value })} /></div>
            <div className="grid gap-2"><label className="text-sm font-medium" htmlFor="effort">推理强度</label><NativeSelect id="effort" value={form.draft.reasoningEffort} onChange={(event) => form.setDraft({ ...form.draft, reasoningEffort: event.target.value as typeof form.draft.reasoningEffort })}>
              <NativeSelectOption value="none">关闭</NativeSelectOption><NativeSelectOption value="low">低</NativeSelectOption><NativeSelectOption value="high">高</NativeSelectOption><NativeSelectOption value="max">最高</NativeSelectOption>
            </NativeSelect></div>
          </div>
          <div className="grid gap-2"><label className="text-sm font-medium" htmlFor="api-key">API Key</label><Input id="api-key" type="password" autoComplete="off" placeholder="留空保留已有密钥" value={form.apiKey} onChange={(event) => form.setApiKey(event.target.value)} />
            <p className="text-xs leading-relaxed text-muted-foreground">{props.configured ? "当前地址已配置密钥。" : "当前地址尚未配置密钥。"}更换地址时需要对应密钥。密钥明文保存在本机 credentials.json。</p>
          </div>
        </fieldset>
        {form.error && <p role="alert" className="text-sm text-destructive">{form.error}</p>}
        <div className="flex justify-between gap-2 border-t pt-4">
          <Button type="button" variant="ghost" disabled={form.busy} onClick={() => void form.removeKey()}><Trash2 />删除密钥</Button>
          <Button disabled={form.busy}>{form.busy && <LoaderCircle className="animate-spin" />}保存设置</Button>
        </div>
      </form>
    </DialogContent>
  </Dialog>;
}
