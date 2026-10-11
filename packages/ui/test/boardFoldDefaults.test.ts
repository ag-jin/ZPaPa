import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { BoardPaneView } from "../src/board/BoardPaneView.js";
import type { BoardFoldControls } from "../src/board/boardFoldState.js";
import type { BoardPaneLoadState } from "../src/board/loadBoardDocument.js";
import { parseBoardJson } from "../src/board/boardViewModel.js";
import type { BoardViewMode } from "../src/board/boardViewsViewModel.js";
import { ZCodeIntlProvider } from "../src/i18n/IntlProvider.js";
import { FOLD_BOARD } from "./boardFoldFixture.js";

/**
 * 折叠默认态的四视图落地（卡 #89 / A4-3；AD-5）。
 *
 * 期望值的独立真源：裁决包 AD-5「缺口展开 · 含活跃期次展开 · 全完成/全取消折叠」（itw-20261010-5372）
 * + 卡文验收「用户首次打开看到缺口与活跃期次展开、全终态组折叠；刷新后保持（记忆）」+ 规则书 v2 B2
 * （树形特性块默认展开规则，递归扩展到容器层）。断言手推自夹具（FOLD_BOARD 的缺口/段位分布）。
 *
 * 反例（必咬）：KANB2/DONE1 是全终态组（默认必须折叠——展开即违 AD-5）；DONE2 是含缺口终态组
 * （默认必须展开——折叠即把缺口埋掉，违 OB-2 共洽判据）。
 */

function readyState(): BoardPaneLoadState {
  const outcome = parseBoardJson(JSON.stringify(FOLD_BOARD));
  assert.equal(outcome.kind, "ready", "夹具必须是 ready");
  if (outcome.kind !== "ready") throw new Error("夹具必须是 ready");
  return { kind: "ready", board: outcome.board };
}

function render(
  viewMode: BoardViewMode,
  fold?: BoardFoldControls,
  locale: "zh-CN" | "en-US" = "zh-CN",
): string {
  return renderToStaticMarkup(
    createElement(ZCodeIntlProvider, {
      initialLocale: locale,
      children: createElement(BoardPaneView, {
        state: readyState(),
        viewMode,
        ...(fold ? { fold } : {}),
      }),
    }),
  );
}

/** `<details ...>` 开标签（判 open 属性用）；锚点可以是任意落在该标签上的 data 属性。 */
function detailsTag(markup: string, anchor: string): string {
  const at = markup.indexOf(anchor);
  assert.ok(at >= 0, `锚点应存在：${anchor}`);
  const start = markup.lastIndexOf("<details", at);
  assert.ok(start >= 0 && start < at, `锚点应落在 <details> 开标签上：${anchor}`);
  const end = markup.indexOf(">", at);
  return markup.slice(start, end);
}

function isOpen(markup: string, anchor: string): boolean {
  return /\sopen(=|[ >]|$)/.test(detailsTag(markup, anchor) + " ");
}

/* ---------------- 树形（B2 递归扩展：稿层 + 容器层） ---------------- */

test("树形默认态：缺口/含活跃组展开，全终态组折叠（含活跃期次展开 + 全终态反例必咬）", () => {
  const markup = render("tree");
  // 容器层（epic ⊃ 期次）：KANB1 含活跃成员 → 展开；KANB2 全终态 → 折叠。
  assert.equal(isOpen(markup, 'data-board-epic-block="KANB"'), true, "KANB 含活跃期次 → 展开");
  assert.equal(isOpen(markup, 'data-board-phase-block="KANB1"'), true, "KANB1 含活跃成员 → 展开");
  assert.equal(
    isOpen(markup, 'data-board-phase-block="KANB2"'),
    false,
    "KANB2 全终态（已完成 + 已取消）→ 折叠（全终态组展开必咬）",
  );
  assert.equal(
    isOpen(markup, 'data-board-epic-block="DONE"'),
    true,
    "DONE 含缺口终态成员 → epic 层也展开（缺口跨层传播）",
  );
  assert.equal(isOpen(markup, 'data-board-phase-block="DONE1"'), false, "DONE1 全终态 → 折叠");
  assert.equal(
    isOpen(markup, 'data-board-phase-block="DONE2"'),
    true,
    "DONE2 终态成员带缺口 → 展开（缺口组折叠必咬：缺口不许被折叠组埋掉）",
  );
  // 稿层（B2 原判据，递归扩展后同样认「已取消」为终态）。
  assert.equal(isOpen(markup, 'data-board-feature-block="plan:fold-active"'), true, "活跃稿展开");
  assert.equal(
    isOpen(markup, 'data-board-feature-block="plan:fold-done-a"'),
    false,
    "已完成稿折叠（B2 原判据）",
  );
  assert.equal(
    isOpen(markup, 'data-board-feature-block="plan:fold-done-b"'),
    false,
    "已完成稿折叠（容器层折叠不影响稿层自身判据）",
  );
  assert.equal(
    isOpen(markup, 'data-board-feature-block="spec:fold-done-ungrouped"'),
    false,
    "无归属已完成稿（叶级）折叠",
  );
  assert.equal(
    isOpen(markup, 'data-board-feature-block="spec:fold-todo-ungrouped"'),
    true,
    "无归属待办稿（叶级）展开",
  );
});

