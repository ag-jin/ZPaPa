/**
 * 看板列视图（卡 #33）：七段位列（列 = 段位），节点按自身 `stage` 卡入列；
 * 卡 #34 补卡片点击 → 弹窗与跳转落点高亮（`boardCardInteraction` 一处生成的 props）。
 *
 * 单一真源：消费契约 §13.2「看板（列视图）」列 + §13.3（待设计列 = 访谈汇总子区）+
 * §13.4（待合并角标）+ §3.5（列内排序 attention 置顶 + updatedAt 倒序）。分组/排序全在
 * 纯函数层（`boardViewsViewModel`），本组件只做渲染。
 *
 * 空列策略（按 §13 成文）：**七列恒在，空列显示 0**——与仓库既有看板
 * （`squad/WorkItemsBoard.tsx` 的 statusCategory 空泳道保留）同款：骨架不随数据跳动。
 */
import { cn } from "@/components/lib/utils.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { boardCardHighlightProps, boardCardOpenProps } from "./boardCardInteraction.js";
import { BoardNodeBadges, BoardNodeNumber, BoardStageBadge } from "./boardNodeParts.js";
import { formatBoardStageText } from "./boardPresentation.js";
import type { BoardViewModel } from "./boardViewModel.js";
import {
  buildBoardKanban,
  type BoardKanbanColumn,
  type BoardViewNode,
} from "./boardViewsViewModel.js";

/** 列内卡片（紧凑形态，契约 §13.2/§3.3）：号 + 标题 + 段位徽章 + 缺口徽章（+ 该格要求的角标）。 */
function BoardKanbanCard({
  node,
  showStatusRule,
  onOpenCard,
  highlightCardId,
}: {
  node: BoardViewNode;
  /** 仅「已取消」列展示取消原因（§13.2）。 */
  showStatusRule: boolean;
  onOpenCard?: (id: string) => void;
  highlightCardId: string | null;
}) {
  const { className: highlightClassName, ...highlightProps } = boardCardHighlightProps(
    node.id,
    highlightCardId,
    { withBorder: true },
  );
  return (
    <div
      data-board-card={node.id}
      {...highlightProps}
      {...boardCardOpenProps({ id: node.id, ...(onOpenCard ? { onOpenCard } : {}) })}
      className={cn(
        "flex flex-col gap-1 rounded-lg border border-border/50 bg-surface px-2 py-1.5",
        highlightClassName,
      )}
    >
      <div className="flex min-w-0 items-center gap-1.5">
        <BoardNodeNumber no={node.no} label={node.label} />
        <span className="min-w-0 flex-1 truncate text-ui-sm text-foreground">{node.title}</span>
      </div>
      <div className="flex flex-wrap items-center gap-1">
        <BoardStageBadge stage={node.stage} />
        <BoardNodeBadges
          attention={node.attention}
          blockers={node.blockers.length}
          lastRun={node.lastRun}
          draft={node.draft}
          activeRunRole={node.activeRun?.role ?? null}
          status={node.status}
        />
      </div>
      {showStatusRule && node.statusRule ? (
        <div data-board-status-rule="" className="text-ui-xs text-foreground-subtle">
          {node.statusRule}
        </div>
      ) : null}
    </div>
  );
}

function BoardKanbanColumnBody({
  column,
  onOpenCard,
  highlightCardId,
}: {
  column: BoardKanbanColumn;
  onOpenCard?: (id: string) => void;
  highlightCardId: string | null;
}) {
  const { intl } = useZCodeIntl();
  const cancelled = column.stage === "已取消";
  return (
    <div className="flex min-h-0 flex-col gap-1.5 overflow-y-auto p-1.5">
      {column.nodes.map((node) => (
        <BoardKanbanCard
          key={node.id}
          node={node}
          showStatusRule={cancelled}
          {...(onOpenCard ? { onOpenCard } : {})}
          highlightCardId={highlightCardId}
        />
      ))}
      {column.nodes.length === 0 && column.interview === null ? (
        <div className="px-1 py-0.5 text-ui-xs text-foreground-subtle">0</div>
      ) : null}
      {column.interview ? (
        // 访谈汇总子区（§13.3）：一列多节点、默认折叠；计数取 attentionSummary（纯函数层已定）。
        // 摆在列尾：安排类节点是主列内容，汇总区是附加聚合。
        <details data-board-interview-summary="" className="rounded-lg border border-border/50">
          <summary className="flex cursor-pointer items-center gap-1.5 px-2 py-1 text-ui-xs text-foreground-subtle">
            <span className="min-w-0 flex-1 truncate">
              {intl.formatMessage({ id: "board.kanban.interviewSummary" })}
            </span>
            <span
              data-board-interview-count={column.interview.count}
              className="shrink-0 rounded-md bg-surface px-1.5 py-0.5 tabular-nums"
            >
              {column.interview.count}
            </span>
          </summary>
          <div className="flex flex-col gap-1.5 p-1.5 pt-0">
            {column.interview.nodes.map((node) => (
              <BoardKanbanCard
                key={node.id}
                node={node}
                showStatusRule={false}
                {...(onOpenCard ? { onOpenCard } : {})}
                highlightCardId={highlightCardId}
              />
            ))}
          </div>
        </details>
      ) : null}
    </div>
  );
}

