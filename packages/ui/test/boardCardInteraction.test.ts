import assert from "node:assert/strict";
import test from "node:test";
import type { KeyboardEvent as ReactKeyboardEvent, MouseEvent } from "react";
import {
  boardCardHighlightProps,
  boardCardKeyIntent,
  boardCardOpenProps,
  boardCardSelector,
} from "../src/board/boardCardInteraction.js";

/**
 * 卡片交互的纯函数缝（卡 #34）：行/卡点击 → 弹窗、跳转落点定位与高亮。
 *
 * 期望值的独立真源：契约 §3.1/§3.3（「点击节点/卡片 → 弹窗」）、§6（`dependency` 跳转：
 * 滚动到目标卡并高亮）与卡 #34 派发指令（跳转=滚动到对应卡并高亮，面板内实现）。
 * 选择器转义是防注入/防误命中的判据，逐字写死。
 */

test("卡片定位选择器：按 id 取锚点，引号与反斜杠转义（不注入、不误命中）", () => {
  assert.equal(boardCardSelector("task:8"), '[data-board-card="task:8"]');
  assert.equal(
    boardCardSelector("spec:preview-channel"),
    '[data-board-card="spec:preview-channel"]',
  );
  assert.equal(boardCardSelector('task:"x"'), '[data-board-card="task:\\"x\\""]');
  assert.equal(boardCardSelector("task:a\\b"), '[data-board-card="task:a\\\\b"]');
  assert.notEqual(boardCardSelector("task:8"), '[data-board-card="task:80"]', "精确匹配，不是前缀");
});

test("卡片激活键位：Enter / Space 打开弹窗，其余键不打开（纯函数一处判定）", () => {
  assert.equal(boardCardKeyIntent("Enter"), "open");
  assert.equal(boardCardKeyIntent(" "), "open", "Space 也是标准激活键");
  assert.equal(boardCardKeyIntent("Escape"), "none");
  assert.equal(boardCardKeyIntent("Tab"), "none");
});

test("打开态 props：有回调才可点（role/tabIndex/键盘激活），无回调保持只读展示", () => {
  const clickable = boardCardOpenProps({ id: "task:8", onOpenCard: () => {} });
  assert.equal(clickable.role, "button");
  assert.equal(clickable.tabIndex, 0);
  assert.equal(typeof clickable.onClick, "function");
  assert.equal(typeof clickable.onKeyDown, "function");
  assert.deepEqual(
    boardCardOpenProps({ id: "task:8" }),
    {},
    "没有打开回调 → 不挂交互 props（面板仍可只读展示）",
  );
});

/** 只要 handler 读到的两个字段：真实的 React 合成事件在无 DOM 环境里造不出来（同款降级见仓库既有做法）。 */
function mouseEvent(): MouseEvent {
  return {} as unknown as MouseEvent;
}

function keyEvent(key: string, onPreventDefault?: () => void): ReactKeyboardEvent {
  return {
    key,
    preventDefault: () => onPreventDefault?.(),
  } as unknown as ReactKeyboardEvent;
}

test("打开/激活回调：点击与 Enter/Space 都回传卡片 id；其余键不回传", () => {
  const opened: string[] = [];
  const props = boardCardOpenProps({ id: "task:8", onOpenCard: (id) => opened.push(id) });
  props.onClick?.(mouseEvent());
  props.onKeyDown?.(keyEvent("Enter"));
  props.onKeyDown?.(keyEvent(" "));
  props.onKeyDown?.(keyEvent("Escape"));
  assert.deepEqual(opened, ["task:8", "task:8", "task:8"]);
  let prevented = false;
  props.onKeyDown?.(
    keyEvent(" ", () => {
      prevented = true;
    }),
  );
  assert.equal(prevented, true, "Space 激活要阻止页面滚动默认行为");
});

test("高亮 props：命中跳转落点才挂 data 锚点（其余卡片不带该属性）", () => {
  assert.deepEqual(boardCardHighlightProps("task:9", "task:9"), {
    "data-board-card-highlight": "true",
  });
  assert.deepEqual(boardCardHighlightProps("task:8", "task:9"), {});
  assert.deepEqual(boardCardHighlightProps("task:9", null), {}, "没有跳转就没有高亮");
  assert.deepEqual(boardCardHighlightProps("task:9", undefined), {});
});
