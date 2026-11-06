import { createContext, memo, useCallback, useContext, useEffect, useMemo, useRef, useState, type MouseEventHandler, type ReactNode } from "react";
import { ImageIcon, Minus, Plus, RotateCcw } from "lucide-react";
import type { ImageImport, ImageRef } from "@tilot/protocol";
import type { Request } from "../client";
import { Button } from "../components/ui/button";
import { Dialog, DialogContent, DialogTitle } from "../components/ui/dialog";
import { Popover, PopoverAnchor, PopoverContent } from "../components/ui/popover";
import { useCopyText } from "../hooks/use-copy-text";

type ImageSource = Exclude<ImageImport, { base64: string }>;
interface Preview {
  name: string;
  address?: string;
  read: () => Promise<string>;
  trigger: HTMLButtonElement;
}

function readWhenVisible(element: Element, read: () => void): () => void {
  if (typeof IntersectionObserver === "undefined") {
    read();
    return () => {};
  }
  const observer = new IntersectionObserver((entries) => {
    if (!entries.some((entry) => entry.isIntersecting)) return;
    observer.disconnect();
    read();
  });
  observer.observe(element);
  return () => observer.disconnect();
}

/** 图片通过本地副本显示，菜单复制的是引用中的原始地址。 */
function ImageAddressMenu({ address, children }: {
  address: string | undefined;
  children: (onContextMenu?: MouseEventHandler<HTMLElement>) => ReactNode;
}) {
  const [position, setPosition] = useState<{ x: number; y: number } | null>(null);
  const trigger = useRef<HTMLElement>(null);
  const { status, copy } = useCopyText();
  if (!address) return children();

  return <Popover open={position !== null} onOpenChange={(open) => { if (!open) setPosition(null); }}>
    {children((event) => {
      event.preventDefault();
      trigger.current = event.currentTarget;
      if (event.clientX || event.clientY) {
        setPosition({ x: event.clientX, y: event.clientY });
      } else {
        const bounds = event.currentTarget.getBoundingClientRect();
        setPosition({ x: bounds.left, y: bounds.bottom });
      }
    })}
    {position && <PopoverAnchor asChild><span aria-hidden className="pointer-events-none fixed" style={{ left: position.x, top: position.y }} /></PopoverAnchor>}
    <PopoverContent align="start" sideOffset={2} className="z-[60] w-auto p-1"
      onCloseAutoFocus={(event) => { event.preventDefault(); trigger.current?.focus(); }}>
      <Button type="button" variant="ghost" size="sm" onClick={() => void copy(address)}>复制图片地址</Button>
      {status && <p role="status" className="px-2 py-1 text-xs text-muted-foreground">{status}</p>}
    </PopoverContent>
  </Popover>;
}

const Images = createContext<{
  load: (id: string) => Promise<string>;
  loadSource: (source: ImageSource) => Promise<string>;
  show: (preview: Preview) => void;
} | null>(null);

/** 每个对话复用已读取的图片副本和进行中的请求。 */
export function ImageProvider({ request, threadId, children }: { request: Request; threadId: string | null; children: ReactNode }) {
  const current = useRef(request); current.current = request;
  const cache = useMemo(() => new Map<string, Promise<string>>(), [threadId]);
  const [selected, show] = useState<Preview | null>(null);
  useEffect(() => { show(null); }, [threadId]);
  const readOnce = useCallback((key: string, read: () => Promise<string>) => {
    const cached = cache.get(key);
    if (cached) return cached;
    const pending = read().catch((error) => {
      cache.delete(key);
      throw error;
    });
    cache.set(key, pending);
    return pending;
  }, [cache]);
  const load = useCallback((id: string) => readOnce(id, async () => {
    const image = await current.current("image.read", { imageId: id });
    return image.dataUrl;
  }), [readOnce]);
  const loadSource = useCallback((source: ImageSource) => readOnce(JSON.stringify(source), async () => {
    const image = await current.current("image.import", source);
    return load(image.id);
  }), [load, readOnce]);
  const value = useMemo(() => ({ load, loadSource, show }), [load, loadSource]);
  return <Images.Provider value={value}>{children}{selected && <ImagePreview preview={selected} onClose={() => show(null)} />}</Images.Provider>;
}

