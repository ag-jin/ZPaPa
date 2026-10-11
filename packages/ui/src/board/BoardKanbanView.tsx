/**
 * 看板列视图（卡 #33）：七段位列（列 = 段位），节点按自身 `stage` 卡入列；
 * 卡 #34 补卡片点击 → 弹窗与跳转落点高亮（`boardCardInteraction` 一处生成的 props）；
 * 卡 #46 / 规则书 v2（B3）：列内按特性分组——**特性名做卡片分组头（非独立卡，不占一列位置）**，
 * 任务卡随分组行排布；跨列的任务用轻量分组标签带出特性名。
 * 卡 #168 / A4-1b：列内三层容器接线——epic 章 ⊃ 期次组 ⊃ 列内分组（裁决包 AD-1）；容器装配走
 * `boardEpicContainers.assembleBoardEpicContainers`（与 tree 同一归组单点，跨列轻量组同样按特性
 * 归属），层头走 `BoardFeatureGroupHeaderContent` 的 `layer` 变体、折叠指示符走共享零件。层计数 =
 * **本列实际承载**的成员稿数/期数（与渲染出来的子块逐一对齐——列内投影下同一 epic 头在不同列
 * 计数不同，诚实反映该列承载面）。无归属组照旧平铺在前（AD-8；零 epic 板零变化）。
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
import {
  BOARD_KANBAN_COLLAPSIBLE_STAGE,
  boardCardHighlightProps,
  boardCardOpenProps,
} from "./boardCardInteraction.js";
import { assembleBoardEpicContainers, type BoardEpicItemContainer } from "./boardEpicContainers.js";
import { BoardEpicLayerSection } from "./boardEpicLayerSections.js";
import {
  BoardFeatureGroupHeaderContent,
  BoardNodeBadges,
  BoardNodeNumber,
  BoardStageBadge,
} from "./boardNodeParts.js";
import { formatBoardStageText } from "./boardPresentation.js";
import type { BoardViewModel } from "./boardViewModel.js";
import {
  buildBoardKanban,
  type BoardKanbanColumn,
  type BoardKanbanGroup,
  type BoardViewNode,
} from "./boardViewsViewModel.js";

/**
 * 看板列根（七列同款，评审 #35-S1 二轮）：行内拉伸的定高 flex 列，列体 `overflow-y-auto`
 * 是列内唯一滚动容器。已完成列必须与六列共用这一条链——`<details>` 承载高度链在 Chromium
 * 里不生效（非 summary 内容在 UA 影子容器内，列体拿内容高、永不滚动），故改为条件渲染。
 */
const BOARD_KANBAN_COLUMN_CLASS =
  "flex w-56 shrink-0 flex-col rounded-xl border border-border/50 bg-background";

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
      data-board-kanban-card={node.id}
      data-board-card={node.id}
      {...highlightProps}
      {...boardCardOpenProps({ id: node.id, ...(onOpenCard ? { onOpenCard } : {}) })}
      className={cn(
        "flex flex-col gap-1 rounded-lg border border-border/50 bg-surface px-2 py-1.5",
        highlightClassName,
      )}
    >
      <div className="flex min-w-0 items-center gap-1.5">
        <BoardNodeNumber no={node.no} label={node.label} planCode={node.planCode} />
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

/**
 * 列内分组（B3）：分组头 = 特性名（非独立卡——没有卡片外壳，不占卡位）；
 * 特性自身段位在本列时分组头带自身徽章（可点开特性弹窗），跨列随行时只作轻量标签（#54-9/P-2）。
 *
 * 组头行允许 `flex-wrap`（#54-3）：w-56 列里「编号 + 名称 + 段位 + 徽章 + 计数」挤不下时，
 * 徽章落第二行——长徽章不得撑出列盒横向滚动。
 */
