/**
 * 卡 #90 / A4-4 epic 弹窗退化形态（AD-6 + C4-2「rollup 数字 + 指针下钻」）。
 *
 * 「退化」= epic 不是卡：复用不了卡片弹窗（无稳定号/无 run/lastRun/无段位），弹窗只承载
 * **卷起事实 + 指针**：名 + 计数（N 期次·M 卡）+ rollup 缺口徽章 + 段位构成（L2 rollup，
 * AD-6「rollup 段位入 L2 层」）+ 期次指针（点即下钻到该期次容器）。
 *
 * 期望值的独立真源：EPIC_BOARD 夹具段落自带分布（KANB 三稿两期，仅 PLW0 在 KANB1 带
 * interrupted-resume；CNCL 登记行 cancelled）——用例手推数字，不用实现回算。
 */
import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { BoardPaneView } from "../src/board/BoardPaneView.js";
import { BoardEpicDialog, type BoardEpicDialogProps } from "../src/board/BoardEpicDialog.js";
import {
  boardEpicOpenProps,
  boardEpicOpenSelector,
  boardPhaseSelector,
} from "../src/board/boardCardInteraction.js";
import { boardFoldIdsOfPhase } from "../src/board/boardFoldState.js";
import {
  buildBoardEpicDialog,
  type BoardEpicDialogModel,
  type BoardEpicDialogPhasePointer,
} from "../src/board/boardDialogViewModel.js";
import { parseBoardJson, type BoardViewModel } from "../src/board/boardViewModel.js";
import type { BoardViewMode } from "../src/board/boardViewsViewModel.js";
import { ZCodeIntlProvider } from "../src/i18n/IntlProvider.js";
import { EPIC_BOARD } from "./boardEpicFixture.js";

function readyBoard(raw: unknown): BoardViewModel {
  const outcome = parseBoardJson(JSON.stringify(raw));
  assert.equal(outcome.kind, "ready", "夹具必须是 ready");
  if (outcome.kind !== "ready") throw new Error("夹具必须是 ready");
  return outcome.board;
}

function renderDialog(
  code: string,
  locale: "zh-CN" | "en-US" = "zh-CN",
  raw: unknown = EPIC_BOARD,
): string {
  const props: BoardEpicDialogProps = { board: readyBoard(raw), code };
  return renderToStaticMarkup(
    createElement(ZCodeIntlProvider, {
      initialLocale: locale,
      children: createElement(BoardEpicDialog, props),
    }),
  );
}

test("epic 弹窗模型：卷起计数/缺口/段位构成/期次指针都从成员单点派生（不重算）", () => {
  const board = readyBoard(EPIC_BOARD);
  const kanb: BoardEpicDialogModel | null = buildBoardEpicDialog(board, "KANB");
  assert.ok(kanb, "KANB 登记行应产出弹窗模型");
  assert.equal(kanb.code, "KANB");
  assert.equal(kanb.title, "看板系统");
  assert.equal(kanb.planCount, 3, "成员稿数 = 3");
  assert.equal(kanb.phaseCount, 2, "期次数 = 2");
  assert.equal(kanb.gapCount, 1, "缺口码条数 = 1（仅 PLW0）");
  assert.equal(kanb.statusMessageId, null, "active 登记行不产终态标注（终态仅非活跃）");
  assert.deepEqual(
    kanb.composition,
    [
      { stage: "待办", count: 1 },
      { stage: "执行中", count: 1 },
      { stage: "审核中", count: 1 },
    ],
    "段位构成按词表序（待办 → 执行中 → 审核中），只读成员已有段位",
  );
  const pointers: BoardEpicDialogPhasePointer[] = kanb.phases;
  assert.deepEqual(
    pointers,
    [
      { phase: 1, name: "KANB1", planCount: 2, gapCount: 1 },
      { phase: 2, name: "KANB2", planCount: 1, gapCount: 0 },
    ],
    "期次指针：升序（KANB1 → KANB2）+ 本期稿数/缺口",
  );

  const cncl = buildBoardEpicDialog(board, "CNCL");
  assert.ok(cncl);
  assert.equal(cncl.statusMessageId, "board.status.cancelled", "cancelled 登记行产终态标注词条");
  const odd = structuredClone(EPIC_BOARD) as {
    epics: Array<{ code: string; status: string }>;
  };
  odd.epics[0]!.status = "怪状态";
  const oddModel = buildBoardEpicDialog(readyBoard(odd), "KANB");
  assert.equal(oddModel?.statusMessageId, null, "未知取值不猜语义（不标注）");
  assert.equal(buildBoardEpicDialog(board, "NOPE"), null, "无登记行 → null（不留幽灵弹窗）");
});

