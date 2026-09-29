import { useState } from "react";
import { Check, ChevronDown, ChevronRight } from "lucide-react";
import type { Provider, ReasoningEffort } from "@tilot/protocol";
import { Button } from "../components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "../components/ui/popover";
import { Slider } from "../components/ui/slider";

/** 思考强度从低到高排列，滑块位置就是数组下标。 */
const EFFORTS: ReasoningEffort[] = ["none", "low", "high", "max"];

interface ModelPickerProps {
  providerId: string;
  model: string;
  reasoningEffort: ReasoningEffort;
  providers: Provider[];
  onChange: (providerId: string, model: string, reasoningEffort: ReasoningEffort) => void;
}

/** Codex 式模型选择：面板默认显示思考强度滑块，点击上方模型名切换到按服务分组的模型列表，选中后回到滑块。 */
export function ModelPicker({ providerId, model, reasoningEffort, providers, onChange }: ModelPickerProps) {
  const [view, setView] = useState<"effort" | "models">("effort");
  // 服务被删或模型不在列表中时标红，提示重新选择。
  const missing = !providers.find((provider) => provider.id === providerId)?.models.some((item) => item.id === model);

  return <Popover onOpenChange={() => setView("effort")}>
    <PopoverTrigger asChild>
      <Button type="button" variant="ghost" size="sm" className="h-8 gap-1 rounded-full px-2.5 text-sm font-normal hover:bg-white/10!" title={missing ? "当前服务没有这个模型，请重新选择" : "选择模型和思考强度"}>
        <span className={`max-w-40 truncate ${missing ? "text-destructive" : ""}`}>{model}</span>
        <span className="text-muted-foreground">{reasoningEffort}</span>
        <ChevronDown className="disclosure-icon size-3.5 text-muted-foreground" />
      </Button>
    </PopoverTrigger>
    <PopoverContent align="end" sideOffset={8} className="w-56 rounded-xl border-white/10 p-2 shadow-xl">
      {view === "effort" ? <>
        <button type="button" className="mx-auto mb-2 flex min-w-28 max-w-full flex-col items-center rounded-lg px-3 py-1 outline-none transition-colors hover:bg-white/8 focus-visible:bg-white/8"
          onClick={() => setView("models")}>
          <span className="text-[15px] leading-6 font-semibold text-link">{reasoningEffort}</span>
          <span className={`flex max-w-full items-center gap-0.5 text-xs ${missing ? "text-destructive" : "text-muted-foreground"}`}>
            <span className="truncate">{model}</span><ChevronRight className="disclosure-icon size-3" />
          </span>
        </button>
        <Slider min={0} max={EFFORTS.length - 1} step={1} value={[EFFORTS.indexOf(reasoningEffort)]} aria-label="思考强度"
          onValueChange={([index]) => onChange(providerId, model, EFFORTS[index!]!)} />
      </> : <div className="max-h-72 overflow-y-auto">
        <p className="px-2 pt-0.5 pb-1 text-xs text-muted-foreground">选择模型</p>
        {providers.map((provider) => <div key={provider.id} role="group" aria-label={provider.name} className="pb-1">
          <p className="px-2 pt-1.5 pb-0.5 text-xs text-muted-foreground/70">{provider.name}</p>
          {provider.models.map((item) => {
            const selected = provider.id === providerId && item.id === model;
            return <button key={item.id} type="button" aria-pressed={selected}
              className="flex h-8 w-full items-center gap-2 rounded-md px-2 text-left text-[13px] outline-none hover:bg-white/8 focus-visible:bg-white/8"
              onClick={() => { onChange(provider.id, item.id, reasoningEffort); setView("effort"); }}>
              <span className="min-w-0 flex-1 truncate">{item.id}</span>
              {selected && <Check className="size-3.5 shrink-0" />}
            </button>;
          })}
        </div>)}
      </div>}
    </PopoverContent>
  </Popover>;
}
