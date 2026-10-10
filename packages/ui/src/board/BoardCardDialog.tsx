/**
 * 卡片弹窗（卡 #34；卡 #46 / 规则书 v2 B5 改造）：只读，全部字段来自被点卡片自身。
 *
 * 结构（#46 B5 区块重排）：标题 → 状态/缺口 → **阻碍（突出）** → **执行摘要**（最近执行四要素 +
 * 责任管线，当前执行者高亮）→ 细节（空串隐藏）→ 来源 → 证据路径 → PR（null 隐藏）→ **时间戳（底部小字）**。
 * 信息精简（B5）：去草案徽章、状态色点去重（段位徽章已含状态）、路径截断（basename + `title` 全路径）、
 * 时间相对化（"3 小时前"）。
 * 定位（B5）：overlay = **面板容器内 absolute**（`<div data-board-pane>` 是 relative 定位上下文），
 * 不再是 `fixed inset-0` 的全局遮罩。
 * 关闭路径：× 与遮罩在壳内（点即关），Esc 由宿主消费纯函数 `boardCardDialogKeyIntent`
 * ——壳内不判第二遍键位（同 `WorkItemMobileSheet` 的既有纪律）。
 *
 * 为什么不用 radix `Dialog`：本面板的渲染缝是 SSR（`react-dom/server`，卡 #32/#33 建立），
 * portal 里的弹窗内容在该缝里不可见；弹窗正文恰是本卡的交付主体，必须可断言。
 * 表单元素与配色仍走既有零件与语义 token（`bg-popover` / `border-popover-border` / `rounded-2xl`
 * / `shadow-md`，DESIGN.md 弹窗外壳规范）。
 */
import type { ReactNode } from "react";
import { XIcon } from "lucide-react";
import { Badge } from "@/components/ui/badge.js";
import { Button } from "@/components/ui/button.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import {
  buildBoardCardDialog,
  BOARD_ORIGIN_MESSAGE_IDS,
  type BoardDialogBlocker,
  type BoardDialogJumpTarget,
} from "./boardDialogViewModel.js";
import {
  BoardAssigneePipeline,
  BoardNodeBadges,
  BoardNodeNumber,
  BoardStageBadge,
} from "./boardNodeParts.js";
import {
  formatBoardLastRunText,
  formatBoardPathTail,
  formatBoardRelativeTime,
  formatBoardRunTime,
  formatBoardStatusText,
} from "./boardPresentation.js";
import type { BoardViewNode } from "./boardViewsViewModel.js";
import type { BoardViewModel } from "./boardViewModel.js";

export interface BoardCardDialogProps {
  board: BoardViewModel;
  node: BoardViewNode;
  /** 关闭（× / 遮罩 / 宿主消费的 Esc）。 */
  onClose?: () => void;
  /** 依赖跳转（滚动到目标卡并高亮，由宿主执行）。 */
  onJumpToCard?: (target: BoardDialogJumpTarget) => void;
  /** 相对时间的「现在」（毫秒）；缺省取渲染时刻（测试注入固定值）。 */
  now?: number;
}

/** 区块壳：标题 + 内容，`data-board-dialog-section` 是呈现锚点（不含判据）。 */
function DialogSection({
  name,
  title,
  className,
  children,
}: {
  name: string;
  title: string;
  className?: string;
  children: ReactNode;
}) {
  return (
    <section
      data-board-dialog-section={name}
      className={className ?? "flex flex-col gap-1 border-t border-border/50 px-3 py-2"}
    >
      <h3 className="text-ui-xs font-medium text-foreground-subtle">{title}</h3>
      {children}
    </section>
  );
}

/**
 * 路径行（B5 路径截断）：可见文本 = 文件名，`title` = 原路径（悬停可查、信息不丢）。
 * `select-all` 便于整段复制。
 */
function PathText({ path, anchor, index }: { path: string; anchor?: string; index?: number }) {
  return (
    <span
      {...(anchor ? { [anchor]: index ?? "" } : {})}
      title={path}
      className="select-all font-mono text-ui-xs break-all text-foreground-subtle"
    >
      {formatBoardPathTail(path)}
    </span>
  );
}

