import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { BoardPaneView, type BoardPaneViewProps } from "../src/board/BoardPaneView.js";
import {
  buildBoardListRows,
  EMPTY_BOARD_LIST_CONTROLS,
  type BoardListControls,
  type BoardViewNode,
} from "../src/board/boardViewsViewModel.js";
import {
  BOARD_VIEW_SORTS,
  BOARD_VIEW_SORT_MESSAGE_IDS,
  boardSortFilterValue,
  sinkCompletedTreeSiblings,
} from "../src/board/boardViewSorting.js";
import { BOARD_STAGES } from "../src/board/boardViewModel.js";
import { ZCodeIntlProvider } from "../src/i18n/IntlProvider.js";
import enUS from "../src/i18n/locales/en-US.js";
import zhCN from "../src/i18n/locales/zh-CN.js";
import { readySortingBoard, sortingBoard } from "./boardSortingFixture.js";

/**
 * 看板排序与完成沉底的真渲染/纯函数守卫（卡 #65：「看板里面已完成的任务放在最后面。需要排序功能」
 * ——正式版实测反馈②，来源访谈 itw-20261010-0d3e）。
 *
 * 期望值的独立真源：消费契约 §3.5（attention 项置顶，其余按 `updatedAt` 倒序；「最老未动」是
 * 用户主动切换的第二视角）+ 卡 #65 的三视角定义（最近更新 / 最老未动 / 段位序）。
 * 行序期望**逐条写死**在本文件（不由实现回算）；夹具见 `boardSortingFixture`（混合板：
 * 完成/未完成/带缺口/嵌套/不同 updatedAt/整体已完成的特性块）。
 */

function nodeIds(nodes: BoardViewNode[]): string[] {
  return nodes.map((node) => node.id);
}

/** 混合板的三种排序视角（每条 id 顺序按契约语义手推，见夹具头注释的时间与段位）。 */
const RECENT_ORDER = [
  "task:75", // 缺口置顶（07:00 最老也置顶）
  "task:72", // 待办 12:00
  "task:77", // 待办（嵌套）10:00
  "plan:plan-sort", // 执行中（特性）09:50
  "task:82", // 执行中 08:30
  "task:78", // 待办（阶段二）07:30
  "task:73", // 已完成 13:00（比 #72 新，仍沉底）
  "task:76", // 已完成（嵌套）11:00
  "task:79", // 已完成（阶段二）09:30
  "task:74", // 已完成 08:00
  "task:71", // 已完成（阶段零）06:45
  "spec:spec-done", // 已完成特性 06:00
  "task:81", // 已完成（规格）05:30
];

const OLDEST_ORDER = [
  "task:75", // 缺口仍置顶（第二视角不改变置顶语义）
  "task:81", // 05:30（最老未动）
  "spec:spec-done", // 06:00
  "task:71", // 06:45
  "task:78", // 07:30
  "task:74", // 08:00
  "task:82", // 08:30
  "task:79", // 09:30
  "plan:plan-sort", // 09:50
  "task:77", // 10:00
  "task:76", // 11:00
  "task:72", // 12:00
  "task:73", // 13:00
];

const STAGE_ORDER = [
  "task:75", // 缺口仍置顶
  "task:72", // 待办（流水序第 2 段）12:00
  "task:77", // 待办 10:00
  "task:78", // 待办 07:30（比 #82 老，但待办段位在前）
  "plan:plan-sort", // 执行中（第 3 段）09:50
  "task:82", // 执行中 08:30
  "task:73", // 已完成（第 6 段）13:00
  "task:76", // 已完成 11:00
  "task:79", // 已完成 09:30
  "task:74", // 已完成 08:00
  "task:71", // 已完成 06:45
  "spec:spec-done", // 已完成 06:00
  "task:81", // 已完成 05:30
];

test("列表排序 · 段位序（#65 新视角）：attention 置顶 → 段位流水序 → updatedAt 倒序", () => {
  assert.deepEqual(nodeIds(buildBoardListRows(sortingBoard(), { sort: "stage" })), STAGE_ORDER);
  // 段位序用的是契约的七段位流水序（不是别的字典序/笔画序）。
  assert.deepEqual(
    [...BOARD_STAGES],
    ["待设计", "待办", "执行中", "审核中", "阻塞", "已完成", "已取消"],
  );
});

test("列表排序 · 最近更新（契约序）：已完成沉底，attention 仍置顶（#65 全视图口径）", () => {
  assert.deepEqual(nodeIds(buildBoardListRows(sortingBoard(), { sort: "recent" })), RECENT_ORDER);
});

test("列表排序 · 最老未动第二视角：按卡龄升序，不做沉底（§3.5）", () => {
  assert.deepEqual(nodeIds(buildBoardListRows(sortingBoard(), { sort: "oldest" })), OLDEST_ORDER);
});

/* ---------------- 排序控件（闭集 + 词条 + 归一） ---------------- */

