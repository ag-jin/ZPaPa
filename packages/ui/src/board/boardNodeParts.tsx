/**
 * 看板三视图共用的节点零件（卡 #33）。
 *
 * 单点纪律：段位徽章 / 状态色点 / 缺口徽章 / 编号角标在树形、看板、列表三处**同一实现**
 * —— 文案与 data 锚点只此一份，视图层只决定摆在哪（契约 §13.2 各格要求的呈现元素）。
 */
import { Badge } from "@/components/ui/badge.js";
import { cn } from "@/components/lib/utils.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import {
  boardStatusDotClassName,
  formatAttentionBadgeText,
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

/** 编号：`ID-<label>`；`no`/`label` 缺省是合法形态 → 「未领号」角标（契约 §3.3）。 */
export function BoardNodeNumber({ no, label }: { no: number | null; label: string | null }) {
  const { intl } = useZCodeIntl();
  const text = label ? `ID-${label}` : no !== null ? `ID-${no}` : null;
  if (text === null) {
    return (
      <Badge variant="outline" className="shrink-0">
        {intl.formatMessage({ id: "board.unassigned" })}
      </Badge>
    );
  }
  return <span className="shrink-0 font-mono text-ui-xs text-foreground-subtle">{text}</span>;
}

/** `draft: true` → 「草案」角标；`blockers` 非空 → 「受阻 N」（契约 §3.3）。 */
export function BoardDraftBadge() {
  const { intl } = useZCodeIntl();
  return (
    <Badge variant="secondary" className="shrink-0">
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