test("epic 弹窗渲染：名 + 计数 + rollup 缺口徽章在头（同一组头零件单点）", () => {
  const markup = renderDialog("KANB");
  assert.match(markup, /data-board-epic-dialog="KANB"/, "弹窗身份锚点 = epic 码");
  assert.match(markup, /role="dialog"/, "弹窗语义");
  assert.match(markup, /aria-modal="true"/, "模态语义");
  assert.match(markup, /data-board-layer-kind="epic"/, "复用组头零件的层身份位");
  assert.match(markup, /data-board-layer-name="KANB"/);
  assert.ok(markup.includes("看板系统"), "登记行标题在头");
  assert.match(markup, /data-board-layer-plan-count="3"/, "稿数片");
  assert.match(markup, /data-board-layer-phase-count="2"/, "期数片");
  assert.match(markup, /data-board-layer-gap-count="1"/, "rollup 缺口徽章");
  assert.ok(!markup.includes("data-board-layer-status"), "活跃史诗不出现终态徽章（反例同守）");
  assert.ok(!markup.includes("data-board-stage"), "不自算段位：弹窗不落段位徽章");
});

test("epic 弹窗渲染：L2 rollup 段位构成（词表序 + 无段位行）与终态标注（仅非活跃）", () => {
  const kanb = renderDialog("KANB");
  // 区块锚点与卡片弹窗同一族（`data-board-dialog-section`，外壳/区块壳共用单点）；身份锚点区分弹窗种类。
  assert.match(kanb, /data-board-dialog-section="composition"/, "段位构成区块");
  assert.match(kanb, /data-board-epic-dialog-stage="待办"[^>]*>[\s\S]*?待办[\s\S]*?>1</, "待办 1");
  assert.match(
    kanb,
    /data-board-epic-dialog-stage="执行中"[^>]*>[\s\S]*?执行中[\s\S]*?>1</,
    "执行中 1",
  );
  assert.match(kanb, /data-board-epic-dialog-stage="审核中"[^>]*>[\s\S]*?>1</, "审核中 1");
  const todo = kanb.indexOf('data-board-epic-dialog-stage="待办"');
  const doing = kanb.indexOf('data-board-epic-dialog-stage="执行中"');
  const review = kanb.indexOf('data-board-epic-dialog-stage="审核中"');
  assert.ok(todo >= 0 && doing > todo && review > doing, "构成行按词表序渲染");

  const noStage = structuredClone(EPIC_BOARD) as {
    features: Array<{ epic?: string; stage: string | null }>;
  };
  for (const feature of noStage.features) {
    if (feature.epic === "epic:KANB") feature.stage = null;
  }
  const mixed = renderDialog("KANB", "zh-CN", noStage);
  assert.match(mixed, /data-board-epic-dialog-stage-none="3"/, "无段位成员独立成行（不吞字段）");
  assert.ok(mixed.includes("无段位"), `无段位行文案：${mixed}`);

  const cncl = renderDialog("CNCL");
  assert.match(cncl, /data-board-layer-status="cancelled"/, "终态登记行在弹窗头落标注");
  assert.ok(cncl.includes("已取消"), "终态标注逐字");
});

