import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { Thread } from "@tilot/protocol";
import { groupThreads, projectName } from "../src/projects.ts";
import { TaskList } from "../src/task-list.tsx";
import { SidebarProvider } from "../src/components/ui/sidebar.tsx";

// 同名项目必须按完整路径隔离，展示时保留可识别路径和任务顺序。
test("侧栏区分同名目录和普通对话，保留项目内任务顺序", () => {
  const threads: Thread[] = ["D:\\one\\demo", null, "D:\\two\\demo", "D:\\one\\demo"].map((projectPath, index) => ({ id: String(index), title: `任务 ${index}`, projectPath, createdAt: index, updatedAt: index }));
  const groups = groupThreads(threads);
  assert.deepEqual(groups.map((group) => group.threads.map((thread) => thread.id)), [["0", "3"], ["1"], ["2"]]);
  assert.equal(projectName("D:\\"), "D:\\");
  assert.equal(projectName("D:\\one\\demo\\"), "demo");
  const html = renderToStaticMarkup(createElement(SidebarProvider, {}, createElement(TaskList, { threads, selected: "2", disabled: false, onSelect: () => {}, onNew: () => {} })));
  assert.ok(html.includes("D:\\one\\demo"));
  assert.ok(html.includes("D:\\two\\demo"));
  assert.match(html, /普通对话/);
  const selectedButton = html.match(/<button\b(?=[^>]*title="任务 2")[^>]*>/)?.[0] ?? "";
  assert.match(selectedButton, /data-active="true"/);
  assert.match(selectedButton, /aria-current="page"/);
});
