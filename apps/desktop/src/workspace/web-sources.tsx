import type { WebSource } from "@tilot/protocol";
import { WebLink, webURL } from "./markdown";

export function WebSources({ sources, showSnippets = false }: { sources: WebSource[]; showSnippets?: boolean }) {
  const unique = new Map<string, WebSource>();
  for (const source of sources) {
    if (webURL(source.url) && !unique.has(source.url)) unique.set(source.url, source);
  }
  if (!unique.size) return null;
  return <ul aria-label={showSnippets ? "联网结果" : "参考来源"} className="space-y-1 text-xs text-muted-foreground">
    {[...unique.values()].map((source) => <li key={source.url} className="wrap-anywhere">
      <WebLink href={source.url} title={source.url} className="text-foreground underline-offset-2 hover:underline">{source.title}</WebLink>
      {showSnippets && source.snippet && <p className="mt-0.5">{source.snippet}</p>}
    </li>)}
  </ul>;
}
