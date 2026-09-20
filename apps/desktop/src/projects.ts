import type { Thread } from "@tilot/protocol";

/** 一个项目及其任务；空路径表示没有绑定项目的普通对话。 */
export interface ProjectGroup {
  path: string | null;
  threads: Thread[];
}

/** 按服务返回的规范路径分组，保留任务及项目最近出现的顺序。 */
export function groupThreads(threads: Thread[]): ProjectGroup[] {
  const groups = new Map<string | null, ProjectGroup>();
  for (const thread of threads) {
    let group = groups.get(thread.projectPath);
    if (!group) {
      group = { path: thread.projectPath, threads: [] };
      groups.set(thread.projectPath, group);
    }
    group.threads.push(thread);
  }
  return [...groups.values()];
}

/** 取目录末段作为短名称，根目录仍显示完整路径，不更改用于绑定的原路径。 */
export function projectName(path: string | null): string {
  if (path === null) return "普通对话";
  if (/^[A-Za-z]:[\\/]+$/.test(path)) return path;
  return path.replace(/[\\/]+$/, "").split(/[\\/]/).at(-1) || path;
}