/**
 * 列头内容（列名 = 段位词条 + 计数）：普通列与可折叠列（已完成）共用同一份。
 * 列名带 `data-board-column-title` 锚点（评审 #33-S2：测试与定位不绑 CSS 类）。
 */
function BoardKanbanHeaderContent({ column }: { column: BoardKanbanColumn }) {
  const { intl } = useZCodeIntl();
  const count = column.nodes.length + (column.interview?.nodes.length ?? 0);
  return (
    <>
      <span
        data-board-column-title=""
        className="min-w-0 flex-1 truncate text-ui-sm font-semibold text-foreground"
      >
        {formatBoardStageText(column.stage, intl.formatMessage)}
      </span>
      <span
        data-board-column-count={count}
        className="shrink-0 rounded-md bg-surface px-1.5 py-0.5 text-ui-xs tabular-nums text-foreground-subtle"
      >
        {count}
      </span>
    </>
  );
}

function BoardKanbanHeader({ column }: { column: BoardKanbanColumn }) {
  return (
    <div className="flex items-center gap-1.5 px-1.5 py-1">
      <BoardKanbanHeaderContent column={column} />
    </div>
  );
}

export function BoardKanbanView({
  board,
  onOpenCard,
  highlightCardId = null,
}: {
  board: BoardViewModel;
  /** 卡片点击（打开弹窗）；缺省时看板退化为只读展示。 */
  onOpenCard?: (id: string) => void;
  /** 跳转落点（该卡带高亮锚点）。 */
  highlightCardId?: string | null;
}) {
  const { intl } = useZCodeIntl();
  const { columns, unplacedCount } = buildBoardKanban(board);
  return (
    <div data-board-view="kanban" className="flex h-full min-h-0 flex-col">
      {unplacedCount > 0 ? (
        <div
          data-board-unplaced={unplacedCount}
          role="status"
          className="mx-3 mt-2 rounded-lg border border-warning/40 bg-warning/10 px-2 py-1 text-ui-xs text-foreground"
        >
          {intl.formatMessage({ id: "board.kanban.unplaced" }, { count: unplacedCount })}
        </div>
      ) : null}
      {/* 列：固定宽 + 容器横滚（仓库既有看板形态，squad/WorkItemsBoard 同款）。 */}
      <div className="flex min-h-0 flex-1 gap-3 overflow-x-auto px-3 py-3">
        {columns.map((column) =>
          column.stage === "已完成" ? (
            // 「已完成」列是可折叠分区（§13.2）：默认展开（归档前要看得见），用户可折叠。
            // 高度链（评审 #33-S5/#35-S1）：details 本身不挂 flex（跨浏览器风险），改挂 grid 两行
            // ——summary「auto」+ 内包 div「minmax(0,1fr)」；否则列体 overflow-y-auto 拿到 auto 高，
            // 内容溢出列盒且永不滚动。折叠列里的跳转落点由宿主在滚动前展开（`boardRevealDetailsIntent`）。
            <details
              key={column.stage}
              open
              data-board-column={column.stage}
              data-board-column-details={column.stage}
              className="grid w-56 shrink-0 grid-rows-[auto_minmax(0,1fr)] rounded-xl border border-border/50 bg-background"
            >
              <summary className="flex cursor-pointer items-center gap-1.5 px-1.5 py-1">
                <BoardKanbanHeaderContent column={column} />
              </summary>
              <div className="flex min-h-0 flex-col">
                <BoardKanbanColumnBody
                  column={column}
                  {...(onOpenCard ? { onOpenCard } : {})}
                  highlightCardId={highlightCardId}
                />
              </div>
            </details>
          ) : (
            <section
              key={column.stage}
              data-board-column={column.stage}
              // 「已取消」列灰显（§13.2）：取消不清理现场，灰显表达终态；锚点让守卫断言可辨。
              {...(column.stage === "已取消" ? { "data-board-column-muted": "true" } : {})}
              className={cn(
                "flex w-56 shrink-0 flex-col rounded-xl border border-border/50 bg-background",
                column.stage === "已取消" && "opacity-70",
              )}
            >
              <BoardKanbanHeader column={column} />
              <BoardKanbanColumnBody
                column={column}
                {...(onOpenCard ? { onOpenCard } : {})}
                highlightCardId={highlightCardId}
              />
            </section>
          ),
        )}
      </div>
    </div>
  );
}
