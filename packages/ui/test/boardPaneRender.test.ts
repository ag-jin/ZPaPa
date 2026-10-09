import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { BoardPaneView, type BoardPaneViewProps } from "../src/board/BoardPaneView.js";
import type { BoardPaneLoadState } from "../src/board/loadBoardDocument.js";
import { parseBoardJson } from "../src/board/boardViewModel.js";
import { ZCodeIntlProvider } from "../src/i18n/IntlProvider.js";
import { GOLDEN_SHAPED_BOARD } from "./boardTestFixture.js";

/**
 * 看板树形视图的真渲染守卫（卡 #32）。
 *
 * 期望值的独立真源：`.zcode/board/board-consumption-contract.md` §2（空态 A/B/C 逐字）、
 * §3.1（置顶提示条骨架）、§3.3（特性节点/卡片行骨架）、§4（四缺口码徽章逐字）。
 * 逐字文案以字面量钉在这里 —— 只查词条 key 或只查原文表会漏掉「渲染了错误文案」这一类坏法。
 */

function render(state: BoardPaneLoadState, props: Partial<BoardPaneViewProps> = {}): string {
  return renderToStaticMarkup(
    createElement(ZCodeIntlProvider, {
      initialLocale: "zh-CN" as const,
      children: createElement(BoardPaneView, { state, onRefresh: () => {}, ...props }),
    }),
  );
}

function renderEnglish(state: BoardPaneLoadState): string {
  return renderToStaticMarkup(
    createElement(ZCodeIntlProvider, {
      initialLocale: "en-US" as const,
      children: createElement(BoardPaneView, { state, onRefresh: () => {} }),
    }),
  );
}

/** 段位徽章的可见文本（`data-board-stage` 属性仍是字段原值，这里取文字节点）。 */
function stageBadgeTexts(markup: string): string[] {
  return [...markup.matchAll(/data-board-stage="[^"]*"[^>]*>([^<]*)</g)].map((match) =>
    (match[1] ?? "").trim(),
  );
}

function textInside(markup: string, attr: string): string {
  const match = new RegExp(`${attr}[^>]*>([^<]*)<`).exec(markup);
  assert.ok(match, `markup 里找不到 ${attr}：\n${markup}`);
  return (match[1] ?? "").trim();
}

function readyState(): BoardPaneLoadState {
  const outcome = parseBoardJson(JSON.stringify(GOLDEN_SHAPED_BOARD));
  if (outcome.kind !== "ready") throw new Error("夹具必须是 v2 且 features 非空");
  return { kind: "ready", board: outcome.board };
}

test("树渲染：特性节点行 = 编号 + 标题 + 段位徽章 + 状态色", () => {
  const markup = render(readyState());
  assert.ok(markup.includes('data-board-pane=""'), "面板根节点应存在");
  assert.ok(markup.includes('data-board-feature="spec:preview-channel"'), "特性节点应存在");
  assert.ok(markup.includes("ID-1"), "特性编号应渲染 ID-<label>");
  assert.ok(markup.includes("预览通道（Preview Channel）"), "特性标题应渲染");
  assert.ok(markup.includes('data-board-stage="执行中"'), "特性段位徽章应渲染 stage 字段文本");
  assert.ok(markup.includes('data-board-status="active"'), "状态色应带可辨别的状态标记");
  assert.ok(!markup.includes('未领号">未领号'), "合法未领号形态不得误标");
});

test("每张卡片也渲染自己的段位徽章（stage 字段按节点独立取）", () => {
  const markup = render(readyState());
  const cardRegion = (taskId: string, nextTaskId: string) =>
    markup.slice(
      markup.indexOf(`data-board-task="${taskId}"`),
      markup.indexOf(`data-board-task="${nextTaskId}"`),
    );
  const card7 = cardRegion("task:7", "task:8");
  const card8 = cardRegion("task:8", "task:9");
  assert.ok(
    card7.includes('data-board-stage="待办"'),
    `卡片 1.1 应渲染自己的段位：${card7.slice(0, 200)}`,
  );
  assert.ok(card8.includes('data-board-stage="执行中"'), "卡片 1.2 应渲染自己的段位");
});