test("树形记忆：用户覆盖优先于默认态（刷新后保持——会话记忆读回路径落渲染面）", () => {
  const muted: BoardFoldControls = { state: {}, onToggle: () => {} };
  const defaults = render("tree", muted);
  assert.equal(isOpen(defaults, 'data-board-phase-block="KANB2"'), false);
  const overridden: BoardFoldControls = {
    state: { "phase:KANB#2": true, "epic:DONE": false },
    onToggle: () => {},
  };
  const markup = render("tree", overridden);
  assert.equal(
    isOpen(markup, 'data-board-phase-block="KANB2"'),
    true,
    "用户展开过 → 渲染面照记忆展开（刷新后保持）",
  );
  assert.equal(
    isOpen(markup, 'data-board-epic-block="DONE"'),
    false,
    "用户折叠过 → 渲染面照记忆折叠（覆盖优先于默认态）",
  );
  assert.equal(
    isOpen(markup, 'data-board-feature-block="plan:fold-active"'),
    true,
    "未覆盖的组照默认态（覆盖只动被动过的那一层）",
  );
});

/* ---------------- 列表（B4 分组行 + 容器层同判据） ---------------- */

test("列表默认态：分组行与容器层走同一份递归判据（全终态组折叠 + 缺口组展开）", () => {
  const markup = render("list");
  assert.equal(isOpen(markup, 'data-board-epic-block="KANB"'), true, "KANB 含活跃期次 → 展开");
  assert.equal(isOpen(markup, 'data-board-phase-block="KANB1"'), true, "KANB1 含活跃成员 → 展开");
  assert.equal(
    isOpen(markup, 'data-board-phase-block="KANB2"'),
    false,
    "KANB2 全终态 → 折叠（全终态组展开必咬）",
  );
  assert.equal(isOpen(markup, 'data-board-epic-block="DONE"'), true, "DONE 含缺口成员 → 展开");
  assert.equal(isOpen(markup, 'data-board-phase-block="DONE1"'), false, "DONE1 全终态 → 折叠");
  assert.equal(
    isOpen(markup, 'data-board-phase-block="DONE2"'),
    true,
    "DONE2 终态成员带缺口 → 展开（缺口组折叠必咬）",
  );
  // 稿层分组行（B4 `<details>`）：叶级判据（缺口展开 / 终态折叠 / 其余展开）。
  assert.equal(isOpen(markup, 'data-board-list-group="plan:fold-active"'), true, "活跃稿分组展开");
  assert.equal(
    isOpen(markup, 'data-board-list-group="plan:fold-done-a"'),
    false,
    "已完成稿分组折叠（B2 判据的列表面落地）",
  );
  assert.equal(
    isOpen(markup, 'data-board-list-group="spec:fold-done-ungrouped"'),
    false,
    "无归属已完成稿分组折叠",
  );
  assert.equal(
    isOpen(markup, 'data-board-list-group="spec:fold-todo-ungrouped"'),
    true,
    "无归属待办稿分组展开",
  );
});

test("列表记忆：同一稿 id 的覆盖跨视图生效（树形折叠过 → 列表同折叠）", () => {
  const fold: BoardFoldControls = {
    state: { "plan:fold-active": false },
    onToggle: () => {},
  };
  const markup = render("list", fold);
  assert.equal(
    isOpen(markup, 'data-board-list-group="plan:fold-active"'),
    false,
    "稿 id 即折叠 id：树形折叠过的稿在列表同样折叠（同一份记忆）",
  );
  assert.equal(
    isOpen(markup, 'data-board-list-group="spec:fold-todo-ungrouped"'),
    true,
    "未覆盖的组照默认态",
  );
});

