import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { BoardPaneView } from "../src/board/BoardPaneView.js";
import { BoardFeatureGroupHeaderContent } from "../src/board/boardNodeParts.js";
import { parseBoardJson } from "../src/board/boardViewModel.js";
import { ZCodeIntlProvider } from "../src/i18n/IntlProvider.js";
import { EPIC_BOARD, EPIC_BOARD_FLAT } from "./boardEpicFixture.js";

/**
 * 组头单点零件的层头扩展（卡 #87 / A4-1 tracer 接口面）与树形三层容器落位。
 *
 * 期望值的独立真源：卡文「组头单点零件（BoardFeatureGroupHeaderContent）扩展承载层名/计数」+
 * markers.md §10.1（epic ⊃ phase ⊃ 稿；层名 = 登记码 / AD-3 双字段合成名）+ 既有 `[N 张卡]`
 * 计数片形态（照旧，不回归）+ board.md 的 epic 章渲染口径（A3-2/#85）。
 */

function renderTree(raw: unknown, locale: "zh-CN" | "en-US" = "zh-CN"): string {
  const outcome = parseBoardJson(JSON.stringify(raw));
  assert.equal(outcome.kind, "ready", "夹具必须是 ready");
  if (outcome.kind !== "ready") throw new Error("夹具必须是 ready");
  return renderToStaticMarkup(
    createElement(ZCodeIntlProvider, {
      initialLocale: locale,
      children: createElement(BoardPaneView, {
        state: { kind: "ready" as const, board: outcome.board },
        viewMode: "tree",
      }),
    }),
  );
}

/** 渲染序区间 [起点锚点, 终点锚点)；终点为 null 时到文末（用于判定「块在谁的里面」）。 */
function sliceBetween(markup: string, fromAnchor: string, toAnchor: string | null): string {
  const start = markup.indexOf(fromAnchor);
  assert.ok(start >= 0, `起点锚点应存在：${fromAnchor}`);
  if (toAnchor === null) return markup.slice(start);
  const end = markup.indexOf(toAnchor, start);
  assert.ok(end > start, `终点锚点应在起点之后：${toAnchor}`);
  return markup.slice(start, end);
}

/** 层头的最小字段面（层不是卡：无号、无计划码、无段位/缺口字段）。 */
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

function renderPart(node: ReturnType<typeof createElement>): string {
  return renderToStaticMarkup(
    createElement(ZCodeIntlProvider, { initialLocale: "zh-CN", children: node }),
  );
}

test("组头零件扩展：epic 层头 = 层名 + 稿数/期数计数片（不生造「未领号」编号）", () => {
  const markup = renderPart(
    createElement(BoardFeatureGroupHeaderContent, {
      feature: EPIC_LAYER_FEATURE,
      layer: { kind: "epic", name: "KANB", planCount: 3, phaseCount: 2 },
      titleClassName: "text-ui-base font-medium text-foreground",
    }),
  );
  assert.match(markup, /data-board-layer-kind="epic"/, "层类型锚点（epic）");
  assert.match(markup, /data-board-layer-name="KANB"/, "层名锚点 = 登记码原值");
  assert.ok(markup.includes(">KANB<"), `层名逐字渲染：${markup}`);
  assert.match(markup, /data-board-layer-plan-count="3"/, "稿数计数片锚点");
  assert.ok(markup.includes(">3 稿<"), `稿数片文案：${markup}`);
  assert.match(markup, /data-board-layer-phase-count="2"/, "期数计数片锚点（epic 层次级片）");
  assert.ok(markup.includes(">2 期<"), `期数片文案：${markup}`);
  assert.ok(!markup.includes("data-board-unassigned"), "层头不是卡：不落「未领号」角标");
  assert.ok(!markup.includes("data-board-node-id"), "层头不走稿层编号位");
  assert.ok(markup.includes("看板系统"), "层标题照常渲染");
});

test("组头零件扩展：期次层头 = 合成层名（KANB1）+ 稿数片（无期数片）", () => {
  const markup = renderPart(
    createElement(BoardFeatureGroupHeaderContent, {
      feature: { ...EPIC_LAYER_FEATURE, title: "" },
      layer: { kind: "phase", name: "KANB1", planCount: 2 },
    }),
  );
  assert.match(markup, /data-board-layer-kind="phase"/, "层类型锚点（phase）");
  assert.match(markup, /data-board-layer-name="KANB1"/, "期次层名 = AD-3 双字段合成名");
  assert.match(markup, /data-board-layer-plan-count="2"/);
  assert.ok(markup.includes(">2 稿<"));
  assert.ok(!markup.includes("data-board-layer-phase-count"), "期次层不渲染期数片");
});

