/**
 * 看板四视图共用的节点零件（卡 #33；卡 #35 增 `BoardNodeBadges` 角标簇单点装配）。
 *
 * 单点纪律：段位徽章 / 状态色点 / 缺口徽章 / 编号角标 / 角标簇在树形、看板、列表、弹窗
 * 各处**同一实现**—— 文案与 data 锚点只此一份，视图层只决定摆在哪（契约 §13.2 各格要求的呈现元素）。
 */
import { Badge } from "@/components/ui/badge.js";
import { cn } from "@/components/lib/utils.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import {
  boardStatusDotClassName,
  formatAttentionBadgeText,
  formatBoardActiveRunText,
  formatBoardFeatureId,
  formatBoardNodeId,
  formatBoardStageText,
} from "./boardPresentation.js";
import type { BoardAttentionCode, BoardLastRun } from "./boardViewModel.js";

/** 段位徽章：可见文本走词条（评审 S5），`data-board-stage` 保留字段原值（锚点不本地化）。 */
export function BoardStageBadge({ stage }: { stage: string | null }) {
  const { intl } = useZCodeIntl();
  const label = formatBoardStageText(stage, intl.formatMessage);
  if (label === null) return null;
  return (
    <Badge variant="secondary" data-board-stage={stage} className="shrink-0">
      {label}
    </Badge>
  );
}

/** status 四态色点（词汇与 progress.json 完全一致，契约 §3.2；未知状态不猜色）。 */
export function BoardStatusDot({ status }: { status: string | null }) {
  const className = boardStatusDotClassName(status);
  if (!className) return null;
  return (
    <span
      data-board-status={status}
      aria-hidden="true"
      className={cn("size-2 shrink-0 rounded-full", className)}
    />
  );
}

/** 四缺口码徽章（文案逐字，契约 §4；`interrupted-resume` 的 #N 取自该卡 lastRun.stoppedAt）。 */
export function BoardAttentionBadges({
  attention,
  lastRun,
}: {
  attention: BoardAttentionCode[];
  lastRun: BoardLastRun | null;
}) {
  const { intl } = useZCodeIntl();
  return (
    <>
      {attention.map((code) => (
        <Badge
          key={code}
          variant="outline"
          data-board-attention={code}
          className="border-warning/40 bg-warning/10 text-warning"
        >
          {formatAttentionBadgeText(code, lastRun, intl.formatMessage)}
        </Badge>
      ))}
    </>
  );
}

/**
 * 编号（#46 B1）：`计划码-层级`（如 UI01-1.2）/ 无计划码 `ID-<label>`；`short`（同一计划
 * 分组内：树形/列表/表格）只显示层级（1.2）。`no`/`label` 缺省是合法形态 → 「未领号」角标
 * （契约 §3.3）；`data-board-node-id` 锚点携带最终形态文本（测试与定位不绑 CSS 类）。
 */
export function BoardNodeNumber({
  no,
  label,
  planCode = null,
  short = false,
  variant = "task",
}: {
  no: number | null;
  label: string | null;
  planCode?: string | null;
  short?: boolean;
  /** "task"（默认）：计划码-层级 / ID-<label>；"feature"：计划码本身（UI01）/ ID-<label>。 */
  variant?: "task" | "feature";
}) {
  const { intl } = useZCodeIntl();
  const text =
    variant === "feature"
      ? formatBoardFeatureId({ no, label, planCode })
      : formatBoardNodeId({ no, label, planCode }, { short });
  if (text === null) {
    return (
      <Badge variant="outline" data-board-unassigned="" className="shrink-0">
        {intl.formatMessage({ id: "board.unassigned" })}
      </Badge>
    );
  }
  return (
    <span
      data-board-node-id={text}
      className="shrink-0 font-mono text-ui-xs text-foreground-subtle"
    >
      {text}
    </span>
  );
}

/** `draft: true` → 「草案」角标；`blockers` 非空 → 「受阻 N」（契约 §3.3）。 */
export function BoardDraftBadge() {
  const { intl } = useZCodeIntl();
  return (
    <Badge variant="secondary" data-board-draft="" className="shrink-0">
      {intl.formatMessage({ id: "board.draft" })}
    </Badge>
  );
}

export function BoardBlockerBadge({ count }: { count: number }) {
  const { intl } = useZCodeIntl();
  if (count <= 0) return null;
  return (
    <Badge variant="outline" data-board-blockers={count} className="shrink-0">
      {intl.formatMessage({ id: "board.blockedByCount" }, { count })}
    </Badge>
  );
}

/** 执行角色徽记（标记 `data-board-active-run`，与表格的 `activeRun` 列同源字段）。 */
export function BoardActiveRunBadge({ role }: { role: string }) {
  const { intl } = useZCodeIntl();
  return (
    <Badge variant="secondary" data-board-active-run={role} className="shrink-0">
      {formatBoardActiveRunText(role, intl.formatMessage)}
    </Badge>
  );
}

/**
 * 卡片角标簇（四视图共用，评审 #33-S3）：草案 → 缺口徽章 → 受阻 N → 执行角色 → 状态点。
 * 单点必要性：树形/看板/列表/弹窗各自拼一遍，四份的**顺序与取舍**早晚对不上
 * （角标属于节点自身字段，视图差异只在摆放位置）。段位徽章与编号不在簇内
 * ——它们在各视图的位置不同（行首/行尾），由视图自行摆放。
 */
export function BoardNodeBadges({
  attention,
  blockers,
  lastRun,
  draft,
  activeRunRole,
  status,
}: {
  attention: BoardAttentionCode[];
  /** 节点自身的 blockers（特性级照实传；不借子树的值）。 */
  blockers: number;
  lastRun: BoardLastRun | null;
  draft: boolean;
  activeRunRole: string | null;
  status: string | null;
}) {
  return (
    <span data-board-badges="" className="flex min-w-0 flex-wrap items-center gap-1">
      {draft ? <BoardDraftBadge /> : null}
      <BoardAttentionBadges attention={attention} lastRun={lastRun} />
      <BoardBlockerBadge count={blockers} />
      {activeRunRole ? <BoardActiveRunBadge role={activeRunRole} /> : null}
      <BoardStatusDot status={status} />
    </span>
  );
}