/* ---------------- 看板（列内投影：默认态按本列实际承载算） ---------------- */

/** 列切片（到下一列为止）；列表头按渲染序给出。 */
function columnSlice(markup: string, stage: string, nextStage: string | null): string {
  const start = markup.indexOf(`data-board-column="${stage}"`);
  assert.ok(start >= 0, `列应存在：${stage}`);
  if (nextStage === null) return markup.slice(start);
  const end = markup.indexOf(`data-board-column="${nextStage}"`, start);
  assert.ok(end > start, `下一列应在 ${stage} 之后：${nextStage}`);
  return markup.slice(start, end);
}

test("看板默认态：列内容器按本列承载成员算默认态（全终态列内折叠、缺口成员列内展开）", () => {
  const markup = render("kanban");
  // 执行中列：KANB1 只承载活跃稿 A → 期次与 epic 都展开。
  const running = columnSlice(markup, "执行中", "审核中");
  assert.equal(isOpen(running, 'data-board-epic-block="KANB"'), true, "执行中列：epic 展开");
  assert.equal(isOpen(running, 'data-board-phase-block="KANB1"'), true, "执行中列：KANB1 展开");
  // 已完成列：KANB 承载 B/C（全终态）→ 折叠；DONE 承载 DONE1（全终态）+ DONE2（缺口成员）→ 展开。
  const done = columnSlice(markup, "已完成", "已取消");
  assert.equal(
    isOpen(done, 'data-board-epic-block="KANB"'),
    false,
    "已完成列：KANB 承载成员全终态 → 折叠（列内投影口径）",
  );
  assert.equal(isOpen(done, 'data-board-phase-block="KANB1"'), false, "已完成列：KANB1 折叠");
  assert.equal(isOpen(done, 'data-board-phase-block="KANB2"'), false, "已完成列：KANB2 折叠");
  assert.equal(
    isOpen(done, 'data-board-epic-block="DONE"'),
    true,
    "已完成列：DONE 含缺口成员 G → 展开（缺口组折叠必咬）",
  );
  assert.equal(
    isOpen(done, 'data-board-phase-block="DONE1"'),
    false,
    "已完成列：DONE1 全终态 → 折叠",
  );
  assert.equal(
    isOpen(done, 'data-board-phase-block="DONE2"'),
    true,
    "已完成列：DONE2 成员 G 带缺口 → 展开",
  );
  // 已取消列：KANB2/DONE1 承载的成员全终态 → 两级都折叠。
  const cancelled = columnSlice(markup, "已取消", null);
  assert.equal(isOpen(cancelled, 'data-board-epic-block="KANB"'), false, "已取消列：KANB 折叠");
  assert.equal(
    isOpen(cancelled, 'data-board-epic-block="DONE"'),
    false,
    "已取消列：DONE 只承载 DONE1（全终态）→ 折叠",
  );
});

/* ---------------- 表格（两级 colSpan 组行：容器层真折叠，不造假 affordance） ---------------- */

/** 表格层/组折叠按钮开标签（锚点不同名：层 `data-board-layer-toggle` / 稿组 `data-board-group-toggle`）。 */
function toggleTag(markup: string, attribute: string, foldId: string): string {
  const match = new RegExp(`<button[^>]*${attribute}="${foldId}"[^>]*>`).exec(markup);
  assert.ok(match, `表格里应有 ${foldId} 的折叠按钮（${attribute}）`);
  return match[0];
}

