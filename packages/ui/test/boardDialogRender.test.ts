import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { BoardCardDialog, type BoardCardDialogProps } from "../src/board/BoardCardDialog.js";
import { resolveBoardDialogNode } from "../src/board/boardDialogViewModel.js";
import { parseBoardJson, type BoardViewModel } from "../src/board/boardViewModel.js";
import { ZCodeIntlProvider } from "../src/i18n/IntlProvider.js";
import { GOLDEN_SHAPED_BOARD } from "./boardTestFixture.js";

/**
 * 卡片弹窗的真渲染守卫（卡 #34，契约 §6 逐字）。
 *
 * 期望值的独立真源：`.zcode/board/board-consumption-contract.md` §6（区块与交互：编号+名称 /
 * 状态·缺口 / 细节（空串隐藏）/ 阻拦（external 与 dependency，目标不在当前板 → 禁用跳转）/
 * 最近执行 / 来源 / 证据路径 / 时间戳 / PR（null 隐藏））+ 同节「特性节点弹窗的阻拦区块隐藏」
 * + §6.1（只展示 lastRun，不承诺 activity 全文）。
 */

function goldenBoard(): BoardViewModel {
  const outcome = parseBoardJson(JSON.stringify(GOLDEN_SHAPED_BOARD));
  if (outcome.kind !== "ready") throw new Error("夹具必须是 v2 且 features 非空");
  return outcome.board;
}

function render(
  cardId: string,
  props: Partial<BoardCardDialogProps> = {},
  locale: "zh-CN" | "en-US" = "zh-CN",
) {
  const board = goldenBoard();
  const node = resolveBoardDialogNode(board, cardId);
  assert.ok(node, `夹具里应有节点 ${cardId}`);
  return renderToStaticMarkup(
    createElement(ZCodeIntlProvider, {
      initialLocale: locale,
      children: createElement(BoardCardDialog, { board, node, ...props }),
    }),
  );
}

function sectionOf(markup: string, section: string): string | null {
  const match = new RegExp(`data-board-dialog-section="${section}"`).exec(markup);
  if (!match) return null;
  const start = markup.lastIndexOf("<section", match.index);
  const next = markup.indexOf("data-board-dialog-section=", match.index + 1);
  return markup.slice(start >= 0 ? start : match.index, next === -1 ? markup.length : next);
}

test("弹窗：编号 + 名称 + 状态/缺口徽章（词汇与卡片一致，契约 §6）", () => {
  const markup = render("task:8");
  assert.ok(markup.includes('role="dialog"'), "弹窗是有语义的对话框");
  assert.ok(markup.includes('aria-modal="true"'), "模态语义");
  assert.ok(markup.includes('data-board-dialog="task:8"'), "弹窗身份 = 被点卡片");
  assert.ok(markup.includes("ID-1.2"), "编号按 ID-<label> 渲染");
  assert.ok(markup.includes("让开关立刻生效（核心）"), "名称渲染");
  const status = sectionOf(markup, "status");
  assert.ok(status, "状态/缺口区块应存在");
  assert.ok(status.includes('data-board-stage="执行中"'), "段位徽章（与卡片同一零件）");
  // #46 B5：弹窗状态色点去重（段位徽章已含状态）；#54-5：statusText 与段位徽章同义 → 不重复渲染。
  assert.ok(!status.includes('data-board-status="'), "弹窗不重复状态色点（B5）");
  assert.ok(
    !status.includes("data-board-dialog-status"),
    "段位徽章在场时不重复 statusText（#54-5；去「待办 待办中」）",
  );
  assert.ok(status.includes('data-board-attention="interrupted-resume"'), "缺口徽章 1");
  assert.ok(status.includes('data-board-attention="unmerged-worktree"'), "缺口徽章 2");
  assert.ok(status.includes("执行中断，可续（停在 #8）"), "缺口文案逐字（§4）");
  assert.ok(status.includes("implementer 执行中"), "执行角色徽记（activeRun）");
});

