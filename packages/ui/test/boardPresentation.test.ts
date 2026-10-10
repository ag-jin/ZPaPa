import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import enUS from "../src/i18n/locales/en-US.js";
import zhCN from "../src/i18n/locales/zh-CN.js";
import {
  boardStatusDotClassName,
  BOARD_ATTENTION_LABEL_MESSAGE_IDS,
  BOARD_STAGE_MESSAGE_IDS,
  BOARD_STATUS_MESSAGE_IDS,
  formatAttentionBadgeText,
  formatAttentionSummaryText,
  formatBoardLastRunText,
  formatBoardRunTime,
  formatBoardStageText,
  formatBoardStaleHint,
  isBoardStale,
} from "../src/board/boardPresentation.js";
import {
  BOARD_ATTENTION_CODES,
  BOARD_STATUS_VALUES,
  hasAttentionSignal,
  type BoardLastRun,
} from "../src/board/boardViewModel.js";
import {
  BOARD_DIALOG_ORIGIN_KEYS,
  BOARD_ORIGIN_MESSAGE_IDS,
} from "../src/board/boardDialogViewModel.js";
import {
  BOARD_TABLE_COLUMNS,
  BOARD_TABLE_COLUMN_MESSAGE_IDS,
} from "../src/board/boardTableViewModel.js";

/**
 * 看板呈现层的纯函数缝（卡 #32）。
 *
 * 期望值的独立真源：`.zcode/board/board-consumption-contract.md` §2（空态逐字）、
 * §3.1/§4（提示条与四缺口码徽章逐字）、§3.3（lastRun 四要素）。文案一律从 zh-CN 词条表取词，
 * 字面量写在测试里 —— 词条漂移必须让测试红。
 */

function formatterWith(messages: Record<string, string>) {
  return (descriptor: { id: string }, values?: Record<string, string | number>) => {
    let message = messages[descriptor.id] ?? descriptor.id;
    for (const [key, value] of Object.entries(values ?? {})) {
      message = message.replaceAll(`{${key}}`, String(value));
    }
    return message;
  };
}

const t = formatterWith(zhCN);
const tEn = formatterWith(enUS);

test("四缺口码徽章文案逐字（契约 §4）", () => {
  const interrupted: BoardLastRun = {
    at: "2026-10-09T14:20:00+08:00",
    role: "implementer",
    result: "partial",
    stoppedAt: 8,
    next: "补 updater 单测后重新验证",
  };
  assert.equal(formatAttentionBadgeText("interviewed-not-arranged", null, t), "已访谈，尚未落卡");
  assert.equal(formatAttentionBadgeText("arranged-not-expanded", null, t), "已安排，尚未拆解任务");
  assert.equal(
    formatAttentionBadgeText("interrupted-resume", interrupted, t),
    "执行中断，可续（停在 #8）",
  );
  assert.equal(formatAttentionBadgeText("unmerged-worktree", null, t), "待合并（执行现场未回流）");
});

test("interrupted-resume 缺断点号时不编造号，退化为不带断点的固定文案", () => {
  const noBreakpoint: BoardLastRun = {
    at: "2026-10-09T14:20:00+08:00",
    role: "implementer",
    result: "interrupted",
    stoppedAt: null,
    next: null,
  };
  assert.equal(formatAttentionBadgeText("interrupted-resume", noBreakpoint, t), "执行中断，可续");
});

test("attentionSummary 提示条逐字（契约 §3.1：N 已访谈未安排 · M 已安排未展开 · K 执行中断可续 · L 待合并）", () => {
  const text = formatAttentionSummaryText(
    {
      interviewedNotArranged: 1,
      arrangedNotExpanded: 2,
      interruptedResume: 1,
      unmergedWorktree: 1,
    },
    t,
  );
  assert.equal(text, "1 已访谈未安排 · 2 已安排未展开 · 1 执行中断可续 · 1 待合并");
});

test("提示条仅当四项计数有非零项时出现（契约 §3.1）", () => {
  assert.equal(
    hasAttentionSignal({
      interviewedNotArranged: 0,
      arrangedNotExpanded: 0,
      interruptedResume: 0,
      unmergedWorktree: 0,
    }),
    false,
  );
  assert.equal(
    hasAttentionSignal({
      interviewedNotArranged: 0,
      arrangedNotExpanded: 5,
      interruptedResume: 0,
      unmergedWorktree: 0,
    }),
    true,
  );
});

