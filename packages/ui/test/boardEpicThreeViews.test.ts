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
  groupBoardFeaturesByEpic,
} from "../src/board/boardEpicContainers.js";
import { parseBoardJson, type BoardViewModel } from "../src/board/boardViewModel.js";
import type { BoardViewMode } from "../src/board/boardViewsViewModel.js";
import { ZCodeIntlProvider } from "../src/i18n/IntlProvider.js";
import { EPIC_BOARD, EPIC_BOARD_EDGE, EPIC_BOARD_FLAT } from "./boardEpicFixture.js";

/**
 * 看板/列表/表格三视图的三层容器接线（卡 #168 / A4-1b）。
 *
 * 期望值的独立真源：A4-1 接口面（`evidence/T87/interface-face.txt`：`groupBoardFeaturesByEpic`
 * 归组口径 / `BoardFeatureGroupHeaderContent` 的 layer 判别联合 / data-board-* 锚点族）+ 裁决包
 * AD-1「四视图渲染为显式 KANB ⊃ KANB1 ⊃ 稿 三层容器」+ markers.md §10（正常板同口径、违规板显式
 * 回退）+ §10.5（终态由登记行唯一承载）。断言手推自夹具（登记序/期次序/文档序），不用实现回算。
 *
 * 覆盖（CR-S1 三条回退分支在本文件钉住，见 EPIC_BOARD_EDGE 注释）：
 *   - 三视图各自的三层容器装配（复用同一零件与同一归组单点）；
 *   - 零 epic 板三视图零变化（AD-8）；
 *   - 半对稿顶层平铺 / 登记 epic 零成员空 phases / active 不落终态标注。
 */

function readyBoard(raw: unknown): BoardViewModel {
  const outcome = parseBoardJson(JSON.stringify(raw));
  assert.equal(outcome.kind, "ready", "夹具必须是 ready");
  if (outcome.kind !== "ready") throw new Error("夹具必须是 ready");
  return outcome.board;
}

test("视图侧容器装配（单点）：按同一 epic/phase 归属切分视图分组；无归属组保持管线序平铺", () => {
  const board = readyBoard(EPIC_BOARD);
  // 视图侧「分组」只需一个成员稿 id（列表/表格 = 组头特性 id；看板 = 组头特性 id）。
  const items = [
    { id: "plan:plan-boardv2-a" },
    { id: "plan:plan-zcode-ui" },
    { id: "plan:plan-by-number" },
    { id: "plan:plan-boardv2-b1" },
  ];
  const { epics, ungrouped } = assembleBoardEpicContainers(board, items, (item) => item.id);
  assert.deepEqual(
    ungrouped.map((item) => item.id),
    ["plan:plan-by-number"],
    "稳定号引用稿的视图分组不归组（与 groupBoardFeaturesByEpic 同判据）",
  );
  assert.deepEqual(
    epics.map((container) => [
      container.epic.code,
      container.phases.map((phase) => [
        phase.name,
        phase.items.map((item) => item.id),
        phase.items.length,
      ]),
      container.items.length,
    ]),
    [
      [
        "KANB",
        [
          ["KANB1", ["plan:plan-boardv2-a", "plan:plan-zcode-ui"], 2],
          ["KANB2", ["plan:plan-boardv2-b1"], 1],
        ],
        3,
      ],
    ],
    "容器 = 期次升序、组内保持输入序（视图管线序）；层计数 = 实际承载成员",
  );
});