test("弹窗：状态行精简 —— 段位徽章在场时不重复 statusText（#54-5）", () => {
  // 真源：用户第四轮标注⑤——「待办 待办中」重复；段位徽章已经表达状态轴。
  const markup = render("task:8");
  const status = sectionOf(markup, "status");
  assert.ok(status, "状态/缺口区块应存在");
  assert.ok(status.includes('data-board-stage="执行中"'), "段位徽章是状态行的唯一状态表达");
  assert.ok(
    !status.includes("data-board-dialog-status"),
    "段位徽章在场 → 不再渲染同义的 statusText 行",
  );
  assert.ok(!status.includes(">进行中<"), "不出现「进行中」这类与段位同义的重复文案");
  // 段位缺省的卡：没有了段位徽章，status 文本是唯一状态来源，照常渲染（值空才不渲染）。
  const raw = structuredClone(GOLDEN_SHAPED_BOARD) as {
    features: Array<{ tasks: Array<Record<string, unknown>> }>;
  };
  const card8 = raw.features[0]?.tasks[1];
  assert.ok(card8);
  delete card8.stage;
  const outcome = parseBoardJson(JSON.stringify(raw));
  assert.equal(outcome.kind, "ready");
  if (outcome.kind !== "ready") return;
  const node = resolveBoardDialogNode(outcome.board, "task:8");
  assert.ok(node);
  const fallback = renderToStaticMarkup(
    createElement(ZCodeIntlProvider, {
      initialLocale: "zh-CN" as const,
      children: createElement(BoardCardDialog, { board: outcome.board, node }),
    }),
  );
  assert.ok(
    sectionOf(fallback, "status")?.includes('data-board-dialog-status="active"'),
    "无段位徽章时 statusText 仍是唯一状态来源（锚点保留，值空才不渲染）",
  );
});

test("弹窗：待合并 + 受阻合并为单一徽章，两锚点各保留原值（#54-5）", () => {
  // 真源：用户第四轮标注⑤——「待合并」与「受阻 N」并列像两个独立问题；
  // 合并呈现后语义不丢：data-board-attention 与 data-board-blockers 仍各带原值。
  const raw = structuredClone(GOLDEN_SHAPED_BOARD) as {
    features: Array<{ tasks: Array<Record<string, unknown>> }>;
  };
  const card8 = raw.features[0]?.tasks[1];
  assert.ok(card8, "夹具应有 #8");
  card8.blockers = [
    { kind: "dependency", blockedBy: 9, summary: "等上游", evidence: [] },
    { kind: "external", summary: "外部待定", evidence: [] },
  ];
  const outcome = parseBoardJson(JSON.stringify(raw));
  assert.equal(outcome.kind, "ready");
  if (outcome.kind !== "ready") return;
  const node = resolveBoardDialogNode(outcome.board, "task:8");
  assert.ok(node);
  const markup = renderToStaticMarkup(
    createElement(ZCodeIntlProvider, {
      initialLocale: "zh-CN" as const,
      children: createElement(BoardCardDialog, { board: outcome.board, node }),
    }),
  );
  const status = sectionOf(markup, "status");
  assert.ok(status);
  assert.ok(status.includes("待合并 · 受阻于上游"), "合并为单一徽章（词条化文案）");
  assert.ok(
    /data-board-attention="unmerged-worktree"[^>]*data-board-blockers="2"/.test(status) ||
      /data-board-blockers="2"[^>]*data-board-attention="unmerged-worktree"/.test(status),
    "同一徽章上两个锚点各保留原值（attention 码与受阻数都不丢）",
  );
  assert.ok(!status.includes("待合并（执行现场未回流）"), "合并后不再并列渲染原始「待合并」徽章");
  assert.ok(!/data-board-blockers="2"[^>]*>\s*受阻 2/.test(status), "也不再并列渲染「受阻 N」徽章");
});