test("组头零件扩展：稿层计数片照旧（[N 张卡] 与锚点不变——三视图/A4-1b 复用不回归）", () => {
  const markup = renderPart(
    createElement(BoardFeatureGroupHeaderContent, {
      feature: {
        no: 31,
        label: "31",
        planCode: "PLW0",
        title: "看板 v2 一期甲稿",
        stage: "执行中",
        attention: [],
        blockers: [],
        status: "active",
      },
      cardCount: 4,
    }),
  );
  assert.match(markup, /data-board-node-id="PLW0"/);
  assert.match(markup, /data-board-feature-card-count="4"/);
  assert.ok(markup.includes(">4 张卡<"), `稿层计数片文案照旧：${markup}`);
  assert.ok(!markup.includes("data-board-layer-name"), "稿层不带层名锚点");
});

test("树形三层容器：epic 章（登记序）⊃ 期次组（升序）⊃ 稿块；层头层名/计数走单点零件", () => {
  const markup = renderTree(EPIC_BOARD);

  // 第一层：epic 章按登记序（KANB → CNCL），各自是可折叠容器（容器头 = summary）。
  const kanbIndex = markup.indexOf('data-board-epic-block="KANB"');
  const cnclIndex = markup.indexOf('data-board-epic-block="CNCL"');
  assert.ok(
    kanbIndex >= 0 && cnclIndex > kanbIndex,
    `epic 章按登记序渲染：${markup.slice(0, 300)}`,
  );
  assert.match(markup, /data-board-epic-summary="KANB"/, "epic 章头锚点");
  const kanbHeader = sliceBetween(
    markup,
    'data-board-epic-summary="KANB"',
    'data-board-phase-block="KANB1"',
  );
  assert.match(kanbHeader, /data-board-layer-kind="epic"/, "epic 层头走单点零件的层锚点");
  assert.match(kanbHeader, /data-board-layer-name="KANB"/);
  assert.ok(
    kanbHeader.includes(">KANB<") && kanbHeader.includes("看板系统"),
    `层名 + 登记行标题：${kanbHeader}`,
  );
  assert.ok(kanbHeader.includes(">3 稿<"), `epic 层稿数 = 成员稿数（3）：${kanbHeader}`);
  assert.match(kanbHeader, /data-board-layer-phase-count="2"/, "epic 层期数片");
  assert.ok(kanbHeader.includes(">2 期<"), `期数片文案：${kanbHeader}`);

  // 第二层：期次组升序（KANB1 → KANB2），期次名 = AD-3 双字段合成名。
  const k1 = markup.indexOf('data-board-phase-block="KANB1"');
  const k2 = markup.indexOf('data-board-phase-block="KANB2"');
  assert.ok(k1 >= 0 && k2 > k1, "期次组按期次序升序（KANB1 → KANB2）");
  const k1Header = sliceBetween(
    markup,
    'data-board-phase-summary="KANB1"',
    "data-board-feature-block=",
  );
  assert.match(k1Header, /data-board-layer-kind="phase"/, "期次组头走单点零件的层锚点");
  assert.match(k1Header, /data-board-layer-name="KANB1"/);
  assert.ok(k1Header.includes(">2 稿<"), `期次组头稿数 = 该期稿数（一期两稿）：${k1Header}`);
  assert.ok(!k1Header.includes("data-board-layer-phase-count"), "期次组头不渲染期数片");

  // 第三层：稿块嵌在所属期次容器内（一期两稿：PLW0 与 UI01 同组；二期稿不在其中）。
  const k1Slice = sliceBetween(
    markup,
    'data-board-phase-block="KANB1"',
    'data-board-phase-block="KANB2"',
  );
  assert.match(k1Slice, /data-board-feature-block="plan:plan-boardv2-a"/, "PLW0 在 KANB1 组内");
  assert.match(
    k1Slice,
    /data-board-feature-block="plan:plan-zcode-ui"/,
    "UI01 同属 KANB1（一期两稿）",
  );
  assert.ok(
    !k1Slice.includes('data-board-feature-block="plan:plan-boardv2-b1"'),
    "二期稿不得落进一期的组（期次只作分组头，成员按期次归属）",
  );
  const k2Slice = sliceBetween(
    markup,
    'data-board-phase-block="KANB2"',
    'data-board-epic-block="CNCL"',
  );
  assert.match(k2Slice, /data-board-feature-block="plan:plan-boardv2-b1"/, "UI02 在 KANB2 组内");
  const cnclSlice = sliceBetween(markup, 'data-board-epic-block="CNCL"', null);
  assert.match(
    cnclSlice,
    /data-board-feature-block="plan:plan-cancelled-epic"/,
    "终态 epic 的成员稿照常入组",
  );
});

