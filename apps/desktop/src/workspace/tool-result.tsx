/** 历史搜索行的展示字段，不依赖服务端工具实现。 */
interface SearchLine { line: number; text: string; textTruncated: boolean }

/** 旧历史或不完整结果不能直接当作搜索行渲染。 */
function isSearchLine(value: unknown): value is SearchLine {
  if (!value || typeof value !== "object") return false;
  const line = value as Record<string, unknown>;
  return Number.isInteger(line.line) && Number(line.line) >= 1 && typeof line.text === "string" && typeof line.textTruncated === "boolean";
}

/** 将目录与搜索结果变成可复制的相对路径和行号；未知结构保留原始结果。 */
function searchResult(name: string, data: Record<string, unknown>): { label: string; text: string } | undefined {
  if (name === "ls" && Array.isArray(data.entries)) {
    const entries = data.entries as unknown[];
    const lines: string[] = [];
    for (const entry of entries) {
      if (!entry || typeof entry !== "object") return;
      const { path, type } = entry as Record<string, unknown>;
      if (typeof path !== "string" || typeof type !== "string" || !["file", "directory", "link", "other"].includes(type)) return;
      lines.push(path + (type === "directory" ? "/" : type === "link" ? "（链接）" : ""));
    }
    return { label: `显示 ${entries.length} 个目录项`, text: lines.join("\n") || "（空目录）" };
  }
  if (name === "find" && Array.isArray(data.files) && data.files.every((file) => typeof file === "string")) {
    return { label: `显示 ${data.files.length} 个文件`, text: data.files.join("\n") || "（没有匹配文件）" };
  }
  if (name === "grep" && Array.isArray(data.matches)) {
    const matches = data.matches as unknown[];
    const groups: string[] = [];
    for (const match of matches) {
      if (!isSearchLine(match)) return;
      const { path, before, after } = match as SearchLine & Record<string, unknown>;
      if (typeof path !== "string" || !Array.isArray(before) || !Array.isArray(after) || !before.every(isSearchLine) || !after.every(isSearchLine)) return;
      const format = (line: SearchLine, separator: string) => `${path}${separator}${line.line}${separator} ${line.text}${line.textTruncated ? "（行已截断）" : ""}`;
      groups.push([...before.map((line) => format(line, "-")), format(match, ":"), ...after.map((line) => format(line, "-"))].join("\n"));
    }
    return { label: `显示 ${matches.length} 条匹配行`, text: groups.join("\n\n") || "（没有匹配内容）" };
  }
}

/** 展示已保存的工具结果，旧历史没有 diff 时继续显示原始内容。 */
export function ToolResult({ name, result, output }: { name: string; result: Record<string, unknown>; output: string }) {
  const data = result.data && typeof result.data === "object" ? result.data as Record<string, unknown> : {};
  if (name === "web_fetch" && result.status === "ok" && typeof data.content === "string") {
    const source = typeof data.finalUrl === "string" ? webURL(data.finalUrl) : "";
    const fetched = typeof data.fetchedAt === "number" && Number.isFinite(data.fetchedAt) ? new Date(data.fetchedAt) : null;
    return <div>
      <div className="space-y-1 border-b px-3 py-2 text-xs text-muted-foreground">
        {typeof data.title === "string" && <p className="font-medium text-foreground">{data.title}</p>}
        {source && <p className="wrap-anywhere">来源：<WebLink href={source} className="underline underline-offset-2 hover:text-foreground">{source}</WebLink></p>}
        {fetched && !Number.isNaN(fetched.getTime()) && <p>抓取时间：{fetched.toLocaleString("zh-CN")}</p>}
      </div>
      <pre aria-label="网页正文" className="max-h-72 overflow-auto px-3 py-2 font-mono text-xs leading-relaxed whitespace-pre-wrap wrap-anywhere">{data.content || "（正文为空）"}</pre>
    </div>;
  }
  if (name === "edit" && result.status === "ok" && typeof data.diff === "string") {
    return <div>
      <p className="border-b px-3 py-1.5 text-xs text-muted-foreground">
        {typeof data.replacements === "number" ? `完成 ${data.replacements} 处替换` : "编辑完成"}
        {typeof data.firstChangedLine === "number" && ` · 首个变更在第 ${data.firstChangedLine} 行`}
      </p>
      <pre aria-label="文件修改差异" className="max-h-72 overflow-auto py-2 font-mono text-xs leading-relaxed">
        {data.diff.split("\n").map((line, index) => {
          const header = (index === 0 && line.startsWith("--- ")) || (index === 1 && line.startsWith("+++ ")) || line.startsWith("@@");
          const color = header ? "text-muted-foreground" : line.startsWith("+") ? "bg-diff-added/10 text-diff-added" : line.startsWith("-") ? "bg-diff-removed/10 text-diff-removed" : "";
          return <span key={index} className={`block min-w-max px-3 ${color}`}>{line.replace(/\r$/, "") || "\u00a0"}</span>;
        })}
      </pre>
      {data.diffTruncated === true && <p className="border-t px-3 py-1.5 text-xs text-muted-foreground">差异已截断，仅展示部分内容，不能作为完整补丁应用。</p>}
    </div>;
  }
  const search = result.status === "ok" ? searchResult(name, data) : undefined;
  if (search) return <div>
    <p className="border-b px-3 py-1.5 text-xs text-muted-foreground">{search.label}</p>
    <pre aria-label="目录与搜索结果" className="max-h-72 overflow-auto px-3 py-2 font-mono text-xs leading-relaxed whitespace-pre-wrap wrap-anywhere">{search.text}</pre>
    {data.truncated === true && <p className="border-t px-3 py-1.5 text-xs text-muted-foreground">结果已截断，请缩小搜索范围或目录范围。</p>}
  </div>;
  const text = typeof result.error === "string" ? result.error : typeof data.content === "string" ? data.content : typeof data.output === "string" ? data.output : output;
  return <pre className="max-h-72 overflow-auto px-3 py-2 font-mono text-xs leading-relaxed whitespace-pre-wrap wrap-anywhere">{text || "（无输出）"}</pre>;
}
import { WebLink, webURL } from "./markdown";