test("弹窗：特性节点弹窗编号走 feature 形态（#54-9/P-1：UI01 而非 UI01-31）", () => {
  const raw = structuredClone(GOLDEN_SHAPED_BOARD) as {
    features: Array<{ planCode?: string }>;
  };
  const feature = raw.features[0];
  assert.ok(feature);
  feature.planCode = "UI01";
  const outcome = parseBoardJson(JSON.stringify(raw));
  assert.equal(outcome.kind, "ready");
  if (outcome.kind !== "ready") return;
  const node = resolveBoardDialogNode(outcome.board, "spec:preview-channel");
  assert.ok(node);
  const markup = renderToStaticMarkup(
    createElement(ZCodeIntlProvider, {
      initialLocale: "zh-CN" as const,
      children: createElement(BoardCardDialog, { board: outcome.board, node }),
    }),
  );
  assert.ok(markup.includes('data-board-node-id="UI01"'), "特性弹窗编号 = 计划码本身");
  assert.ok(
    !markup.includes('data-board-node-id="UI01-1"'),
    "全局稳定号不得被误读作计划内层级（UI01-31 形态）",
  );
  // 任务卡弹窗仍走 planCode-层级 形态（同一零件两种 variant）。
  const taskMarkup = render("task:8");
  assert.ok(taskMarkup.includes('data-board-node-id="ID-1.2"'), "任务卡弹窗编号形态不变");
});

test("弹窗：细节区块 —— 有文本全文渲染，空串隐藏（§6）", () => {
  const withDetails = render("task:8");
  const details = sectionOf(withDetails, "details");
  assert.ok(details, "有 details 时区块存在");
  assert.ok(
    details.includes("把「应用通道到 updater」抽成一个函数，初始化与拨开关两条路径都调它。"),
    "细节全文渲染（不做截断）",
  );
  const empty = render("task:7");
  assert.equal(sectionOf(empty, "details"), null, "空串 details → 区块隐藏");
  assert.ok(!empty.includes('data-board-dialog-section="details"'), "不渲染空段落");
});

test("弹窗：阻拦区块 —— external 显示 summary + 证据（§6）", () => {
  const markup = render("task:7");
  const blockers = sectionOf(markup, "blockers");
  assert.ok(blockers, "有 blockers 时区块存在");
  assert.ok(blockers.includes('data-board-dialog-blocker="0"'), "阻拦行锚点");
  assert.ok(blockers.includes('data-board-dialog-blocker-kind="external"'), "kind 原值透出");
  assert.ok(
    blockers.includes("dev 污染 atom feed 待验证（决定方案 (a)/(b)）"),
    "external → summary 文案",
  );
  assert.ok(blockers.includes("specs/preview-channel/progress.json"), "external → 证据路径");
  assert.ok(!blockers.includes("data-board-dialog-jump"), "external 没有跳转");
});

test("弹窗：阻拦区块 —— dependency 显示对方 ID-<label> 与 #<no>，可点击跳转（§6）", () => {
  const markup = render("task:plan:plan-payment-split#0");
  const blockers = sectionOf(markup, "blockers");
  assert.ok(blockers);
  assert.ok(blockers.includes('data-board-dialog-blocker-kind="dependency"'));
  assert.ok(blockers.includes("ID-1.3 · #9"), "对方编号：ID-<对方label> + 稳定号 #<对方no>");
  const jump = /<button[^>]*data-board-dialog-jump[^>]*>/.exec(blockers);
  assert.ok(jump, "dependency 有跳转按钮");
  assert.ok(jump[0].includes('data-board-dialog-jump-target="task:9"'), "跳转目标 = 板上那张卡");
  assert.ok(!jump[0].includes('disabled=""'), "目标在板上 → 可点（没有 disabled 属性）");
  assert.ok(
    blockers.includes("等待 #9 的通道函数落地后再合并回调路径"),
    "summary 与跳转并存（不因可跳转而吞摘要）",
  );
});

