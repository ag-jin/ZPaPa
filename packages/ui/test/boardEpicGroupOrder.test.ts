import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { BoardPaneView } from "../src/board/BoardPaneView.js";
import {
  assembleBoardEpicContainers,
  compareBoardPhaseOrder,
  groupBoardFeaturesByEpic,
  phaseDisplayName,
} from "../src/board/boardEpicContainers.js";
import { parseBoardJson, type BoardViewModel } from "../src/board/boardViewModel.js";
import type { BoardViewMode } from "../src/board/boardViewsViewModel.js";
import { ZCodeIntlProvider } from "../src/i18n/IntlProvider.js";
import { EPIC_BOARD_PHASE_ORDER } from "./boardEpicGroupOrderFixture.js";

/**
 * 组序统一比较器（卡 #88 / A4-2；AD-4 改判 = **纯期次序**）：四视图共用一个比较器单点，禁二份。
 *
 * 期望值的独立真源：拍板原句「AD-4 改判：纯期次序（不按推荐的缺口优先+期次序混合）」
 * （itw-20261010-5372）+ markers.md §10.1/§10.3（`phase` = 单值正整数期次序 1,2,3…；显示层
 * 双字段合成 `KANB1`）+ §10 冻结段的「epic 间登记序」。**被拒绝的排序依据**（缺口优先、文档序/
 * 首成员序、显示名字典序、完成度/段位）由 `EPIC_BOARD_PHASE_ORDER` 夹具逐条嵌成反例：任一条被
 * 误用，断言必红（判据手推自夹具，不用实现回算）。
 *
 * 四视图接入面：tree = `groupBoardFeaturesByEpic`（结构视图归组单点）；list/kanban/table =
 * `assembleBoardEpicContainers`（视图侧容器装配单点，序与名复用同一 grouping 段，禁各自重排）。
 */

const testDir = dirname(fileURLToPath(import.meta.url));
const uiSrcDir = join(testDir, "..", "src");

function readyBoard(raw: unknown): BoardViewModel {
  const outcome = parseBoardJson(JSON.stringify(raw));
  assert.equal(outcome.kind, "ready", "夹具必须是 ready");
  if (outcome.kind !== "ready") throw new Error("夹具必须是 ready");
  return outcome.board;
}

function renderView(viewMode: BoardViewMode): string {
  const board = readyBoard(EPIC_BOARD_PHASE_ORDER);
  return renderToStaticMarkup(
    createElement(ZCodeIntlProvider, {
      initialLocale: "zh-CN",
      children: createElement(BoardPaneView, {
        state: { kind: "ready" as const, board },
        viewMode,
      }),
    }),
  );
}

/** 文档序抽期次组头（`data-board-phase-block` 每期次容器恰一处）。 */
function phaseOrderOf(markup: string): string[] {
  return [...markup.matchAll(/data-board-phase-block="([^"]+)"/g)].map((match) => match[1] ?? "");
}

test("组序比较器单点：纯期次序 = 期次序数字升序（不按显示名字典序）", () => {
  assert.ok(compareBoardPhaseOrder(1, 2) < 0, "1 期在 2 期之前");
  assert.ok(compareBoardPhaseOrder(2, 3) < 0, "2 期在 3 期之前");
  assert.ok(
    compareBoardPhaseOrder(3, 10) < 0,
    "两位数期次按数字排（3 < 10）；按显示名 `KANB10` 字典序会反",
  );
  assert.ok(compareBoardPhaseOrder(10, 2) > 0, "反向同判据");
  assert.equal(compareBoardPhaseOrder(2, 2), 0, "同期次相等（确定性）");
  assert.deepEqual(
    [10, 2, 3, 1].sort(compareBoardPhaseOrder),
    [1, 2, 3, 10],
    "比较器可直接排序（严格升降序，数字序非字典序）",
  );
  assert.equal(phaseDisplayName("KANB", 1), "KANB1", "AD-3 双字段合成单点");
  assert.equal(phaseDisplayName("KANB", 10), "KANB10", "两位数期次照拼（显示名不进码位）");
});