test("卡片行：草案/未领号/受阻 N 三枚角标与执行角色徽记", () => {
  const markup = render(readyState());
  // 卡片 1.1：blockers 1 条
  assert.ok(markup.includes('data-board-task="task:7"'), "卡片 #7 应存在");
  assert.ok(markup.includes("ID-1.1"), "卡片编号应渲染 ID-<label>");
  assert.ok(markup.includes("预览发布通道（workflow）"), "卡片标题应渲染");
  assert.ok(markup.includes("受阻 1"), "blockers 非空应渲染「受阻 N」");
  // 卡片 1.2：activeRun 非空
  assert.ok(markup.includes("implementer 执行中"), "activeRun 应渲染执行角色徽记");
  // 未领号的草案卡（plan-payment-split 的两张卡）
  assert.ok(markup.includes("支付拆分（旧稿）"), "未领号特性应照常渲染");
  assert.ok(markup.includes("未领号"), "no/label 缺省应渲染「未领号」角标（合法缺省形态）");
  assert.ok(markup.includes("草案"), "draft 卡应渲染「草案」角标");
  assert.ok(markup.includes("受阻 2"), "两张 draft 卡的第二张 blockers 为 2");
});

test("最近执行行：lastRun 四要素；无断点不编造断点", () => {
  const markup = render(readyState());
  assert.ok(markup.includes("partial"), "result 应渲染");
  assert.ok(markup.includes("停在 #8"), "断点应逐字渲染 停在 #8");
  assert.ok(markup.includes("补 updater 单测后重新验证"), "下一步摘要应渲染");
  // #7 的 lastRun 无断点无摘要；把两行切片比较，确保 #7 的卡片行里没有断点文案。
  const card7 = markup.slice(
    markup.indexOf('data-board-task="task:7"'),
    markup.indexOf('data-board-task="task:8"'),
  );
  const card8 = markup.slice(markup.indexOf('data-board-task="task:8"'));
  assert.ok(card7.length > 0 && card8.length > 0, "两张卡都应渲染");
  assert.ok(!card7.includes("停在"), `#7 无断点不得渲染「停在」：${card7}`);
  assert.ok(card8.includes("停在 #8"), "卡 1.2 的最近执行行应含断点");
});

test("四缺口码徽章逐字（契约 §4）与 attentionSummary 置顶提示条（§3.1）", () => {
  const markup = render(readyState());
  assert.equal(
    bannerText(markup),
    "1 已访谈未安排 · 2 已安排未展开 · 1 执行中断可续 · 1 待合并",
  );
  assert.ok(markup.includes("执行中断，可续（停在 #8）"), "interrupted-resume 徽章应逐字");
  assert.ok(markup.includes("待合并（执行现场未回流）"), "unmerged-worktree 徽章应逐字");
  assert.ok(markup.includes("已安排，尚未拆解任务"), "arranged-not-expanded 徽章应逐字");
  assert.ok(markup.includes("已访谈，尚未落卡"), "interviewed-not-arranged 徽章应逐字");
});

test("提示条在无缺口时不出现", () => {
  const state = readyState();
  if (state.kind !== "ready") throw new Error("准备失败");
  const quiet: BoardPaneLoadState = {
    kind: "ready",
    board: {
      ...state.board,
      attentionSummary: {
        interviewedNotArranged: 0,
        arrangedNotExpanded: 0,
        interruptedResume: 0,
        unmergedWorktree: 0,
      },
    },
  };
  assert.ok(!render(quiet).includes("data-board-attention-banner"));
});

test("板级诊断只读展示（diagnostics 非空属合法形态）", () => {
  const markup = render(readyState());
  assert.ok(markup.includes('data-board-diagnostics=""'));
  assert.ok(markup.includes("docs/plans/plan-payment-split.md"));
  assert.ok(markup.includes("按未领号上板，运行 --assign 补号"));
});