test("弹窗：dependency 无目标（目标不在当前板）→ 跳转按钮禁用，只显示 summary（§6）", () => {
  const markup = render("task:plan:plan-payment-split#1");
  const blockers = sectionOf(markup, "blockers");
  assert.ok(blockers);
  const jump = /<button[^>]*data-board-dialog-jump[^>]*>/.exec(blockers);
  assert.ok(jump, "无目标也渲染按钮（可见地禁用，不静默消失）");
  assert.ok(jump[0].includes('disabled=""'), "无目标 → 禁用跳转");
  assert.ok(!jump[0].includes("data-board-dialog-jump-target"), "不编造跳转目标");
  assert.ok(blockers.includes(">—<"), "无 summary 时给占位符，不渲染空行");
});

test("弹窗：跳转按钮按目标可点性切换（跳转动作本身由宿主执行：滚动 + 高亮）", () => {
  const clickable = render("task:plan:plan-payment-split#0");
  const disabled = render("task:plan:plan-payment-split#1");
  const buttonOf = (markup: string) => {
    const match = /<button[^>]*data-board-dialog-jump[^>]*>/.exec(markup);
    assert.ok(match, "阻拦行应渲染跳转按钮");
    return match[0];
  };
  assert.ok(buttonOf(clickable).includes('data-board-dialog-jump-target="task:9"'));
  assert.ok(!buttonOf(clickable).includes('disabled=""'), "有目标 → 按钮可点");
  assert.ok(buttonOf(disabled).includes('disabled=""'), "无目标 → 按钮禁用");
  // 无 DOM 环境（仓库无 jsdom/testing-library 先例）不伪断言点击：可点性判据在纯函数层
  // `resolveBoardCardJumpTarget` 已逐条钉住，宿主的滚动 + 高亮接线登记为未覆盖项。
});

test("弹窗：特性节点（label 缺省）显示未领号；阻拦区块隐藏（§6 约束）", () => {
  const markup = render("plan:plan-payment-split");
  assert.ok(markup.includes("未领号"), "未领号特性照样开弹窗（缺省不是空态）");
  assert.ok(markup.includes("支付拆分（旧稿）"));
  assert.equal(sectionOf(markup, "blockers"), null, "特性节点弹窗不渲染阻拦区块");
});

test("弹窗：执行摘要四要素 / 来源行 / 证据路径 / 时间戳（§6 后四区块；#46 B5 区块改名为执行摘要）", () => {
  const markup = render("task:8");
  const lastRun = sectionOf(markup, "execution");
  assert.ok(lastRun, "执行摘要区块存在（最近执行四要素 + 责任管线）");
  assert.ok(lastRun.includes("partial"), "result");
  assert.ok(lastRun.includes("停在 #8"), "断点");
  assert.ok(lastRun.includes("补 updater 单测后重新验证"), "下一步摘要");
  const origin = sectionOf(markup, "origin");
  assert.ok(origin, "来源区块存在");
  assert.ok(origin.includes('data-board-dialog-origin="interviewId"'), "interviewId 行");
  assert.ok(origin.includes("itw-20261009-a1b2"), "来源值原样透出");
  assert.ok(origin.includes('data-board-dialog-origin="specRoot"'));
  const evidence = sectionOf(markup, "evidence");
  assert.ok(evidence, "证据路径区块存在");
  assert.ok(evidence.includes('data-board-dialog-evidence="0"'));
  assert.ok(
    evidence.includes("specs/preview-channel/progress.json"),
    "展示路径文本（不承诺编辑器打开）",
  );
  assert.ok(evidence.includes("ZPaPa/packages/desktop/src/updateStatusModel.ts"));
  assert.ok(evidence.includes("select-all"), "路径是可整段复制的文本");
  const timestamps = sectionOf(markup, "timestamps");
  assert.ok(timestamps, "时间戳区块存在");
  assert.ok(timestamps.includes('data-board-dialog-timestamp="createdAt"'));
  assert.ok(timestamps.includes('data-board-dialog-timestamp="updatedAt"'));
});

