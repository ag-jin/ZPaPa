/**
 * 卡 #90 / A4-4 组头徽章（AD-6）——层 rollup 缺口计数徽章与计数词条形态。
 *
 * 期望值的独立真源：裁决包 AD-6「组头 = 名 + 计数（N 期次·M 卡）+ rollup 缺口计数徽章；
 * 终态徽章仅非活跃时出现；rollup 段位入 L2 层」（B §4.1 T-3 下限建议 c）+ 夹具段落自带的
 * 成员/缺口分布（EPIC_BOARD 里 KANB 三稿中仅 PLW0 带 interrupted-resume——缺口码条数 1）。
 * 计数是纯函数层的产物，测试不用实现回算期望值：写死「夹具已知的几个数」。
 */
import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { BoardPaneView } from "../src/board/BoardPaneView.js";
import { BoardFeatureGroupHeaderContent } from "../src/board/boardNodeParts.js";
import {
  boardLayerGapCount,
  boardLayerStageComposition,
} from "../src/board/boardEpicContainers.js";
import { parseBoardJson, type BoardViewModel } from "../src/board/boardViewModel.js";
import type { BoardViewMode } from "../src/board/boardViewsViewModel.js";
import { ZCodeIntlProvider } from "../src/i18n/IntlProvider.js";
import { EPIC_BOARD } from "./boardEpicFixture.js";

/** 层头的最小字段面（层不是卡：无号、无计划码、无段位/缺口字段；与 A4-1 测试同形）。 */
const EPIC_LAYER_FEATURE = {
  no: null,
  label: null,
  planCode: null,
  title: "看板系统",
  stage: null,
  attention: [],
  blockers: [],
  status: null,
};

function renderPart(node: ReturnType<typeof createElement>, locale: "zh-CN" | "en-US" = "zh-CN") {
  return renderToStaticMarkup(
    createElement(ZCodeIntlProvider, { initialLocale: locale, children: node }),
  );
}

function readyBoard(raw: unknown): BoardViewModel {
  const outcome = parseBoardJson(JSON.stringify(raw));
  assert.equal(outcome.kind, "ready", "夹具必须是 ready");
  if (outcome.kind !== "ready") throw new Error("夹具必须是 ready");
  return outcome.board;
}

