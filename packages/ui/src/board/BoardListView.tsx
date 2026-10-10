/**
 * 看板列表视图（卡 #33）：过滤（段位/状态/缺口码）+ 排序（updatedAt 卡龄）；
 * 卡 #34 补行点击 → 弹窗与跳转落点高亮（`boardCardInteraction` 一处生成的 props）；
 * 卡 #46 / 规则书 v2（B4）：**分组行（特性头 + 缩进子行，可折叠）**——同一计划分组内
 * 子行编号省略计划码前缀（B1），缩进按结构深度。
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
  BoardFeatureGroupHeaderContent,
  BoardNodeBadges,
  BoardNodeNumber,
  BoardStageBadge,
} from "./boardNodeParts.js";
import type { BoardViewModel } from "./boardViewModel.js";
import {
  boardListControlsToQuery,
  buildBoardListGroups,
  EMPTY_BOARD_LIST_CONTROLS,
  type BoardListControls,
  type BoardViewNode,
} from "./boardViewsViewModel.js";

/** 子行缩进（结构深度）：分组行之下第一层不缩进，其后每层 +2 级间距。 */
const ROW_INDENT_CLASSES = ["pl-0", "pl-3", "pl-6", "pl-9"] as const;

function rowIndentClass(depth: number): string {
  const index = Math.min(Math.max(depth, 0), ROW_INDENT_CLASSES.length - 1);
  return ROW_INDENT_CLASSES[index] ?? "pl-0";
}

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
      data-board-indent={node.depth}
      {...highlightProps}
      {...boardCardOpenProps({ id: node.id, ...(onOpenCard ? { onOpenCard } : {}) })}
      className={cn(
        "flex flex-col gap-0.5 rounded-lg px-2 py-1.5 hover:bg-surface-hover",
        rowIndentClass(node.depth),
        highlightClassName,
      )}
    >
      <div className="flex min-w-0 items-center gap-2">
        {/* 行首段位徽章（§13.2 列表列）。 */}
        <BoardStageBadge stage={node.stage} />
        <BoardNodeNumber no={node.no} label={node.label} planCode={node.planCode} short />
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

/** 分组行（B4）：特性头（折叠摘要）+ 可见子行；折叠态仍显示 `[N 张卡]` 摘要。 */
function BoardListGroup({
  feature,
  nodes,
  onOpenCard,
  highlightCardId,
}: {
  feature: BoardViewNode;
  nodes: BoardViewNode[];
  onOpenCard?: (id: string) => void;
  highlightCardId: string | null;
}) {
  const { className: highlightClassName, ...highlightProps } = boardCardHighlightProps(
    feature.id,
    highlightCardId,
  );
  return (
    <details
      data-board-list-group={feature.id}
      open
      className="rounded-xl border border-border/50 bg-surface/30"
    >
      <summary
        data-board-list-group-summary={feature.id}
        className="flex cursor-pointer list-none items-center gap-2 px-2 py-1.5 hover:bg-surface-hover"
      >
        <div
          data-board-card={feature.id}
          {...highlightProps}
          {...boardCardOpenProps({
            id: feature.id,
            ...(onOpenCard ? { onOpenCard } : {}),
            preventDefaultOnClick: true,
          })}
          className={cn("flex min-w-0 flex-1 items-center gap-2", highlightClassName)}
        >
          <BoardFeatureGroupHeaderContent feature={feature} cardCount={nodes.length} />
        </div>
      </summary>
      <div className="flex flex-col gap-0.5 px-1 pb-1">
        {nodes.map((node) => (
          <BoardListRow
            key={node.id}
            node={node}
            {...(onOpenCard ? { onOpenCard } : {})}
            highlightCardId={highlightCardId}
          />
        ))}
      </div>
    </details>
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
  const groups = buildBoardListGroups(board, boardListControlsToQuery(controls));
  return (
    <div data-board-view="list" className="flex h-full min-h-0 flex-col">
      <div className="shrink-0 border-b border-border/50 px-3 py-2">
        <BoardListFilterControls controls={controls} onChange={onControlsChange ?? (() => {})} />
      </div>
      <div className="flex min-h-0 flex-1 flex-col gap-1.5 overflow-y-auto px-3 py-2">
        {groups.length === 0 ? (
          <div data-board-list-empty="" className="px-1 py-2 text-ui-sm text-foreground-subtle">
            {intl.formatMessage({ id: "board.list.empty" })}
          </div>
        ) : (
          groups.map((group) => (
            <BoardListGroup
              key={group.feature.id}
              feature={group.feature}
              nodes={group.nodes}
              {...(onOpenCard ? { onOpenCard } : {})}
              highlightCardId={highlightCardId}
            />
          ))
        )}
      </div>
    </div>
  );
}