test("弹窗：lastRun 为 null 时不渲染最近执行行（§6 / §3.3 同口径；执行摘要仍含管线）", () => {
  // 草案第二张：无 lastRun、无 origin、无证据路径（形态见 boardTestFixture）。
  const markup = render("task:plan:plan-payment-split#1");
  const execution = sectionOf(markup, "execution");
  assert.ok(execution, "执行摘要区块仍在（#46 B6：管线单独成行）");
  assert.ok(!execution.includes("停在 #"), "无 run → 不渲染最近执行行");
  assert.ok(!/\d{2}\/\d{2}, \d{2}:\d{2}/.test(execution), "无 run → 无绝对时间行");
  assert.equal(sectionOf(markup, "origin"), null, "无 origin → 来源区块隐藏");
  assert.equal(sectionOf(markup, "evidence"), null, "无证据路径 → 区块隐藏");
  const timestamps = sectionOf(markup, "timestamps");
  assert.ok(timestamps, "该卡夹具带 updatedAt → 时间戳区块仍在");
  assert.ok(
    !timestamps.includes('data-board-dialog-timestamp="createdAt"'),
    "缺 createdAt 的行不渲染",
  );
  assert.ok(
    timestamps.includes('data-board-dialog-timestamp="updatedAt"'),
    "有 updatedAt 的行照常渲染",
  );
});

test("弹窗：PR 区块（远程模式）号 + 链接；pr 缺省 → 隐藏（§6）", () => {
  const withPr = render("task:9");
  const pr = sectionOf(withPr, "pr");
  assert.ok(pr, "有 pr 时区块存在");
  assert.ok(pr.includes("#41"), "远程号");
  assert.ok(
    pr.includes('href="https://github.com/ag-jin/ZPaPa/pull/41"'),
    "链接指向板上 url（不拼接、不改写）",
  );
  assert.equal(sectionOf(render("task:8"), "pr"), null, "pr 缺省 → 区块隐藏");
});

test("弹窗：关闭路径的锚点（× 与遮罩）都在（Esc 判据在宿主消费的纯函数里）", () => {
  const markup = render("task:8", { onClose: () => {} });
  const closeButton = /<button[^>]*data-board-dialog-close="button"[^>]*>/.exec(markup);
  assert.ok(closeButton, "× 关闭钮应存在");
  assert.ok(closeButton[0].includes('aria-label="关闭"'), "关闭钮有可及名称（不留裸图标）");
  assert.ok(markup.includes('data-board-dialog-scrim=""'), "遮罩应存在（点遮罩关闭）");
  assert.ok(markup.includes('role="dialog"'), "弹窗语义");
});

test("弹窗：英文界面全部区块标题与状态词汇走英文词条（界面文案不漏中文）", () => {
  const markup = render("task:8", {}, "en-US");
  for (const label of ["Details", "Execution", "Source", "Evidence", "Timestamps"]) {
    assert.ok(markup.includes(`>${label}<`), `en-US 弹窗应含区块标题「${label}」`);
  }
  // #54-5：状态行只留段位徽章 → 英文界面由段位词条表达（无重复 statusText）。
  assert.ok(markup.includes(">In progress<"), "段位徽章走英文词条");
  assert.ok(!markup.includes("data-board-dialog-status"), "不重复渲染同义 statusText");
  // 只查界面文案（词条渲染出的可见文本）；板上数据（标题/细节/路径）照原样透出，不参与本地化。
  const sectionTitles = ["Details", "Execution", "Source", "Evidence", "Timestamps"];
  const uiCopy = ["In progress", ...sectionTitles];
  for (const copy of uiCopy) {
    assert.ok(!/[\u4e00-\u9fff]/.test(copy), `en-US 界面文案漏了中文：${copy}`);
  }
});