test("空态 A 逐字：本项目还没有看板。完成一次访谈登记或创建第一个 spec 后自动生成。", () => {
  const markup = render({ kind: "missing" });
  assert.equal(
    textInside(markup, 'data-board-empty="missing"'),
    "本项目还没有看板。完成一次访谈登记或创建第一个 spec 后自动生成。",
  );
});

test("空态 B 逐字：尚无规格或计划。", () => {
  const markup = render({ kind: "empty" });
  assert.equal(textInside(markup, 'data-board-empty="empty"'), "尚无规格或计划。");
});

test("空态 C 逐字且不得白屏：板格式无法读取（版本过新/损坏），请在会话中运行编译器重建。", () => {
  const markup = render({ kind: "damaged" });
  assert.equal(
    textInside(markup, 'data-board-empty="damaged"'),
    "板格式无法读取（版本过新/损坏），请在会话中运行编译器重建。",
  );
});

test("读取中态有明确文案，不是空白", () => {
  const markup = render({ kind: "loading" });
  assert.equal(textInside(markup, "data-board-loading"), "正在读取看板…");
});

test("卡片层级深度按 label 段数缩进（契约 §3.3）", () => {
  const markup = render(readyState());
  const card11 = markup.match(/data-board-task="task:7"[^>]*data-board-indent="(\d+)"/);
  const draftCard = markup.match(/data-board-task="task:[^"]*"[^>]*data-board-indent="(\d+)"/g);
  assert.ok(card11, "卡片应带缩进层级标记");
  assert.equal(card11[1], "1", "label=1.1 的卡片缩进层级为 1");
  assert.ok(draftCard && draftCard.length >= 1, "未领号卡也应有缩进层级");
});

test("英文界面：段位徽章走英文词条，不出现中文段位（评审 S5）", () => {
  const markup = renderEnglish(readyState());
  const texts = stageBadgeTexts(markup);
  assert.ok(texts.length > 0, `英文界面应有段位徽章：\n${markup}`);
  for (const text of texts) {
    assert.ok(!/[\u4e00-\u9fff]/.test(text), `en-US 段位徽章漏了中文：${text}`);
  }
  // 字段原值仍是锚点（data 属性不本地化），可见文本才本地化。
  assert.ok(markup.includes('data-board-stage="执行中"'), "段位锚点应保留字段原值");
  assert.ok(texts.includes("In progress"), `执行中 的英文词条应为 In progress：${texts.join("|")}`);
  assert.ok(texts.includes("To do"), `待办 的英文词条应为 To do：${texts.join("|")}`);
});

/* ---------------- 面板级入口与暂时不可读（评审 #32-P3/P5） ---------------- */

test("暂时不可读（连接未就绪）：专门文案 + 刷新入口，不指引重编译（评审 #32-P3）", () => {
  const markup = render({ kind: "unavailable" });
  assert.equal(
    textInside(markup, 'data-board-empty="unavailable"'),
    "看板暂时不可读（连接未就绪）。连接恢复后会自动重读，也可以点右上角刷新重试。",
  );
  assert.ok(!markup.includes("运行编译器重建"), "断连不该指引重编译（那是损坏态的动作）");
  assert.ok(markup.includes("data-board-refresh"), "暂时不可读态也要能手动刷新");
});

test("刷新按钮提到面板级：空态 A/B/C、暂时不可读与加载态都能点（评审 #32-P5）", () => {
  const states: BoardPaneLoadState[] = [
    { kind: "missing" },
    { kind: "empty" },
    { kind: "damaged" },
    { kind: "unavailable" },
    { kind: "loading" },
  ];
  for (const state of states) {
    assert.ok(render(state).includes("data-board-refresh"), `${state.kind} 态应有刷新按钮`);
  }
  assert.ok(
    render(readyState()).includes("data-board-refresh"),
    "就绪态既有头部的刷新按钮仍在",
  );
  const readOnly = renderToStaticMarkup(
    createElement(ZCodeIntlProvider, {
      initialLocale: "zh-CN" as const,
      children: createElement(BoardPaneView, { state: { kind: "missing" } }),
    }),
  );
  assert.ok(!readOnly.includes("data-board-refresh"), "没有刷新回调时不渲染死按钮");
});