test("epic 弹窗渲染：期次指针（升序、带稿数/缺口）+ 下钻可及名称（C4-2 指针下钻）", () => {
  const markup = renderDialog("KANB");
  assert.match(markup, /data-board-dialog-section="phases"/, "期次指针区块");
  const k1 = markup.indexOf('data-board-epic-drill="KANB1"');
  const k2 = markup.indexOf('data-board-epic-drill="KANB2"');
  assert.ok(k1 >= 0 && k2 > k1, "指针升序（KANB1 → KANB2）");
  const k1Button = /<button[^>]*data-board-epic-drill="KANB1"[^>]*>/.exec(markup);
  assert.ok(k1Button, "指针是真按钮（可键盘激活）");
  assert.ok(k1Button[0].includes('aria-label="下钻到 KANB1"'), `下钻可及名称：${k1Button[0]}`);
  assert.ok(k1Button[0].includes('type="button"'), "按钮 type=button（不触发表单提交）");
  const k1Slice = markup.slice(k1, k2);
  assert.ok(k1Slice.includes(">2 稿<"), `指针带本期稿数：${k1Slice}`);
  assert.match(k1Slice, /data-board-layer-gap-count="1"/, "指针带本期缺口（缺口不许被埋）");
  const k2Slice = markup.slice(k2);
  assert.ok(!k2Slice.slice(0, 400).includes("data-board-layer-gap-count"), "无缺口期次不落徽章");
});

test("epic 弹窗英文面：区块标题与指针可及名称两语齐（界面文案零中文）", () => {
  const english = structuredClone(EPIC_BOARD) as { epics: Array<{ code: string; title: string }> };
  for (const epic of english.epics) epic.title = `Epic ${epic.code}`;
  const markup = renderDialog("KANB", "en-US", english);
  assert.ok(markup.includes("Stage composition"), `英文构成区块标题：${markup}`);
  assert.ok(markup.includes("Phases"), "英文期次区块标题");
  assert.ok(markup.includes('aria-label="Drill down to KANB1"'), "英文下钻可及名称");
  const text = markup.replace(/<[^>]*>/g, " ");
  assert.ok(!/[\u4e00-\u9fff]/.test(text), `界面文案零中文（板上数据已换英文标题）：${text}`);
});

/* ---------------- 触发面与宿主接线（A4-4 第五/六切片） ---------------- */

test("epic 开弹窗落点（纯函数）：键位判据与卡片同源；缺 handler 不落交互（只读不造死按钮）", () => {
  assert.deepEqual(boardEpicOpenProps({ code: "KANB" }), {}, "缺 onOpenEpic → 空 props（只读）");
  const opened: string[] = [];
  const props = boardEpicOpenProps({ code: "KANB", onOpenEpic: (code) => opened.push(code) });
  assert.equal(props.role, "button", "可及角色");
  assert.equal(props.tabIndex, 0, "可键盘聚焦");
  let prevented = false;
  const clickEvent = {
    preventDefault: () => {
      prevented = true;
    },
  } as unknown as Parameters<NonNullable<typeof props.onClick>>[0];
  props.onClick?.(clickEvent);
  assert.deepEqual(opened, ["KANB"], "点标题区 → 回传 epic 码");
  assert.equal(prevented, true, "落点在 <summary> 里：preventDefault 保住不折叠");
  const keyEvent = (key: string) => {
    let keyPrevented = false;
    props.onKeyDown?.({
      key,
      preventDefault: () => {
        keyPrevented = true;
      },
    } as unknown as Parameters<NonNullable<typeof props.onKeyDown>>[0]);
    return keyPrevented;
  };
  assert.equal(keyEvent("Enter"), true, "Enter 激活");
  assert.equal(keyEvent(" "), true, "Space 激活");
  assert.equal(keyEvent("x"), false, "其余键不激活");
  assert.deepEqual(opened, ["KANB", "KANB", "KANB"], "三次激活都回传同一码");
});

