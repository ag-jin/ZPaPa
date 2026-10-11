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
import { Button } from "@/components/ui/button.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { BoardAttentionBanner } from "./boardAttentionBanner.js";
import {
  BOARD_PANE_ROOT_CLASS,
  BoardPaneRefreshButton,
  BoardPlaceholder,
  BoardSnapshotNotice,
} from "./boardPlaceholderParts.js";
import { BoardCardDialog } from "./BoardCardDialog.js";
import { BoardEpicDialog } from "./BoardEpicDialog.js";
import { BoardGuideView } from "./BoardGuideView.js";
import { BoardTreeView } from "./BoardTreeView.js";
import { BoardKanbanView } from "./BoardKanbanView.js";
import { BoardListView } from "./BoardListView.js";
import { BoardTableView } from "./BoardTableView.js";
import { resolveBoardDialogNode, type BoardJumpTarget } from "./boardDialogViewModel.js";
import { DEFAULT_BOARD_VIEW_MODE } from "./boardViewModeMemory.js";
import {
  BOARD_PLACEHOLDER_MESSAGE_IDS,
  formatBoardPathTail,
  formatBoardRunTime,
  formatBoardStaleHint,
  type BoardPlaceholderKind,
} from "./boardPresentation.js";
import { BOARD_JSON_MAX_READ_BYTES, type BoardPaneLoadState } from "./loadBoardDocument.js";
import { hasAttentionSignal, BOARD_KNOWN_VERSION, type BoardViewModel } from "./boardViewModel.js";
import {
  BOARD_VIEW_MODES,
  BOARD_VIEW_MODE_MESSAGE_IDS,
  type BoardViewMode,
  type BoardListControls,
} from "./boardViewsViewModel.js";
import type { BoardTableColumnVisibility } from "./boardTableViewModel.js";
import type { BoardFoldControls } from "./boardFoldState.js";

export interface BoardPaneViewProps {
  state: BoardPaneLoadState;
  onRefresh?: () => void;
  /** 面板内视图（会话内保持，由宿主 BoardPane 持有；缺省 = 单点常量 `DEFAULT_BOARD_VIEW_MODE`，C3-5/#140 起为指引面）。 */
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
  /** 看板「已完成」列展开态（宿主持有：跳转揭示要能先置展开；缺省展开）。 */
  kanbanCompletedExpanded?: boolean;
  onKanbanCompletedExpandedChange?: (expanded: boolean) => void;
  /**
   * 折叠控制（#89/A4-3；宿主持有并做会话记忆）：四视图的每一层折叠点（epic 章/期次组/稿层分组）
   * 共用这一份——`state` = 用户显式覆盖，`onToggle` = 用户动作回传。缺省 = 只读渲染，按默认态。
   */
  fold?: BoardFoldControls;
  /**
   * 上次成功读取的快照（#158；E7 §7.2）：仅 `state.kind === "unavailable"` 时消费——断连不清空
   * 版面，保留快照并附状态行。其余态（损坏/版本/空态是就绪后的确定性判定）不吃快照。
   */
  unavailableSnapshot?: BoardViewModel | null;
  /** epic 弹窗打开态（#90/A4-4：宿主只持 epic 码；同一时刻与卡片弹窗互斥）。 */
  openEpicCode?: string | null;
  onOpenEpic?: (code: string) => void;
  onCloseEpic?: () => void;
  /** epic 弹窗期次指针下钻（展开祖先层 + 滚动/高亮，由宿主执行）。 */
  onDrillToPhase?: (epicCode: string, phase: number) => void;
  /** 陈旧判定的「现在」（毫秒）；缺省取渲染时刻（测试注入固定值）。 */
  now?: number;
}

