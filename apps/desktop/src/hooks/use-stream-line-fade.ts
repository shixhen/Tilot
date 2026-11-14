import { useLayoutEffect, useRef } from "react";

type Line = { top: number; bottom: number };
type Fade = { line: Line; slot: number; animation: Animation };
type ActiveFades = { node: HTMLDivElement; last: Line; fades: Fade[] };
const opacityProperties: string[] = [];

function opacityProperty(slot: number): string {
  const existing = opacityProperties[slot];
  if (existing) return existing;
  const name = `--tilot-line-opacity-${slot}`;
  CSS.registerProperty({ name, syntax: "<number>", inherits: false, initialValue: "1" });
  opacityProperties.push(name);
  return name;
}

/** 同一张遮罩只覆盖正在淡入的几行，浏览器分别播放它们的透明度动画。 */
function updateMask({ node, fades }: ActiveFades): void {
  if (!fades.length) {
    node.style.removeProperty("mask-image");
    return;
  }
  const stops = fades.map(({ line, slot }) =>
    `#000 0 ${Math.max(0, line.top)}px, rgb(0 0 0 / var(${opacityProperty(slot)})) 0 ${line.bottom}px`,
  );
  node.style.maskImage = `linear-gradient(${stops.join(", ")}, #000 0)`;
}

function lastTextRect(element: HTMLElement): Line | undefined {
  const walker = element.ownerDocument.createTreeWalker(element, NodeFilter.SHOW_TEXT);
  const range = element.ownerDocument.createRange();
  for (let node = walker.lastChild() as Text | null; node; node = walker.previousNode() as Text | null) {
    const end = node.data.trimEnd().length;
    if (!end) continue;
    range.setStart(node, end - 1);
    range.setEnd(node, end);
    const rect = range.getBoundingClientRect();
    if (!rect.width || !rect.height) continue;
    const lineHeight = parseFloat(getComputedStyle(node.parentElement!).lineHeight);
    const padding = Number.isFinite(lineHeight) ? Math.max(0, (lineHeight - rect.height) / 2) : 0;
    const origin = element.getBoundingClientRect().top;
    return { top: rect.top - origin - padding, bottom: rect.bottom - origin + padding };
  }
}

/** 补字时沿用同一行的动画，换行时旧行继续播放。 */
export function useStreamLineFade(text: string, streaming: boolean) {
  const element = useRef<HTMLDivElement>(null);
  const active = useRef<ActiveFades | null>(null);
  useLayoutEffect(() => () => {
    const state = active.current;
    if (!state) return;
    for (const fade of state.fades) fade.animation.cancel();
    state.node.style.removeProperty("mask-image");
    active.current = null;
  }, []);
  useLayoutEffect(() => {
    if (!streaming) return;
    const frame = requestAnimationFrame(() => {
      const node = element.current;
      if (!node || window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
      const line = lastTextRect(node);
      if (!line) return;
      const previous = active.current;
      if (previous?.node === node && Math.abs(line.top - previous.last.top) < (line.bottom - line.top) / 2) return;
      const state = previous?.node === node ? previous : { node, last: line, fades: [] };
      state.last = line;
      let slot = 0;
      while (state.fades.some((fade) => fade.slot === slot)) slot++;
      const property = opacityProperty(slot);
      const animation = node.animate([
        { [property]: "0.3" },
        { [property]: "1" },
      ], { duration: 160, easing: "ease-out" });
      const fade = { line, slot, animation };
      state.fades.push(fade);
      state.fades.sort((a, b) => a.line.top - b.line.top);
      active.current = state;
      updateMask(state);
      animation.onfinish = () => {
        state.fades = state.fades.filter((item) => item !== fade);
        updateMask(state);
      };
    });
    return () => cancelAnimationFrame(frame);
  }, [text, streaming]);
  return element;
}
