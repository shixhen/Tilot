"use client"

import * as React from "react"
import * as SliderPrimitive from "@radix-ui/react-slider"
import { cn } from "@/lib/utils"

/**
 * 基于 shadcn Slider 调整为 Codex 样式：粗轨道、大圆形滑块，并在每个可选位置显示小圆点。
 * 只支持单个取值；aria-label 放到滑块按钮上，读屏软件才能读出名称。
 */
function Slider({
  className,
  min = 0,
  max = 100,
  step = 1,
  value,
  "aria-label": label,
  ...props
}: React.ComponentProps<typeof SliderPrimitive.Root> & { value: number[] }) {
  const current = value[0]!
  const marks = Array.from({ length: Math.round((max - min) / step) + 1 }, (_, index) => min + index * step)

  return (
    <SliderPrimitive.Root
      data-slot="slider"
      min={min}
      max={max}
      step={step}
      value={value}
      className={cn("relative flex h-6 w-full touch-none items-center select-none data-[disabled]:opacity-50", className)}
      {...props}
    >
      <SliderPrimitive.Track data-slot="slider-track" className="relative h-full grow overflow-hidden rounded-full bg-white/10">
        <SliderPrimitive.Range data-slot="slider-range" className="absolute h-full bg-brand" />
        {/* 圆点与滑块中心对齐：Radix 让滑块留在轨道内，中心的可移动范围是左右各缩进半个滑块宽度。 */}
        <div className="pointer-events-none absolute inset-y-0 right-3 left-3">
          {marks.map((mark) => (
            <span key={mark} className={cn("absolute top-1/2 size-1 -translate-1/2 rounded-full", mark <= current ? "bg-white/60" : "bg-white/25")}
              style={{ left: `${((mark - min) / (max - min)) * 100}%` }} />
          ))}
        </div>
      </SliderPrimitive.Track>
      <SliderPrimitive.Thumb
        data-slot="slider-thumb"
        aria-label={label}
        className="block size-6 shrink-0 rounded-full bg-white shadow-md outline-hidden transition-[box-shadow] focus-visible:ring-3 focus-visible:ring-white/30"
      />
    </SliderPrimitive.Root>
  )
}

export { Slider }