test("回退分支（CR-S1）：半对稿顶层平铺、登记 epic 零成员空 phases、active 登记行原值透出", () => {
  const board = readyBoard(EPIC_BOARD_EDGE);
  const grouping = groupBoardFeaturesByEpic(board);
  assert.deepEqual(
    grouping.ungrouped.map((feature) => feature.no),
    [1, 33, 35, 36, 37],
    "半对稿（只有 epic / 只有 phase）与既有三类无归属稿一律顶层平铺（不吞稿、不造半截容器）",
  );
  const empt = grouping.epics.find((group) => group.epic.code === "EMPT");
  assert.ok(empt, "零成员登记行照常成章（登记序）");
  assert.deepEqual(
    [empt.epic.status, empt.phases, empt.members],
    ["active", [], []],
    "零成员 epic = 空 phases/空 members（不造假成员）",
  );
  assert.deepEqual(
    grouping.epics.map((group) => group.epic.code),
    ["KANB", "CNCL", "EMPT"],
    "登记序成章（EMPT 在登记序末位）",
  );
  const kanb = grouping.epics.find((group) => group.epic.code === "KANB");
  assert.equal(kanb?.epic.status, "active", "active 登记行原值透出（不落终态标注的判别在零件层）");
});

test("视图侧容器装配：零承载成员（含零成员 epic）不造空容器——空壳承诺只在结构视图（tree）", () => {
  const board = readyBoard(EPIC_BOARD_EDGE);
  const { epics, ungrouped } = assembleBoardEpicContainers(
    board,
    [{ id: "plan:plan-boardv2-a" }],
    (item) => item.id,
  );
  assert.deepEqual(
    epics.map((container) => container.epic.code),
    ["KANB"],
    "EMPT（零成员）与 CNCL（本视图无分组）都不造空壳（过滤/列视图不铺空容器）",
  );
  assert.deepEqual(ungrouped, [], "唯一分组归属 KANB");
});

/* ---------------- 三视图渲染公共装置 ---------------- */

function renderView(
  raw: unknown,
  viewMode: BoardViewMode,
  locale: "zh-CN" | "en-US" = "zh-CN",
): string {
  const outcome = parseBoardJson(JSON.stringify(raw));
  assert.equal(outcome.kind, "ready", "夹具必须是 ready");
  if (outcome.kind !== "ready") throw new Error("夹具必须是 ready");
  return renderToStaticMarkup(
    createElement(ZCodeIntlProvider, {
      initialLocale: locale,
      children: createElement(BoardPaneView, {
        state: { kind: "ready" as const, board: outcome.board },
        viewMode,
      }),
    }),
  );
}

/** 渲染序区间 [起点锚点, 终点锚点)；终点为 null 时到文末（判定「块在谁的里面」）。 */
function sliceBetween(markup: string, fromAnchor: string, toAnchor: string | null): string {
  const start = markup.indexOf(fromAnchor);
  assert.ok(start >= 0, `起点锚点应存在：${fromAnchor}`);
  if (toAnchor === null) return markup.slice(start);
  const end = markup.indexOf(toAnchor, start);
  assert.ok(end > start, `终点锚点应在起点之后：${toAnchor}`);
  return markup.slice(start, end);
}

/* ---------------- 列表视图（三层容器接线） ---------------- */

