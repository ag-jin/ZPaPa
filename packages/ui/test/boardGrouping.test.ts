import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { BoardPaneView, type BoardPaneViewProps } from "../src/board/BoardPaneView.js";
import type { BoardPaneLoadState } from "../src/board/loadBoardDocument.js";
import {
  buildBoardKanban,
  buildBoardListGroups,
} from "../src/board/boardViewsViewModel.js";
import { parseBoardJson } from "../src/board/boardViewModel.js";
import { ZCodeIntlProvider } from "../src/i18n/IntlProvider.js";
import { GROUPING_BOARD } from "./boardGroupingFixture.js";

/**
 * 分组呈现的守卫（卡 #46 / 规则书 v2：B3 看板分组头 + B4 列表/表格分组折叠 + B6 责任管线高亮）。
 *
 * 期望值的独立真源：用户 2026-10-10 实测反馈：
 *   - B3：特性名做卡片分组头（**非独立卡**，不占一列位置）；
 *   - B4：列表/表格 = 分组行（特性头 + 缩进子行），可折叠；
 *   - B6：责任管线里当前执行者加粗变色，其余灰色小字（currentAssignee 来自 A3）。
 */

function readyState(): BoardPaneLoadState {
  const outcome = parseBoardJson(JSON.stringify(GROUPING_BOARD));
  if (outcome.kind !== "ready") throw new Error("夹具必须是 ready");
  return { kind: "ready", board: outcome.board };
}

function render(props: Partial<BoardPaneViewProps> = {}): string {
  return renderToStaticMarkup(
    createElement(ZCodeIntlProvider, {
      initialLocale: "zh-CN" as const,
      children: createElement(BoardPaneView, { state: readyState(), ...props }),
    }),
  );
}

function anchors(markup: string, attribute: string): string[] {
  return [...markup.matchAll(new RegExp(`${attribute}="([^"]*)"`, "g"))].map(
    (match) => match[1] ?? "",
  );
}

/* ---------------- B3：看板分组头 ---------------- */

test("看板模型：列内按特性分组；特性节点自身段位所在列 = 分组头（featureInColumn）", () => {
  const outcome = parseBoardJson(JSON.stringify(GROUPING_BOARD));
  if (outcome.kind !== "ready") throw new Error("夹具必须是 ready");
  const { columns } = buildBoardKanban(outcome.board);
  const doing = columns.find((column) => column.stage === "执行中");
  assert.ok(doing);
  assert.deepEqual(
    doing.groups.map((group) => group.feature.id),
    ["plan:plan-zcode-ui"],
    "执行中列只有计划分组（特性自身段位 = 执行中）",
  );
  assert.equal(doing.groups[0]?.featureInColumn, true, "特性节点自身段位 = 本列");
  assert.deepEqual(
    doing.groups[0]?.nodes.map((node) => node.id),
    ["task:46"],
    "分组内是同列的任务卡",
  );

  const review = columns.find((column) => column.stage === "审核中");
  const todo = columns.find((column) => column.stage === "待办");
  assert.deepEqual(
    todo?.groups.map((group) => ({ id: group.feature.id, inColumn: group.featureInColumn })),
    [
      { id: "spec:alpha", inColumn: true },
      { id: "plan:plan-zcode-ui", inColumn: false },
    ],
    "待办列：spec 特性头在本列（inColumn），计划的待办卡以轻量分组标签随行",
  );
  assert.deepEqual(
    todo?.groups.find((group) => group.feature.id === "plan:plan-zcode-ui")?.nodes.map((n) => n.id),
    ["task:47"],
    "跨列分组只带本列的任务卡",
  );
  assert.equal(review?.groups.length, 0, "无节点列无分组");
});

test("看板渲染：特性分组头不是独立卡（卡片锚点只出现在任务卡上）", () => {
  const markup = render({ viewMode: "kanban" });
  const doing = markup.slice(
    markup.indexOf('data-board-column="执行中"'),
    markup.indexOf('data-board-column="审核中"'),
  );
  assert.match(doing, /data-board-kanban-group="plan:plan-zcode-ui"/, "执行中列带分组头锚点");
  assert.deepEqual(anchors(doing, "data-board-kanban-card"), ["task:46"], "列内卡片锚点只有任务卡（特性不再占卡位）");
  assert.match(doing, /data-board-feature-code="UI01"/, "分组头显示计划码（完整形态）");
  const todo = markup.slice(
    markup.indexOf('data-board-column="待办"'),
    markup.indexOf('data-board-column="执行中"'),
  );
  // 待办列两组均无缺口、成员同刻（09:00）：分组序按「组内最高优先成员」比较，同刻回落到成员 id
  // （task:21 < task:47）——单一比较器（compareBoardViewNodes）同时管组序与行序，不另造规则。
  assert.deepEqual(
    anchors(todo, "data-board-kanban-group"),
    ["spec:alpha", "plan:plan-zcode-ui"],
    "待办列分组序 = 组内最高优先成员（同刻按 id 稳定收敛）",
  );
});