test("lastRun 行四要素：时间 · result · 停在 #N · 下一步摘要（契约 §3.3）", () => {
  const text = formatBoardLastRunText(
    {
      at: "2026-10-09T14:20:00+08:00",
      role: "implementer",
      result: "partial",
      stoppedAt: 8,
      next: "补 updater 单测后重新验证",
    },
    t,
  );
  assert.ok(text, "有 lastRun 必须渲染该行");
  assert.ok(text.includes("partial"), `result 应出现在行内：${text}`);
  assert.ok(text.includes("停在 #8"), `断点应逐字出现：${text}`);
  assert.ok(text.includes("补 updater 单测后重新验证"), `下一步摘要应出现：${text}`);
});

test("lastRun 为 null 时不渲染该行（契约 §3.3）", () => {
  assert.equal(formatBoardLastRunText(null, t), null);
});

test("lastRun 无断点无摘要时只保留时间与 result，不编造「停在 #N」", () => {
  const text = formatBoardLastRunText(
    {
      at: "2026-10-09T14:05:00+08:00",
      role: "code-reviewer",
      result: "done",
      stoppedAt: null,
      next: null,
    },
    t,
  );
  assert.ok(text);
  assert.ok(text.includes("done"));
  assert.ok(!text.includes("停在"), `缺断点不得编造：${text}`);
});

test("四态配色键：pending/active/blocked/completed 各有一档样式，未知状态无色档", () => {
  const classes = new Set<string>();
  for (const status of ["pending", "active", "blocked", "completed"]) {
    const className = boardStatusDotClassName(status);
    assert.ok(className, `${status} 应有配色`);
    classes.add(className);
  }
  assert.equal(classes.size, 4, "四态配色必须互不相同");
  assert.equal(boardStatusDotClassName(null), null);
  assert.equal(boardStatusDotClassName("some-future-status"), null);
});

/**
 * 段位词条映射（评审 S5：en-US 界面出现中文段位）。
 * 期望值的独立真源：契约 §13.1 七段位词表（与 schema v2.1 / `lib/derive.mjs` 同源）。
 * 中文侧必须逐字等于契约词表（界面术语即契约术语）；英文侧不得漏中文（S5 的病）。
 */
const STAGE_VALUES = ["待设计", "待办", "执行中", "审核中", "阻塞", "已完成", "已取消"] as const;

test("七段位中文词条逐字（契约 §13.1）", () => {
  for (const stage of STAGE_VALUES) {
    assert.equal(formatBoardStageText(stage, t), stage, `${stage} 的中文词条应逐字等于段位词`);
  }
});

test("七段位英文词条齐备且不含中文（评审 S5）", () => {
  const labels = STAGE_VALUES.map((stage) => formatBoardStageText(stage, tEn));
  for (const [index, label] of labels.entries()) {
    assert.ok(label && label.trim().length > 0, `${STAGE_VALUES[index]} 缺英文词条`);
    assert.ok(
      label !== null && !/[\u4e00-\u9fff]/.test(label),
      `${STAGE_VALUES[index]} 的英文词条漏了中文：${label}`,
    );
  }
  assert.equal(new Set(labels).size, STAGE_VALUES.length, "七个英文段位名必须互异");
});

test("段位缺省/不认识：null 不渲染徽章，未知段位原样透出（不吞字段、不自造词）", () => {
  assert.equal(formatBoardStageText(null, t), null);
  assert.equal(formatBoardStageText("未来段位", t), "未来段位");
});

test("来源行的键枚举与词条表同模块：呈现叶子不反依赖弹窗 VM（评审 S6）", () => {
  const source = readFileSync(
    new URL("../src/board/boardPresentation.ts", import.meta.url),
    "utf8",
  );
  assert.doesNotMatch(
    source,
    /boardDialogViewModel/,
    "呈现层叶子不得 import 弹窗 VM（否则加一个 origin 键要跨两模块改两处）",
  );
  assert.deepEqual(
    Object.keys(BOARD_ORIGIN_MESSAGE_IDS),
    [...BOARD_DIALOG_ORIGIN_KEYS],
    "词条表与键枚举同址：键集必须逐项对齐（`Record<…>` 穷尽，加键在编译期报缺）",
  );
});

