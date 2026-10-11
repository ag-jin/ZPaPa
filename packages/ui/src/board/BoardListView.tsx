/**
 * 看板列表视图（卡 #33）：过滤（段位/状态/缺口码）+ 排序（updatedAt 卡龄）；
 * 卡 #34 补行点击 → 弹窗与跳转落点高亮（`boardCardInteraction` 一处生成的 props）；
 * 卡 #46 / 规则书 v2（B4）：**分组行（特性头 + 缩进子行，可折叠）**——同一计划分组内
 * 子行编号省略计划码前缀（B1），缩进按结构深度。
 * 卡 #168 / A4-1b：三层容器接线——epic 章 ⊃ 期次组 ⊃ 现有特性分组（裁决包 AD-1「四视图显式
 * 三层容器」）；容器装配走 `boardEpicContainers.assembleBoardEpicContainers`（与 tree 同一归组
 * 单点，禁二份实现），层头走 `BoardFeatureGroupHeaderContent` 的 `layer` 变体，折叠指示符收口到
 * 共享零件 `BoardFoldIndicator`（CR-S3）。无归属组照旧顶层平铺在前（AD-8；零 epic 板零变化）。
 *
 * 单一真源：消费契约 §13.2「列表」列（行首段位徽章、attention 置顶排序、待合并/受阻角标）+
 * §3.5（排序：attention 置顶 + updatedAt 倒序；「最老未动」第二视角）+ §3.1/§3.3（点击 → 弹窗）。
 * 判据全在纯函数层（`boardViewsViewModel`），本组件只投影 + 回传意图。
 */
