/**
 * 项目看板面板的四视图（卡 #32 树形；卡 #33 增看板列视图与列表视图 + 视图切换；
 * 卡 #34 增表格视图、卡片弹窗宿主与跳转落点高亮）。四视图各在自己的模块里
 * （`BoardTreeView` / `BoardKanbanView` / `BoardListView` / `BoardTableView`），本文件只管
 * 面板骨架：头部（标题/时间戳/四态切换/刷新）、置顶提示条（每段可跳）、陈旧提示行、
 * 视图分派、诊断尾区与弹窗挂载。
 *
 * 渲染骨架与逐字文案的单一真源：`.zcode/board/board-consumption-contract.md` §2/§3.1/§3.3/§4
 * 与 §13（视图矩阵/待设计聚合/待合并角标）、§5（陈旧提示，应用侧轻量版）、§6（弹窗逐字）。
 * 纯展示组件：只吃 `BoardPaneLoadState` 与视图状态，不经服务、不写任何东西（契约 §7.1）；
 * 分组/排序/过滤判据全在纯函数层（`boardViewsViewModel` / `boardTableViewModel` /
 * `boardDialogViewModel`），本文件与各视图组件只投影 + 回传意图。
 */
import { Fragment } from "react";
import { RefreshCwIcon } from "lucide-react";
import { Button } from "@/components/ui/button.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { BoardCardDialog } from "./BoardCardDialog.js";
import { BoardTreeView } from "./BoardTreeView.js";
import { BoardKanbanView } from "./BoardKanbanView.js";
import { BoardListView } from "./BoardListView.js";
import { BoardTableView } from "./BoardTableView.js";
import {
  resolveBoardAttentionJumpTarget,
  resolveBoardDialogNode,
  type BoardJumpTarget,
} from "./boardDialogViewModel.js";
import {
  BOARD_ATTENTION_SUMMARY_ROWS,
  formatAttentionSummarySegment,
  formatBoardRunTime,
  formatBoardStaleHint,
} from "./boardPresentation.js";
import type { BoardPaneLoadState } from "./loadBoardDocument.js";
import { hasAttentionSignal, type BoardViewModel } from "./boardViewModel.js";
import {
  BOARD_VIEW_MODES,
  BOARD_VIEW_MODE_MESSAGE_IDS,
  type BoardViewMode,
  type BoardListControls,
} from "./boardViewsViewModel.js";
import type { BoardTableColumnVisibility } from "./boardTableViewModel.js";

export interface BoardPaneViewProps {
  state: BoardPaneLoadState;
  onRefresh?: () => void;
  /** 面板内视图（会话内保持，由宿主 BoardPane 持有；缺省树形 = tracer 的既有视图）。 */
  viewMode?: BoardViewMode;
  /** 列表/表格视图的过滤与排序状态（宿主持有；缺省 = 不筛 + 默认排序）。 */
  listControls?: BoardListControls;
  onListControlsChange?: (controls: BoardListControls) => void;
  /** 表格视图的列可见性（宿主持有并做会话记忆；缺省 = 契约默认列 + 卡龄）。 */
  tableColumns?: BoardTableColumnVisibility;
  onTableColumnsChange?: (columns: BoardTableColumnVisibility) => void;
  /** 视图切换（宿主持有并做会话记忆）。切四态控件常驻：它是本面板的骨架，不因缺省 handler 消失。 */
  onViewModeChange?: (mode: BoardViewMode) => void;
  /** 打开态卡片 id（同一时刻最多一个弹窗；板上找不到该 id 就不渲染）。 */
  openCardId?: string | null;
  onOpenCard?: (id: string) => void;
  onCloseCard?: () => void;
  /** 依赖跳转与提示条段落跳转（滚动 + 高亮由宿主执行）。 */
  onJumpToCard?: (target: BoardJumpTarget) => void;
  /** 跳转落点（该卡片元素带高亮锚点）。 */
  highlightCardId?: string | null;
  /** 陈旧判定的「现在」（毫秒）；缺省取渲染时刻（测试注入固定值）。 */
  now?: number;
}

/** 面板级刷新按钮（`data-board-refresh`）：就绪头部与占位态同一实现（评审 #32-P5）。 */
function BoardPaneRefreshButton({ onRefresh }: { onRefresh: () => void }) {
  const { intl } = useZCodeIntl();
  return (
    <Button
      type="button"
      variant="ghost"
      size="icon-sm"
      data-board-refresh=""
      className="shrink-0"
      aria-label={intl.formatMessage({ id: "board.refresh" })}
      onClick={onRefresh}
    >
      <RefreshCwIcon className="size-4" />
    </Button>
  );
}

/** 面板内视图切换（树形/看板/列表/表格）：常驻头部，选中态走 `aria-pressed`（不靠颜色表达）。 */
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

