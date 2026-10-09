/**
 * 看板列表视图（卡 #33）：全卡平铺（不分特性组），过滤（段位/状态/缺口码）+ 排序（updatedAt 卡龄）；
 * 卡 #34 补行点击 → 弹窗与跳转落点高亮（`boardCardInteraction` 一处生成的 props）。
 *
 * 单一真源：消费契约 §13.2「列表」列（行首段位徽章、attention 置顶排序、待合并/受阻角标）+
 * §3.5（排序：attention 置顶 + updatedAt 倒序；「最老未动」第二视角）+ §3.1/§3.3（点击 → 弹窗）。
 * 判据全在纯函数层（`boardViewsViewModel`），本组件只投影 + 回传意图。
 */
import { cn } from "@/components/lib/utils.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { BoardListFilterControls } from "./BoardListFilterControls.js";
import { boardCardHighlightProps, boardCardOpenProps } from "./boardCardInteraction.js";
import {
  BoardNodeBadges,
  BoardNodeNumber,
  BoardStageBadge,
} from "./boardNodeParts.js";
import type { BoardViewModel } from "./boardViewModel.js";
import {
  boardListControlsToQuery,
  buildBoardListRows,
  EMPTY_BOARD_LIST_CONTROLS,
  type BoardListControls,
  type BoardViewNode,
} from "./boardViewsViewModel.js";

function BoardListRow({
  node,
  onOpenCard,
  highlightCardId,
}: {
  node: BoardViewNode;
  onOpenCard?: (id: string) => void;
  highlightCardId: string | null;
}) {
  const { className: highlightClassName, ...highlightProps } = boardCardHighlightProps(
    node.id,
    highlightCardId,
  );
  return (
    <div
      data-board-card={node.id}
      {...highlightProps}
      {...boardCardOpenProps({ id: node.id, ...(onOpenCard ? { onOpenCard } : {}) })}
      className={cn(
        "flex flex-col gap-0.5 rounded-lg px-2 py-1.5 hover:bg-surface-hover",
        highlightClassName,
      )}
    >
      <div className="flex min-w-0 items-center gap-2">
        {/* 行首段位徽章（§13.2 列表列）。 */}
        <BoardStageBadge stage={node.stage} />
        <BoardNodeNumber no={node.no} label={node.label} />
        <span className="min-w-0 flex-1 truncate text-ui-sm text-foreground">{node.title}</span>
        <BoardNodeBadges
          attention={node.attention}
          blockers={node.blockers.length}
          lastRun={node.lastRun}
          draft={node.draft}
          activeRunRole={node.activeRun?.role ?? null}
          status={node.status}
        />
      </div>
      {node.stage === "已取消" && node.statusRule ? (
        // 取消原因（§13.2 列表列「已取消」行）：只在终态行展示，其余行不铺溯源噪声。
        <div data-board-status-rule="" className="truncate text-ui-xs text-foreground-subtle">
          {node.statusRule}
        </div>
      ) : null}
    </div>
  );
}

export interface BoardListViewProps {
  board: BoardViewModel;
  controls?: BoardListControls;
  onControlsChange?: (controls: BoardListControls) => void;
  /** 行点击（打开弹窗）；缺省时列表退化为只读展示。 */
  onOpenCard?: (id: string) => void;
  /** 跳转落点（该行带高亮锚点）。 */
  highlightCardId?: string | null;
}

export function BoardListView({
  board,
  controls = EMPTY_BOARD_LIST_CONTROLS,
  onControlsChange,
  onOpenCard,
  highlightCardId = null,
}: BoardListViewProps) {
  const { intl } = useZCodeIntl();
  const rows = buildBoardListRows(board, boardListControlsToQuery(controls));
  return (
    <div data-board-view="list" className="flex h-full min-h-0 flex-col">
      <div className="shrink-0 border-b border-border/50 px-3 py-2">
        <BoardListFilterControls controls={controls} onChange={onControlsChange ?? (() => {})} />
      </div>
      <div className="flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto px-3 py-2">
        {rows.length === 0 ? (
          <div data-board-list-empty="" className="px-1 py-2 text-ui-sm text-foreground-subtle">
            {intl.formatMessage({ id: "board.list.empty" })}
          </div>
        ) : (
          rows.map((node) => (
            <BoardListRow
              key={node.id}
              node={node}
              {...(onOpenCard ? { onOpenCard } : {})}
              highlightCardId={highlightCardId}
            />
          ))
        )}
      </div>
    </div>
  );
}
