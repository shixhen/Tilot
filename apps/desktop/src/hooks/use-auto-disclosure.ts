import { useEffect, useRef, useState } from "react";

/** 也检查跨越多个节点的选区，避免外层收起时隐藏内层选中的文字。 */
export function hasSelection(element: HTMLElement | null): boolean {
  if (!element) return false;
  const selection = element.ownerDocument.getSelection();
  if (!selection || selection.isCollapsed) return false;
  for (let index = 0; index < selection.rangeCount; index++) {
    if (selection.getRangeAt(index).intersectsNode(element)) return true;
  }
  return false;
}

/** 自动关闭遇到选中文字时等待；返回取消函数，供手动操作和卸载清理。 */
export function closeWhenUnselected(element: HTMLElement | null, close: () => void): () => void {
  const document = element?.ownerDocument;
  function cancel(): void { document?.removeEventListener("selectionchange", check); }
  function check(): void {
    if (hasSelection(element)) return;
    cancel();
    close();
  }
  document?.addEventListener("selectionchange", check);
  check();
  return cancel;
}

/** 只在运行状态改变时自动开关，同一块的内容更新保留手动操作。 */
export function useAutoDisclosure(active: boolean) {
  const [open, setOpen] = useState(active);
  const content = useRef<HTMLDivElement>(null);
  const cancelClose = useRef<(() => void) | undefined>(undefined);
  useEffect(() => {
    if (active) setOpen(true);
    else cancelClose.current = closeWhenUnselected(content.current, () => setOpen(false));
    return () => { cancelClose.current?.(); cancelClose.current = undefined; };
  }, [active]);
  function onOpenChange(value: boolean): void {
    cancelClose.current?.();
    setOpen(value);
  }
  return { open, onOpenChange, content };
}
