import assert from "node:assert/strict";
import { test } from "node:test";
import { closeWhenUnselected, hasSelection } from "../src/hooks/use-auto-disclosure.ts";

/** 用浏览器同样的事件接口模拟选区，测试自动关闭及清理，不依赖页面预览。 */
function selectionFixture() {
  const selected = new Set<HTMLElement>();
  const document = new EventTarget();
  const selection = {
    isCollapsed: false, rangeCount: 1,
    getRangeAt: () => ({ intersectsNode: (element: HTMLElement) => selected.has(element) }),
  };
  Object.assign(document, { getSelection: () => selection });
  const outer = { ownerDocument: document } as unknown as HTMLElement;
  const inner = { ownerDocument: document } as unknown as HTMLElement;
  return { document, selection, selected, outer, inner,
    change: () => document.dispatchEvent(new Event("selectionchange")) };
}

test("选区覆盖内外层时一起暂缓收起，取消选择后各关闭一次", () => {
  const { selected, outer, inner, selection, change } = selectionFixture();
  selected.add(outer).add(inner);
  const closed: string[] = [];
  closeWhenUnselected(outer, () => closed.push("outer"));
  closeWhenUnselected(inner, () => closed.push("inner"));
  change();
  assert.deepEqual(closed, []);
  selection.isCollapsed = true;
  change();
  assert.deepEqual(closed, ["outer", "inner"]);
  change();
  assert.equal(closed.length, 2);
});

test("选区移出内容即可收起，不必清空页面其他位置的选区", () => {
  const { selected, outer, change } = selectionFixture();
  selected.add(outer);
  let closes = 0;
  closeWhenUnselected(outer, () => closes++);
  selected.clear();
  change();
  assert.equal(closes, 1);
});

test("手动操作或卸载会取消等待，之后选区变化不再触发旧的自动关闭", () => {
  const { selected, outer, change } = selectionFixture();
  selected.add(outer);
  let closes = 0;
  const cancel = closeWhenUnselected(outer, () => closes++);
  cancel();
  selected.clear();
  change();
  assert.equal(closes, 0);
});

test("无选区或选区在块外时立即关闭，不留下监听器", () => {
  const { outer, selected, selection, change } = selectionFixture();
  let closes = 0;
  closeWhenUnselected(outer, () => closes++);
  assert.equal(closes, 1);
  selected.add(outer);
  assert.equal(hasSelection(outer), true);
  selection.rangeCount = 0;
  assert.equal(hasSelection(outer), false);
  closeWhenUnselected(outer, () => closes++);
  assert.equal(closes, 2);
  change();
  assert.equal(closes, 2);
  assert.equal(hasSelection(null), false);
});