test("列表：三层容器接线——无归属组平铺在前，epic 章 ⊃ 期次组 ⊃ 特性分组（层头走单点零件）", () => {
  const markup = renderView(EPIC_BOARD, "list");
  // 无归属组在前（与 tree 同序：AD-8 顶层平铺，不为孤儿/稳定号引用造容器）。
  const firstEpic = markup.indexOf("data-board-epic-block=");
  assert.ok(firstEpic > 0, "列表应渲染 epic 章");
  for (const id of ["spec:preview-channel", "plan:plan-by-number", "plan:plan-orphan"]) {
    const index = markup.indexOf(`data-board-list-group="${id}"`);
    assert.ok(index >= 0 && index < firstEpic, `无归属组顶层平铺在容器之前：${id}`);
  }
  // 第一层：KANB 章头 = 单点零件的层头（层名 + 登记行标题 + 稿数/期数）。
  const epicDetails = /<details[^>]*data-board-epic-block="KANB"[^>]*>/.exec(markup);
  assert.ok(epicDetails, "epic 章应是可折叠容器");
  assert.ok(epicDetails[0].includes(" open"), "容器默认展开（缺口不许被埋）");
  const kanbHeader = sliceBetween(
    markup,
    'data-board-epic-summary="KANB"',
    'data-board-phase-block="KANB1"',
  );
  assert.match(kanbHeader, /data-board-layer-kind="epic"/, "层头走单点零件的层锚点");
  assert.match(kanbHeader, /data-board-layer-name="KANB"/);
  assert.match(kanbHeader, /data-board-layer-plan-count="3"/, "层稿数 = 实际承载成员");
  assert.match(kanbHeader, /data-board-layer-phase-count="2"/);
  assert.ok(kanbHeader.includes("看板系统"), "登记行标题照常渲染");
  assert.ok(!kanbHeader.includes("data-board-card"), "层不是卡：章头无卡片锚点");
  assert.match(kanbHeader, /data-board-fold-indicator/, "折叠指示符走共享零件（CR-S3 收口）");
  // 第二层：KANB1 期次组头（AD-3 合成名 + 该期稿数）。
  const k1Header = sliceBetween(
    markup,
    'data-board-phase-summary="KANB1"',
    'data-board-list-group="',
  );
  assert.match(k1Header, /data-board-layer-kind="phase"/);
  assert.match(k1Header, /data-board-layer-name="KANB1"/);
  assert.match(k1Header, /data-board-layer-plan-count="2"/);
  assert.ok(k1Header.includes("2 稿"), `期次层稿数片文案：${k1Header}`);
  assert.ok(!k1Header.includes("data-board-layer-phase-count"), "期次层不渲染期数片");
  // 第三层：一期两稿在 KANB1 组内；二期稿与终态 epic 成员不在其中。
  const k1 = sliceBetween(
    markup,
    'data-board-phase-block="KANB1"',
    'data-board-phase-block="KANB2"',
  );
  assert.ok(k1.includes('data-board-list-group="plan:plan-boardv2-a"'), "PLW0 在 KANB1 组内");
  assert.ok(k1.includes('data-board-list-group="plan:plan-zcode-ui"'), "UI01 同属 KANB1");
  assert.ok(!k1.includes('data-board-list-group="plan:plan-boardv2-b1"'), "二期稿不落一期组");
  const k2 = sliceBetween(markup, 'data-board-phase-block="KANB2"', 'data-board-epic-block="CNCL"');
  assert.ok(k2.includes('data-board-list-group="plan:plan-boardv2-b1"'), "UI02 在 KANB2 组内");
  const cncl = sliceBetween(markup, 'data-board-epic-block="CNCL"', null);
  assert.ok(cncl.includes('data-board-list-group="plan:plan-cancelled-epic"'), "终态成员照常入组");
  assert.match(cncl, /data-board-layer-status="cancelled"/, "终态登记行落标注");
  assert.ok(!kanbHeader.includes("data-board-layer-status"), "active 登记行不落终态标注");
});

test("列表：零 epic 板零变化（AD-8）——不落容器锚点，既有分组结构照旧", () => {
  const markup = renderView(EPIC_BOARD_FLAT, "list");
  assert.ok(!markup.includes("data-board-epic-block"), "零 epic 项目不造容器");
  assert.ok(!markup.includes("data-board-phase-block"), "零 epic 项目不造期次组");
  assert.ok(!markup.includes("data-board-layer-name"), "零 epic 项目不落层头锚点");
  assert.match(markup, /data-board-list-group="plan:plan-boardv2-a"/, "既有分组照旧");
  assert.match(markup, /data-board-list-group-summary="plan:plan-boardv2-a"/, "分组摘要照旧");
  assert.match(markup, /data-board-feature-card-count="2"/, "稿层计数片照旧");
});