test("树形三层容器：无归属/孤儿引用/稳定号引用稿顶层平铺在容器之前（AD-8，不为孤儿造章）", () => {
  const markup = renderTree(EPIC_BOARD);
  const firstEpic = markup.indexOf("data-board-epic-block=");
  assert.ok(firstEpic > 0, "应有 epic 容器");
  for (const featureId of ["spec:preview-channel", "plan:plan-by-number", "plan:plan-orphan"]) {
    const index = markup.indexOf(`data-board-feature-block="${featureId}"`);
    assert.ok(index >= 0, `顶层平铺稿应渲染：${featureId}`);
    assert.ok(index < firstEpic, `无归属/孤儿/稳定号引用稿在容器之前顶层平铺：${featureId}`);
  }
  assert.ok(
    !markup.includes("data-board-unassigned-feature") && !markup.includes("board.unassigned"),
    "无归属是合法形态：不标「未归属」（AD-8/§10.7）",
  );
});

test("树形三层容器：零 epic 板不落任何容器锚点（既有扁平树零回归，AD-8）", () => {
  const markup = renderTree(EPIC_BOARD_FLAT);
  assert.ok(!markup.includes("data-board-epic-block"), "零 epic 项目不造容器");
  assert.ok(!markup.includes("data-board-phase-block"), "零 epic 项目不造期次组");
  assert.ok(!markup.includes("data-board-layer-name"), "零 epic 项目不落层头锚点");
  assert.match(markup, /data-board-feature-block="plan:plan-boardv2-a"/, "稿块照旧渲染");
  assert.match(markup, /data-board-feature-card-count="2"/, "稿层计数片照旧");
});

test("树形三层容器：epic 登记行终态标注在层头呈现（cancelled/archived），成员稿照常可读（§10.5）", () => {
  const markup = renderTree(EPIC_BOARD);
  const cnclHeader = sliceBetween(
    markup,
    'data-board-epic-summary="CNCL"',
    'data-board-phase-block="CNCL1"',
  );
  assert.match(cnclHeader, /data-board-layer-status="cancelled"/, "登记行 cancelled 的锚点带原值");
  assert.ok(cnclHeader.includes("已取消"), `终态标注逐字：${cnclHeader}`);

  const archived = structuredClone(EPIC_BOARD) as {
    epics: Array<{ code: string; status: string }>;
  };
  const cnclRow = archived.epics[1];
  assert.ok(cnclRow);
  cnclRow.status = "archived";
  const archivedHeader = sliceBetween(
    renderTree(archived),
    'data-board-epic-summary="CNCL"',
    'data-board-phase-block="CNCL1"',
  );
  assert.match(archivedHeader, /data-board-layer-status="archived"/);
  assert.ok(archivedHeader.includes("已归档"), `archived 标注逐字：${archivedHeader}`);
});

test("树形三层容器：英文界面层头文案两语齐（计数片/终态标注不漏中文）", () => {
  const archived = structuredClone(EPIC_BOARD) as {
    epics: Array<{ code: string; status: string }>;
  };
  const cnclRow = archived.epics[1];
  assert.ok(cnclRow);
  cnclRow.status = "archived";
  const markup = renderTree(archived, "en-US");
  const kanbHeader = sliceBetween(
    markup,
    'data-board-epic-summary="KANB"',
    'data-board-phase-block="KANB1"',
  );
  assert.ok(kanbHeader.includes(">3 drafts<"), `英文稿数片：${kanbHeader}`);
  assert.ok(kanbHeader.includes(">2 phases<"), `英文期数片：${kanbHeader}`);
  const cnclHeader = sliceBetween(
    markup,
    'data-board-epic-summary="CNCL"',
    'data-board-phase-block="CNCL1"',
  );
  assert.ok(cnclHeader.includes("Archived"), `英文终态标注：${cnclHeader}`);
  // 板上数据（登记行标题）可以是中文；判据只针对界面词条：计数片与终态标注不得漏中文文案。
  assert.ok(
    !/[0-9] 稿|[0-9] 期|张卡|已取消|已归档/.test(kanbHeader + cnclHeader),
    "层头界面文案不漏中文词条",
  );
});
