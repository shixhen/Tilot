import { useCopyText } from "../hooks/use-copy-text";
import { ChartNoAxesColumnIncreasing, Check, Copy, Pencil } from "lucide-react";
import type { TurnMetrics } from "../request-metrics";
import { Button } from "../components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "../components/ui/tooltip";

/** 消息操作条：用户操作悬停显示，回复操作常驻；时间使用消息记录中的实际时间。 */
interface MessageActionsProps {
  text: string;
  time: number | null;
  user?: boolean;
  metrics?: TurnMetrics | undefined;
  onEdit?: ((text: string) => void) | undefined;
  disabled?: boolean;
  running?: boolean;
}

/** 展示整轮累计，不将未返回的数据误记为零；缓存命中属于输入 token 的一部分。 */
export function MetricsDetails({ metrics }: { metrics?: TurnMetrics | undefined }) {
  const cacheHitRate = metrics?.inputTokens != null && metrics.inputTokens > 0 && metrics.cachedTokens != null
    ? `${Math.round(metrics.cachedTokens / metrics.inputTokens * 100)}%` : "暂无数据";
  const rows = [
    ["模型请求次数", metrics?.requestCount.toLocaleString() ?? "暂无数据"],
    ["首 token 耗时", metrics?.firstTokenMs == null ? "暂无数据" : `${(metrics.firstTokenMs / 1000).toFixed(2)} s`],
    ["生成速度（TPS）", metrics?.tokensPerSecond == null ? "暂无数据" : `${metrics.tokensPerSecond.toFixed(1)} token/s`],
    ["缓存命中率", cacheHitRate],
    ["缓存命中", metrics?.cachedTokens?.toLocaleString() ?? "暂无数据"],
    ["缓存未命中", metrics?.inputTokens == null || metrics.cachedTokens == null ? "暂无数据" : (metrics.inputTokens - metrics.cachedTokens).toLocaleString()],
    ["输出 token", metrics?.outputTokens?.toLocaleString() ?? "暂无数据"],
  ];
  return <div className="w-60 text-sm">
    <p className="mb-2 font-medium">本轮模型请求</p>
    <dl className="grid grid-cols-[1fr_auto] gap-x-5 gap-y-1.5">{rows.map(([label, value]) =>
      <div key={label} className="contents"><dt className="text-muted-foreground">{label}</dt><dd className="text-right tabular-nums">{value}</dd></div>)}</dl>
    {metrics && metrics.finishedRequestCount < metrics.requestCount && <p className="mt-2 text-xs text-muted-foreground">已汇总 {metrics.finishedRequestCount} 次已结束请求，用量将在当前请求结束后更新。</p>}
    {!!metrics?.missingUsageCount && <p className="mt-2 text-xs text-muted-foreground">{metrics.missingUsageCount} 次请求缺少部分用量，对应合计显示“暂无数据”。</p>}
  </div>;
}

/** 正文操作栏使用的整轮统计入口。 */
export function MetricsButton({ metrics }: { metrics?: TurnMetrics | undefined }) {
  return <Tooltip><TooltipTrigger asChild><Button type="button" variant="ghost" size="icon-xs" className="size-7" aria-label="本轮模型请求统计"><ChartNoAxesColumnIncreasing className="size-[15px]" /></Button></TooltipTrigger>
    <TooltipContent side="top" align="start" sideOffset={8} showArrow={false} className="rounded-xl border bg-popover p-3 text-popover-foreground shadow-lg">
      <MetricsDetails metrics={metrics} />
    </TooltipContent>
  </Tooltip>;
}

/** AI 操作在整轮结束后显示；运行中保留高度，用户消息仍立即提供操作。 */
export function MessageActions({ text, time, user = false, metrics, onEdit, disabled, running = false }: MessageActionsProps) {
  const { status: copyStatus, copy } = useCopyText();
  if (running && !user) return <div className="mt-1 h-7" aria-hidden="true" />;
  const timestamp = time === null ? null : <time dateTime={new Date(time).toISOString()} title={new Date(time).toLocaleString()}
    className={`px-1 text-[12px] tabular-nums ${user ? "" : "opacity-0 transition-opacity group-hover/message:opacity-100 group-focus-within/message:opacity-100"}`}>
    {new Date(time).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false })}
  </time>;
  return <div className={`mt-1 flex h-7 items-center gap-1 text-muted-foreground ${user ? "justify-end opacity-0 pointer-events-none transition-opacity group-hover/message:pointer-events-auto group-hover/message:opacity-100 group-focus-within/message:pointer-events-auto group-focus-within/message:opacity-100" : ""}`}>
    {user && timestamp}
    <Button type="button" variant="ghost" size="icon-xs" className="size-7" aria-label={copyStatus || "复制消息"} title={copyStatus || "复制消息"} onClick={() => void copy(text)}>
      {copyStatus === "已复制" ? <Check className="size-[15px]" /> : <Copy className="size-[15px]" />}
    </Button>
    {user ? <Button type="button" variant="ghost" size="icon-xs" className="size-7" aria-label="编辑消息" title="放回输入框编辑，作为新消息发送" disabled={disabled || !onEdit} onClick={() => onEdit?.(text)}><Pencil className="size-[15px]" /></Button>
      : <MetricsButton metrics={metrics} />}
    {!user && timestamp}
    <span role="status" className="sr-only">{copyStatus}</span>
  </div>;
}
