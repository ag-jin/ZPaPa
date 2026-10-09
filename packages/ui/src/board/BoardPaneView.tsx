/**
 * 项目看板面板的三视图（卡 #32 树形；卡 #33 增看板列视图与列表视图 + 视图切换）。
 *
 * 渲染骨架与逐字文案的单一真源：`.zcode/board/board-consumption-contract.md` §2/§3.1/§3.3/§4
 * 与 §13（视图矩阵/待设计聚合/待合并角标）。纯展示组件：只吃 `BoardPaneLoadState` 与视图状态，
 * 不经服务、不写任何东西（契约 §7.1）；分组/排序/过滤判据全在 `boardViewsViewModel` 纯函数层。
 */
import { RefreshCwIcon } from "lucide-react";
import { Badge } from "@/components/ui/badge.js";
import { Button } from "@/components/ui/button.js";
import { cn } from "@/components/lib/utils.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { BoardKanbanView } from "./BoardKanbanView.js";
import { BoardListView } from "./BoardListView.js";
import {
  BoardAttentionBadges,
  BoardBlockerBadge,
  BoardDraftBadge,
  BoardNodeNumber,
  BoardStageBadge,
  BoardStatusDot,
} from "./boardNodeParts.js";
import {
  boardTaskLabelIndentLevel,
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
import {
  BOARD_VIEW_MODES,
  BOARD_VIEW_MODE_MESSAGE_IDS,
  type BoardViewMode,
  type BoardListControls,
} from "./boardViewsViewModel.js";

export interface BoardPaneViewProps {
  state: BoardPaneLoadState;
  onRefresh?: () => void;
  /** 面板内视图（会话内保持，由宿主 BoardPane 持有；缺省树形 = tracer 的既有视图）。 */
  viewMode?: BoardViewMode;
  /** 列表视图的过滤/排序状态（宿主持有；缺省 = 不筛 + 默认排序）。 */
  listControls?: BoardListControls;
  onListControlsChange?: (controls: BoardListControls) => void;
  /** 视图切换（宿主持有并做会话记忆）。切三态控件常驻：它是本面板的骨架，不因缺省 handler 消失。 */
  onViewModeChange?: (mode: BoardViewMode) => void;
}

/** 缩进层级 → 左侧内边距（层级=label 段数；未领号卡按第二层）。 */
const TASK_INDENT_CLASSES = ["pl-2", "pl-6", "pl-10", "pl-14"] as const;

function taskIndentClass(level: number): string {
  return (
    TASK_INDENT_CLASSES[Math.min(Math.max(level, 0), TASK_INDENT_CLASSES.length - 1)] ?? "pl-2"
  );
}

function BoardTaskRow({ task, depth }: { task: BoardTaskNode; depth: number }) {
  const { intl } = useZCodeIntl();
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
          <BoardNodeNumber no={task.no} label={task.label} />
          <span className="min-w-0 flex-1 truncate text-ui-sm text-foreground">{task.title}</span>
          <BoardStageBadge stage={task.stage} />
          {task.draft ? <BoardDraftBadge /> : null}
          <BoardAttentionBadges attention={task.attention} lastRun={task.lastRun} />
          <BoardBlockerBadge count={task.blockerCount} />
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
        <BoardNodeNumber no={feature.no} label={feature.label} />
        <span className="min-w-0 flex-1 truncate text-ui-base font-medium text-foreground">
          {feature.title}
        </span>
        <BoardStageBadge stage={feature.stage} />
        <BoardAttentionBadges attention={feature.attention} lastRun={null} />
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

/** 面板内视图切换（树形/看板/列表）：常驻头部，选中态走 `aria-pressed`（不靠颜色表达）。 */
function BoardViewSwitcher({
  viewMode,
  onViewModeChange,
}: {
  viewMode: BoardViewMode;
  onViewModeChange: (mode: BoardViewMode) => void;
}) {
  const { intl } = useZCodeIntl();
  return (
    <div
      data-board-view-switcher=""
      role="group"
      aria-label={intl.formatMessage({ id: "board.view.label" })}
      className="flex shrink-0 items-center gap-0.5"
    >
      {BOARD_VIEW_MODES.map((mode) => {
        const active = mode === viewMode;
        return (
          <Button
            key={mode}
            type="button"
            size="xs"
            variant={active ? "secondary" : "ghost"}
            aria-pressed={active}
            data-board-view-option={mode}
            data-active={active ? "true" : "false"}
            onClick={() => onViewModeChange(mode)}
          >
            {intl.formatMessage({ id: BOARD_VIEW_MODE_MESSAGE_IDS[mode] })}
          </Button>
        );
      })}
    </div>
  );
}

function BoardReadyView({
  board,
  onRefresh,
  viewMode,
  listControls,
  onListControlsChange,
  onViewModeChange,
}: {
  board: BoardViewModel;
  onRefresh?: () => void;
  viewMode: BoardViewMode;
  listControls?: BoardListControls;
  onListControlsChange?: (controls: BoardListControls) => void;
  onViewModeChange?: (mode: BoardViewMode) => void;
}) {
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
        <div className="flex shrink-0 items-center gap-1">
          <BoardViewSwitcher
            viewMode={viewMode}
            onViewModeChange={onViewModeChange ?? (() => {})}
          />
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
      </div>
      {showBanner ? (
        // 提示条是第一优先级视觉元素：attentionSummary 非零即置顶常驻（契约 §3.1/§8.4）。
        // 三视图共用同一条：缺口不因切视图而消失。
        <div className="shrink-0 px-3 pt-3">
          <div
            data-board-attention-banner=""
            role="status"
            className="rounded-lg border border-warning/40 bg-warning/10 px-3 py-2 text-ui-sm text-foreground"
          >
            {formatAttentionSummaryText(board.attentionSummary, intl.formatMessage)}
          </div>
        </div>
      ) : null}
      <div className="flex min-h-0 flex-1 flex-col">
        {viewMode === "kanban" ? (
          <BoardKanbanView board={board} />
        ) : viewMode === "list" ? (
          <BoardListView
            board={board}
            {...(listControls ? { controls: listControls } : {})}
            {...(onListControlsChange ? { onControlsChange: onListControlsChange } : {})}
          />
        ) : (
          <div className="min-h-0 flex-1 overflow-y-auto px-3 py-3">
            {board.features.map((feature) => (
              <BoardFeatureSection key={feature.id} feature={feature} />
            ))}
          </div>
        )}
      </div>
      {board.diagnostics.length > 0 ? (
        // 板级诊断（含「已取消卡未清理现场」的清理提示，§13.4）：三视图共用只读尾区。
        <div
          data-board-diagnostics=""
          className="max-h-32 shrink-0 overflow-y-auto border-t border-border/50 px-3 py-2"
        >
          <div className="pb-1 text-ui-xs font-medium text-foreground-subtle">
            {intl.formatMessage(
              { id: "board.diagnostics.title" },
              { count: board.diagnostics.length },
            )}
          </div>
          <ul className="flex flex-col gap-1">
            {board.diagnostics.map((diagnostic, index) => (
              <li key={`${diagnostic.path}:${index}`} className="text-ui-xs text-foreground-subtle">
                <span className="font-mono">{diagnostic.path}</span> {diagnostic.message}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
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

export function BoardPaneView({
  state,
  onRefresh,
  viewMode = "tree",
  listControls,
  onListControlsChange,
  onViewModeChange,
}: BoardPaneViewProps) {
  const { intl } = useZCodeIntl();
  if (state.kind === "ready") {
    return (
      <BoardReadyView
        board={state.board}
        viewMode={viewMode}
        {...(onRefresh ? { onRefresh } : {})}
        {...(listControls ? { listControls } : {})}
        {...(onListControlsChange ? { onListControlsChange } : {})}
        {...(onViewModeChange ? { onViewModeChange } : {})}
      />
    );
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
