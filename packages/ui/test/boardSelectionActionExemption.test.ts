import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { BoardPaneView } from "../src/board/BoardPaneView.js";
import type { BoardPaneLoadState } from "../src/board/loadBoardDocument.js";
import { parseBoardJson } from "../src/board/boardViewModel.js";
import { ZCodeIntlProvider } from "../src/i18n/IntlProvider.js";
import { GOLDEN_SHAPED_BOARD } from "./boardTestFixture.js";

/**
 * 看板面板的**选择浮条豁免声明**守卫（卡 #64）。
 *
 * 契约（成文于 `src/lib/conversationSelectionGuard.ts`）：只读表面在根容器声明
 * `data-no-selection-action`，共享判据据此豁免「选中文字→添加到当前任务/在辅助对话中提问」浮条。
 * 本文件只钉「面板确实声明了该身份」这一结构事实；**行为证据**（看板内选区不出现浮条、
 * 文件预览选区照常出现浮条）在真 Electron 的 `boardSelectionToolbarBrowser.ts` 两场景四条断言里——
 * SSR 结构断言不构成行为证据（UI 卡门禁，2026-10-10）。
 *
 * 为什么按「同一元素」断言：`data-board-pane` 是弹窗定位/锚点用的面板身份，豁免属性必须与它
 * 落在同一个根元素上（分别放在父子两层会让 `closest()` 仍能命中，但豁免范围会被后来的兄弟内容
 * 悄悄扩大——同一元素把范围钉死成"面板根及其子树"）。
 */

function readyState(): BoardPaneLoadState {
  const outcome = parseBoardJson(JSON.stringify(GOLDEN_SHAPED_BOARD));
  if (outcome.kind !== "ready") throw new Error("夹具必须是 v2 且 features 非空");
  return { kind: "ready", board: outcome.board };
}

function render(state: BoardPaneLoadState): string {
  return renderToStaticMarkup(
    createElement(ZCodeIntlProvider, {
      initialLocale: "zh-CN" as const,
      children: createElement(BoardPaneView, { state, onRefresh: () => {} }),
    }),
  );
}

/** 面板根元素的开标签（`data-board-pane` 与豁免属性必须在同一标签上）。 */
function boardPaneRootTag(markup: string): string {
  const match = /<div[^>]*data-board-pane=""[^>]*>/.exec(markup);
  assert.ok(match, `markup 里找不到看板面板根元素：\n${markup.slice(0, 400)}`);
  return match[0];
}

test("就绪态：面板根声明选择浮条豁免（与 data-board-pane 同一元素）", () => {
  const markup = render(readyState());
  const rootTag = boardPaneRootTag(markup);
  assert.ok(
    rootTag.includes("data-no-selection-action"),
    `看板面板根必须声明 data-no-selection-action（卡 #64 的共享豁免约定）：\n${rootTag}`,
  );
});

test("占位态（空/损坏/不可读/加载中）：同一份豁免声明", () => {
  const kinds: BoardPaneLoadState[] = [
    { kind: "missing" },
    { kind: "empty" },
    { kind: "damaged" },
    { kind: "unavailable" },
    { kind: "loading" },
  ];
  for (const state of kinds) {
    const markup = render(state);
    const rootTag = boardPaneRootTag(markup);
    assert.ok(
      rootTag.includes("data-no-selection-action"),
      `占位态 ${state.kind} 的面板根必须与就绪态同一份豁免声明：\n${rootTag}`,
    );
  }
});
