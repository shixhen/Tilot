import { memo } from "react";
import { Circle } from "lucide-react";
import type { TurnRecord } from "../conversation";
import { getContextTokens } from "../request-metrics";
import { Button } from "../components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "../components/ui/tooltip";

const tokenFormat = new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 });
const circumference = 2 * Math.PI * 10;

/** 输入框旁的上下文占用；详情仅在悬浮或键盘聚焦时显示。 */
export const ContextUsage = memo(function ContextUsage({ records, capacity }: { records: TurnRecord[]; capacity: number | null }) {
  const used = getContextTokens(records);
  const percent = used !== null && capacity !== null ? Math.round(used / capacity * 100) : null;
  const progress = percent === null ? 0 : Math.min(percent, 100);
  return <Tooltip>
    <TooltipTrigger asChild><Button type="button" variant="ghost" size="icon-sm" className="rounded-full text-muted-foreground" aria-label="上下文使用情况">
      <span className="relative size-4" aria-hidden="true">
        <Circle className="size-4 opacity-30" />
        {percent !== null && <Circle className="absolute inset-0 size-4 -rotate-90" strokeLinecap="butt"
          style={{ strokeDasharray: `${circumference * progress / 100} ${circumference}` }} />}
      </span>
    </Button></TooltipTrigger>
    <TooltipContent side="top" align="end" sideOffset={8} showArrow={false} className="max-w-72 rounded-xl border bg-popover p-3 text-left text-sm text-popover-foreground shadow-lg">
      <p className="mb-1 text-muted-foreground">上下文窗口</p>
      {percent !== null && <p className="font-medium tabular-nums">{percent}% 已用（剩余 {Math.max(0, 100 - percent)}%）</p>}
      <p className="tabular-nums">已用 {used === null ? "暂无数据" : `${tokenFormat.format(used).toLowerCase()} Token`}，总容量 {capacity === null ? "未设置" : `${tokenFormat.format(capacity).toLowerCase()} Token`}</p>
      <p className="mt-1 text-xs text-muted-foreground">{capacity === null ? "可在连接设置中填写该模型的上下文容量。"
        : used === null ? "等待模型请求返回用量。" : "按最近一次请求的输入与输出用量估算。"}</p>
    </TooltipContent>
  </Tooltip>;
});
