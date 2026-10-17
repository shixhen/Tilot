import { useState } from "react";
import { Check, ChevronDown, Shield } from "lucide-react";
import type { PermissionMode } from "@tilot/protocol";
import { Button } from "../components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "../components/ui/popover";

const PERMISSION_LABELS: Record<PermissionMode, string> = {
  "read-only": "只读", "workspace-write": "项目内修改", "full-access": "完全访问",
};

interface PermissionPickerProps {
  mode: PermissionMode;
  project: boolean;
  locked: boolean;
  disabled: boolean;
  running: boolean;
  onChange: (mode: PermissionMode) => void;
}

/** 三种模式平级展示；已锁定的不兼容选项仍显示，并解释禁用原因。 */
export function PermissionPicker({ mode, project, locked, disabled, running, onChange }: PermissionPickerProps) {
  const [open, setOpen] = useState(false);
  const modes: PermissionMode[] = project ? ["read-only", "workspace-write", "full-access"] : ["read-only", "full-access"];
  return <Popover open={open} onOpenChange={setOpen}>
    <PopoverTrigger asChild><Button type="button" variant="ghost" size="sm" disabled={disabled}
      className="h-8 gap-1 rounded-full px-2 text-xs font-normal" aria-label={`权限：${PERMISSION_LABELS[mode]}`}>
      <Shield className="size-3.5" /><span>{PERMISSION_LABELS[mode]}</span><ChevronDown className="disclosure-icon size-3" />
    </Button></PopoverTrigger>
    <PopoverContent align="start" className="w-64 rounded-xl p-2">
      {modes.map((item) => {
        const blocked = locked && (mode === "read-only") !== (item === "read-only");
        return <Button key={item} type="button" variant="ghost" disabled={blocked} aria-pressed={mode === item}
          className="w-full justify-between font-normal" title={blocked ? "首次发送后不能切换到此模式，请新建对话" : undefined}
          onClick={() => { onChange(item); setOpen(false); }}>{PERMISSION_LABELS[item]}{mode === item && <Check />}</Button>;
      })}
      <p className="px-2 pt-2 pb-1 text-xs text-muted-foreground">{locked
        ? "首次发送后，只读与其他模式不能互相切换。" : "首次发送前可选择；发送后只读与其他模式不能互相切换。"}
        {running && "当前轮次权限固定，修改在下一轮生效。"}</p>
    </PopoverContent>
  </Popover>;
}
