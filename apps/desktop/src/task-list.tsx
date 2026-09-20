import type { Thread } from "@tilot/protocol";
import { groupThreads, projectName } from "./projects";

/** 任务侧栏的数据与操作，组件不创建任务或修改已有项目绑定。 */
interface TaskListProps {
  threads: Thread[];
  selected: string | null;
  disabled: boolean;
  onSelect: (id: string) => void;
  onNew: (projectPath: string | null) => void;
}

/** 将任务按项目展示，同名目录用完整路径区分，并提供同项目新对话入口。 */
export function TaskList({ threads, selected, disabled, onSelect, onNew }: TaskListProps) {
  return <nav className="thread-list" aria-label="历史任务">
    {groupThreads(threads).map((group) => <section className="project-group" key={group.path ?? "ordinary"}>
      <div className="project-heading"><span title={group.path ?? "普通对话"}>{projectName(group.path)}</span>
        <button className="icon-button" title={group.path ?? "普通对话"} aria-label={`在${projectName(group.path)}中新建对话`} disabled={disabled} onClick={() => onNew(group.path)}>+</button>
      </div>
      {group.path && <p className="project-path" title={group.path}>{group.path}</p>}
      {group.threads.map((thread) => <button className={`thread-button ${selected === thread.id ? "selected" : ""}`} key={thread.id} title={thread.title} disabled={disabled} onClick={() => onSelect(thread.id)}><span>{thread.title}</span></button>)}
    </section>)}
    {threads.length === 0 && <p className="sidebar-empty">发送消息，开始第一个任务</p>}
  </nav>;
}
