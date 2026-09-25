import { useEffect, useState } from "react";
import { isTauri } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { Copy, Minus, Square, X } from "lucide-react";
import { Button } from "../components/ui/button";
import { SidebarTrigger } from "../components/ui/sidebar";

/** 将侧栏开关放在窗口左上角，并连接桌面窗口的拖动和控制操作。 */
export function WorkspaceTitlebar() {
  const native = isTauri();
  const [maximized, setMaximized] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /** 展示窗口操作失败的原因，避免点击后无反馈。 */
  async function run(action: () => Promise<unknown>): Promise<void> {
    try {
      await action();
      setError(null);
    } catch (cause) {
      setError(String(cause));
    }
  }

  useEffect(() => {
    if (!native) return;
    const window = getCurrentWindow();
    let disposed = false;
    /** 同步系统快捷键、双击标题栏等操作产生的最大化状态。 */
    async function syncMaximized(): Promise<void> {
      const value = await window.isMaximized();
      if (!disposed) setMaximized(value);
    }
    void run(syncMaximized);
    const listener = window.onResized(() => void run(syncMaximized));
    void listener.catch((cause) => { if (!disposed) setError(String(cause)); });
    return () => {
      disposed = true;
      void listener.then((unlisten) => unlisten(), () => {});
    };
  }, [native]);

  return <div className="flex h-7.5 shrink-0 select-none items-center text-muted-foreground">
    <SidebarTrigger className="mx-2 size-6" />
    <div data-tauri-drag-region={native ? "" : undefined} className="flex h-full min-w-0 flex-1 items-center px-2 text-xs">
      {error && <span role="alert" className="truncate text-destructive" title={error}>{error}</span>}
    </div>
    {native && <div className="flex h-full">
      <Button variant="ghost" className="h-full w-12 rounded-none" aria-label="最小化" onClick={() => void run(() => getCurrentWindow().minimize())}><Minus className="size-4" /></Button>
      <Button variant="ghost" className="h-full w-12 rounded-none" aria-label={maximized ? "还原窗口" : "最大化"} onClick={() => void run(() => getCurrentWindow().toggleMaximize())}>{maximized ? <Copy className="size-3.5" /> : <Square className="size-3.5" />}</Button>
      <Button variant="ghost" className="h-full w-12 rounded-none hover:bg-destructive hover:text-background" aria-label="关闭窗口" onClick={() => void run(() => getCurrentWindow().close())}><X className="size-4" /></Button>
    </div>}
  </div>;
}