/* ---------------- 陈旧提示（契约 §5 的应用侧轻量版） ---------------- */

test("陈旧提示：updatedAt 距今超阈值才出现，纯提示不改变内容渲染（契约 §5）", () => {
  const updatedAt = "2026-10-09T16:05:00+08:00";
  const justAfter = render(readyState(), { now: Date.parse("2026-10-10T15:00:00+08:00") });
  assert.ok(!justAfter.includes("data-board-stale-hint"), "未超阈值不提示");
  const stale = render(readyState(), { now: Date.parse("2026-10-11T17:00:00+08:00") });
  const hint = textInside(stale, "data-board-stale-hint");
  assert.ok(hint.includes("板可能已过期"), `陈旧提示文案：${hint}`);
  assert.ok(hint.includes("建议在会话内重新编译板"), "提示要给出可做的动作");
  assert.ok(stale.includes("预览通道（Preview Channel）"), "陈旧提示不改变既有内容渲染");
  assert.ok(
    !stale.includes("data-board-empty="),
    "陈旧不是空态（契约 §5：不改变空态判定）",
  );
  // updatedAt 缺省（旧板）→ 没有陈旧信号，不编造。
  const state = readyState();
  if (state.kind !== "ready") throw new Error("准备失败");
  const withoutUpdatedAt = render(
    { kind: "ready", board: { ...state.board, updatedAt: null } },
    { now: Date.parse("2026-10-20T00:00:00+08:00") },
  );
  assert.ok(!withoutUpdatedAt.includes("data-board-stale-hint"), "没有时间戳就不猜陈旧");
});

/* ---------------- 提示条段落跳转（#32 遗留） ---------------- */

/** 提示条可见文本（剥标签后归一空白）：文案仍须逐字等于契约 §3.1 模板。 */
function bannerText(markup: string): string {
  const anchor = markup.indexOf("data-board-attention-banner");
  assert.ok(anchor >= 0, "提示条应存在");
  const start = markup.indexOf(">", anchor) + 1;
  const slice = markup.slice(start, markup.indexOf("</div>", start));
  return slice
    .replace(/<[^>]*>/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

test("提示条每段可跳（#32 遗留）：文案逐字不变，有落点的段落是按钮", () => {
  const markup = render(readyState(), { onJumpToCard: () => {} });
  assert.equal(bannerText(markup), "1 已访谈未安排 · 2 已安排未展开 · 1 执行中断可续 · 1 待合并");
  for (const code of [
    "interviewed-not-arranged",
    "arranged-not-expanded",
    "interrupted-resume",
    "unmerged-worktree",
  ]) {
    assert.ok(
      markup.includes(`data-board-attention-jump="${code}"`),
      `${code} 段有对应卡片时应可跳`,
    );
  }
  assert.ok(
    /<button[^>]*data-board-attention-jump="unmerged-worktree"[^>]*>/.test(markup),
    "段落跳转用一个按钮承载（键盘可达）",
  );
});

test("提示条计数没有对应卡片时不给死按钮（陈旧摘要的合法形态）", () => {
  const state = readyState();
  if (state.kind !== "ready") throw new Error("准备失败");
  const staleSummary = render(
    {
      kind: "ready",
      board: {
        ...state.board,
        attentionSummary: {
          interviewedNotArranged: 0,
          arrangedNotExpanded: 0,
          interruptedResume: 0,
          unmergedWorktree: 3,
        },
        features: state.board.features.map((feature) => ({
          ...feature,
          attention: [],
          tasks: feature.tasks.map((task) => ({ ...task, attention: [] })),
        })),
      },
    },
    { onJumpToCard: () => {} },
  );
  assert.equal(bannerText(staleSummary), "0 已访谈未安排 · 0 已安排未展开 · 0 执行中断可续 · 3 待合并");
  assert.ok(
    staleSummary.includes('data-board-attention-jump-none="unmerged-worktree"'),
    "没有落点的段落渲染为纯文本锚点",
  );
  assert.ok(
    !staleSummary.includes('data-board-attention-jump="unmerged-worktree"'),
    "不得给一个跳不到任何卡的死按钮",
  );
});
