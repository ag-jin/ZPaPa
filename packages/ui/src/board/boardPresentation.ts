/**
 * 看板呈现层纯函数（卡 #32）。
 *
 * 契约逐字文案的落点：`.zcode/board/board-consumption-contract.md` §3.1/§3.3/§4。
 * 词条 id 在 zh-CN / en-US 词条表；本模块只做「字段 → 文案/样式」的映射，不做状态推导。
 */
import type {
  BoardAttentionCode,
  BoardAttentionSummary,
  BoardLastRun,
  BoardStage,
  BoardStatusValue,
} from "./boardViewModel.js";

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

/**
 * 提示条四段（文案逐字，契约 §3.1）：summary 键 → 缺口码 → 词条 id。顺序即渲染序。
 * 段落级渲染（#32 遗留「提示条点击滚动到对应卡」）从这张表派生：跳转落点按缺口码在板上找节点，
 * 全文仍是同一模板拼出来的（分隔符 ` · `），词条与顺序只有这一份。
 */
export const BOARD_ATTENTION_SUMMARY_ROWS = [
  [
    "interviewedNotArranged",
    "interviewed-not-arranged",
    "board.attention.summary.interviewedNotArranged",
  ],
  ["arrangedNotExpanded", "arranged-not-expanded", "board.attention.summary.arrangedNotExpanded"],
  ["interruptedResume", "interrupted-resume", "board.attention.summary.interruptedResume"],
  ["unmergedWorktree", "unmerged-worktree", "board.attention.summary.unmergedWorktree"],
] as const satisfies ReadonlyArray<
  readonly [keyof BoardAttentionSummary, BoardAttentionCode, string]
>;

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

/** 置顶提示条单段文案（契约 §3.1 逐字；`count` 由调用方从 summary 取）。 */
export function formatAttentionSummarySegment(
  code: BoardAttentionCode,
  count: number,
  formatMessage: BoardMessageFormatter,
): string {
  const row = BOARD_ATTENTION_SUMMARY_ROWS.find((entry) => entry[1] === code);
  return row ? formatMessage({ id: row[2] }, { count }) : "";
}

/** 置顶提示条全文（契约 §3.1 逐字；四段都用当前计数渲染）：段落 + ` · ` 分隔。 */
export function formatAttentionSummaryText(
  summary: BoardAttentionSummary,
  formatMessage: BoardMessageFormatter,
): string {
  return BOARD_ATTENTION_SUMMARY_ROWS.map(([key, code]) =>
    formatAttentionSummarySegment(code, summary[key], formatMessage),
  ).join(" · ");
}

/**
 * 最近执行行（契约 §3.3 四要素）：`<时间> · <result> · 停在 #N · <下一步摘要>`。
 * `lastRun` 为 null 时不渲染该行；缺断点/摘要的段整体省略，不编造。
 */
export function formatBoardLastRunText(
  lastRun: BoardLastRun | null,
  formatMessage: BoardMessageFormatter,
  options: { formatTime?: (at: string) => string } = {},
): string | null {
  if (!lastRun) return null;
  const formatTime = options.formatTime ?? formatBoardRunTime;
  const parts: string[] = [];
  if (lastRun.at) parts.push(formatTime(lastRun.at));
  if (lastRun.result) parts.push(lastRun.result);
  if (lastRun.stoppedAt !== null) {
    parts.push(formatMessage({ id: "board.lastRun.stoppedAt" }, { no: lastRun.stoppedAt }));
  }
  if (lastRun.next) parts.push(lastRun.next);
  return parts.length > 0 ? parts.join(" · ") : null;
}

/* ---------------- 弹窗信息精简（#46 B5） ---------------- */

/**
 * 路径截断（#46 B5「路径截断」）：只显示文件名（basename），目录层级不进弹窗正文；
 * 全路径由视图层放进 `title` 悬停可查，信息不丢失。
 */
export function formatBoardPathTail(path: string): string {
  const trimmed = path.replace(/\/+$/, "");
  const index = trimmed.lastIndexOf("/");
  return index >= 0 ? trimmed.slice(index + 1) : trimmed;
}