test("表格默认态：epic/期次两级组行真折叠（全终态层收起子行、缺口层展开；全终态组展开必咬）", () => {
  const markup = render("table");
  // KANB：epic 展开（含活跃期次）；KANB1 展开；KANB2 全终态 → 收起（其成员行不渲染）。
  assert.match(
    toggleTag(markup, "data-board-layer-toggle", "epic:KANB"),
    /aria-expanded="true"/,
    "KANB epic 组行展开（含活跃期次）",
  );
  assert.match(
    toggleTag(markup, "data-board-layer-toggle", "phase:KANB#1"),
    /aria-expanded="true"/,
    "KANB1 期次组行展开（含活跃成员）",
  );
  assert.match(
    toggleTag(markup, "data-board-layer-toggle", "phase:KANB#2"),
    /aria-expanded="false"/,
    "KANB2 期次组行折叠（全终态组展开必咬）",
  );
  assert.ok(
    !markup.includes('data-board-table-group="plan:fold-done-b"'),
    "KANB2 折叠 → 其成员行不渲染（真折叠不是 CSS 藏）",
  );
  // DONE：epic 展开（DONE2 带缺口）；DONE1 折叠（其成员行不渲染）；DONE2 展开。
  assert.match(
    toggleTag(markup, "data-board-layer-toggle", "epic:DONE"),
    /aria-expanded="true"/,
    "DONE epic 组行展开（缺口跨层传播）",
  );
  assert.match(
    toggleTag(markup, "data-board-layer-toggle", "phase:DONE#1"),
    /aria-expanded="false"/,
    "DONE1 全终态 → 折叠",
  );
  assert.ok(
    !markup.includes('data-board-table-group="plan:fold-done-c"'),
    "DONE1 折叠 → 其成员行不渲染",
  );
  assert.match(
    toggleTag(markup, "data-board-layer-toggle", "phase:DONE#2"),
    /aria-expanded="true"/,
    "DONE2 终态成员带缺口 → 展开（缺口组折叠必咬）",
  );
  assert.ok(
    markup.includes('data-board-table-group="plan:fold-gap-terminal"'),
    "DONE2 展开 → 缺口成员行在渲染面可见",
  );
  // 折叠的层行仍显示层计数（次要一扫知大概：收起不等于信息消失）。
  const kanb2Row = sliceBetween(
    markup,
    'data-board-phase-summary="KANB2"',
    'data-board-epic-block="DONE"',
  );
  assert.match(kanb2Row, /data-board-layer-plan-count="2"/, "折叠态层行照显稿数");
  // 稿层分组行（既有机制）：默认态同判据——H（已完成）收起、I（待办）展开。
  assert.match(
    toggleTag(markup, "data-board-group-toggle", "spec:fold-done-ungrouped"),
    /aria-expanded="false"/,
    "无归属已完成稿的分组行折叠（B2 判据的表格面落地）",
  );
  assert.ok(!markup.includes('data-board-card="task:308"'), "折叠组行名下子行不渲染");
  assert.match(
    toggleTag(markup, "data-board-group-toggle", "spec:fold-todo-ungrouped"),
    /aria-expanded="true"/,
    "无归属待办稿的分组行展开",
  );
  assert.ok(markup.includes('data-board-card="task:309"'), "展开组行子行照渲染");
});

test("表格记忆：覆盖把折叠层展开后子行回到渲染面（刷新后保持的表格面）", () => {
  const fold: BoardFoldControls = {
    state: { "phase:KANB#2": true, "epic:DONE": false, "plan:fold-done-a": true },
    onToggle: () => {},
  };
  const markup = render("table", fold);
  assert.match(
    toggleTag(markup, "data-board-layer-toggle", "phase:KANB#2"),
    /aria-expanded="true"/,
    "用户展开过 KANB2 → 渲染面照记忆展开",
  );
  assert.ok(
    markup.includes('data-board-table-group="plan:fold-done-b"'),
    "展开后的成员行回到渲染面（条件渲染随覆盖态）",
  );
  assert.match(
    toggleTag(markup, "data-board-layer-toggle", "epic:DONE"),
    /aria-expanded="false"/,
    "用户折叠过 DONE → 覆盖优先于默认态",
  );
  assert.ok(
    !markup.includes('data-board-table-group="plan:fold-gap-terminal"'),
    "用户折叠的 epic 下成员行整体不渲染",
  );
  assert.match(
    toggleTag(markup, "data-board-group-toggle", "plan:fold-done-a"),
    /aria-expanded="true"/,
    "已完成稿被用户展开过 → 稿层分组行照记忆展开",
  );
});

/** 渲染序区间 [起点锚点, 终点锚点)；终点为 null 时到文末。 */
function sliceBetween(markup: string, fromAnchor: string, toAnchor: string | null): string {
  const start = markup.indexOf(fromAnchor);
  assert.ok(start >= 0, `起点锚点应存在：${fromAnchor}`);
  if (toAnchor === null) return markup.slice(start);
  const end = markup.indexOf(toAnchor, start);
  assert.ok(end > start, `终点锚点应在起点之后：${toAnchor}`);
  return markup.slice(start, end);
}