test("列表：回退分支渲染（CR-S1）——半对稿顶层平铺、零成员 epic 不造空壳", () => {
  const markup = renderView(EPIC_BOARD_EDGE, "list");
  const firstEpic = markup.indexOf("data-board-epic-block=");
  for (const id of ["plan:plan-half-pair-epic", "plan:plan-half-pair-phase"]) {
    const index = markup.indexOf(`data-board-list-group="${id}"`);
    assert.ok(index >= 0 && index < firstEpic, `半对稿顶层平铺：${id}`);
  }
  assert.ok(!markup.includes('data-board-epic-block="EMPT"'), "零成员 epic 在列表视图不造空壳");
});

test("单点收口（CR-S3）：BoardListView 不再内联折叠指示符（字形与锚点只在共享零件里）", () => {
  const source = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "../src/board/BoardListView.tsx"),
    "utf8",
  );
  assert.ok(!source.includes("data-board-fold-indicator"), "折叠锚点只在共享零件里装配");
  assert.ok(!source.includes("▸"), "指示符字形只在共享零件里");
  const rendered = renderView(EPIC_BOARD, "list");
  assert.ok(rendered.includes('data-board-fold-indicator=""'), "渲染面照旧有指示符（共享零件）");
});

/* ---------------- 看板视图（列内三层容器接线） ---------------- */

test("看板：列内三层容器——epic 章 ⊃ 期次组 ⊃ 列内分组（层头走单点零件，无归属组平铺在前）", () => {
  const markup = renderView(EPIC_BOARD, "kanban");
  const running = sliceBetween(markup, 'data-board-column="执行中"', 'data-board-column="审核中"');
  // 无归属组（PREV）平铺在前；KANB 容器在后（ADR-8 顶层平铺同序）。
  const prevGroup = running.indexOf('data-board-kanban-group="spec:preview-channel"');
  const epicIndex = running.indexOf('data-board-epic-block="KANB"');
  assert.ok(prevGroup >= 0 && epicIndex > prevGroup, "无归属组平铺在容器之前");
  const epicDetails = /<details[^>]*data-board-epic-block="KANB"[^>]*>/.exec(running);
  assert.ok(epicDetails, "列内 epic 章应是可折叠容器");
  assert.ok(epicDetails[0].includes(" open"), "容器默认展开（缺口不许被埋）");
  const epicHeader = sliceBetween(
    running,
    'data-board-epic-summary="KANB"',
    'data-board-phase-block="KANB1"',
  );
  assert.match(epicHeader, /data-board-layer-kind="epic"/, "列内 epic 层头走单点零件");
  assert.match(epicHeader, /data-board-layer-name="KANB"/);
  assert.match(epicHeader, /data-board-layer-plan-count="1"/, "层计数 = 本列实际承载成员稿数");
  assert.match(epicHeader, /data-board-layer-phase-count="1"/, "层计数 = 本列实际承载期数");
  assert.ok(epicHeader.includes("看板系统"), "登记行标题照常渲染");
  assert.ok(!epicHeader.includes("data-board-card"), "层不是卡：列内层头无卡片锚点");
  const phaseBlock = sliceBetween(running, 'data-board-phase-block="KANB1"', null);
  assert.match(phaseBlock, /data-board-layer-kind="phase"/);
  assert.match(phaseBlock, /data-board-layer-name="KANB1"/);
  assert.match(phaseBlock, /data-board-layer-plan-count="1"/);
  assert.ok(
    phaseBlock.includes('data-board-kanban-group="plan:plan-boardv2-a"'),
    "PLW0 组在 KANB1 容器内",
  );
  assert.ok(
    !running.includes('data-board-kanban-group="plan:plan-zcode-ui"'),
    "UI01（审核中）不落执行中列",
  );

  // 审核中列：KANB1 只承载 UI01（跨列投影，层计数随列收缩）。
  const review = sliceBetween(markup, 'data-board-column="审核中"', 'data-board-column="阻塞"');
  const reviewEpic = sliceBetween(
    review,
    'data-board-epic-summary="KANB"',
    'data-board-phase-block="KANB1"',
  );
  assert.match(reviewEpic, /data-board-layer-plan-count="1"/);
  const reviewPhase = sliceBetween(review, 'data-board-phase-block="KANB1"', null);
  assert.ok(reviewPhase.includes('data-board-kanban-group="plan:plan-zcode-ui"'));

  // 待办列：两个 epic 容器（KANB→KANB2、CNCL→CNCL1）各自承载其组；无归属组（NUM1/ORPH）在前。
  const todo = sliceBetween(markup, 'data-board-column="待办"', 'data-board-column="执行中"');
  const todoEpicIndex = todo.indexOf("data-board-epic-block=");
  for (const id of ["plan:plan-by-number", "plan:plan-orphan"]) {
    const index = todo.indexOf(`data-board-kanban-group="${id}"`);
    assert.ok(index >= 0 && index < todoEpicIndex, `无归属组平铺在容器之前：${id}`);
  }
  const k2 = sliceBetween(todo, 'data-board-phase-block="KANB2"', 'data-board-epic-block="CNCL"');
  assert.ok(k2.includes('data-board-kanban-group="plan:plan-boardv2-b1"'), "UI02 在 KANB2 容器内");
  const cncl = sliceBetween(todo, 'data-board-epic-block="CNCL"', null);
  assert.match(cncl, /data-board-layer-status="cancelled"/, "终态登记行在列内同样落标注");
  assert.ok(
    cncl.includes('data-board-kanban-group="plan:plan-cancelled-epic"'),
    "终态成员照常入组",
  );

  // 已完成列：跨列轻量分组（PLW0 的已完成任务）也归容器（归属只认特性，不认列）。
  const done = sliceBetween(markup, 'data-board-column="已完成"', 'data-board-column="已取消"');
  const doneEpic = sliceBetween(done, 'data-board-epic-block="KANB"', null);
  assert.match(
    doneEpic,
    /data-board-kanban-group-header="plan:plan-boardv2-a"[^>]*data-board-group-lightweight="true"/,
    "跨列轻量组头照旧（容器归属不改组头形态）",
  );
});

