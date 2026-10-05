"use client"

import * as CollapsiblePrimitive from "@radix-ui/react-collapsible"
import { createContext, useContext, useEffect, useState } from "react"

const OpenContext = createContext(false)

/** shadcn Collapsible：提供组件的语义结构、交互或默认样式。 */
function Collapsible({
  open: controlledOpen, defaultOpen = false, onOpenChange,
  ...props
}: React.ComponentProps<typeof CollapsiblePrimitive.Root>) {
  const [localOpen, setLocalOpen] = useState(defaultOpen)
  const open = controlledOpen ?? localOpen
  return <OpenContext.Provider value={open}>
    <CollapsiblePrimitive.Root data-slot="collapsible" {...props} open={open} onOpenChange={(value) => {
      setLocalOpen(value)
      onOpenChange?.(value)
    }} />
  </OpenContext.Provider>
}

/** shadcn CollapsibleTrigger：提供组件的语义结构、交互或默认样式。 */
function CollapsibleTrigger({
  ...props
}: React.ComponentProps<typeof CollapsiblePrimitive.CollapsibleTrigger>) {
  return (
    <CollapsiblePrimitive.CollapsibleTrigger
      data-slot="collapsible-trigger"
      {...props}
    />
  )
}

/** 动画容器和内容样式分开，边框、内外间距也随高度收起；支持嵌套与快速反向切换。 */
function CollapsibleContent({
  className, children,
  ...props
}: React.ComponentProps<typeof CollapsiblePrimitive.CollapsibleContent>) {
  const open = useContext(OpenContext)
  const [mounted, setMounted] = useState(open)
  useEffect(() => {
    if (open) setMounted(true)
    else if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) setMounted(false)
  }, [open])
  return (
    <CollapsiblePrimitive.CollapsibleContent
      data-slot="collapsible-content"
      {...props}
      forceMount
    >
      <div className="collapsible-motion" data-state={open ? "open" : "closed"} aria-hidden={!open} inert={!open}
        onTransitionEnd={(event) => {
          if (!open && event.target === event.currentTarget && event.propertyName === "grid-template-rows") setMounted(false)
        }}>
        <div className="min-h-0 min-w-0 overflow-hidden">
          <div className={className}>{(open || mounted) && children}</div>
        </div>
      </div>
    </CollapsiblePrimitive.CollapsibleContent>
  )
}

export { Collapsible, CollapsibleTrigger, CollapsibleContent }