/**
 * 相对时间（#46 B5「时间相对化」）：`刚刚 / N 分钟前 / N 小时前 / N 天前`；
 * 超过 30 天回落绝对时间（`formatBoardRunTime`）；解析不了 → null（视图层回退原值，不编造）。
 * 纯函数：`now` 由调用方传入，同一屏内一致；时钟回拨（未来时间）按「刚刚」。
 */
export function formatBoardRelativeTime(
  at: string,
  now: number,
  formatMessage: BoardMessageFormatter,
): string | null {
  const epochMs = Date.parse(at);
  if (!Number.isFinite(epochMs)) return null;
  const delta = now - epochMs;
  if (delta < 60_000) return formatMessage({ id: "board.relative.justNow" });
  const minutes = Math.floor(delta / 60_000);
  if (minutes < 60) return formatMessage({ id: "board.relative.minutes" }, { count: minutes });
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return formatMessage({ id: "board.relative.hours" }, { count: hours });
  const days = Math.floor(hours / 24);
  if (days < 30) return formatMessage({ id: "board.relative.days" }, { count: days });
  return formatBoardRunTime(at);
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

/**
 * 七段位 → 词条（契约 §13.1；`Record<BoardStage, …>` 穷尽：词表加值会在编译期报缺，
 * 而不是界面上露出裸段位词）。zh-CN 词条逐字等于契约词表，en-US 走英文词条（评审 S5）。
 */
export const BOARD_STAGE_MESSAGE_IDS: Record<BoardStage, string> = {
  待设计: "board.stage.design",
  待办: "board.stage.todo",
  执行中: "board.stage.running",
  审核中: "board.stage.review",
  阻塞: "board.stage.blocked",
  已完成: "board.stage.done",
  已取消: "board.stage.cancelled",
};

/** status 枚举 → 词条（过滤控件用；`status` 四态 + v2.1 `cancelled`）。 */
export const BOARD_STATUS_MESSAGE_IDS: Record<BoardStatusValue, string> = {
  pending: "board.status.pending",
  active: "board.status.active",
  blocked: "board.status.blocked",
  completed: "board.status.completed",
  cancelled: "board.status.cancelled",
};

/** 四缺口码的**短标签**（过滤控件用；徽章仍走 §4 逐字文案，两者用途不同）。 */
export const BOARD_ATTENTION_LABEL_MESSAGE_IDS: Record<BoardAttentionCode, string> = {
  "interviewed-not-arranged": "board.attention.label.interviewedNotArranged",
  "arranged-not-expanded": "board.attention.label.arrangedNotExpanded",
  "interrupted-resume": "board.attention.label.interruptedResume",
  "unmerged-worktree": "board.attention.label.unmergedWorktree",
};

/**
 * 段位徽章/列头文案。零映射（缺段位）不渲染；不认识的新段位原样透出
 * —— 与 `formatBoardRunTime` 同款「不吞字段、不自造词」姿态（契约 §13.6：应用侧不得自算段位）。
 */
export function formatBoardStageText(
  stage: string | null,
  formatMessage: BoardMessageFormatter,
): string | null {
  if (stage === null) return null;
  const messageId = BOARD_STAGE_MESSAGE_IDS[stage as BoardStage];
  if (!messageId) return stage;
  return formatMessage({ id: messageId });
}

/** 卡片缩进层级 = label 段数 - 1；未领号卡按第二层（契约 §3.3）。 */
export function boardTaskLabelIndentLevel(label: string | null): number {
  if (!label) return 1;
  const segments = label.split(".").filter((segment) => segment.length > 0);
  return Math.max(1, segments.length) - 1;
}

/* ---------------- 编号形态（#46 B1：计划码-层级） ---------------- */

/**
 * 编号显示形态（#46 B1，规则书 v2）：
 *   - 完整形态：有计划码 → `<计划码>-<层级>`（如 `UI01-1.2`）；无计划码 → `ID-<label>`；
 *   - 短形态（`short: true`，树形/列表/表格在**同一计划分组内**）：只显示层级（如 `1.2`）；
 *     无计划码时没有前缀可省，形态不变；
 *   - 降级链：缺 label → `ID-<稳定号>`（§2.4 过渡态）；未领号 → null（组件渲染「未领号」角标）。
 * 纯函数：字段原值取出入，不做任何推导（计划码合法性在映射层已收敛）。
 */
export function formatBoardNodeId(
  node: { no: number | null; label: string | null; planCode?: string | null },
  options: { short?: boolean } = {},
): string | null {
  const planCode = node.planCode ?? null;
  if (node.label != null) {
    if (planCode != null) return options.short === true ? node.label : `${planCode}-${node.label}`;
    return `ID-${node.label}`;
  }
  return node.no !== null ? `ID-${node.no}` : null;
}

/**
 * 特性编号形态（#46 B1）：有计划码 → 计划码本身（`UI01`，它就是计划的身份）；
 * 否则与节点编号同链（`ID-<label>` → `ID-<no>` → null）。
 */
export function formatBoardFeatureId(node: {
  no: number | null;
  label: string | null;
  planCode?: string | null;
}): string | null {
  return node.planCode ?? formatBoardNodeId(node);
}

/**
 * 卡龄 = `updatedAt` 距 `now` 的整天数（floor）。缺字段/解析不了 → null（没有卡龄信号）；
 * 时钟回拨（未来时间）按 0 天，不出现负数。纯函数：`now` 由调用方传入，同一屏内一致。
 */
export function boardCardAgeDays(updatedAt: string | null, now: number): number | null {
  if (!updatedAt) return null;
  const epochMs = Date.parse(updatedAt);
  if (!Number.isFinite(epochMs)) return null;
  return Math.max(0, Math.floor((now - epochMs) / (24 * 60 * 60 * 1000)));
}

/** 卡龄文案（表格「卡龄」列）：`N 天`；没有卡龄信号 → null（空单元格）。 */
export function formatBoardCardAge(
  updatedAt: string | null,
  now: number,
  formatMessage: BoardMessageFormatter,
): string | null {
  const days = boardCardAgeDays(updatedAt, now);
  return days === null ? null : formatMessage({ id: "board.age.days" }, { days });
}

/**
 * status 文案（表格「状态」列 + 过滤控件）：与 `formatBoardStageText` 同款姿态
 * —— null 不渲染；不认识的新状态原样透出（不吞字段、不自造词）。
 */
export function formatBoardStatusText(
  status: string | null,
  formatMessage: BoardMessageFormatter,
): string | null {
  if (status === null) return null;
  const messageId = BOARD_STATUS_MESSAGE_IDS[status as BoardStatusValue];
  if (!messageId) return status;
  return formatMessage({ id: messageId });
}

/* ---------------- 陈旧检测（契约 §5 的应用侧轻量版） ---------------- */

/**
 * 陈旧阈值：`updatedAt` 距当前超过 24 小时即提示「板可能已过期」。
 *
 * 契约 §5 原文要求「比对 `sources[]` 各文件 mtime 与 `updatedAt`」，但那需要逐条 fs stat；
 * 应用侧的读取缝只有「存在性 + 读文本」，本期**不发明 fs 通道**（契约 §5 勘误一行，
 * 见 `.zcode/board/board-consumption-contract.md` §5），改为纯时间启发式：
 * 板是活动物（本工作区的板按会话重编译），跨天没动过就该提醒重编译。
 */
export const BOARD_STALE_AFTER_MS = 24 * 60 * 60 * 1000;

/** 陈旧判定：`updatedAt` 解析不了（没有信号）→ false，不编造陈旧。 */
export function isBoardStale(updatedAt: string | null, now: number): boolean {
  if (!updatedAt) return false;
  const epochMs = Date.parse(updatedAt);
  if (!Number.isFinite(epochMs)) return false;
  return now - epochMs > BOARD_STALE_AFTER_MS;
}

/**
 * 陈旧提示行文案（契约 §5 的「可能已过期」角标的轻量呈现：一行提示，不是错误态，
 * 不改变既有内容渲染）。`updatedAt` 缺省/解析不了 → null（不提示）。
 */
export function formatBoardStaleHint(
  updatedAt: string | null,
  now: number,
  formatMessage: BoardMessageFormatter,
): string | null {
  if (!updatedAt || !isBoardStale(updatedAt, now)) return null;
  return formatMessage({ id: "board.stale.hint" }, { time: formatBoardRunTime(updatedAt) });
}
