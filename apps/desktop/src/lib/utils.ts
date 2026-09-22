import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

/** 合并组件样式，调用处的 Tailwind 类可以覆盖默认样式。 */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