/**
 * 看板面板根元素的类名、面板级刷新按钮、未连接快照状态行与占位态零件（卡 #158 平移）：
 * 定义与释义在 `boardPlaceholderParts`（本文件只留骨架与分派）。
 */

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
  kanbanCompletedExpanded,
  onKanbanCompletedExpandedChange,
  fold,
  snapshotNotice,
  openEpicCode,
  onOpenEpic,
  onCloseEpic,
  onDrillToPhase,
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
  kanbanCompletedExpanded?: boolean;
  onKanbanCompletedExpandedChange?: (expanded: boolean) => void;
  fold?: BoardFoldControls;
  /** 未连接保留快照时的状态行文案（#158；只在 unavailable+快照这条路径传入）。 */
  snapshotNotice?: string | null;
  openEpicCode?: string | null;
  onOpenEpic?: (code: string) => void;
  onCloseEpic?: () => void;
  onDrillToPhase?: (epicCode: string, phase: number) => void;
  now: number;
}) {
  const { intl } = useZCodeIntl();
  const showBanner = hasAttentionSignal(board.attentionSummary);
  const staleHint = formatBoardStaleHint(board.updatedAt, now, intl.formatMessage);
  // 同一时刻最多一个弹窗：宿主只持一个 id，这里按 id 解析（悬空 id → null，不留幽灵弹窗）。
  const dialogNode = resolveBoardDialogNode(board, openCardId ?? null);
  // epic 弹窗（#90/A4-4）：同为「打开态 → 至多一个」——悬空码同样不留幽灵弹窗（模型层判）。
  const openEpic = openEpicCode ?? null;
  return (
    // relative：弹窗 overlay 是**面板容器内 absolute**（#46 B5），不是 fixed 全局遮罩。
    // `data-no-selection-action`（卡 #64）：看板是只读投影，面板内不得出现
    // 「选中文字→添加到会话」浮条。豁免判据在共享层 `conversationSelectionGuard`（只认这个属性，
    // 不认看板身份）——本面板只声明约定，不在 board 模块里自建第二套选区判定。
    <div data-board-pane="" data-no-selection-action="" className={BOARD_PANE_ROOT_CLASS}>
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
      {showBanner ? (
        // 提示条是第一优先级视觉元素：attentionSummary 非零即置顶常驻（契约 §3.1/§8.4），
        // 排在陈旧提示行**之上**（评审 #35-P1：陈旧行不得顶在提示条之前）。
        // 四视图共用同一条：缺口不因切视图而消失；每段可跳到对应卡（#32 遗留）。
        <div className="shrink-0 px-3 pt-3">
          <BoardAttentionBanner board={board} {...(onJumpToCard ? { onJumpToCard } : {})} />
        </div>
      ) : null}
      {snapshotNotice ? <BoardSnapshotNotice message={snapshotNotice} /> : null}
      {staleHint ? (
        // 陈旧提示（契约 §5 应用侧轻量版）：纯提示行，不改变既有内容渲染，也不是空态；
        // 排在提示条**之下**（提示条为第一优先级视觉元素，见上）。
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
      <div className="flex min-h-0 flex-1 flex-col">
        {viewMode === "guide" ? (
          // 指引面（C3-1/#136）：L1 默认面候选（缺省切换归 C3-5/#140）；卡行点击走同一弹窗宿主状态。
          <BoardGuideView board={board} now={now} {...(onOpenCard ? { onOpenCard } : {})} />
        ) : viewMode === "kanban" ? (
          <BoardKanbanView
            board={board}
            {...(onOpenCard ? { onOpenCard } : {})}
            highlightCardId={highlightCardId ?? null}
            {...(kanbanCompletedExpanded !== undefined
              ? { completedExpanded: kanbanCompletedExpanded }
              : {})}
            {...(onKanbanCompletedExpandedChange
              ? { onCompletedExpandedChange: onKanbanCompletedExpandedChange }
              : {})}
            {...(fold ? { fold } : {})}
            {...(onOpenEpic ? { onOpenEpic } : {})}
          />
        ) : viewMode === "list" ? (
          <BoardListView
            board={board}
            {...(listControls ? { controls: listControls } : {})}
            {...(onListControlsChange ? { onControlsChange: onListControlsChange } : {})}
            {...(onOpenCard ? { onOpenCard } : {})}
            highlightCardId={highlightCardId ?? null}
            {...(fold ? { fold } : {})}
            {...(onOpenEpic ? { onOpenEpic } : {})}
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
            {...(fold ? { fold } : {})}
            {...(onOpenEpic ? { onOpenEpic } : {})}
          />
        ) : (
          <BoardTreeView
            board={board}
            {...(onOpenCard ? { onOpenCard } : {})}
            highlightCardId={highlightCardId ?? null}
            {...(fold ? { fold } : {})}
            {...(onOpenEpic ? { onOpenEpic } : {})}
          />
        )}
      </div>
      {board.diagnostics.length > 0 ? (
        // 板级诊断（含「已取消卡未清理现场」的清理提示，§13.4）：四视图共用只读尾区。
        // #46 B7：默认折叠为一行「诊断 N 条」，点开才列明细（细节不抢版面，但不静默隐藏）。
        <details data-board-diagnostics="" className="shrink-0 border-t border-border/50">
          <summary className="cursor-pointer px-3 py-2 text-ui-xs font-medium text-foreground-subtle">
            {intl.formatMessage(
              { id: "board.diagnostics.collapsed" },
              { count: board.diagnostics.length },
            )}
          </summary>
          <div className="max-h-32 overflow-y-auto px-3 pb-2">
            <ul className="flex flex-col gap-1">
              {board.diagnostics.map((diagnostic, index) => (
                <li
                  key={`${diagnostic.path}:${index}`}
                  className="text-ui-xs text-foreground-subtle"
                >
                  <span className="font-mono" title={diagnostic.path}>
                    {formatBoardPathTail(diagnostic.path)}
                  </span>{" "}
                  {diagnostic.message}
                </li>
              ))}
            </ul>
          </div>
        </details>
      ) : null}
      {openEpic !== null ? (
        // epic 弹窗（#90/A4-4 退化形态）：与卡片弹窗同一外壳/同一「至多一个」纪律；
        // 悬空码在模型层判空（组件收到 null 直接不渲染，不留幽灵弹窗）。
        <BoardEpicDialog
          board={board}
          code={openEpic}
          {...(onCloseEpic ? { onClose: onCloseEpic } : {})}
          {...(onDrillToPhase ? { onDrillToPhase } : {})}
        />
      ) : null}
      {dialogNode ? (
        <BoardCardDialog
          board={board}
          node={dialogNode}
          now={now}
          {...(onCloseCard ? { onClose: onCloseCard } : {})}
          {...(onJumpToCard ? { onJumpToCard } : {})}
        />
      ) : null}
    </div>
  );
}

/** 占位态种类的再导出（定义在 boardPresentation：文案 id 表同处，锚点/文案对应单点维护）。 */
export type { BoardPlaceholderKind } from "./boardPresentation.js";

export function BoardPaneView({
  state,
  onRefresh,
  viewMode = DEFAULT_BOARD_VIEW_MODE,
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
  kanbanCompletedExpanded,
  onKanbanCompletedExpandedChange,
  fold,
  unavailableSnapshot,
  openEpicCode = null,
  onOpenEpic,
  onCloseEpic,
  onDrillToPhase,
  now,
}: BoardPaneViewProps) {
  const { intl } = useZCodeIntl();
  const ageBase = now ?? Date.now();
  // 未连接（暂时不可读）且手里有上次成功读取的快照：保留快照 + 状态行，不落占位清空版面
  // （#158；E7 §7.2「显示暂时不可读，保留上次快照但标陈旧」）。快照只对这一种态生效：
  // 损坏/版本/空态是就绪后的确定性判定，不得拿旧板冒充现状（见测试反例）。
  const retainedBoard = state.kind === "unavailable" ? (unavailableSnapshot ?? null) : null;
  if (state.kind === "ready" || retainedBoard) {
    const board = state.kind === "ready" ? state.board : retainedBoard;
    if (!board) return null;
    return (
      <BoardReadyView
        board={board}
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
        {...(kanbanCompletedExpanded !== undefined ? { kanbanCompletedExpanded } : {})}
        {...(onKanbanCompletedExpandedChange ? { onKanbanCompletedExpandedChange } : {})}
        {...(fold ? { fold } : {})}
        {...(retainedBoard
          ? { snapshotNotice: intl.formatMessage({ id: "board.unavailable.snapshotNotice" }) }
          : {})}
        {...(openEpicCode !== null ? { openEpicCode } : {})}
        {...(onOpenEpic ? { onOpenEpic } : {})}
        {...(onCloseEpic ? { onCloseEpic } : {})}
        {...(onDrillToPhase ? { onDrillToPhase } : {})}
      />
    );
  }
  // 占位态（空态 A1/A2 二分、B、损坏态、版本过新/过旧、文件过大、暂时不可读）+ 加载中：错误态绝不显示
  // 空白假装正常（契约 §2/§7.6/§14）；「暂时不可读」单独成态，不借损坏态的词条（评审 #32-P3）；
  // 空态 A1/A2 各走各自指引（#158：新生给起步动作、板文件缺失给重建动作）。
  // 有快照的不可读态已在上面走「保留快照」分支，不落这里（E7 §7.2）。
  const kind: BoardPlaceholderKind =
    state.kind === "loading" ? "loading" : (state.kind satisfies BoardPlaceholderKind);
  // 版本态词条带两级版本号（板上版本 / 应用支持的主版本）：比较口径的唯一真源是 BOARD_KNOWN_VERSION；
  // 文件过大态词条带读取上限（唯一真源 BOARD_JSON_MAX_READ_BYTES，避免文案与常量漂移）。
  const messageValues: Record<string, number> | undefined =
    state.kind === "version-newer" || state.kind === "version-older"
      ? { version: state.version, supported: BOARD_KNOWN_VERSION }
      : state.kind === "too-large"
        ? { limitKiB: BOARD_JSON_MAX_READ_BYTES / 1024 }
        : undefined;
  return (
    <BoardPlaceholder
      kind={kind}
      message={intl.formatMessage({ id: BOARD_PLACEHOLDER_MESSAGE_IDS[kind] }, messageValues)}
      {...(onRefresh ? { onRefresh } : {})}
    />
  );
}
