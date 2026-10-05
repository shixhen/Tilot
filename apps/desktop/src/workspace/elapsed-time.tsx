import { useEffect, useState } from "react";

/** 短操作保留一位小数，长过程显示分秒。 */
export function formatDuration(ms: number): string {
  if (ms < 10000) return `${Math.max(0, ms / 1000).toFixed(1)}s`;
  const seconds = Math.round(ms / 1000);
  const h = Math.floor(seconds / 3600), m = Math.floor(seconds / 60) % 60, s = seconds % 60;
  if (h > 0) return `${h}h ${m}m`;
  return m > 0 ? `${m}m ${s}s` : `${s}s`;
}

/** 活动过程实时计时，结束后只使用服务保存的实测值；旧历史不估算。 */
export function ElapsedTime({ startedAt, durationMs, running }: {
  startedAt?: number | null | undefined; durationMs?: number | null | undefined; running: boolean;
}) {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (!running || startedAt == null || durationMs != null) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 100);
    return () => window.clearInterval(timer);
  }, [running, startedAt, durationMs]);
  const elapsed = durationMs ?? (running && startedAt != null ? Math.max(0, now - startedAt) : null);
  if (elapsed === null && running) return null;
  return <span className="shrink-0 text-xs text-muted-foreground tabular-nums">{elapsed === null ? "耗时未知" : `耗时 ${formatDuration(elapsed)}`}</span>;
}
