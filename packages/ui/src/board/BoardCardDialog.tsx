/**
 * 卡片弹窗（卡 #34，消费契约 §6 逐字）：只读，全部字段来自被点卡片自身。
 *
 * 结构（§6 表）：编号+名称 / 状态·缺口 / 细节（空串隐藏）/ 阻拦（external 与 dependency，
 * 目标不在当前板 → 禁用跳转）/ 最近执行 / 来源 / 证据路径 / 时间戳 / PR（null 隐藏）。
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
import { BoardNodeBadges, BoardNodeNumber, BoardStageBadge } from "./boardNodeParts.js";
import {
  formatBoardLastRunText,
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
}

/** 区块壳：标题 + 内容，`data-board-dialog-section` 是呈现锚点（不含判据）。 */
function DialogSection({
  name,
  title,
  children,
}: {
  name: string;
  title: string;
  children: ReactNode;
}) {
  return (
    <section
      data-board-dialog-section={name}
      className="flex flex-col gap-1 border-t border-border/50 px-3 py-2"
    >
      <h3 className="text-ui-xs font-medium text-foreground-subtle">{title}</h3>
      {children}
    </section>
  );
}

/** 证据路径行：展示路径文本（`select-all` 便于整段复制），不承诺编辑器打开（A3 未验证）。 */
function EvidenceList({ paths }: { paths: string[] }) {
  return (
    <ul className="flex flex-col gap-0.5">
      {paths.map((path, index) => (
        <li
          key={`${index}:${path}`}
          data-board-dialog-evidence={index}
          className="select-all font-mono text-ui-xs break-all text-foreground-subtle"
        >
          {path}
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

export function BoardCardDialog({ board, node, onClose, onJumpToCard }: BoardCardDialogProps) {
  const { intl } = useZCodeIntl();
  const t = (id: string) => intl.formatMessage({ id });
  const dialog = buildBoardCardDialog(board, node);
  const statusText = formatBoardStatusText(dialog.status, intl.formatMessage);
  const lastRunText = formatBoardLastRunText(dialog.lastRun, intl.formatMessage);
  const close = onClose ?? (() => {});
  return (
    <div
      data-board-dialog-root=""
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto p-4"
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
          <BoardNodeNumber no={dialog.no} label={dialog.label} />
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
          <BoardNodeBadges
            attention={dialog.attention}
            blockers={dialog.blockers.length}
            lastRun={dialog.lastRun}
            draft={dialog.draft}
            activeRunRole={dialog.activeRun?.role ?? null}
            status={dialog.status}
          />
        </div>
        {dialog.details ? (
          <DialogSection name="details" title={t("board.dialog.detailsTitle")}>
            <p className="text-ui-sm text-foreground">{dialog.details}</p>
          </DialogSection>
        ) : null}
        {dialog.showBlockers ? (
          <DialogSection name="blockers" title={t("board.dialog.blockersTitle")}>
            {dialog.blockers.map((blocker) => (
              <DialogBlockerRow
                key={blocker.index}
                blocker={blocker}
                {...(onJumpToCard ? { onJumpToCard } : {})}
              />
            ))}
          </DialogSection>
        ) : null}
        {lastRunText ? (
          <DialogSection name="lastRun" title={t("board.dialog.lastRunTitle")}>
            <div className="font-mono text-ui-xs text-foreground-subtle">{lastRunText}</div>
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
                <span className="min-w-0 break-all font-mono text-foreground">{row.value}</span>
              </div>
            ))}
          </DialogSection>
        ) : null}
        {dialog.evidence.length > 0 ? (
          <DialogSection name="evidence" title={t("board.dialog.evidenceTitle")}>
            <EvidenceList paths={dialog.evidence} />
          </DialogSection>
        ) : null}
        {dialog.createdAt || dialog.updatedAt ? (
          <DialogSection name="timestamps" title={t("board.dialog.timestampsTitle")}>
            {dialog.createdAt ? (
              <div
                data-board-dialog-timestamp="createdAt"
                className="text-ui-xs text-foreground-subtle"
              >
                {t("board.dialog.createdAt")} {formatBoardRunTime(dialog.createdAt)}
              </div>
            ) : null}
            {dialog.updatedAt ? (
              <div
                data-board-dialog-timestamp="updatedAt"
                className="text-ui-xs text-foreground-subtle"
              >
                {t("board.dialog.updatedAt")} {formatBoardRunTime(dialog.updatedAt)}
              </div>
            ) : null}
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
      </div>
    </div>
  );
}
