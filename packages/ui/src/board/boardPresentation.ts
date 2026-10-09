/**
 * 看板呈现层纯函数（卡 #32）。
 *
 * 契约逐字文案的落点：`.zcode/board/board-consumption-contract.md` §3.1/§3.3/§4。
 * 词条 id 在 zh-CN / en-US 词条表；本模块只做「字段 → 文案/样式」的映射，不做状态推导。
 */
import type { BoardAttentionCode, BoardAttentionSummary, BoardLastRun } from "./boardViewModel.js";

export type BoardMessageFormatter = (
  descriptor: { id: string },
  values?: Record<string, string | number>,
) => string;

/** 四缺口码 → 徽章词条（文案逐字，契约 §4）。 */
export const BOARD_ATTENTION_BADGE_IDS: Record<BoardAttentionCode, string> = {
  "interviewed-not-arranged": "board.attention.interviewedNotArranged",
  "arranged-not-expanded": "board.attention.arrangedNotExpanded",
  "interrupted-resume": "board.attention.interruptedResume",
  "unmerged-worktree": "board.attention.unmergedWorktree",
};

/** 提示条四段词条（文案逐字，契约 §3.1）。 */
export const BOARD_ATTENTION_SUMMARY_IDS = [
  ["interviewedNotArranged", "board.attention.summary.interviewedNotArranged"],
  ["arrangedNotExpanded", "board.attention.summary.arrangedNotExpanded"],
  ["interruptedResume", "board.attention.summary.interruptedResume"],
  ["unmergedWorktree", "board.attention.summary.unmergedWorktree"],
] as const satisfies ReadonlyArray<readonly [keyof BoardAttentionSummary, string]>;

const BOARD_RUN_TIME_FORMAT = new Intl.DateTimeFormat(undefined, {
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
});

/** 卡片密排行里的短时间戳；解析不了就原样透出，不吞字段。 */
export function formatBoardRunTime(at: string): string {
  const epochMs = Date.parse(at);
  if (!Number.isFinite(epochMs)) return at;
  return BOARD_RUN_TIME_FORMAT.format(new Date(epochMs));
}

/**
 * 卡片缺口徽章文案（契约 §4）。
 * `interrupted-resume` 的 `#N` 用该卡 `lastRun.stoppedAt` 替换；缺断点时不编造号。
 */
export function formatAttentionBadgeText(
  code: BoardAttentionCode,
  lastRun: BoardLastRun | null,
  formatMessage: BoardMessageFormatter,
): string {
  if (code === "interrupted-resume") {
    const stoppedAt = lastRun?.stoppedAt ?? null;
    if (stoppedAt === null) {
      return formatMessage({ id: "board.attention.interruptedResumeNoBreakpoint" });
    }
    return formatMessage({ id: BOARD_ATTENTION_BADGE_IDS[code] }, { no: stoppedAt });
  }
  return formatMessage({ id: BOARD_ATTENTION_BADGE_IDS[code] });
}

/** 置顶提示条全文（契约 §3.1 逐字；四段都用当前计数渲染）。 */
export function formatAttentionSummaryText(
  summary: BoardAttentionSummary,
  formatMessage: BoardMessageFormatter,
): string {
  return BOARD_ATTENTION_SUMMARY_IDS.map(([key, id]) =>
    formatMessage({ id }, { count: summary[key] }),
  ).join(" · ");
}

/**
 * 最近执行行（契约 §3.3 四要素）：`<时间> · <result> · 停在 #N · <下一步摘要>`。
 * `lastRun` 为 null 时不渲染该行；缺断点/摘要的段整体省略，不编造。
 */
export function formatBoardLastRunText(
  lastRun: BoardLastRun | null,
  formatMessage: BoardMessageFormatter,
): string | null {
  if (!lastRun) return null;
  const parts: string[] = [];
  if (lastRun.at) parts.push(formatBoardRunTime(lastRun.at));
  if (lastRun.result) parts.push(lastRun.result);
  if (lastRun.stoppedAt !== null) {
    parts.push(formatMessage({ id: "board.lastRun.stoppedAt" }, { no: lastRun.stoppedAt }));
  }
  if (lastRun.next) parts.push(lastRun.next);
  return parts.length > 0 ? parts.join(" · ") : null;
}

/** 执行角色徽记：显示字段，不新增状态词汇（契约 §3.3）。 */
export function formatBoardActiveRunText(
  role: string,
  formatMessage: BoardMessageFormatter,
): string {
  return formatMessage({ id: "board.activeRun" }, { role });
}

/** status 四态配色（词汇与 progress.json 完全一致，契约 §3.2）。 */
export function boardStatusDotClassName(status: string | null): string | null {
  switch (status) {
    case "pending":
      return "bg-foreground-subtlest";
    case "active":
      return "bg-primary";
    case "blocked":
      return "bg-destructive";
    case "completed":
      return "bg-success";
    default:
      return null;
  }
}

/** 卡片缩进层级 = label 段数 - 1；未领号卡按第二层（契约 §3.3）。 */
export function boardTaskLabelIndentLevel(label: string | null): number {
  if (!label) return 1;
  const segments = label.split(".").filter((segment) => segment.length > 0);
  return Math.max(1, segments.length) - 1;
}
