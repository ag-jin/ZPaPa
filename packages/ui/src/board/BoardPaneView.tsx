/**
 * 项目看板面板的树形只读视图（卡 #32）。
 *
 * 渲染骨架与逐字文案的单一真源：`.zcode/board/board-consumption-contract.md` §2/§3.1/§3.3/§4。
 * 纯展示组件：只吃 `BoardPaneLoadState`，不经服务、不写任何东西（契约 §7.1）。
 */
import { RefreshCwIcon } from "lucide-react";
import { Badge } from "@/components/ui/badge.js";
import { Button } from "@/components/ui/button.js";
import { cn } from "@/components/lib/utils.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import {
  boardStatusDotClassName,
  boardTaskLabelIndentLevel,
  formatAttentionBadgeText,
  formatAttentionSummaryText,
  formatBoardActiveRunText,
  formatBoardLastRunText,
  formatBoardRunTime,
} from "./boardPresentation.js";
import type { BoardPaneLoadState } from "./loadBoardDocument.js";
import {
  hasAttentionSignal,
  type BoardTaskNode,
  type BoardViewModel,
  type BoardFeatureNode,
} from "./boardViewModel.js";

export interface BoardPaneViewProps {
  state: BoardPaneLoadState;
  onRefresh?: () => void;
}

/** 缩进层级 → 左侧内边距（层级=label 段数；未领号卡按第二层）。 */
const TASK_INDENT_CLASSES = ["pl-2", "pl-6", "pl-10", "pl-14"] as const;

function taskIndentClass(level: number): string {
  return (
    TASK_INDENT_CLASSES[Math.min(Math.max(level, 0), TASK_INDENT_CLASSES.length - 1)] ?? "pl-2"
  );
}

function nodeNumberLabel(node: { label: string | null; no: number | null }): string | null {
  if (node.label) return `ID-${node.label}`;
  if (node.no !== null) return `ID-${node.no}`;
  return null;
}

