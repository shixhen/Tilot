import { createContext, memo, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ImageIcon, Minus, Plus, RotateCcw } from "lucide-react";
import type { ImageRef } from "@tilot/protocol";
import type { Request } from "../client";
import { Button } from "../components/ui/button";
import { Dialog, DialogContent, DialogTitle } from "../components/ui/dialog";

const Images = createContext<{ load: (id: string) => Promise<string>; show: (image: ImageRef) => void } | null>(null);

/** 只向本地服务读取副本；稳定回调避免流式正文更新反复加载图片。 */
export function ImageProvider({ request, threadId, children }: { request: Request; threadId: string | null; children: ReactNode }) {
  const current = useRef(request); current.current = request;
  const cache = useMemo(() => new Map<string, Promise<string>>(), [threadId]);
  const [selected, show] = useState<ImageRef | null>(null);
  useEffect(() => { show(null); }, [threadId]);
  const load = useCallback((id: string) => {
    let data = cache.get(id);
    if (!data) { data = current.current("image.read", { imageId: id }).then((value) => value.dataUrl).catch((error) => { cache.delete(id); throw error; }); cache.set(id, data); }
    return data;
  }, [cache]);
  const value = useMemo(() => ({ load, show }), [load]);
  return <Images.Provider value={value}>{children}{selected && <ImagePreview image={selected} load={load} onClose={() => show(null)} />}</Images.Provider>;
}

export const ImageGallery = memo(function ImageGallery({ images }: { images: ImageRef[] }) {
  return <div className="flex min-w-0 flex-wrap gap-2">{images.map((image, index) => <ImageThumbnail key={`${image.id}-${index}`} image={image} />)}</div>;
});

function ImageThumbnail({ image }: { image: ImageRef }) {
  const context = useContext(Images); const element = useRef<HTMLButtonElement>(null);
  const [source, setSource] = useState(""); const [error, setError] = useState("");
  useEffect(() => {
    if (!context) return;
    let active = true;
    const read = () => { void context.load(image.id).then((value) => { if (active) setSource(value); }).catch((error: Error) => { if (active) setError(error.message); }); };
    if (typeof IntersectionObserver === "undefined") { read(); return () => { active = false; }; }
    const observer = new IntersectionObserver((entries) => { if (entries.some((entry) => entry.isIntersecting)) { observer.disconnect(); read(); } });
    observer.observe(element.current!);
    return () => { active = false; observer.disconnect(); };
  }, [context, image.id]);
  return <button ref={element} type="button" aria-label={`查看图片 ${image.name}`} title={error || image.name} onClick={() => context?.show(image)}
    className="flex size-20 shrink-0 items-center justify-center overflow-hidden rounded-lg border bg-muted focus-visible:ring-2 focus-visible:ring-ring">
    {source ? <img src={source} alt={image.name} className="size-full object-cover" /> : <ImageIcon className={error ? "text-destructive" : "text-muted-foreground"} />}
  </button>;
}

function ImagePreview({ image, load, onClose }: { image: ImageRef; load: (id: string) => Promise<string>; onClose: () => void }) {
  const [source, setSource] = useState(""); const [error, setError] = useState("");
  const [scale, setScale] = useState(1); const [position, setPosition] = useState({ x: 0, y: 0 });
  const drag = useRef<{ x: number; y: number } | null>(null);
  useEffect(() => { let active = true; void load(image.id).then((value) => { if (active) setSource(value); }).catch((error: Error) => { if (active) setError(error.message); }); return () => { active = false; }; }, [image.id, load]);
  return <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}><DialogContent aria-describedby={undefined} className="flex h-[85vh] max-w-[95vw] flex-col overflow-hidden sm:max-w-[95vw]">
    <DialogTitle className="truncate pr-6 text-sm">{image.name}</DialogTitle>
    <div className="flex min-h-0 flex-1 touch-none items-center justify-center overflow-hidden bg-muted cursor-grab active:cursor-grabbing"
      onPointerDown={(event) => { if (event.button !== 0) return; drag.current = { x: event.clientX - position.x, y: event.clientY - position.y }; event.currentTarget.setPointerCapture(event.pointerId); }}
      onPointerMove={(event) => { if (drag.current) setPosition({ x: event.clientX - drag.current.x, y: event.clientY - drag.current.y }); }}
      onPointerUp={() => { drag.current = null; }} onPointerCancel={() => { drag.current = null; }} onLostPointerCapture={() => { drag.current = null; }}>
      {error ? <p role="alert" className="text-sm text-destructive">{error}</p> : source ? <img draggable={false} src={source} alt={image.name} className="max-h-full max-w-full select-none object-contain" style={{ transform: `translate(${position.x}px, ${position.y}px) scale(${scale})` }} /> : <p role="status">正在读取图片…</p>}
    </div>
    <div className="flex items-center justify-center gap-3">
      <Button variant="outline" size="icon-sm" aria-label="缩小图片" onClick={() => setScale((value) => Math.max(0.1, value / 1.25))}><Minus /></Button>
      <span className="w-12 text-center text-xs">{Math.round(scale * 100)}%</span>
      <Button variant="outline" size="icon-sm" aria-label="放大图片" onClick={() => setScale((value) => value * 1.25)}><Plus /></Button>
      <Button variant="ghost" size="icon-sm" aria-label="复位图片" onClick={() => { setScale(1); setPosition({ x: 0, y: 0 }); }}><RotateCcw /></Button>
    </div>
  </DialogContent></Dialog>;
}