/** Markdown 会将路径中的空格、非 ASCII 字符和反斜杠进行 URL 编码。 */
function referenceSource(src: string): ImageSource | undefined {
  if (/^https?:\/\//i.test(src)) return { url: src };
  try {
    let path = decodeURIComponent(src);
    if (/^file:\/\/\//i.test(src)) {
      const url = new URL(src);
      if (url.host || url.search || url.hash) return;
      path = decodeURIComponent(url.pathname).replace(/^\/(?=[a-z]:\/)/i, "");
    }
    if (/^(?:[a-z]:[\\/]|\/(?![\\/]))/i.test(path)) return { path };
  } catch { /* 无效的路径编码按普通图片说明显示。 */ }
}

/** 正文图片进入可见区域时读取，弹窗复用同一份图片。 */
export function ImageReference({ src, alt, autoLoad }: { src: string | undefined; alt: string | undefined; autoLoad: boolean }) {
  const context = useContext(Images);
  const element = useRef<HTMLButtonElement>(null);
  const [thumbnail, setThumbnail] = useState("");
  const [error, setError] = useState("");
  const source = useMemo(() => src ? referenceSource(src) : undefined, [src]);
  useEffect(() => {
    if (!autoLoad || !context || !source || !element.current) return;
    let active = true;
    const stop = readWhenVisible(element.current, () => {
      void context.loadSource(source).then((data) => {
        if (!active) return;
        setThumbnail(data);
        setError("");
      }).catch((error: Error) => {
        if (active) setError(error.message);
      });
    });
    return () => { active = false; stop(); };
  }, [autoLoad, context, source]);
  if (!context || !source) return <span className="text-muted-foreground">[图片：{alt || "未提供说明"}]</span>;

  const name = alt || "图片";
  const address = "path" in source ? source.path : source.url;
  return <ImageAddressMenu address={address}>{(onContextMenu) =>
    <button ref={element} type="button" aria-label={`预览图片 ${name}`} title={error || address}
      className="inline-flex max-w-full items-center gap-1.5 overflow-hidden rounded-md border bg-muted/40 px-2 py-1 text-sm hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring"
      onContextMenu={onContextMenu}
      onClick={(event) => context.show({
        name,
        address,
        trigger: event.currentTarget,
        read: async () => {
          const data = thumbnail || await context.loadSource(source);
          setThumbnail(data);
          setError("");
          return data;
        },
      })}>
      {thumbnail ? <img src={thumbnail} alt={name} className="max-h-28 max-w-[min(100%,14rem)] object-contain"
        onError={() => { setThumbnail(""); setError("图片内容无法显示。"); }} />
        : <><ImageIcon className="size-4 shrink-0" /><span>{name}{error && " · 加载失败，点击重试"}</span></>}
    </button>}
  </ImageAddressMenu>;
}

export const ImageGallery = memo(function ImageGallery({ images }: { images: ImageRef[] }) {
  return <div className="flex min-w-0 flex-wrap gap-2">{images.map((image, index) => <ImageThumbnail key={`${image.id}-${index}`} image={image} />)}</div>;
});

function ImageThumbnail({ image }: { image: ImageRef }) {
  const context = useContext(Images); const element = useRef<HTMLButtonElement>(null);
  const [source, setSource] = useState(""); const [error, setError] = useState("");
  useEffect(() => {
    if (!context || !element.current) return;
    let active = true;
    const stop = readWhenVisible(element.current, () => {
      void context.load(image.id).then((value) => { if (active) setSource(value); })
        .catch((error: Error) => { if (active) setError(error.message); });
    });
    return () => { active = false; stop(); };
  }, [context, image.id]);
  return <button ref={element} type="button" aria-label={`查看图片 ${image.name}`} title={error || image.name}
    onClick={(event) => context?.show({ name: image.name, trigger: event.currentTarget, read: () => context.load(image.id) })}
    className="flex size-20 shrink-0 items-center justify-center overflow-hidden rounded-lg border bg-muted focus-visible:ring-2 focus-visible:ring-ring">
    {source ? <img src={source} alt={image.name} className="size-full object-cover" /> : <ImageIcon className={error ? "text-destructive" : "text-muted-foreground"} />}
  </button>;
}

function ImagePreview({ preview, onClose }: { preview: Preview; onClose: () => void }) {
  const [source, setSource] = useState(""); const [error, setError] = useState("");
  const [scale, setScale] = useState(1); const [position, setPosition] = useState({ x: 0, y: 0 });
  const drag = useRef<{ x: number; y: number } | null>(null);
  useEffect(() => {
    let active = true;
    void preview.read().then((value) => { if (active) setSource(value); })
      .catch((error: Error) => { if (active) setError(error.message); });
    return () => { active = false; };
  }, [preview]);
  return <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}><DialogContent aria-describedby={undefined}
    onCloseAutoFocus={(event) => { event.preventDefault(); preview.trigger.focus(); }}
    className="flex h-[85vh] max-w-[95vw] flex-col overflow-hidden sm:max-w-[95vw]">
    <DialogTitle className="truncate pr-6 text-sm">{preview.name}</DialogTitle>
    <div className="flex min-h-0 flex-1 touch-none items-center justify-center overflow-hidden bg-muted cursor-grab active:cursor-grabbing"
      onPointerDown={(event) => { if (event.button !== 0) return; drag.current = { x: event.clientX - position.x, y: event.clientY - position.y }; event.currentTarget.setPointerCapture(event.pointerId); }}
      onPointerMove={(event) => { if (drag.current) setPosition({ x: event.clientX - drag.current.x, y: event.clientY - drag.current.y }); }}
      onPointerUp={() => { drag.current = null; }} onPointerCancel={() => { drag.current = null; }} onLostPointerCapture={() => { drag.current = null; }}>
      {error ? <p role="alert" className="text-sm text-destructive">{error}</p>
        : source ? <ImageAddressMenu address={preview.address}>{(onContextMenu) =>
          <img draggable={false} src={source} alt={preview.name} tabIndex={preview.address ? 0 : undefined}
            className="max-h-full max-w-full select-none object-contain"
            style={{ transform: `translate(${position.x}px, ${position.y}px) scale(${scale})` }}
            onContextMenu={onContextMenu} onError={() => setError("图片内容无法显示。")} />}
        </ImageAddressMenu>
          : <p role="status">正在读取图片…</p>}
    </div>
    <div className="flex items-center justify-center gap-3">
      <Button variant="outline" size="icon-sm" aria-label="缩小图片" onClick={() => setScale((value) => Math.max(0.1, value / 1.25))}><Minus /></Button>
      <span className="w-12 text-center text-xs">{Math.round(scale * 100)}%</span>
      <Button variant="outline" size="icon-sm" aria-label="放大图片" onClick={() => setScale((value) => value * 1.25)}><Plus /></Button>
      <Button variant="ghost" size="icon-sm" aria-label="复位图片" onClick={() => { setScale(1); setPosition({ x: 0, y: 0 }); }}><RotateCcw /></Button>
    </div>
  </DialogContent></Dialog>;
}