function BoardKanbanGroupBlock({
  group,
  showStatusRule,
  onOpenCard,
  highlightCardId,
}: {
  group: BoardKanbanGroup;
  showStatusRule: boolean;
  onOpenCard?: (id: string) => void;
  highlightCardId: string | null;
}) {
  const { className: highlightClassName, ...highlightProps } = boardCardHighlightProps(
    group.feature.id,
    highlightCardId,
  );
  return (
    <div data-board-kanban-group={group.feature.id} className="flex flex-col gap-1">
      <div
        data-board-kanban-group-header={group.feature.id}
        // 溢出防线锚点（#59 S-4）：守卫断言按 data 锚点判「组头行允许折行」，不绑 CSS 类名。
        data-board-overflow-wrap=""
        {...(!group.featureInColumn ? { "data-board-group-lightweight": "true" } : {})}
        data-board-card={group.feature.id}
        {...highlightProps}
        {...boardCardOpenProps({ id: group.feature.id, ...(onOpenCard ? { onOpenCard } : {}) })}
        className={cn(
          "flex min-w-0 flex-wrap items-center gap-1.5 rounded-md px-1 py-0.5",
          highlightClassName,
        )}
      >
        <BoardFeatureGroupHeaderContent
          feature={group.feature}
          cardCount={group.totalCards}
          lightweight={!group.featureInColumn}
        />
      </div>
      {group.nodes.map((node) => (
        <BoardKanbanCard
          key={node.id}
          node={node}
          showStatusRule={showStatusRule}
          {...(onOpenCard ? { onOpenCard } : {})}
          highlightCardId={highlightCardId}
        />
      ))}
    </div>
  );
}

/**
 * 期次组（列内三层容器第二层；#168）：组头 = 合成层名（`KANB1`，AD-3）+ 本列承载稿数；
 * 体 = 本列的期内分组。整行是折叠落点（期次不是卡：无弹窗落点；组头行允许折行见 #54-3）。
 * 容器装配走 `BoardEpicLayerSection` 单点（与 tree/列表同一份）。
 */
function BoardKanbanPhaseSection({
  phase,
  showStatusRule,
  onOpenCard,
  highlightCardId,
}: {
  phase: BoardEpicItemContainer<BoardKanbanGroup>["phases"][number];
  showStatusRule: boolean;
  onOpenCard?: (id: string) => void;
  highlightCardId: string | null;
}) {
  return (
    <BoardEpicLayerSection
      layer={{ kind: "phase", name: phase.name, planCount: phase.items.length }}
      title=""
      titleClassName="text-ui-xs font-medium text-foreground-subtle"
      className="group flex flex-col overflow-hidden rounded-md border border-border/50"
      summaryClassName="flex min-w-0 cursor-pointer list-none flex-wrap items-center gap-1.5 px-1 py-0.5 hover:bg-surface-hover"
      bodyClassName="flex flex-col gap-1 p-0.5"
      // 溢出防线锚点（#59 S-4）：w-56 列里层头行允许折行，不绑 CSS 类名判据。
      summaryProps={{ "data-board-overflow-wrap": "" }}
    >
      {phase.items.map((group) => (
        <BoardKanbanGroupBlock
          key={group.feature.id}
          group={group}
          showStatusRule={showStatusRule}
          {...(onOpenCard ? { onOpenCard } : {})}
          highlightCardId={highlightCardId}
        />
      ))}
    </BoardEpicLayerSection>
  );
}

/**
 * epic 章（列内三层容器第一层；#168）：章头 = 登记行层名 + 标题 + 终态标注（§10.5）+ 本列稿数/期数；
 * 体 = 期次组（升序）。**epic 不是卡**：章头整行是折叠落点（退化形态与 tree 同口径）。
 */
function BoardKanbanEpicSection({
  container,
  showStatusRule,
  onOpenCard,
  highlightCardId,
}: {
  container: BoardEpicItemContainer<BoardKanbanGroup>;
  showStatusRule: boolean;
  onOpenCard?: (id: string) => void;
  highlightCardId: string | null;
}) {
  return (
    <BoardEpicLayerSection
      layer={{
        kind: "epic",
        name: container.epic.code,
        planCount: container.items.length,
        phaseCount: container.phases.length,
        status: container.epic.status,
      }}
      title={container.epic.title}
      titleClassName="text-ui-xs font-medium text-foreground"
      className="group flex flex-col overflow-hidden rounded-lg border border-border/60 bg-surface/40"
      summaryClassName="flex min-w-0 cursor-pointer list-none flex-wrap items-center gap-1.5 px-1 py-1 hover:bg-surface-hover"
      bodyClassName="flex flex-col gap-1 p-0.5"
      // 溢出防线锚点（#59 S-4）：窄列层头行允许折行（与组头行同款）。
      summaryProps={{ "data-board-overflow-wrap": "" }}
    >
      {container.phases.map((phase) => (
        <BoardKanbanPhaseSection
          key={phase.name}
          phase={phase}
          showStatusRule={showStatusRule}
          {...(onOpenCard ? { onOpenCard } : {})}
          highlightCardId={highlightCardId}
        />
      ))}
    </BoardEpicLayerSection>
  );
}

