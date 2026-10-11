/**
 * 卡片弹窗（卡 #34；卡 #46 / 规则书 v2 B5 改造）：只读，全部字段来自被点卡片自身。
 *
 * 结构（#46 B5 区块重排）：标题 → 状态/缺口 → **阻碍（突出）** → **执行摘要**（最近执行四要素 +
 * 责任管线，当前执行者高亮）→ 细节（空串隐藏）→ 来源 → 证据路径 → PR（null 隐藏）→ **时间戳（底部小字）**。
 * 信息精简（B5）：去草案徽章、状态色点去重（段位徽章已含状态）、路径截断（basename + `title` 全路径）、
 * 时间相对化（"3 小时前"）。
 * 外壳（定位/遮罩/`role=dialog`/Tab 回绕）与区块壳走共用单点 `BoardDialogShell`（#90/A4-4 抽出，
 * 与 epic 弹窗同一份）；关闭路径 × 与遮罩在壳内（点即关），Esc 由宿主消费纯函数
 * `boardCardDialogKeyIntent`。焦点闭环（#59 M4）：关闭后焦点恢复到打开者在宿主 `BoardPane`。
 */
import { XIcon } from "lucide-react";
import { Badge } from "@/components/ui/badge.js";
import { Button } from "@/components/ui/button.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { BoardDialogShell, DialogSection } from "./BoardDialogShell.js";
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

/**
 * 路径行（B5 路径截断）：可见文本 = 文件名，`title` = 原路径（悬停可查、信息不丢）。
 * `select-all` 便于整段复制。
 *
 * `evidenceIndex`（#55 S-6）：显式 prop → 固定 `data-board-dialog-evidence` 锚点
 * （不再用动态属性键 `{ [anchor]: … }` 装配：调用点一眼看清锚点名，少一层间接）。
 */
function PathText({ path, evidenceIndex }: { path: string; evidenceIndex?: number }) {
  return (
    <span
      {...(evidenceIndex !== undefined ? { "data-board-dialog-evidence": evidenceIndex } : {})}
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
          <PathText path={path} evidenceIndex={index} />
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
      // 首个圆角内容容器从 rounded-xl 起（#59 N1；DESIGN.md Dialog 层级：外壳不计入内容层级）。
      className="flex flex-col gap-1 rounded-xl bg-surface px-2 py-1.5"
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
    <BoardDialogShell
      ariaLabel={dialog.title}
      identityProps={{ "data-board-dialog": dialog.id }}
      onClose={close}
    >
      <div data-board-dialog-section="header" className="flex items-start gap-2 px-3 py-2">
        <BoardNodeNumber
          no={dialog.no}
          label={dialog.label}
          planCode={node.planCode}
          // #59 S-7：kind 闭集与 variant 闭集同名，直接透传（去掉冗余三元）。
          variant={dialog.kind}
        />
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
        {/* #54-5 状态行精简：段位徽章已在场时不再渲染同义的 statusText（「待办 待办中」重复）。
              段位缺失（徽章不渲染）时 status 文本是唯一状态来源，锚点保留、照常渲染。 */}
        {statusText && dialog.stage === null ? (
          <span
            data-board-dialog-status={dialog.status ?? ""}
            className="text-ui-xs text-foreground"
          >
            {statusText}
          </span>
        ) : null}
        {/* B5 精简：draft 徽章不重复（表里已有草案语境）、状态点去重（段位徽章已含状态）。
              #54-5：待合并 + 受阻合并为单一徽章（两个锚点各带原值）。 */}
        <BoardNodeBadges
          attention={dialog.attention}
          blockers={dialog.blockers.length}
          lastRun={dialog.lastRun}
          draft={false}
          activeRunRole={dialog.activeRun?.role ?? null}
          status={dialog.status}
          showStatusDot={false}
          mergeUnmergedBlocked
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
              nextAssignee={dialog.nextAssignee}
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
    </BoardDialogShell>
  );
}
