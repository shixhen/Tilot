import { useEffect, useRef, useState } from "react";

/** 复制成功提示保留的时间，单位为毫秒。 */
const COPY_FEEDBACK_MS = 1500;

/** 消息和代码块共用复制反馈；再次复制重新计时，卸载时清理定时器。 */
export function useCopyText() {
  const [status, setStatus] = useState("");
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; clearTimeout(timer.current); };
  }, []);

  /** 复制成功后短暂显示勾，失败时保留错误提示供用户处理。 */
  async function copy(text: string): Promise<void> {
    try {
      await navigator.clipboard.writeText(text);
      if (!mounted.current) return;
      clearTimeout(timer.current);
      setStatus("已复制");
      timer.current = setTimeout(() => setStatus(""), COPY_FEEDBACK_MS);
    } catch {
      if (!mounted.current) return;
      clearTimeout(timer.current);
      setStatus("复制失败，请手动选择文字");
    }
  }
  return { status, copy };
}