function BoardKanbanColumnBody({
  board,
  column,
  onOpenCard,
  highlightCardId,
}: {
  board: BoardViewModel;
  column: BoardKanbanColumn;
  onOpenCard?: (id: string) => void;
  highlightCardId: string | null;
}) {
  const { intl } = useZCodeIntl();
  const cancelled = column.stage === "已取消";
  // 三层容器装配（#168 单点）：按列内实际承载的分组切容器（跨列轻量组同样按特性归属）。
  const containers = assembleBoardEpicContainers(board, column.groups, (group) => group.feature.id);
  return (
    <div className="flex min-h-0 flex-col gap-1.5 overflow-y-auto p-1.5">
      {containers.ungrouped.map((group) => (
        <BoardKanbanGroupBlock
          key={group.feature.id}
          group={group}
          showStatusRule={cancelled}
          {...(onOpenCard ? { onOpenCard } : {})}
          highlightCardId={highlightCardId}
        />
      ))}
      {containers.epics.map((container) => (
        <BoardKanbanEpicSection
          key={container.epic.code}
          container={container}
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

/**
 * 可折叠列的列头（评审 #35-S1 二轮）：状态化按钮，`aria-expanded` 表达展开态；
 * 缺省 handler 时按钮不折叠（视图仍可只读展示，与卡片打开态的退化口径一致）。
 */
function BoardKanbanToggleHeader({
  column,
  expanded,
  onToggle,
}: {
  column: BoardKanbanColumn;
  expanded: boolean;
  onToggle?: (expanded: boolean) => void;
}) {
  return (
    <button
      type="button"
      data-board-column-toggle={column.stage}
      aria-expanded={expanded}
      onClick={() => onToggle?.(!expanded)}
      className="flex items-center gap-1.5 px-1.5 py-1 text-left"
    >
      <BoardKanbanHeaderContent column={column} />
    </button>
  );
}

export function BoardKanbanView({
  board,
  onOpenCard,
  highlightCardId = null,
  completedExpanded = true,
  onCompletedExpandedChange,
}: {
  board: BoardViewModel;
  /** 卡片点击（打开弹窗）；缺省时看板退化为只读展示。 */
  onOpenCard?: (id: string) => void;
  /** 跳转落点（该卡带高亮锚点）。 */
  highlightCardId?: string | null;
  /** 「已完成」列展开态（宿主持有：跳转揭示要能先置展开；缺省展开 = 归档前默认可见）。 */
  completedExpanded?: boolean;
  onCompletedExpandedChange?: (expanded: boolean) => void;
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
          column.stage === BOARD_KANBAN_COLLAPSIBLE_STAGE ? (
            // 「已完成」列是可折叠分区（§13.2）：默认展开（归档前要看得见），列头按钮可折叠。
            // 折叠 = 条件渲染（列体整块不渲染），不是 CSS 藏起来：列根因此与六列同款 flex 链，
            // 列体照常拿到剩余高度、照常滚动（评审 #35-S1 二轮；浏览器行为断言见
            // `test/boardKanbanBrowserLayout.ts`）。跳转落点在折叠列里时由宿主先置展开态
            // （`boardRevealKanbanColumnIntent`）。
            <section
              key={column.stage}
              data-board-column={column.stage}
              className={BOARD_KANBAN_COLUMN_CLASS}
            >
              <BoardKanbanToggleHeader
                column={column}
                expanded={completedExpanded}
                {...(onCompletedExpandedChange ? { onToggle: onCompletedExpandedChange } : {})}
              />
              {completedExpanded ? (
                <BoardKanbanColumnBody
                  board={board}
                  column={column}
                  {...(onOpenCard ? { onOpenCard } : {})}
                  highlightCardId={highlightCardId}
                />
              ) : null}
            </section>
          ) : (
            <section
              key={column.stage}
              data-board-column={column.stage}
              // 「已取消」列灰显（§13.2）：取消不清理现场，灰显表达终态；锚点让守卫断言可辨。
              {...(column.stage === "已取消" ? { "data-board-column-muted": "true" } : {})}
              className={cn(BOARD_KANBAN_COLUMN_CLASS, column.stage === "已取消" && "opacity-70")}
            >
              <BoardKanbanHeader column={column} />
              <BoardKanbanColumnBody
                board={board}
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
