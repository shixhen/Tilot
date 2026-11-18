import type { Response, ResponseFunctionWebSearch } from "openai/resources/responses/responses";
import type { ToolView, WebSource } from "@tilot/protocol";

/** 只投影可展示的来源字段。服务端回放凭据仍保存在原始模型响应中。 */
export function webSource(value: unknown): WebSource | undefined {
  if (!value || typeof value !== "object" || !("url" in value) || typeof value.url !== "string" || !/^https?:\/\//i.test(value.url)) return;
  return {
    url: value.url,
    title: "title" in value && typeof value.title === "string" && value.title.trim() ? value.title : value.url,
    ...("snippet" in value && typeof value.snippet === "string" && value.snippet ? { snippet: value.snippet } : {}),
  };
}

/** 服务端联网使用模型输出位置，不登记为等待本地执行的工具调用。 */
export function projectWebTool(item: ResponseFunctionWebSearch, outputIndex: number): ToolView {
  const action = item.action;
  const searching = action.type === "search";
  const name = searching ? "web_search" : action.type === "find_in_page" ? "web_find" : "web_read";
  const args = searching ? { queries: action.queries ?? (action.query ? [action.query] : []) }
    : { url: action.url, ...(action.type === "find_in_page" ? { pattern: action.pattern } : {}) };
  const failed = item.status === "failed";
  const running = item.status === "in_progress" || item.status === "searching";
  const page = "page" in item ? webSource(item.page) : undefined;
  const source = page ?? webSource(args);
  const sources = searching ? (action.sources ?? []).flatMap((result) => webSource(result) ?? [])
    : source ? [source] : [];
  const error = "error" in item && item.error && typeof item.error === "object" && "code" in item.error && typeof item.error.code === "string"
    ? item.error.code : "联网工具执行失败";
  return {
    id: item.id, outputIndex, name, arguments: JSON.stringify(args), hosted: true, running,
    output: failed ? JSON.stringify({ status: "error", error })
      : item.status === "completed" ? JSON.stringify({ status: "ok", data: { sources } }) : null,
  };
}

/** 有用量时，省略联网统计字段表示次数为零；缺少用量时次数未知。 */
export function webToolCalls(usage: Response["usage"]): number | null {
  if (!usage) return null;
  if (!("server_tool_use" in usage) || usage.server_tool_use == null) return 0;
  const counts = usage.server_tool_use;
  if (typeof counts !== "object") return null;
  let total = 0;
  for (const name of ["tool_search", "tool_fetch", "tool_image_search"]) {
    const count: unknown = (counts as Record<string, unknown>)[name] ?? 0;
    if (typeof count !== "number" || !Number.isSafeInteger(count) || count < 0) return null;
    total += count;
  }
  return total;
}