function renderPane(props: Partial<BoardPaneViewProps> = {}): string {
  return renderToStaticMarkup(
    createElement(ZCodeIntlProvider, {
      initialLocale: "zh-CN" as const,
      children: createElement(BoardPaneView, {
        state: readySortingBoard(),
        viewMode: "list",
        ...props,
      }),
    }),
  );
}

function renderPaneEn(props: Partial<BoardPaneViewProps> = {}): string {
  return renderToStaticMarkup(
    createElement(ZCodeIntlProvider, {
      initialLocale: "en-US" as const,
      children: createElement(BoardPaneView, {
        state: readySortingBoard(),
        viewMode: "list",
        ...props,
      }),
    }),
  );
}

/** 排序控件的选项（闭集取值 + 显示文案）。 */
function sortOptions(markup: string): Array<{ value: string; label: string }> {
  const match = /data-board-filter="sort"[\s\S]*?<\/select>/.exec(markup);
  assert.ok(match, '找不到排序控件（data-board-filter="sort"）');
  return [...match[0].matchAll(/<option value="([^"]*)"[^>]*>([^<]*)<\/option>/g)].map((entry) => ({
    value: entry[1] ?? "",
    label: entry[2] ?? "",
  }));
}

/** 列表行序（行锚点 = 同时带 data-board-card 与 data-board-indent 的元素；分组头不在此列）。 */
function listRowIds(markup: string): string[] {
  return markup
    .split("<div")
    .filter((tag) => tag.includes("data-board-indent=") && tag.includes("data-board-card="))
    .map((tag) => /data-board-card="([^"]*)"/.exec(tag)?.[1] ?? "");
}

/** 表格行序（同为带缩进的行；分组行是整行占位，不带行锚点）。 */
function tableRowIds(markup: string): string[] {
  return markup
    .split("<tr")
    .filter((tag) => tag.includes("data-board-indent=") && tag.includes("data-board-card="))
    .map((tag) => /data-board-card="([^"]*)"/.exec(tag)?.[1] ?? "");
}

test("排序控件（#65）：列表/表格头部三视角闭集（最近更新 / 最老未动 / 段位序），词条两语齐全", () => {
  assert.deepEqual(
    sortOptions(renderPane()),
    [
      { value: "recent", label: "最近更新" },
      { value: "oldest", label: "最老未动" },
      { value: "stage", label: "段位序" },
    ],
    "三视角选项与逐字文案（默认视角 = 契约序 = 最近更新）",
  );
  assert.deepEqual(
    sortOptions(renderPaneEn()).map((option) => option.label),
    ["Recently updated", "Oldest untouched", "Stage order"],
    "英文界面走英文词条（不漏中文）",
  );
  assert.deepEqual([...BOARD_VIEW_SORTS], ["recent", "oldest", "stage"], "闭集顺序即控件选项序");
  for (const sort of BOARD_VIEW_SORTS) {
    assert.ok(zhCN[BOARD_VIEW_SORT_MESSAGE_IDS[sort]], `${sort} 缺 zh-CN 词条`);
    assert.ok(enUS[BOARD_VIEW_SORT_MESSAGE_IDS[sort]], `${sort} 缺 en-US 词条`);
  }
});

test("排序取值归一（#65）：闭集成员原样透传，坏值回落契约序（UI 不裸 as 断言）", () => {
  assert.equal(boardSortFilterValue("stage"), "stage");
  assert.equal(boardSortFilterValue("oldest"), "oldest");
  assert.equal(boardSortFilterValue("recent"), "recent");
  assert.equal(boardSortFilterValue(""), "recent", "空串 = 默认视角");
  assert.equal(boardSortFilterValue("future-sort"), "recent", "认不出的取值不猜");
});

test("列表排序端到端（#65）：控件状态 → 行序（完成沉底 / 段位序各按契约语义）", () => {
  const list = (controls: Partial<BoardListControls>) =>
    renderPane({ listControls: { ...EMPTY_BOARD_LIST_CONTROLS, ...controls } });
  // 列表行按特性分组渲染：行序 = 组内平铺序（分组头不是行），组序 = 成员首次出现序。
  assert.deepEqual(
    listRowIds(list({ sort: "recent" })),
    [
      "task:75",
      "task:72",
      "task:77",
      "task:82",
      "task:78",
      "task:73",
      "task:76",
      "task:79",
      "task:74",
      "task:71",
      "task:81",
    ],
    "默认序：全部未完成行在前、已完成行沉底（#73 比 #72 新也不许抢位）",
  );
  assert.deepEqual(
    listRowIds(list({ sort: "stage" })),
    [
      "task:75",
      "task:72",
      "task:77",
      "task:78",
      "task:82",
      "task:73",
      "task:76",
      "task:79",
      "task:74",
      "task:71",
      "task:81",
    ],
    "段位序：待办行整体早于执行中行（#78 老于 #82 仍在前）",
  );
  assert.deepEqual(
    listRowIds(list({ sort: "oldest" })),
    [
      "task:75",
      "task:71",
      "task:78",
      "task:74",
      "task:82",
      "task:79",
      "task:77",
      "task:76",
      "task:72",
      "task:73",
      "task:81",
    ],
    "最老未动：置顶后按卡龄升序（不沉底）；行仍按所属特性分组（组序 = 成员首次出现序）",
  );
});