test("看板：零 epic 板零变化（AD-8）——不落容器锚点，列内分组与列头照旧", () => {
  const markup = renderView(EPIC_BOARD_FLAT, "kanban");
  assert.ok(!markup.includes("data-board-epic-block"));
  assert.ok(!markup.includes("data-board-phase-block"));
  assert.ok(!markup.includes("data-board-layer-name"));
  assert.ok(markup.includes('data-board-kanban-group="plan:plan-boardv2-a"'), "列内分组照旧");
  assert.equal([...markup.matchAll(/data-board-column="([^"]+)"/g)].length, 7, "七列骨架不变");
});

test("看板：回退分支渲染（CR-S1）——半对稿平铺在其段位列，零成员 epic 不造空壳", () => {
  const markup = renderView(EPIC_BOARD_EDGE, "kanban");
  const todo = sliceBetween(markup, 'data-board-column="待办"', 'data-board-column="执行中"');
  const firstEpic = todo.indexOf("data-board-epic-block=");
  assert.ok(firstEpic > 0, "待办列应有 epic 容器（KANB2/CNCL1）");
  for (const id of ["plan:plan-half-pair-epic", "plan:plan-half-pair-phase"]) {
    const index = todo.indexOf(`data-board-kanban-group="${id}"`);
    assert.ok(index >= 0 && index < firstEpic, `半对稿平铺在容器之前：${id}`);
  }
  assert.ok(!markup.includes('data-board-epic-block="EMPT"'), "零成员 epic 在看板不造空壳");
});

/* ---------------- 表格视图（两级 colSpan 组行接线） ---------------- */

test("表格：两级 colSpan 组行——epic 行 ⊃ 期次行在成员分组行之前，列配置与既有结构不变", () => {
  const markup = renderView(EPIC_BOARD, "table");
  assert.equal(
    [...markup.matchAll(/data-board-column-header="([^"]+)"/g)].length,
    10,
    "列配置不动（默认十列）",
  );
  // 无归属分组行在前（AD-8 顶层平铺）。
  const firstEpicRow = markup.indexOf("data-board-epic-block=");
  assert.ok(firstEpicRow > 0, "表格应渲染 epic 组行");
  for (const id of ["spec:preview-channel", "plan:plan-by-number", "plan:plan-orphan"]) {
    const index = markup.indexOf(`data-board-table-group="${id}"`);
    assert.ok(index >= 0 && index < firstEpicRow, `无归属分组行平铺在容器行之前：${id}`);
  }
  // epic 行 = colSpan 全列 + 单点零件的层头（层名/标题/稿数/期数）。
  const epicRow = sliceBetween(
    markup,
    'data-board-epic-summary="KANB"',
    'data-board-phase-summary="KANB1"',
  );
  assert.match(epicRow, /data-board-layer-kind="epic"/, "层头走单点零件");
  assert.match(epicRow, /data-board-layer-name="KANB"/);
  assert.match(epicRow, /data-board-layer-plan-count="3"/);
  assert.match(epicRow, /data-board-layer-phase-count="2"/);
  assert.match(epicRow, /colspan="10"/i, "组行跨全部可见列");
  assert.ok(!epicRow.includes("data-board-card"), "层不是卡：组行无卡片锚点");
  // 期次行 = 第二层 colSpan 组行（合成名 + 该期稿数）。
  const phaseRow = sliceBetween(
    markup,
    'data-board-phase-summary="KANB1"',
    'data-board-table-group="',
  );
  assert.match(phaseRow, /data-board-layer-kind="phase"/);
  assert.match(phaseRow, /data-board-layer-name="KANB1"/);
  assert.match(phaseRow, /data-board-layer-plan-count="2"/);
  assert.match(phaseRow, /colspan="10"/i, "期次组行同样跨全部可见列");
  // 成员分组行落在对应期次行之后（一期两稿；二期稿不落一期）。
  const k1 = sliceBetween(
    markup,
    'data-board-phase-block="KANB1"',
    'data-board-phase-block="KANB2"',
  );
  assert.ok(k1.includes('data-board-table-group="plan:plan-boardv2-a"'), "PLW0 分组行在 KANB1 内");
  assert.ok(k1.includes('data-board-table-group="plan:plan-zcode-ui"'), "UI01 分组行在 KANB1 内");
  assert.ok(!k1.includes('data-board-table-group="plan:plan-boardv2-b1"'), "二期稿不落一期");
  const cncl = sliceBetween(markup, 'data-board-epic-block="CNCL"', null);
  assert.match(cncl, /data-board-layer-status="cancelled"/, "终态登记行落标注");
  assert.ok(cncl.includes('data-board-table-group="plan:plan-cancelled-epic"'), "终态成员照常入组");
  assert.ok(!markup.includes('data-board-layer-status="active"'), "active 登记行不落终态标注");
});

test("表格：零 epic 板零变化（AD-8）——不落容器组行，既有分组 tbody 与行序照旧", () => {
  const markup = renderView(EPIC_BOARD_FLAT, "table");
  assert.ok(!markup.includes("data-board-epic-block"));
  assert.ok(!markup.includes("data-board-phase-block"));
  assert.ok(!markup.includes("data-board-layer-name"));
  assert.match(markup, /data-board-table-group="plan:plan-boardv2-a"/, "既有分组 tbody 照旧");
  assert.ok(
    markup.indexOf('data-board-table-group="plan:plan-boardv2-a"') <
      markup.indexOf('data-board-table-group="spec:preview-channel"'),
    "行序 = 既有管线序（PLW0 挂缺口 → 置顶在 PREV 之前；分组只是分区）",
  );
});

test("表格：回退分支渲染（CR-S1）——半对稿分组行平铺在容器行之前，零成员 epic 不造空壳", () => {
  const markup = renderView(EPIC_BOARD_EDGE, "table");
  const firstEpicRow = markup.indexOf("data-board-epic-block=");
  for (const id of ["plan:plan-half-pair-epic", "plan:plan-half-pair-phase"]) {
    const index = markup.indexOf(`data-board-table-group="${id}"`);
    assert.ok(index >= 0 && index < firstEpicRow, `半对稿分组行平铺：${id}`);
  }
  assert.ok(!markup.includes('data-board-epic-block="EMPT"'), "零成员 epic 在表格不造空壳");
});

/* ---------------- 前修发现（A4-1 第四绿移交 F2） ---------------- */ test("层头长标题恢复路径（F2）：标题 span 条件展开原生 title（截断不丢信息，空串省略）", () => {
  const markup = renderView(EPIC_BOARD, "list");
  const epicHeader = sliceBetween(
    markup,
    'data-board-epic-summary="KANB"',
    'data-board-phase-block="KANB1"',
  );
  assert.match(
    epicHeader,
    /title="看板系统"/,
    "epic 层头标题带原生 title（层不是卡、无弹窗可查全文——#59 截断必配 title 姿态）",
  );
  const phaseHeader = sliceBetween(
    markup,
    'data-board-phase-summary="KANB1"',
    'data-board-list-group="',
  );
  assert.ok(!/\stitle=""/.test(phaseHeader), "期次层头无标题字段：不落空 title");
  // 稿层标题走同一 span（同一零件）：feature 标题同样带 title（三视图受益）。
  const groupSummary = sliceBetween(
    markup,
    'data-board-list-group-summary="plan:plan-boardv2-a"',
    "data-board-list-group=",
  );
  assert.match(groupSummary, /title="看板 v2 一期甲稿"/, "稿层标题同一处修复");
});

/* ---------------- 三视图词条面（复用既有键，无新增文案） ---------------- */

test("三视图层头文案两语齐平（en-US）：计数片/终态标注不漏中文（同一零件同一词条）", () => {
  const archived = structuredClone(EPIC_BOARD) as {
    epics: Array<{ code: string; status: string }>;
  };
  const cnclRow = archived.epics[1];
  assert.ok(cnclRow, "夹具应有 CNCL 登记行");
  cnclRow.status = "archived";
  // 列表/表格：整板容器层计数 = 全球成员（3 稿 / 2 期）；看板：列内投影计数（1 稿 / 1 期）。
  for (const viewMode of ["list", "table"] as const) {
    const markup = renderView(archived, viewMode, "en-US");
    const epicHeader = sliceBetween(
      markup,
      'data-board-layer-kind="epic"',
      'data-board-layer-kind="phase"',
    );
    assert.ok(epicHeader.includes(">3 drafts<"), `${viewMode}：英文稿数片`);
    assert.ok(epicHeader.includes(">2 phases<"), `${viewMode}：英文期数片`);
    const cncl = sliceBetween(
      markup,
      'data-board-layer-name="CNCL"',
      'data-board-layer-name="CNCL1"',
    );
    assert.ok(cncl.includes("Archived"), `${viewMode}：英文终态标注`);
    // 界面文案不漏中文词条（层头切片；板上数据/过滤控件机器词汇不在此列）。
    assert.ok(
      !/[0-9] 稿|[0-9] 期|张卡|已取消|已归档/.test(epicHeader + cncl),
      `${viewMode}：层头界面文案不漏中文词条`,
    );
  }
  const kanban = renderView(archived, "kanban", "en-US");
  const kanbanEpic = sliceBetween(
    kanban,
    'data-board-layer-kind="epic"',
    'data-board-layer-kind="phase"',
  );
  assert.match(kanbanEpic, /data-board-layer-plan-count="1"/, "看板列内层计数 = 本列承载（1 稿）");
  assert.ok(kanbanEpic.includes(">1 drafts<"), "英文稿数片（列内形态）");
  const kanbanCncl = sliceBetween(
    kanban,
    'data-board-layer-name="CNCL"',
    'data-board-layer-name="CNCL1"',
  );
  assert.ok(kanbanCncl.includes("Archived"), "看板列内终态标注走同一词条");
});