/** 证据路径行列表（B5 路径截断）。 */
function EvidenceList({ paths }: { paths: string[] }) {
  return (
    <ul className="flex flex-col gap-0.5">
      {paths.map((path, index) => (
        <li key={`${index}:${path}`}>
          <PathText path={path} anchor="data-board-dialog-evidence" index={index} />
        </li>
      ))}
    </ul>
  );
}

function DialogBlockerRow({
  blocker,
  onJumpToCard,
}: {
  blocker: BoardDialogBlocker;
  onJumpToCard?: (target: BoardDialogJumpTarget) => void;
}) {
  const { intl } = useZCodeIntl();
  const target = blocker.target;
  return (
    <div
      data-board-dialog-blocker={blocker.index}
      data-board-dialog-blocker-kind={blocker.kind}
      className="flex flex-col gap-1 rounded-lg bg-surface px-2 py-1.5"
    >
      <div className="flex min-w-0 flex-wrap items-center gap-1.5">
        <Badge variant="outline" className="shrink-0">
          {blocker.kind}
        </Badge>
        {target && blocker.targetText ? (
          <span className="shrink-0 font-mono text-ui-xs text-foreground-subtle">
            {blocker.targetText}
          </span>
        ) : null}
        {blocker.kind === "dependency" ? (
          <Button
            type="button"
            size="xs"
            variant="secondary"
            data-board-dialog-jump=""
            {...(target ? { "data-board-dialog-jump-target": target.id } : {})}
            disabled={!target}
            onClick={() => {
              if (target && onJumpToCard) onJumpToCard(target);
            }}
          >
            {intl.formatMessage({ id: "board.dialog.jump" })}
          </Button>
        ) : null}
      </div>
      {/* 缺 summary 时给一个中性占位符：不留空行，也不编造文案。 */}
      <p className="text-ui-sm text-foreground">{blocker.summary ?? "—"}</p>
      {blocker.evidence.length > 0 ? (
        <div data-board-dialog-blocker-evidence={blocker.index}>
          <EvidenceList paths={blocker.evidence} />
        </div>
      ) : null}
    </div>
  );
}