test("组序反例：缺口卡/文档序/显示名字典序都不改变期次组序（纯期次序必咬）", () => {
  const board = readyBoard(EPIC_BOARD_PHASE_ORDER);
  const grouping = groupBoardFeaturesByEpic(board);
  assert.deepEqual(
    grouping.epics.map((group) => group.epic.code),
    ["KANB"],
    "epic 章按登记序（单 epic 夹具）",
  );
  const kanb = grouping.epics[0];
  assert.ok(kanb, "KANB 章应存在");
  assert.deepEqual(
    kanb.phases.map((phase) => [phase.name, phase.phase, phase.features.map((f) => f.no)]),
    [
      ["KANB1", 1, [90, 91]],
      ["KANB2", 2, [92]],
      ["KANB3", 3, [93]],
      ["KANB10", 10, [95]],
    ],
    "缺口在 phase 2、文档序乱序（2→3→1→10→1）、含 phase 10——组序仍是纯期次序；" +
      "「缺口优先」会把 KANB2 提到最前，「字典序」会把 KANB10 提到第二",
  );
  assert.deepEqual(grouping.ungrouped, [], "夹具成员全部归属 KANB（无平铺稿）");

  // 视图侧装配（list/kanban/table 共用）：同输入同序——序来自同一 grouping 单点，不各自重排。
  const assembled = assembleBoardEpicContainers(
    board,
    board.features.map((feature) => ({ id: feature.id })),
    (item) => item.id,
  );
  assert.deepEqual(
    assembled.epics[0]?.phases.map((phase) => [
      phase.name,
      phase.phase,
      phase.items.map((item) => item.id),
    ]),
    [
      ["KANB1", 1, ["plan:plan-phase-one-a", "plan:plan-phase-one-b"]],
      ["KANB2", 2, ["plan:plan-phase-two-gap"]],
      ["KANB3", 3, ["plan:plan-phase-three"]],
      ["KANB10", 10, ["plan:plan-phase-ten"]],
    ],
    "视图侧容器 = 同一比较器单点（组内保持视图输入序：一期两稿）",
  );
});

test("四视图同序（SSR 文档序）：tree/list/kanban/table 期次组头序一致 = KANB1→KANB2→KANB3→KANB10", () => {
  const expected = ["KANB1", "KANB2", "KANB3", "KANB10"];
  const orders = new Map<BoardViewMode, string[]>();
  for (const viewMode of ["tree", "list", "kanban", "table"] as const) {
    const order = phaseOrderOf(renderView(viewMode));
    orders.set(viewMode, order);
    assert.deepEqual(order, expected, `${viewMode} 视图：期次组按期次序排列（各期全部落地可对照）`);
  }
  for (const viewMode of ["list", "kanban", "table"] as const) {
    assert.deepEqual(
      orders.get(viewMode),
      orders.get("tree"),
      `${viewMode} 与 tree 同序（同一输入 → 同一组序）`,
    );
  }
});

test("单点收口（禁二份，源码守卫）：四视图不内联期次排序/合成名，序与名只在容器单点", () => {
  const viewSources = Object.fromEntries(
    ["BoardTreeView.tsx", "BoardListView.tsx", "BoardKanbanView.tsx", "BoardTableView.tsx"].map(
      (file) => [file, readFileSync(join(uiSrcDir, "board", file), "utf8")],
    ),
  );
  for (const [file, source] of Object.entries(viewSources)) {
    assert.ok(
      !source.includes(".sort("),
      `${file}：视图不得内联排序（组序一律走 boardEpicContainers 比较器单点）`,
    );
    assert.ok(
      !/code\}\$\{/.test(source),
      `${file}：视图不得内联合成期次显示名（AD-3 合成在容器单点）`,
    );
  }
  assert.match(
    viewSources["BoardTreeView.tsx"] ?? "",
    /groupBoardFeaturesByEpic/,
    "tree 接入结构视图归组单点",
  );
  for (const file of ["BoardListView.tsx", "BoardKanbanView.tsx", "BoardTableView.tsx"]) {
    assert.match(
      viewSources[file] ?? "",
      /assembleBoardEpicContainers/,
      `${file} 接入视图侧容器装配单点`,
    );
  }
});