function renderPane(
  viewMode: BoardViewMode,
  props: Record<string, unknown> = {},
  raw: unknown = EPIC_BOARD,
): string {
  return renderToStaticMarkup(
    createElement(ZCodeIntlProvider, {
      initialLocale: "zh-CN",
      children: createElement(BoardPaneView, {
        state: { kind: "ready" as const, board: readyBoard(raw) },
        viewMode,
        ...props,
      }),
    }),
  );
}

test("组头触发面：epic 层头标题区是弹窗落点（四视图同一零件），期次/稿层不变", () => {
  for (const viewMode of ["tree", "list", "kanban", "table"] as const) {
    const markup = renderPane(viewMode, { onOpenEpic: () => {} });
    const epicAnchor = markup.indexOf('data-board-epic-open="KANB"');
    assert.ok(epicAnchor >= 0, `${viewMode}：epic 层头有开弹窗锚点`);
    assert.match(
      markup.slice(0, epicAnchor + 200),
      /role="button"/,
      `${viewMode}：落点带可及角色（title 分区）`,
    );
    assert.ok(
      !markup.includes('data-board-epic-open="KANB1"'),
      `${viewMode}：期次层头不开弹窗（只有 epic 层是落点）`,
    );
    assert.ok(!markup.includes('data-board-phase-open="'), `${viewMode}：期次层不新造落点锚点`);
  }
  const readOnly = renderPane("tree");
  assert.ok(
    !readOnly.includes("data-board-epic-open"),
    "缺 onOpenEpic 时只读渲染：不落死按钮（与既有缺省口径一致）",
  );
  assert.ok(!readOnly.includes("data-board-epic-dialog"), "没打开态不渲染 epic 弹窗");
});

test("宿主接线：openEpicCode 命中才渲染 epic 弹窗；悬空码不留幽灵弹窗", () => {
  const open = renderPane("tree", { openEpicCode: "KANB", onOpenEpic: () => {} });
  assert.match(open, /data-board-epic-dialog="KANB"/, "打开态渲染 epic 弹窗");
  assert.match(open, /data-board-epic-drill="KANB1"/, "弹窗期次指针在");
  const dangling = renderPane("tree", { openEpicCode: "NOPE" });
  assert.ok(!dangling.includes("data-board-epic-dialog"), "悬空 epic 码 → 不渲染（不留幽灵弹窗）");
  const closed = renderPane("tree", { openEpicCode: null });
  assert.ok(!closed.includes("data-board-epic-dialog"), "缺省打开态 = 关闭");
});

test("下钻单点：期次祖先折叠 id、期次/落点选择器都一处生成（同目标重跳不靠裸选择器拼装）", () => {
  assert.deepEqual(
    boardFoldIdsOfPhase("KANB", 2),
    ["epic:KANB", "phase:KANB#2"],
    "期次祖先折叠 id：先 epic 后 phase（与 boardFoldIdsOfCard 同序）",
  );
  assert.equal(boardPhaseSelector("KANB1"), '[data-board-phase-block="KANB1"]');
  assert.equal(
    boardPhaseSelector('怪"名'),
    '[data-board-phase-block="怪\\"名"]',
    "选择器拼装转义（不因数据成败）",
  );
  assert.equal(boardEpicOpenSelector("KANB"), '[data-board-epic-open="KANB"]');
});

test("下钻定位落点：layer 高亮锚点随 highlightCardId 命中期次块（四视图同一零件）", () => {
  for (const viewMode of ["tree", "list", "kanban", "table"] as const) {
    const markup = renderPane(viewMode, { highlightCardId: "KANB1" });
    assert.match(
      markup,
      /data-board-phase-block="KANB1"[^>]*data-board-layer-highlight="true"|data-board-layer-highlight="true"[^>]*data-board-phase-block="KANB1"/,
      `${viewMode}：命中期次块带高亮锚点`,
    );
    assert.ok(
      !markup.includes('data-board-epic-block="KANB" data-board-layer-highlight'),
      `${viewMode}：未命中层不带高亮`,
    );
  }
});