test("表格排序端到端（#65）：分组内行序 = 同一平铺管线（与列表同语义）", () => {
  const table = (controls: Partial<BoardListControls>) =>
    renderPane({ viewMode: "table", listControls: { ...EMPTY_BOARD_LIST_CONTROLS, ...controls } });
  assert.deepEqual(
    tableRowIds(table({ sort: "recent" })),
    [
      "task:75",
      "task:72",
      "task:77",
      "task:82",
      "task:78",
      "task:73",
      "task:76",
      "task:79",
      "task:74",
      "task:71",
      "task:81",
    ],
    "表格分组内沉底（同一管线，不与列表漂移）",
  );
  assert.deepEqual(
    tableRowIds(table({ sort: "stage" })),
    [
      "task:75",
      "task:72",
      "task:77",
      "task:78",
      "task:82",
      "task:73",
      "task:76",
      "task:79",
      "task:74",
      "task:71",
      "task:81",
    ],
    "段位序在表格里同语义",
  );
});

/* ---------------- 树形视图：结构序内的完成沉底（#65） ---------------- */

/** 树形卡片渲染序（任务卡锚点 `data-board-task`，不含特性头）。 */
function treeCardIds(markup: string): string[] {
  return [...markup.matchAll(/data-board-task="([^"]*)"/g)].map((entry) => entry[1] ?? "");
}

test("树形沉底（#65）：同级已完成卡沉底（嵌套层级也生效），章节与特性块位置不动", () => {
  // 真源（卡 #65 口径）：树形保持结构序（文档序）——章节子分组与特性折叠大块**不重排**；
  // 「已完成沉底」只作用于每个同级组（含嵌套子卡列表）。
  const markup = renderPane({ viewMode: "tree" });
  const anchor = markup.indexOf('data-board-feature-block="plan:plan-sort"');
  assert.ok(anchor >= 0, "应有 plan:plan-sort 特性块");
  const next = markup.indexOf('data-board-feature-block="spec:spec-done"', anchor);
  const planBlock = markup.slice(markup.lastIndexOf("<details", anchor), next);
  assert.deepEqual(
    treeCardIds(planBlock),
    [
      "task:71", // 阶段零（唯一成员：已完成；章节位置不动）
      "task:72", // 阶段一：待办（12:00）
      "task:75", // 阶段一：执行中 + 缺口（07:00，结构序不置顶）
      "task:77", //   └ #75 的嵌套子卡：待办在前（文档序里 #76 在前，沉底后交换）
      "task:76", //     嵌套已完成卡沉到其后
      "task:73", // 阶段一：已完成（13:00 最新，仍沉底）
      "task:74", // 阶段一：已完成（08:00）
      "task:78", // 阶段二：待办（07:30）
      "task:82", // 阶段二：执行中（08:30，按文档序在前、无沉底规则时不交换）
      "task:79", // 阶段二：已完成
    ],
    "同级沉底逐层生效：#73（13:00）不得抢在 #72/#75 之前；嵌套层 #77 在 #76 之前",
  );
  assert.deepEqual(
    [...markup.matchAll(/data-board-section="([^"]+)"/g)].map((entry) => entry[1] ?? ""),
    ["阶段零", "阶段一", "阶段二"],
    "章节子分组按文档序渲染（沉底不重排章节块）",
  );
  assert.deepEqual(
    [...markup.matchAll(/data-board-feature-block="([^"]+)"/g)].map((entry) => entry[1] ?? ""),
    ["plan:plan-sort", "spec:spec-done"],
    "特性折叠大块按文档序渲染（整体已完成的块位置不动）",
  );
  const specBlock = markup.slice(
    markup.lastIndexOf("<details", markup.indexOf('data-board-feature-block="spec:spec-done"')),
  );
  assert.deepEqual(treeCardIds(specBlock), ["task:81"], "已完成特性块内卡片照常渲染");
});

test("树形沉底 · 纯函数（#65）：稳定分区——已完成移至同级末尾，其余相对序（文档序）不动", () => {
  const siblings = [
    { id: "b", stage: "待办" },
    { id: "a", stage: "已完成" },
    { id: "c", stage: "执行中" },
    { id: "d", stage: "已完成" },
    { id: "e", stage: null },
  ];
  assert.deepEqual(
    sinkCompletedTreeSiblings(siblings).map((node) => node.id),
    ["b", "c", "e", "a", "d"],
    "未完成组保持文档序（b, c, e），已完成组沉底且组内保持文档序（a, d）",
  );
  assert.deepEqual(
    siblings.map((node) => node.id),
    ["b", "a", "c", "d", "e"],
    "纯函数：入参顺序不得被就地改写",
  );
});