function BoardStatusDot({ status }: { status: string | null }) {
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

function AttentionBadges({ task }: { task: BoardTaskNode }) {
  const { intl } = useZCodeIntl();
  return (
    <>
      {task.attention.map((code) => (
        <Badge
          key={code}
          variant="outline"
          data-board-attention={code}
          className="border-warning/40 bg-warning/10 text-warning"
        >
          {formatAttentionBadgeText(code, task.lastRun, intl.formatMessage)}
        </Badge>
      ))}
    </>
  );
}

function BoardTaskRow({ task, depth }: { task: BoardTaskNode; depth: number }) {
  const { intl } = useZCodeIntl();
  const number = nodeNumberLabel(task);
  const lastRunText = formatBoardLastRunText(task.lastRun, intl.formatMessage);
  return (
    <>
      <div
        data-board-task={task.id}
        data-board-indent={depth}
        className={cn(
          "flex flex-col gap-0.5 rounded-lg px-2 py-1.5 hover:bg-surface-hover",
          taskIndentClass(depth),
        )}
      >
        <div className="flex min-w-0 items-center gap-2">
          {number ? (
            <span className="shrink-0 font-mono text-ui-xs text-foreground-subtle">{number}</span>
          ) : (
            <Badge variant="outline" className="shrink-0">
              {intl.formatMessage({ id: "board.unassigned" })}
            </Badge>
          )}
          <span className="min-w-0 flex-1 truncate text-ui-sm text-foreground">{task.title}</span>
          {task.stage ? (
            <Badge variant="secondary" data-board-stage={task.stage} className="shrink-0">
              {task.stage}
            </Badge>
          ) : null}
          {task.draft ? (
            <Badge variant="secondary" className="shrink-0">
              {intl.formatMessage({ id: "board.draft" })}
            </Badge>
          ) : null}
          <AttentionBadges task={task} />
          {task.blockerCount > 0 ? (
            <Badge variant="outline" data-board-blockers={task.blockerCount} className="shrink-0">
              {intl.formatMessage({ id: "board.blockedByCount" }, { count: task.blockerCount })}
            </Badge>
          ) : null}
          {task.activeRun ? (
            <Badge
              variant="secondary"
              data-board-active-run={task.activeRun.role}
              className="shrink-0"
            >
              {formatBoardActiveRunText(task.activeRun.role, intl.formatMessage)}
            </Badge>
          ) : null}
          <BoardStatusDot status={task.status} />
        </div>
        {lastRunText ? (
          <div className="truncate font-mono text-ui-xs text-foreground-subtle">{lastRunText}</div>
        ) : null}
      </div>
      {task.children.map((child) => (
        <BoardTaskRow key={child.id} task={child} depth={depth + 1} />
      ))}
    </>
  );
}

function BoardFeatureSection({ feature }: { feature: BoardFeatureNode }) {
  const { intl } = useZCodeIntl();
  const number = nodeNumberLabel(feature);
  const progressText =
    feature.progress && feature.progress.totalTasks > 0
      ? intl.formatMessage(
          { id: "board.progress" },
          {
            completed: feature.progress.completedTasks,
            total: feature.progress.totalTasks,
          },
        )
      : null;
  const updatedAtText = feature.updatedAt
    ? intl.formatMessage({ id: "board.updatedAt" }, { time: formatBoardRunTime(feature.updatedAt) })
    : null;
  return (
    <section data-board-feature={feature.id} className="flex flex-col gap-0.5 pb-3">
      <div className="flex min-w-0 items-center gap-2 rounded-lg bg-surface px-2 py-1.5">
        {number ? (
          <span className="shrink-0 font-mono text-ui-xs text-foreground-subtle">{number}</span>
        ) : (
          <Badge variant="outline" className="shrink-0">
            {intl.formatMessage({ id: "board.unassigned" })}
          </Badge>
        )}
        <span className="min-w-0 flex-1 truncate text-ui-base font-medium text-foreground">
          {feature.title}
        </span>
        {feature.stage ? (
          <Badge variant="secondary" data-board-stage={feature.stage} className="shrink-0">
            {feature.stage}
          </Badge>
        ) : null}
        {feature.attention.map((code) => (
          <Badge
            key={code}
            variant="outline"
            data-board-attention={code}
            className="shrink-0 border-warning/40 bg-warning/10 text-warning"
          >
            {formatAttentionBadgeText(code, null, intl.formatMessage)}
          </Badge>
        ))}
        <BoardStatusDot status={feature.status} />
      </div>
      {updatedAtText || progressText ? (
        <div className="px-2 text-ui-xs text-foreground-subtle">
          {[updatedAtText, progressText].filter(Boolean).join(" · ")}
        </div>
      ) : null}
      <div className="flex flex-col">
        {feature.tasks.map((task) => (
          <BoardTaskRow key={task.id} task={task} depth={boardTaskLabelIndentLevel(task.label)} />
        ))}
      </div>
    </section>
  );
}

function BoardReadyView({ board, onRefresh }: { board: BoardViewModel; onRefresh?: () => void }) {
  const { intl } = useZCodeIntl();
  const showBanner = hasAttentionSignal(board.attentionSummary);
  return (
    <div data-board-pane="" className="flex h-full min-h-0 flex-col">
      <div className="flex h-12 shrink-0 items-center justify-between gap-2 border-b border-border/50 px-3">
        <div className="min-w-0">
          <div className="truncate text-ui-base font-medium text-foreground">
            {board.projectName || intl.formatMessage({ id: "board.title" })}
          </div>
          {board.updatedAt ? (
            <div className="truncate text-ui-xs text-foreground-subtle">
              {intl.formatMessage(
                { id: "board.updatedAt" },
                { time: formatBoardRunTime(board.updatedAt) },
              )}
            </div>
          ) : null}
        </div>
        {onRefresh ? (
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            className="shrink-0"
            aria-label={intl.formatMessage({ id: "board.refresh" })}
            onClick={onRefresh}
          >
            <RefreshCwIcon className="size-4" />
          </Button>
        ) : null}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-3 py-3">
        {showBanner ? (
          // 提示条是第一优先级视觉元素：attentionSummary 非零即置顶常驻（契约 §3.1/§8.4）。
          <div
            data-board-attention-banner=""
            role="status"
            className="mb-3 rounded-lg border border-warning/40 bg-warning/10 px-3 py-2 text-ui-sm text-foreground"
          >
            {formatAttentionSummaryText(board.attentionSummary, intl.formatMessage)}
          </div>
        ) : null}
        {board.features.map((feature) => (
          <BoardFeatureSection key={feature.id} feature={feature} />
        ))}
        {board.diagnostics.length > 0 ? (
          <div data-board-diagnostics="" className="mt-1 border-t border-border/50 pt-2">
            <div className="pb-1 text-ui-xs font-medium text-foreground-subtle">
              {intl.formatMessage(
                { id: "board.diagnostics.title" },
                { count: board.diagnostics.length },
              )}
            </div>
            <ul className="flex flex-col gap-1">
              {board.diagnostics.map((diagnostic, index) => (
                <li
                  key={`${diagnostic.path}:${index}`}
                  className="text-ui-xs text-foreground-subtle"
                >
                  <span className="font-mono">{diagnostic.path}</span> {diagnostic.message}
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </div>
    </div>
  );
}

function BoardPlaceholder({
  attribute,
  attributeValue,
  message,
}: {
  attribute: string;
  attributeValue: string;
  message: string;
}) {
  return (
    <div className="flex h-full min-h-0 items-center justify-center bg-background px-6">
      <div
        {...{ [attribute]: attributeValue }}
        className="max-w-[20rem] text-center text-ui-sm text-foreground-subtle"
      >
        {message}
      </div>
    </div>
  );
}

export function BoardPaneView({ state, onRefresh }: BoardPaneViewProps) {
  const { intl } = useZCodeIntl();
  if (state.kind === "ready") {
    return <BoardReadyView board={state.board} {...(onRefresh ? { onRefresh } : {})} />;
  }
  if (state.kind === "missing") {
    return (
      <BoardPlaceholder
        attribute="data-board-empty"
        attributeValue="missing"
        message={intl.formatMessage({ id: "board.empty.none" })}
      />
    );
  }
  if (state.kind === "empty") {
    return (
      <BoardPlaceholder
        attribute="data-board-empty"
        attributeValue="empty"
        message={intl.formatMessage({ id: "board.empty.features" })}
      />
    );
  }
  if (state.kind === "damaged") {
    // 空态 C 是错误态：绝不显示空白假装正常（契约 §2/§7.6）。
    return (
      <BoardPlaceholder
        attribute="data-board-empty"
        attributeValue="damaged"
        message={intl.formatMessage({ id: "board.empty.damaged" })}
      />
    );
  }
  return (
    <BoardPlaceholder
      attribute="data-board-loading"
      attributeValue=""
      message={intl.formatMessage({ id: "board.loading" })}
    />
  );
}