test("陈旧判定（契约 §5 应用侧轻量版）：updatedAt 距今超 24 小时才提示；没有时间戳不猜", () => {
  const updatedAt = "2026-10-09T16:05:00+08:00";
  const later = (offsetHours: number) => Date.parse(updatedAt) + offsetHours * 60 * 60 * 1000;
  assert.equal(isBoardStale(updatedAt, later(23)), false, "未超阈值不提示");
  assert.equal(isBoardStale(updatedAt, later(24)), false, "恰在阈值上不提示（严格大于）");
  assert.equal(isBoardStale(updatedAt, later(25)), true);
  assert.equal(isBoardStale(null, later(25)), false, "缺 updatedAt 不猜陈旧");
  assert.equal(isBoardStale("不是时间", later(25)), false, "解析不了不猜陈旧");

  const hint = formatBoardStaleHint(updatedAt, later(25), t);
  assert.ok(hint?.startsWith("板可能已过期"), `陈旧提示文案：${hint}`);
  assert.ok(hint?.includes("建议在会话内重新编译板"), "提示要给出可做的动作");
  assert.ok(hint?.includes(formatBoardRunTime(updatedAt)), "提示带板的更新时间");
  assert.equal(formatBoardStaleHint(updatedAt, later(1), t), null, "未超阈值无提示");
  const hintEn = formatBoardStaleHint(updatedAt, later(25), tEn);
  assert.ok(hintEn && !/[\u4e00-\u9fff]/.test(hintEn), `en-US 陈旧提示漏中文：${hintEn}`);
});

test("视图/过滤/排序词条两语齐（引用了的键不得只在一边存在）", () => {
  const ids = [
    ...STAGE_VALUES.map((stage) => BOARD_STAGE_MESSAGE_IDS[stage]),
    ...BOARD_STATUS_VALUES.map((status) => BOARD_STATUS_MESSAGE_IDS[status]),
    ...BOARD_ATTENTION_CODES.map((code) => BOARD_ATTENTION_LABEL_MESSAGE_IDS[code]),
    "board.view.tree",
    "board.view.kanban",
    "board.view.list",
    "board.kanban.interviewSummary",
    "board.kanban.unplaced",
    "board.list.filters",
    "board.list.empty",
    "board.filter.stage",
    "board.filter.status",
    "board.filter.attention",
    "board.filter.kind",
    "board.kind.feature",
    "board.kind.task",
    "board.filter.sort",
    "board.filter.all",
    "board.sort.recent",
    "board.sort.oldest",
    // 卡 #34：表格列头与卡龄、卡片弹窗区块。
    "board.view.table",
    "board.table.columns",
    "board.age.days",
    ...BOARD_TABLE_COLUMNS.map((key) => BOARD_TABLE_COLUMN_MESSAGE_IDS[key]),
    ...BOARD_DIALOG_ORIGIN_KEYS.map((key) => BOARD_ORIGIN_MESSAGE_IDS[key]),
    "board.dialog.close",
    "board.dialog.jump",
    "board.dialog.detailsTitle",
    "board.dialog.blockersTitle",
    // #55 S-7：随 B5 区块改名（「最近执行」→「执行摘要」），键清单跟随在用键。
    "board.dialog.executionTitle",
    "board.dialog.originTitle",
    "board.dialog.evidenceTitle",
    "board.dialog.timestampsTitle",
    "board.dialog.prTitle",
    "board.dialog.createdAt",
    "board.dialog.updatedAt",
    // 卡 #35：暂时不可读与陈旧提示（评审 #32-P3 / 契约 §5 勘误）。
    "board.unavailable",
    "board.stale.hint",
  ];
  for (const id of ids) {
    assert.ok(zhCN[id], `缺 zh-CN 词条：${id}`);
    assert.ok(enUS[id], `缺 en-US 词条：${id}`);
  }
  // 英文过滤标签也不得漏中文（S5 同款判据）。
  for (const code of BOARD_ATTENTION_CODES) {
    const label = enUS[BOARD_ATTENTION_LABEL_MESSAGE_IDS[code]] ?? "";
    assert.ok(!/[\u4e00-\u9fff]/.test(label), `en-US 缺口短标签漏中文：${label}`);
  }
});
