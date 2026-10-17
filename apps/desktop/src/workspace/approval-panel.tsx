import type { ToolApproval } from "@tilot/protocol";
import { Button } from "../components/ui/button";

/** 固定在输入框上方，每次只审批一个具体调用，不提供长期授权。 */
export function ApprovalPanel({ approval, disabled, onRespond }: {
  approval: ToolApproval | undefined;
  disabled: boolean;
  onRespond: (allowed: boolean) => void;
}) {
  if (!approval) return null;
  return <section role="region" aria-label="工具审批" aria-live="polite" className="mb-3 grid min-w-0 gap-3 rounded-xl border bg-card p-3">
    <p className="text-sm font-medium">{approval.name === "shell" ? "允许执行这条命令？" : "允许修改项目外的文件？"}</p>
    {approval.resolvedPath && <p className="break-all text-xs text-muted-foreground">目标：{approval.resolvedPath}</p>}
    <pre className="max-h-48 min-w-0 overflow-y-auto whitespace-pre-wrap break-all rounded-lg bg-muted p-3 text-xs">{approval.arguments}</pre>
    {approval.name === "shell" && <p className="text-xs text-muted-foreground">此命令使用当前系统权限执行，也可能修改项目外的文件。</p>}
    <div className="flex justify-end gap-2"><Button type="button" variant="outline" size="sm" disabled={disabled} onClick={() => onRespond(false)}>拒绝</Button>
      <Button type="button" size="sm" disabled={disabled} onClick={() => onRespond(true)}>允许</Button></div>
  </section>;
}
