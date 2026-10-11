import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { BoardPaneView } from "../src/board/BoardPaneView.js";
import type { BoardPaneLoadState } from "../src/board/loadBoardDocument.js";
import { parseBoardJson } from "../src/board/boardViewModel.js";
import { ZCodeIntlProvider } from "../src/i18n/IntlProvider.js";
import { STAGE_MATRIX_BOARD } from "./boardStageMatrixFixture.js";

/**
 * 排序记忆 vs 过滤临时态的**持久性差异提示**（卡 #175 ②；来源证据
 * `.zcode/board/evidence/T6465d/design-review.md` 第 4 条【归 #60】：排序视角进会话记忆、
 * 过滤条件只在本次打开期间生效，两者同控件组同外观 —— 重开面板「排序保留、过滤清空」会被
 * 误读为同类状态）。评审建议视觉分组或轻量辅助说明，二选一；本卡取**就近的轻量辅助说明**
 * （与 D5 计数片同款：可见短文案 + 全文进 `title`），**不加持久化**。
 *
 * 期望值的独立真源：本卡文案决定（zh/en 逐字写在下面，改文案时测试先红）——不由实现回算。
 * 控件组与排序控件的既有锚点（`data-board-list-filters` / `data-board-filter="sort"`）不变；
 * 提示是纯说明文案，不得借成功色或实心底色（反例：成功色填充）。
 */

function render(viewMode: "list" | "table", locale: "zh-CN" | "en-US" = "zh-CN"): string {
  const outcome = parseBoardJson(JSON.stringify(STAGE_MATRIX_BOARD));
  assert.equal(outcome.kind, "ready", "夹具必须是 ready");
  if (outcome.kind !== "ready") throw new Error("夹具必须是 ready");
  const state: BoardPaneLoadState = { kind: "ready", board: outcome.board };
  return renderToStaticMarkup(
    createElement(ZCodeIntlProvider, {
      initialLocale: locale,
      children: createElement(BoardPaneView, { state, viewMode }),
    }),
  );
}

const ZH_HINT = "排序在本会话保留 · 过滤为临时条件";
const ZH_HINT_TITLE =
  "排序视角按会话记忆保留（切视图或重开面板仍在）；过滤条件为临时状态，关闭面板后回到默认";
const EN_HINT = "Sort kept for this session · filters are temporary";
const EN_HINT_TITLE =
  "Sort order is remembered for this session (kept across view switches and pane reopen); filters are temporary and reset when the pane closes";

/** 控件块之后的正文字锚（提示必须落在控件块内 = 锚点之前）。 */
const BODY_ANCHOR: Record<"list" | "table", string> = {
  list: "data-board-list-group=",
  table: "data-board-table=",
};

test("持久性差异提示（#175 ②）：列表/表格共用控件组，排序控件之后就位一条轻量说明", () => {
  for (const viewMode of ["list", "table"] as const) {
    const markup = render(viewMode);
    const hintAt = markup.indexOf("data-board-sort-memory-hint");
    assert.ok(hintAt >= 0, `${viewMode}：应有排序记忆提示锚点（data-board-sort-memory-hint）`);
    const sortAt = markup.indexOf('data-board-filter="sort"');
    assert.ok(sortAt >= 0, `${viewMode}：排序控件照常在场`);
    assert.ok(hintAt > sortAt, `${viewMode}：提示就近跟在排序控件之后`);
    const bodyAt = markup.indexOf(BODY_ANCHOR[viewMode]);
    assert.ok(bodyAt > hintAt, `${viewMode}：提示落在控件块内（正文字锚之前）`);
    assert.equal(
      markup.match(/data-board-sort-memory-hint/g)?.length,
      1,
      `${viewMode}：一条提示（不重复堆文案）`,
    );
    const tag = /<[^>]*data-board-sort-memory-hint[^>]*>/.exec(markup)?.[0] ?? "";
    assert.ok(!/success/.test(tag), `提示不得借成功色：${tag}`);
    assert.ok(!/\bbg-/.test(tag), `提示不得带实心底色：${tag}`);
  }
  const zh = render("list");
  const zhTag = /<[^>]*data-board-sort-memory-hint[^>]*>[\s\S]*?<\/span>/.exec(zh)?.[0] ?? "";
  assert.ok(zhTag.includes(ZH_HINT), `zh 可见短文案逐字：${zhTag}`);
  assert.equal(
    /title="([^"]*)"/.exec(zhTag)?.[1],
    ZH_HINT_TITLE,
    "zh 全文语义进 title（短文案只给量级，与 D5 计数片同款）",
  );
});

test("持久性差异提示（#175 ②）：en-US 同款提示不漏中文", () => {
  const en = render("list", "en-US");
  const enTag = /<[^>]*data-board-sort-memory-hint[^>]*>[\s\S]*?<\/span>/.exec(en)?.[0] ?? "";
  assert.ok(enTag.includes(EN_HINT), `en 可见短文案逐字：${enTag}`);
  assert.equal(/title="([^"]*)"/.exec(enTag)?.[1], EN_HINT_TITLE, "en 全文语义进 title");
  assert.ok(!/[\u4e00-\u9fff]/.test(enTag), `en 提示不得漏中文：${enTag}`);
});