export function BoardCardDialog({ board, node, onClose, onJumpToCard, now }: BoardCardDialogProps) {
  const { intl } = useZCodeIntl();
  const t = (id: string) => intl.formatMessage({ id });
  const ageBase = now ?? Date.now();
  const relativeTime = (at: string) =>
    formatBoardRelativeTime(at, ageBase, intl.formatMessage) ?? formatBoardRunTime(at);
  const dialog = buildBoardCardDialog(board, node);
  const statusText = formatBoardStatusText(dialog.status, intl.formatMessage);
  const lastRunText = formatBoardLastRunText(dialog.lastRun, intl.formatMessage, {
    formatTime: relativeTime,
  });
  const close = onClose ?? (() => {});
  return (
    <div
      data-board-dialog-root=""
      className="absolute inset-0 z-50 flex items-start justify-center overflow-y-auto p-4"
    >
      {/* 遮罩：鼠标/触摸的关闭路径（键盘一路是 Esc，判据在宿主的纯函数里）。 */}
      <div
        data-board-dialog-scrim=""
        aria-hidden="true"
        className="absolute inset-0 bg-black/60"
        onClick={close}
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-label={dialog.title}
        data-board-dialog={dialog.id}
        className="relative my-auto flex max-h-[85vh] w-full max-w-[26rem] flex-col overflow-hidden rounded-2xl border border-popover-border bg-popover text-ui-base/relaxed text-foreground shadow-md"
      >
        <div data-board-dialog-section="header" className="flex items-start gap-2 px-3 py-2">
          <BoardNodeNumber no={dialog.no} label={dialog.label} planCode={node.planCode} />
          <span className="min-w-0 flex-1 text-ui-sm font-medium text-foreground">
            {dialog.title}
          </span>
          <Button
            autoFocus
            type="button"
            size="icon-sm"
            variant="ghost"
            data-board-dialog-close="button"
            aria-label={t("board.dialog.close")}
            onClick={close}
          >
            <XIcon className="size-4" />
          </Button>
        </div>
        <div
          data-board-dialog-section="status"
          className="flex flex-wrap items-center gap-1.5 border-t border-border/50 px-3 py-2"
        >
          <BoardStageBadge stage={dialog.stage} />
          {statusText ? (
            <span
              data-board-dialog-status={dialog.status ?? ""}
              className="text-ui-xs text-foreground"
            >
              {statusText}
            </span>
          ) : null}
          {/* B5 精简：draft 徽章不重复（表里已有草案语境）、状态点去重（段位徽章已含状态）。 */}
          <BoardNodeBadges
            attention={dialog.attention}
            blockers={dialog.blockers.length}
            lastRun={dialog.lastRun}
            draft={false}
            activeRunRole={dialog.activeRun?.role ?? null}
            status={dialog.status}
            showStatusDot={false}
          />
        </div>
        {dialog.showBlockers ? (
          // 阻碍（B5 突出）：warning 描边 + 浅底，排在最前（标题之后第一个内容区块）。
          <DialogSection
            name="blockers"
            title={t("board.dialog.blockersTitle")}
            className="flex flex-col gap-1 border-t border-warning/40 bg-warning/5 px-3 py-2"
          >
            {dialog.blockers.map((blocker) => (
              <DialogBlockerRow
                key={blocker.index}
                blocker={blocker}
                {...(onJumpToCard ? { onJumpToCard } : {})}
              />
            ))}
          </DialogSection>
        ) : null}
        {lastRunText || dialog.assignees.length > 0 ? (
          // 执行摘要（B5）：最近执行四要素（相对时间）+ 责任管线（当前执行者高亮）
          <DialogSection name="execution" title={t("board.dialog.executionTitle")}>
            {lastRunText ? (
              <div className="font-mono text-ui-xs text-foreground-subtle">{lastRunText}</div>
            ) : null}
            {dialog.assignees.length > 0 ? (
              <BoardAssigneePipeline
                assignees={dialog.assignees}
                currentAssignee={dialog.currentAssignee}
              />
            ) : null}
          </DialogSection>
        ) : null}
        {dialog.details ? (
          <DialogSection name="details" title={t("board.dialog.detailsTitle")}>
            <p className="text-ui-sm text-foreground">{dialog.details}</p>
          </DialogSection>
        ) : null}
        {dialog.origin.length > 0 ? (
          <DialogSection name="origin" title={t("board.dialog.originTitle")}>
            {dialog.origin.map((row) => (
              <div
                key={row.key}
                data-board-dialog-origin={row.key}
                className="flex min-w-0 items-baseline gap-1.5 text-ui-xs"
              >
                <span className="shrink-0 text-foreground-subtle">
                  {t(BOARD_ORIGIN_MESSAGE_IDS[row.key])}
                </span>
                <PathText path={row.value} />
              </div>
            ))}
          </DialogSection>
        ) : null}
        {dialog.evidence.length > 0 ? (
          <DialogSection name="evidence" title={t("board.dialog.evidenceTitle")}>
            <EvidenceList paths={dialog.evidence} />
          </DialogSection>
        ) : null}
        {dialog.pr ? (
          <DialogSection name="pr" title={t("board.dialog.prTitle")}>
            <div className="flex min-w-0 items-baseline gap-1.5 text-ui-xs">
              {dialog.pr.number !== null ? (
                <span data-board-dialog-pr-number={dialog.pr.number} className="shrink-0 font-mono">
                  #{dialog.pr.number}
                </span>
              ) : null}
              {dialog.pr.url ? (
                <a
                  href={dialog.pr.url}
                  target="_blank"
                  rel="noreferrer"
                  className="min-w-0 break-all text-primary underline"
                >
                  {dialog.pr.url}
                </a>
              ) : null}
            </div>
          </DialogSection>
        ) : null}
        {dialog.createdAt || dialog.updatedAt ? (
          // 时间戳（B5）：底部小字、相对化
          <DialogSection name="timestamps" title={t("board.dialog.timestampsTitle")}>
            {dialog.createdAt ? (
              <div
                data-board-dialog-timestamp="createdAt"
                className="text-ui-xs text-foreground-subtle"
              >
                {t("board.dialog.createdAt")} {relativeTime(dialog.createdAt)}
              </div>
            ) : null}
            {dialog.updatedAt ? (
              <div
                data-board-dialog-timestamp="updatedAt"
                className="text-ui-xs text-foreground-subtle"
              >
                {t("board.dialog.updatedAt")} {relativeTime(dialog.updatedAt)}
              </div>
            ) : null}
          </DialogSection>
        ) : null}
      </div>
    </div>
  );
}