/**
 * 置顶提示条（契约 §3.1 逐字）：四段各自成段（每段按缺口码找落点），分隔符 ` · ` 是文本节点
 * ——全文与单段共用同一张词条表（`BOARD_ATTENTION_SUMMARY_ROWS`），文案一字不改。
 * 有落点的段落是按钮（点即滚动到对应卡 + 高亮）；没有落点（陈旧摘要）是纯文本，不给死按钮。
 */
function BoardAttentionBanner({
  board,
  onJumpToCard,
}: {
  board: BoardViewModel;
  onJumpToCard?: (target: BoardJumpTarget) => void;
}) {
  const { intl } = useZCodeIntl();
  return (
    <div
      data-board-attention-banner=""
      role="status"
      className="rounded-lg border border-warning/40 bg-warning/10 px-3 py-2 text-ui-sm text-foreground"
    >
      {BOARD_ATTENTION_SUMMARY_ROWS.map(([summaryKey, code], index) => {
        const text = formatAttentionSummarySegment(
          code,
          board.attentionSummary[summaryKey],
          intl.formatMessage,
        );
        const target = resolveBoardAttentionJumpTarget(board, code);
        return (
          <Fragment key={code}>
            {index > 0 ? <span aria-hidden="true"> · </span> : null}
            {target && onJumpToCard ? (
              <button
                type="button"
                data-board-attention-jump={code}
                className="cursor-pointer rounded-sm underline-offset-2 hover:underline focus-visible:underline"
                onClick={() => onJumpToCard(target)}
              >
                {text}
              </button>
            ) : (
              <span data-board-attention-jump-none={code}>{text}</span>
            )}
          </Fragment>
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
  tableColumns,
  onTableColumnsChange,
  onViewModeChange,
  openCardId,
  onOpenCard,
  onCloseCard,
  onJumpToCard,
  highlightCardId,
  now,
}: {
  board: BoardViewModel;
  onRefresh?: () => void;
  viewMode: BoardViewMode;
  listControls?: BoardListControls;
  onListControlsChange?: (controls: BoardListControls) => void;
  tableColumns?: BoardTableColumnVisibility;
  onTableColumnsChange?: (columns: BoardTableColumnVisibility) => void;
  onViewModeChange?: (mode: BoardViewMode) => void;
  openCardId?: string | null;
  onOpenCard?: (id: string) => void;
  onCloseCard?: () => void;
  onJumpToCard?: (target: BoardJumpTarget) => void;
  highlightCardId?: string | null;
  now: number;
}) {
  const { intl } = useZCodeIntl();
  const showBanner = hasAttentionSignal(board.attentionSummary);
  const staleHint = formatBoardStaleHint(board.updatedAt, now, intl.formatMessage);
  // 同一时刻最多一个弹窗：宿主只持一个 id，这里按 id 解析（悬空 id → null，不留幽灵弹窗）。
  const dialogNode = resolveBoardDialogNode(board, openCardId ?? null);
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
          {onRefresh ? <BoardPaneRefreshButton onRefresh={onRefresh} /> : null}
        </div>
      </div>
      {staleHint ? (
        // 陈旧提示（契约 §5 应用侧轻量版）：纯提示行，不改变既有内容渲染，也不是空态。
        <div className="shrink-0 px-3 pt-3">
          <div
            data-board-stale-hint=""
            role="status"
            className="rounded-lg border border-border/50 bg-surface px-3 py-1.5 text-ui-xs text-foreground-subtle"
          >
            {staleHint}
          </div>
        </div>
      ) : null}
      {showBanner ? (
        // 提示条是第一优先级视觉元素：attentionSummary 非零即置顶常驻（契约 §3.1/§8.4）。
        // 四视图共用同一条：缺口不因切视图而消失；每段可跳到对应卡（#32 遗留）。
        <div className="shrink-0 px-3 pt-3">
          <BoardAttentionBanner board={board} {...(onJumpToCard ? { onJumpToCard } : {})} />
        </div>
      ) : null}
      <div className="flex min-h-0 flex-1 flex-col">
        {viewMode === "kanban" ? (
          <BoardKanbanView
            board={board}
            {...(onOpenCard ? { onOpenCard } : {})}
            highlightCardId={highlightCardId ?? null}
          />
        ) : viewMode === "list" ? (
          <BoardListView
            board={board}
            {...(listControls ? { controls: listControls } : {})}
            {...(onListControlsChange ? { onControlsChange: onListControlsChange } : {})}
            {...(onOpenCard ? { onOpenCard } : {})}
            highlightCardId={highlightCardId ?? null}
          />
        ) : viewMode === "table" ? (
          <BoardTableView
            board={board}
            {...(listControls ? { controls: listControls } : {})}
            {...(onListControlsChange ? { onControlsChange: onListControlsChange } : {})}
            {...(tableColumns ? { columns: tableColumns } : {})}
            {...(onTableColumnsChange ? { onColumnsChange: onTableColumnsChange } : {})}
            {...(onOpenCard ? { onOpenCard } : {})}
            highlightCardId={highlightCardId ?? null}
          />
        ) : (
          <BoardTreeView
            board={board}
            {...(onOpenCard ? { onOpenCard } : {})}
            highlightCardId={highlightCardId ?? null}
          />
        )}
      </div>
      {board.diagnostics.length > 0 ? (
        // 板级诊断（含「已取消卡未清理现场」的清理提示，§13.4）：四视图共用只读尾区。
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
      {dialogNode ? (
        <BoardCardDialog
          board={board}
          node={dialogNode}
          {...(onCloseCard ? { onClose: onCloseCard } : {})}
          {...(onJumpToCard ? { onJumpToCard } : {})}
        />
      ) : null}
    </div>
  );
}

/** 占位态的种类（显式 prop ⇒ 锚点与文案的对应关系写死在类型里，评审 #32-S2）。 */
export type BoardPlaceholderKind = "missing" | "empty" | "damaged" | "unavailable" | "loading";

/**
 * 占位态：空态 A/B/C、暂时不可读与加载中共用同一骨架。
 * 刷新按钮在**面板级**出现（空态 A/C 的文案正指导用户「回来再读」，评审 #32-P5）：
 * 任何占位态都能手动重读；没有刷新回调时不渲染死按钮。
 */
function BoardPlaceholder({
  kind,
  message,
  onRefresh,
}: {
  kind: BoardPlaceholderKind;
  message: string;
  onRefresh?: () => void;
}) {
  const anchor =
    kind === "loading" ? { "data-board-loading": "" } : { "data-board-empty": kind };
  return (
    <div data-board-pane="" className="flex h-full min-h-0 flex-col">
      {onRefresh ? (
        <div className="flex h-12 shrink-0 items-center justify-end border-b border-border/50 px-3">
          <BoardPaneRefreshButton onRefresh={onRefresh} />
        </div>
      ) : null}
      <div className="flex min-h-0 flex-1 items-center justify-center bg-background px-6">
        <div {...anchor} className="max-w-[20rem] text-center text-ui-sm text-foreground-subtle">
          {message}
        </div>
      </div>
    </div>
  );
}

/** 占位态 → 文案（loading 之外的四处锚点值分别为 missing/empty/damaged/unavailable）。 */
const BOARD_PLACEHOLDER_MESSAGE_IDS: Record<BoardPlaceholderKind, string> = {
  missing: "board.empty.none",
  empty: "board.empty.features",
  damaged: "board.empty.damaged",
  unavailable: "board.unavailable",
  loading: "board.loading",
};

export function BoardPaneView({
  state,
  onRefresh,
  viewMode = "tree",
  listControls,
  onListControlsChange,
  tableColumns,
  onTableColumnsChange,
  onViewModeChange,
  openCardId = null,
  onOpenCard,
  onCloseCard,
  onJumpToCard,
  highlightCardId = null,
  now,
}: BoardPaneViewProps) {
  const { intl } = useZCodeIntl();
  const ageBase = now ?? Date.now();
  if (state.kind === "ready") {
    return (
      <BoardReadyView
        board={state.board}
        viewMode={viewMode}
        openCardId={openCardId}
        highlightCardId={highlightCardId}
        now={ageBase}
        {...(onRefresh ? { onRefresh } : {})}
        {...(listControls ? { listControls } : {})}
        {...(onListControlsChange ? { onListControlsChange } : {})}
        {...(tableColumns ? { tableColumns } : {})}
        {...(onTableColumnsChange ? { onTableColumnsChange } : {})}
        {...(onViewModeChange ? { onViewModeChange } : {})}
        {...(onOpenCard ? { onOpenCard } : {})}
        {...(onCloseCard ? { onCloseCard } : {})}
        {...(onJumpToCard ? { onJumpToCard } : {})}
      />
    );
  }
  // 占位态四类 + 加载中：空态 C 是错误态，绝不显示空白假装正常（契约 §2/§7.6）；
  // 「暂时不可读」单独成态，不借空态 C 的词条（评审 #32-P3）。
  const kind: BoardPlaceholderKind =
    state.kind === "loading" ? "loading" : (state.kind satisfies BoardPlaceholderKind);
  return (
    <BoardPlaceholder
      kind={kind}
      message={intl.formatMessage({ id: BOARD_PLACEHOLDER_MESSAGE_IDS[kind] })}
      {...(onRefresh ? { onRefresh } : {})}
    />
  );
}