import { cn } from "@/components/lib/utils.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { BoardListFilterControls } from "./BoardListFilterControls.js";
import { boardCardHighlightProps, boardCardOpenProps } from "./boardCardInteraction.js";
import { assembleBoardEpicContainers, type BoardEpicItemContainer } from "./boardEpicContainers.js";
import { BoardEpicLayerSection } from "./boardEpicLayerSections.js";
import {
  BoardFeatureGroupHeaderContent,
  BoardFoldIndicator,
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

/**
 * 子行缩进（结构深度）：depth=1（分组下行）→ `pl-3`，其后每层再 +3 级距。
 * depth=0（特性行）不走这里——分组头不是行；`pl-0` 仅为越界防御
 * （评审 #46 S-5：注释与实现对齐，不承诺「首层不缩进」）。
 */
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

/** 列表视图侧的容器成员分组：列表管线产出的特性分组（`buildBoardListGroups` 的形态）。 */
type BoardListGroupItem = {
  feature: BoardViewNode;
  nodes: BoardViewNode[];
  totalCards: number;
};

/** 分组行（B4）：特性头（折叠摘要）+ 可见子行；折叠态仍显示 `[N 张卡]` 摘要。 */
function BoardListGroup({
  feature,
  nodes,
  totalCards,
  nested = false,
  onOpenCard,
  highlightCardId,
}: {
  feature: BoardViewNode;
  nodes: BoardViewNode[];
  /** 特性卡总数（#59 S-1）：单点来自视图模型；组内行数是过滤后张数，两者含义不同。 */
  totalCards: number;
  /** 嵌入容器层（epic ⊃ 期次 ⊃ 稿；#168）：半径按 DESIGN.md 容器层级降一档。 */
  nested?: boolean;
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
      className={cn(
        "group border border-border/50 bg-surface/30",
        nested ? "rounded-md" : "rounded-xl",
      )}
    >
      <summary
        data-board-list-group-summary={feature.id}
        className="flex cursor-pointer list-none items-center gap-2 px-2 py-1.5 hover:bg-surface-hover"
      >
        {/* 折叠指示符（#55 S-3）：与树形/看板容器共用同一份零件（A4-1b 收口，CR-S3）。 */}
        <BoardFoldIndicator />
        {/* 点击分区（#54-4）：编号+名称区 = 开弹窗（preventDefault 保住不折叠）；段位/角标/计数区
            与 summary 空白 = 折叠/展开（不再被 preventDefault 吃掉——用户第四轮标注④）。 */}
        <BoardFeatureGroupHeaderContent
          feature={feature}
          cardCount={totalCards}
          titleRegionProps={{
            "data-board-card": feature.id,
            ...highlightProps,
            ...boardCardOpenProps({
              id: feature.id,
              ...(onOpenCard ? { onOpenCard } : {}),
              preventDefaultOnClick: true,
            }),
            ...(highlightClassName ? { className: highlightClassName } : {}),
          }}
        />
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

/**
 * 期次组（三层容器第二层；#168）：组头 = 合成层名（`KANB1`，AD-3）+ 该期实际承载稿数；
 * 体 = 期内特性分组（嵌入形态，半径降一档）。整行是折叠落点（期次不是卡：无弹窗落点）。
 * 容器装配走 `BoardEpicLayerSection` 单点（与 tree/看板同一份）。
 */
function BoardListPhaseSection({
  phase,
  onOpenCard,
  highlightCardId,
}: {
  phase: BoardEpicItemContainer<BoardListGroupItem>["phases"][number];
  onOpenCard?: (id: string) => void;
  highlightCardId: string | null;
}) {
  return (
    <BoardEpicLayerSection
      layer={{ kind: "phase", name: phase.name, planCount: phase.items.length }}
      title=""
      titleClassName="text-ui-xs font-medium text-foreground-subtle"
      className="group flex flex-col overflow-hidden rounded-lg border border-border/50"
      summaryClassName="flex cursor-pointer list-none items-center gap-2 px-2 py-1.5 hover:bg-surface-hover"
      bodyClassName="flex flex-col gap-1 px-1.5 pb-1.5"
    >
      {phase.items.map((group) => (
        <BoardListGroup
          key={group.feature.id}
          feature={group.feature}
          nodes={group.nodes}
          totalCards={group.totalCards}
          nested
          {...(onOpenCard ? { onOpenCard } : {})}
          highlightCardId={highlightCardId}
        />
      ))}
    </BoardEpicLayerSection>
  );
}

/**
 * epic 章（三层容器第一层；#168）：章头 = 登记行层名（4 位码）+ 标题 + 终态标注（§10.5）+
 * 稿数/期数；体 = 期次组（升序）。**epic 不是卡**：章头整行是折叠落点（epic 弹窗退化形态的
 * 容器侧承接：点击路由只走折叠，不落空跳转）。
 */
function BoardListEpicSection({
  container,
  onOpenCard,
  highlightCardId,
}: {
  container: BoardEpicItemContainer<BoardListGroupItem>;
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
      titleClassName="text-ui-base font-medium text-foreground"
      className="group flex flex-col overflow-hidden rounded-xl border border-border/60 bg-surface/40"
      summaryClassName="flex cursor-pointer list-none items-center gap-2 px-2 py-2 hover:bg-surface-hover"
      bodyClassName="flex flex-col gap-1.5 px-1.5 pb-1.5"
    >
      {container.phases.map((phase) => (
        <BoardListPhaseSection
          key={phase.name}
          phase={phase}
          {...(onOpenCard ? { onOpenCard } : {})}
          highlightCardId={highlightCardId}
        />
      ))}
    </BoardEpicLayerSection>
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
  // 三层容器装配（#168 单点）：无归属组顶层平铺在前（AD-8），epic 章按登记序、期次升序。
  const containers = assembleBoardEpicContainers(board, groups, (group) => group.feature.id);
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
          <>
            {containers.ungrouped.map((group) => (
              <BoardListGroup
                key={group.feature.id}
                feature={group.feature}
                nodes={group.nodes}
                totalCards={group.totalCards}
                {...(onOpenCard ? { onOpenCard } : {})}
                highlightCardId={highlightCardId}
              />
            ))}
            {containers.epics.map((container) => (
              <BoardListEpicSection
                key={container.epic.code}
                container={container}
                {...(onOpenCard ? { onOpenCard } : {})}
                highlightCardId={highlightCardId}
              />
            ))}
          </>
        )}
      </div>
    </div>
  );
}