/* ---------------- B4：列表/表格分组折叠 ---------------- */

test("列表模型：分组 = 特性头 + 过滤排序后的子行（组间 attention 置顶序保持）", () => {
  const outcome = parseBoardJson(JSON.stringify(GROUPING_BOARD));
  if (outcome.kind !== "ready") throw new Error("夹具必须是 ready");
  const groups = buildBoardListGroups(outcome.board, {});
  assert.deepEqual(
    groups.map((group) => ({
      feature: group.feature.id,
      rows: group.nodes.map((node) => node.id),
    })),
    [
      { feature: "plan:plan-zcode-ui", rows: ["task:46", "task:47"] },
      { feature: "spec:alpha", rows: ["task:21"] },
    ],
    "分组序按成员最高优先（缺口置顶）；组内行按 updatedAt 倒序",
  );
});

test("列表渲染：分组行（<details>，特性头 + 缩进子行；子行编号短形态）", () => {
  const markup = render({ viewMode: "list" });
  const group = markup.slice(
    markup.indexOf('data-board-list-group="plan:plan-zcode-ui"'),
    markup.indexOf('data-board-list-group="spec:alpha"'),
  );
  assert.match(group, /data-board-feature-card-count="2"/, "分组行显示卡片数摘要");
  assert.match(group, /data-board-node-id="5"/, "计划分组内子行编号省略计划码前缀");
  assert.match(group, /data-board-indent="1"/, "子行带结构缩进");
  assert.match(group, /data-board-list-group-summary="plan:plan-zcode-ui"/, "分组行是折叠摘要");
  const specGroup = markup.slice(markup.indexOf('data-board-list-group="spec:alpha"'));
  assert.match(specGroup, /data-board-node-id="ID-20.1"/, "spec 分组子行维持 ID- 形态");
});

test("表格渲染：分组行（列宽整行占位 + 特性头），子行在分组内", () => {
  const markup = render({ viewMode: "table" });
  const group = markup.slice(
    markup.indexOf('data-board-table-group="plan:plan-zcode-ui"'),
    markup.indexOf('data-board-table-group="spec:alpha"'),
  );
  assert.match(group, /<td[^>]*colspan="10"/i, "分组行整行占位（colSpan = 可见列数）");
  assert.match(group, /data-board-feature-code="UI01"/, "分组行显示计划码");
  assert.match(group, /data-board-node-id="5"/, "子行编号短形态");
  const rowIds = [...group.matchAll(/<tr[^>]*data-board-card="([^"]*)"/g)].map((m) => m[1]);
  assert.deepEqual(rowIds, ["task:46", "task:47"], "分组内行序 = 组内排序");
});

/* ---------------- B6：责任管线高亮 ---------------- */

test("责任管线：当前执行者加粗变色，其余灰色小字（表格 assignees 列）", () => {
  const markup = render({ viewMode: "table" });
  const pipeline = markup.slice(markup.indexOf("data-board-pipeline="));
  assert.match(pipeline, /data-board-pipeline-role="implementer"[^>]*data-board-pipeline-current="true"/, "当前执行者标记");
  assert.ok(
    /data-board-pipeline-current="true"[^>]*class="[^"]*font-medium[^"]*"/.test(pipeline) ||
      /class="[^"]*font-medium[^"]*"[^>]*data-board-pipeline-current="true"/.test(pipeline),
    "当前执行者加粗（font-medium）",
  );
  assert.ok(
    /data-board-pipeline-current="true"[^>]*class="[^"]*text-primary/.test(pipeline) ||
      /class="[^"]*text-primary[^"]*"[^>]*data-board-pipeline-current="true"/.test(pipeline),
    "当前执行者变色（text-primary）",
  );
  assert.ok(
    /data-board-pipeline-role="test-verifier"[^>]*class="[^"]*text-foreground-subtle/.test(pipeline) ||
      /class="[^"]*text-foreground-subtle[^"]*"[^>]*data-board-pipeline-role="test-verifier"/.test(pipeline),
    "其余角色灰色小字（text-foreground-subtle）",
  );
  assert.ok(
    !/data-board-pipeline-role="test-verifier"[^>]*data-board-pipeline-current/.test(pipeline),
    "非当前执行者不得误标",
  );
});
