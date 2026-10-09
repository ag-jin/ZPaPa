import assert from "node:assert/strict";
import test from "node:test";
import zhCN from "../src/i18n/locales/zh-CN.js";
import {
  boardStatusDotClassName,
  boardTaskLabelIndentLevel,
  formatAttentionBadgeText,
  formatAttentionSummaryText,
  formatBoardLastRunText,
} from "../src/board/boardPresentation.js";
import { hasAttentionSignal, type BoardLastRun } from "../src/board/boardViewModel.js";

/**
 * 看板呈现层的纯函数缝（卡 #32）。
 *
 * 期望值的独立真源：`.zcode/board/board-consumption-contract.md` §2（空态逐字）、
 * §3.1/§4（提示条与四缺口码徽章逐字）、§3.3（lastRun 四要素）。文案一律从 zh-CN 词条表取词，
 * 字面量写在测试里 —— 词条漂移必须让测试红。
 */

const t = (descriptor: { id: string }, values?: Record<string, string | number>) => {
  let message = zhCN[descriptor.id] ?? descriptor.id;
  for (const [key, value] of Object.entries(values ?? {})) {
    message = message.replaceAll(`{${key}}`, String(value));
  }
  return message;
};

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

test("卡片缩进随 label 段数；未领号卡按第二层处理（契约 §3.3）", () => {
  assert.equal(boardTaskLabelIndentLevel("1.2"), 1);
  assert.equal(boardTaskLabelIndentLevel("1.2.3"), 2);
  assert.equal(boardTaskLabelIndentLevel(null), 1);
});