function renderView(
  raw: unknown,
  viewMode: BoardViewMode,
  locale: "zh-CN" | "en-US" = "zh-CN",
): string {
  return renderToStaticMarkup(
    createElement(ZCodeIntlProvider, {
      initialLocale: locale,
      children: createElement(BoardPaneView, {
        state: { kind: "ready" as const, board: readyBoard(raw) },
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

test("rollup 缺口计数（单点）：= 成员稿 attention 码条数之和（逐码计数；无缺口 = 0）", () => {
  assert.equal(boardLayerGapCount([]), 0, "零成员 → 0（空集不编造缺口）");
  assert.equal(boardLayerGapCount([{ attention: [] }, { attention: [] }]), 0, "全无缺口的成员 → 0");
  assert.equal(
    boardLayerGapCount([{ attention: [] }, { attention: ["interrupted-resume"] }]),
    1,
    "一个成员一条缺口 → 1",
  );
  assert.equal(
    boardLayerGapCount([
      { attention: ["interrupted-resume", "unmerged-worktree"] },
      { attention: ["unmerged-worktree"] },
      { attention: [] },
    ]),
    3,
    "逐码计数（一个成员多码计多条）——与 attentionSummary 逐码口径同源",
  );
});

test("组头零件扩展：layer.gapCount > 0 渲染 rollup 缺口徽章（锚点带原值 + 全文 title）", () => {
  const markup = renderPart(
    createElement(BoardFeatureGroupHeaderContent, {
      feature: EPIC_LAYER_FEATURE,
      layer: { kind: "epic", name: "KANB", planCount: 3, phaseCount: 2, gapCount: 1 },
      titleSize: "base",
    }),
  );
  assert.match(markup, /data-board-layer-gap-count="1"/, "缺口徽章锚点带原值");
  assert.ok(markup.includes("缺口 1"), `缺口徽章文案：${markup}`);
  assert.match(markup, /data-board-overflow-ellipsis=""/, "窄盒省略号防线（与缺口卡徽章同款）");
  // 顺序：名 + 计数（N 期次·M 卡）+ 缺口徽章（AD-6 逐字）。
  const plan = markup.indexOf("data-board-layer-plan-count");
  const gap = markup.indexOf("data-board-layer-gap-count");
  assert.ok(plan >= 0 && gap > plan, "缺口徽章排在计数片之后");
});

test("组头零件扩展：零缺口（0 或缺省）不渲染缺口徽章——日常零噪声", () => {
  const zero = renderPart(
    createElement(BoardFeatureGroupHeaderContent, {
      feature: EPIC_LAYER_FEATURE,
      layer: { kind: "epic", name: "KANB", planCount: 3, phaseCount: 2, gapCount: 0 },
    }),
  );
  assert.ok(!zero.includes("data-board-layer-gap-count"), "gapCount=0 不落徽章");
  const missing = renderPart(
    createElement(BoardFeatureGroupHeaderContent, {
      feature: EPIC_LAYER_FEATURE,
      layer: { kind: "phase", name: "KANB1", planCount: 2 },
    }),
  );
  assert.ok(!missing.includes("data-board-layer-gap-count"), "gapCount 缺省不落徽章");
});

test("rollup 段位构成（L2 层单点）：按段位词表序计数；无段位/未知段位不吞字段", () => {
  assert.deepEqual(
    boardLayerStageComposition([
      { stage: "已完成" },
      { stage: "执行中" },
      { stage: "已完成" },
      { stage: null },
      { stage: "怪段位" },
    ]),
    [
      { stage: "执行中", count: 1 },
      { stage: "已完成", count: 2 },
      { stage: "怪段位", count: 1 },
      { stage: null, count: 1 },
    ],
    "词表序（执行中在已完成之前）→ 未知段位原样 → 无段位殿后",
  );
  assert.deepEqual(boardLayerStageComposition([]), [], "零成员 → 空构成（不编造）");
});

test("计数词条单复数（F4/D7）：en count=1 走单数键（1 draft/phase/gap/card），zh 两侧同文", () => {
  const one = renderPart(
    createElement(BoardFeatureGroupHeaderContent, {
      feature: EPIC_LAYER_FEATURE,
      layer: { kind: "epic", name: "KANB", planCount: 1, phaseCount: 1, gapCount: 1 },
    }),
    "en-US",
  );
  assert.ok(one.includes(">1 draft<"), `en 单数稿数片：${one}`);
  assert.ok(one.includes(">1 phase<"), `en 单数期数片：${one}`);
  assert.ok(one.includes(">1 gap<"), `en 单数缺口徽章：${one}`);
  assert.ok(
    !one.includes("1 drafts") && !one.includes("1 phases") && !one.includes("1 gaps"),
    "单数不再是裸复数（「1 drafts」必咬）",
  );
  const cardOne = renderPart(
    createElement(BoardFeatureGroupHeaderContent, {
      feature: { ...EPIC_LAYER_FEATURE, title: "单卡稿" },
      cardCount: 1,
    }),
    "en-US",
  );
  assert.ok(cardOne.includes(">1 card<"), `en 单数卡数片：${cardOne}`);
  const many = renderPart(
    createElement(BoardFeatureGroupHeaderContent, {
      feature: EPIC_LAYER_FEATURE,
      layer: { kind: "epic", name: "KANB", planCount: 3, phaseCount: 2, gapCount: 2 },
    }),
    "en-US",
  );
  assert.ok(
    many.includes(">3 drafts<") && many.includes(">2 phases<") && many.includes(">2 gaps<"),
  );
  const zhOne = renderPart(
    createElement(BoardFeatureGroupHeaderContent, {
      feature: EPIC_LAYER_FEATURE,
      layer: { kind: "phase", name: "KANB1", planCount: 1, gapCount: 1 },
    }),
  );
  assert.ok(zhOne.includes(">1 稿<") && zhOne.includes("缺口 1"), `zh 单数同文：${zhOne}`);
});

test("D5 层计数片 title 消歧：稿数/期数片带全文 tooltip（层语义不靠猜）", () => {
  const markup = renderPart(
    createElement(BoardFeatureGroupHeaderContent, {
      feature: EPIC_LAYER_FEATURE,
      layer: { kind: "epic", name: "KANB", planCount: 3, phaseCount: 2, gapCount: 0 },
    }),
  );
  const planChip = /<span[^>]*data-board-layer-plan-count="3"[^>]*>/.exec(markup);
  const phaseChip = /<span[^>]*data-board-layer-phase-count="2"[^>]*>/.exec(markup);
  assert.ok(planChip, "稿数片可定位");
  assert.ok(phaseChip, "期数片可定位");
  assert.ok(
    planChip[0].includes('title="本层成员稿数（每稿含若干卡）"'),
    `稿数片 title 消歧：${planChip[0]}`,
  );
  assert.ok(phaseChip[0].includes('title="本层期次数"'), `期数片 title 消歧：${phaseChip[0]}`);
});

test("终态徽章仅非活跃时出现（AD-6 反例）：active/缺省/未知状态不落；cancelled/archived 落", () => {
  const withStatus = (status: string | null) =>
    renderPart(
      createElement(BoardFeatureGroupHeaderContent, {
        feature: EPIC_LAYER_FEATURE,
        layer: { kind: "epic", name: "KANB", planCount: 3, phaseCount: 2, gapCount: 0, status },
      }),
    );
  assert.ok(!withStatus("active").includes("data-board-layer-status"), "活跃史诗不出现终态徽章");
  assert.ok(!withStatus(null).includes("data-board-layer-status"), "缺省状态不落徽章（零噪声）");
  assert.ok(
    !withStatus("怪状态").includes("data-board-layer-status"),
    "未知取值不猜语义（不标注）",
  );
  assert.match(withStatus("cancelled"), /data-board-layer-status="cancelled"/, "cancelled 落徽章");
  assert.match(withStatus("archived"), /data-board-layer-status="archived"/, "archived 落徽章");
});

test("叶级半径倒挂收口（D6）：容器内叶级行/卡降到 rounded-sm（容器外维持既有档）", () => {
  /** 按 data 锚点取元素的 class 属性（不绑整段 markup 形态）。 */
  const classOf = (markup: string, anchor: string): string => {
    const index = markup.indexOf(anchor);
    assert.ok(index >= 0, `锚点应存在：${anchor}`);
    const open = markup.lastIndexOf("<", index);
    const close = markup.indexOf(">", index);
    const tag = markup.slice(open, close + 1);
    const match = /class="([^"]*)"/.exec(tag);
    return match?.[1] ?? "";
  };
  // DESIGN.md 半径阶梯：嵌套圆角容器逐级降档（xl → lg → md → sm）；叶级行/卡不得大于最近容器。
  const tree = renderView(EPIC_BOARD, "tree");
  const nestedBlock = classOf(tree, 'data-board-feature-block="plan:plan-boardv2-a"');
  assert.ok(nestedBlock.includes("rounded-md"), `嵌套稿块 = md（最近容器）：${nestedBlock}`);
  const nestedRow = classOf(tree, 'data-board-task="task:87"');
  assert.ok(
    nestedRow.includes("rounded-sm"),
    `嵌套容器里的任务行降到 sm（不再 lg > md 倒挂）：${nestedRow}`,
  );
  const nestedRow2 = classOf(tree, 'data-board-task="task:88"');
  assert.ok(nestedRow2.includes("rounded-sm"), "同块其余行同档");
  const topBlock = classOf(tree, 'data-board-feature-block="spec:preview-channel"');
  assert.ok(topBlock.includes("rounded-xl"), `顶层稿块 = xl：${topBlock}`);
  const topRow = classOf(tree, 'data-board-task="task:7"');
  assert.ok(topRow.includes("rounded-lg"), `顶层块里的任务行维持 lg（xl → lg）：${topRow}`);

  const list = renderView(EPIC_BOARD, "list");
  assert.ok(
    classOf(list, 'data-board-list-group="plan:plan-boardv2-a"').includes("rounded-md"),
    "列表嵌套分组 = md",
  );
  assert.ok(
    classOf(list, 'data-board-card="task:87"').includes("rounded-sm"),
    "列表嵌套分组里的行降到 sm",
  );
  assert.ok(
    classOf(list, 'data-board-card="task:7"').includes("rounded-lg"),
    "列表无归属分组（顶层）里的行维持 lg",
  );

  const kanban = renderView(EPIC_BOARD, "kanban");
  const doing = sliceBetween(kanban, 'data-board-column="执行中"', 'data-board-column="审核中"');
  assert.ok(
    classOf(doing, 'data-board-kanban-card="task:87"').includes("rounded-sm"),
    "看板期次容器里的卡降到 sm",
  );
  // 无归属块（最近容器 = 列 rounded-xl → 卡维持 lg）：给无归属稿补一张同列任务卡（夹具变体）。
  const withTopCard = structuredClone(EPIC_BOARD) as {
    features: Array<{ id: string; tasks: unknown[] }>;
  };
  const preview = withTopCard.features.find((feature) => feature.id === "spec:preview-channel");
  assert.ok(preview);
  preview.tasks = [
    {
      no: 9001,
      label: "2.1",
      title: "顶层任务卡（半径档探针）",
      details: "",
      status: "active",
      stage: "执行中",
      draft: false,
      blockers: [],
      attention: [],
      lastRun: null,
      activeRun: null,
      updatedAt: "2026-10-11T06:00:00+08:00",
    },
  ];
  const kanbanVariant = renderView(withTopCard, "kanban");
  const doingVariant = sliceBetween(
    kanbanVariant,
    'data-board-column="执行中"',
    'data-board-column="审核中"',
  );
  assert.ok(
    classOf(doingVariant, 'data-board-kanban-card="task:9001"').includes("rounded-lg"),
    "看板无归属块（最近容器 = 列 xl）里的卡维持 lg",
  );
});

test("四视图组头接 rollup 缺口计数（计数正确性）：tree/list/table = 全量成员，看板 = 列内投影", () => {
  // 夹具已知分布（EPIC_BOARD）：KANB 三稿两期，仅 PLW0（KANB1）带 1 条 interrupted-resume；
  // KANB2 一稿无缺口；CNCL 一稿无缺口且登记行 cancelled。
  for (const viewMode of ["tree", "list", "table"] as const) {
    const markup = renderView(EPIC_BOARD, viewMode);
    const kanb = sliceBetween(
      markup,
      'data-board-layer-name="KANB"',
      'data-board-layer-name="KANB1"',
    );
    assert.match(
      kanb,
      /data-board-layer-gap-count="1"/,
      `${viewMode}：KANB 层缺口=1（3 稿中 1 条）`,
    );
    assert.ok(kanb.includes("缺口 1"), `${viewMode}：缺口徽章文案`);
    assert.match(kanb, /data-board-layer-plan-count="3"/, `${viewMode}：KANB 层稿数=3`);
    const phase1 = sliceBetween(
      markup,
      'data-board-layer-name="KANB1"',
      'data-board-layer-name="KANB2"',
    );
    assert.match(phase1, /data-board-layer-gap-count="1"/, `${viewMode}：KANB1 层缺口=1`);
    assert.match(phase1, /data-board-layer-plan-count="2"/, `${viewMode}：KANB1 层稿数=2`);
    const phase2 = sliceBetween(
      markup,
      'data-board-layer-name="KANB2"',
      'data-board-layer-name="CNCL"',
    );
    assert.ok(!phase2.includes("data-board-layer-gap-count"), `${viewMode}：KANB2 无缺口不落徽章`);
    const cncl = sliceBetween(markup, 'data-board-layer-name="CNCL"', null);
    assert.ok(!cncl.includes("data-board-layer-gap-count"), `${viewMode}：CNCL 无缺口不落徽章`);
    assert.match(cncl, /data-board-layer-status="cancelled"/, `${viewMode}：CNCL 终态徽章在`);
  }
  // 看板列内投影：缺口计与稿数同守「本列实际承载」口径。
  const kanban = renderView(EPIC_BOARD, "kanban");
  const doing = sliceBetween(kanban, 'data-board-column="执行中"', 'data-board-column="审核中"');
  assert.match(doing, /data-board-layer-name="KANB"/, "执行中列有 KANB 容器");
  assert.match(doing, /data-board-layer-plan-count="1"/, "执行中列 KANB 承载 1 稿（PLW0）");
  assert.match(doing, /data-board-layer-gap-count="1"/, "执行中列 KANB 缺口=1（本列承载口径）");
  const review = sliceBetween(kanban, 'data-board-column="审核中"', 'data-board-column="阻塞"');
  assert.match(review, /data-board-layer-plan-count="1"/, "审核中列 KANB 承载 1 稿（UI01）");
  assert.ok(!review.includes("data-board-layer-gap-count"), "审核中列无缺口 → 不落徽章");
});

test("看板期次层缺口接线（M4 覆盖缺口固化）：列内投影期次层带缺口徽章（KANB1 落 / KANB2 不落）", () => {
  // 二绿突变 M4（删看板期次层 gapCount 接线）在交付套件逃逸——本用例把该接线钉死：
  // 看板期次层与 epic 层同守「本列实际承载」口径（KANB1 列内 1 稿带 1 条缺口；KANB2 无缺口）。
  const kanban = renderView(EPIC_BOARD, "kanban");
  const doing = sliceBetween(kanban, 'data-board-column="执行中"', 'data-board-column="审核中"');
  assert.match(doing, /data-board-layer-name="KANB1"/, "执行中列有 KANB1 期次层头");
  const phase1 = sliceBetween(doing, 'data-board-layer-name="KANB1"', null);
  assert.match(phase1, /data-board-layer-gap-count="1"/, "KANB1 期次层缺口=1（本列承载 PLW0）");
  assert.ok(phase1.includes("缺口 1"), "KANB1 期次层缺口徽章文案");
  assert.match(phase1, /data-board-layer-plan-count="1"/, "KANB1 期次层稿数=1（列内投影）");
  const todo = sliceBetween(kanban, 'data-board-column="待办"', 'data-board-column="执行中"');
  assert.match(todo, /data-board-layer-name="KANB2"/, "待办列有 KANB2 期次层头");
  const phase2 = sliceBetween(todo, 'data-board-layer-name="KANB2"', null);
  assert.ok(!phase2.includes("data-board-layer-gap-count"), "KANB2 期次层无缺口不落徽章");
});
