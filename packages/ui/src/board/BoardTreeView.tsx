/**
 * 看板树形视图（卡 #32 tracer 的既有视图；卡 #34 补卡片点击与跳转高亮；
 * 卡 #46 / 规则书 v2 改造：B2 特性折叠块 + 计划稿章节子分组 + B1 短编号；
 * 卡 #87 / A4-1：epic ⊃ 期次 ⊃ 稿三层容器落位——容器装配走 `boardEpicContainers`（A4-1b 三视图
 * 复用同一份），层头层名/计数走 `BoardFeatureGroupHeaderContent` 的层头扩展（同一份零件））。
 *
 * 单一真源：消费契约 §3.1/§3.3（特性节点行与卡片行骨架、最近执行行）+ §6（点击 → 弹窗）
 * + §13（卡片面字段清单，规则书 v2）+ markers.md §10（三层容器与归属对；无归属稿顶层平铺、
 * 不为孤儿造章——与 board.md 渲染口径同源）。判据（折叠默认态、章节分组、缩进层级、lastRun
 * 文案、缺口徽章）全在纯函数层与共用零件（`boardNodeParts`），本组件只做投影 + 回传意图。
 *
 * 折叠形态：三层容器（epic 章 / 期次组）与特性节点都是 `<details>` 大块（边框/背景把层级分开）。
 * 特性默认展开规则 —— 有 attention 缺口的特性展开、completed 特性折叠（attention 优先）；容器层
 * 默认展开（缺口不许被埋：成员缺口在展开的容器里可见；容器折叠是用户动作，不自算滚段位 rollup）。
 * 摘要在稿层显示 `[N 张卡]`（含嵌套）；容器层头显示层名（epic 码 / `KANB1` 合成名，AD-3）与
 * 层计数（稿数/期数）。epic 层**不是卡**：无稳定号、无弹窗落点——整行是折叠落点（点击路由退化
 * 为折叠切换）。跳转落在折叠块内时由宿主先置开（`boardRevealDetailsIntent`）。
 *
 * 完成沉底（#65，卡「完成沉底全视图落实」）：树形是**结构序**视图——特性大块、章节子分组与
 * 其余卡片的文档序都不重排；「已完成沉底」只作用于**同级组**（章节分组内、嵌套子卡列表内），
 * 由纯函数 `sinkCompletedTreeSiblings` 一处判定（稳定分区）。
 */
import { cn } from "@/components/lib/utils.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { boardCardHighlightProps, boardCardOpenProps } from "./boardCardInteraction.js";
import {
  groupBoardFeaturesByEpic,
  type BoardEpicGroup,
  type BoardPhaseGroup,
} from "./boardEpicContainers.js";
import { BoardEpicLayerSection } from "./boardEpicLayerSections.js";
import {
  BoardFeatureGroupHeaderContent,
  BoardFoldIndicator,
  BoardNodeBadges,
  BoardNodeNumber,
  BoardStageBadge,
} from "./boardNodeParts.js";
import { formatBoardLastRunText, formatBoardRunTime } from "./boardPresentation.js";
import { countBoardFeatureTasks } from "./boardViewsViewModel.js";
import { sinkCompletedTreeSiblings } from "./boardViewSorting.js";
import type { BoardFeatureNode, BoardTaskNode, BoardViewModel } from "./boardViewModel.js";

/** 缩进层级 → 左侧内边距（层级 = 结构深度：1 = 特性下第一层；不信 label 段数）。 */
const TASK_INDENT_CLASSES = ["pl-2", "pl-6", "pl-10", "pl-14"] as const;

function taskIndentClass(depth: number): string {
  const index = Math.min(Math.max(depth, 1), TASK_INDENT_CLASSES.length) - 1;
  return TASK_INDENT_CLASSES[index] ?? "pl-2";
}

/**
 * 特性折叠默认态（B2，纯函数单点）：有 attention 缺口 → 展开（缺口不许被埋）；
 * completed → 折叠；其余展开（默认可见）。attention 优先于 completed。
 */
export function boardFeatureDefaultExpanded(feature: {
  attention: readonly unknown[];
  stage: string | null;
}): boolean {
  return feature.attention.length > 0 || feature.stage !== "已完成";
}

/**
 * 章节子分组（B2 数据面 = `task.section`）：按文档序**首次出现位置**成组；无章节任务的无头分组
 * 位置 = 其首个成员在文档里的位置（文档序在前时它自然排在首个有名字的章节之前，但不强制置前
 * ——评审 #46 P-6：注释承诺与实现一致）。
 */
export function groupBoardTasksBySection(
  tasks: BoardTaskNode[],
): Array<{ section: string | null; tasks: BoardTaskNode[] }> {
  const groups: Array<{ section: string | null; tasks: BoardTaskNode[] }> = [];
  const bySection = new Map<string | null, { section: string | null; tasks: BoardTaskNode[] }>();
  for (const task of tasks) {
    const key = task.section;
    let group = bySection.get(key);
    if (!group) {
      group = { section: key, tasks: [] };
      bySection.set(key, group);
      groups.push(group);
    }
    group.tasks.push(task);
  }
  return groups;
}

function BoardTaskRow({
  task,
  planCode,
  onOpenCard,
  highlightCardId,
}: {
  task: BoardTaskNode;
  /** 所属特性的计划码（短编号省略的是它的前缀；#46 B1）。 */
  planCode: string | null;
  onOpenCard?: (id: string) => void;
  highlightCardId: string | null;
}) {
  const { intl } = useZCodeIntl();
  const lastRunText = formatBoardLastRunText(task.lastRun, intl.formatMessage);
  const cancelReasonText = task.stage === "已取消" ? task.statusRule : null;
  const { className: highlightClassName, ...highlightProps } = boardCardHighlightProps(
    task.id,
    highlightCardId,
  );
  return (
    <>
      <div
        data-board-task={task.id}
        data-board-card={task.id}
        data-board-indent={task.depth}
        {...highlightProps}
        {...boardCardOpenProps({ id: task.id, ...(onOpenCard ? { onOpenCard } : {}) })}
        className={cn(
          "flex flex-col gap-0.5 rounded-lg px-2 py-1.5 hover:bg-surface-hover",
          taskIndentClass(task.depth),
          highlightClassName,
        )}
      >
        <div className="flex min-w-0 items-center gap-2">
          <BoardNodeNumber no={task.no} label={task.label} planCode={planCode} short />
          <span className="min-w-0 flex-1 truncate text-ui-sm text-foreground">{task.title}</span>
          <BoardStageBadge stage={task.stage} />
          <BoardNodeBadges
            attention={task.attention}
            blockers={task.blockers.length}
            lastRun={task.lastRun}
            draft={task.draft}
            activeRunRole={task.activeRun?.role ?? null}
            status={task.status}
          />
        </div>
        {lastRunText ? (
          <div className="truncate font-mono text-ui-xs text-foreground-subtle">{lastRunText}</div>
        ) : null}
        {cancelReasonText ? (
          // §13.2 树形「已取消」格：节点行尾徽章 + 取消原因（与列表/看板同一字段 statusRule）。
          <div data-board-status-rule="" className="truncate text-ui-xs text-foreground-subtle">
            {cancelReasonText}
          </div>
        ) : null}
      </div>
      {task.children.length > 0
        ? // 嵌套同级沉底（#65）同样逐层生效：已完成子卡沉到同级末尾，其余保持文档序。
          sinkCompletedTreeSiblings(task.children).map((child) => (
            <BoardTaskRow
              key={child.id}
              task={child}
              planCode={planCode}
              {...(onOpenCard ? { onOpenCard } : {})}
              highlightCardId={highlightCardId}
            />
          ))
        : null}
    </>
  );
}

function BoardFeatureSection({
  feature,
  onOpenCard,
  highlightCardId,
  nested = false,
}: {
  feature: BoardFeatureNode;
  onOpenCard?: (id: string) => void;
  highlightCardId: string | null;
  /**
   * 嵌入容器层（epic ⊃ 期次 ⊃ 稿；#87）：半径按 DESIGN.md 容器层级降一档（rounded-xl → rounded-md），
   * 纵向间距交给容器（gap）而不是块自身的下边距——顶层形态（无 epic 板）逐字不变。
   */
  nested?: boolean;
}) {
  const { intl } = useZCodeIntl();
  const { className: highlightClassName, ...highlightProps } = boardCardHighlightProps(
    feature.id,
    highlightCardId,
  );
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
  // 特性卡总数（#59 S-1）：单点来自视图模型（与看板/列表/表格组头同一口径）。
  const cardCount = countBoardFeatureTasks(feature);
  const groups = groupBoardTasksBySection(feature.tasks);
  return (
    <details
      data-board-feature={feature.id}
      data-board-feature-block={feature.id}
      open={boardFeatureDefaultExpanded(feature) || undefined}
      // 折叠大块（B2）：边框 + 背景把特性与子卡分开，视觉上独立于子卡。
      // 高亮底色只落在标题落点上（#59 S-5：与列表同款，不在块与落点叠两遍）。
      className={cn(
        "group flex flex-col overflow-hidden border border-border/60 bg-surface/40",
        nested ? "rounded-md" : "mb-3 rounded-xl",
      )}
    >
      <summary
        data-board-feature-block-summary={feature.id}
        className="flex cursor-pointer list-none items-center gap-2 px-2 py-2 hover:bg-surface-hover"
      >
        {/* 折叠指示符（#55 S-3）：与容器层头共用一份零件（BoardFoldIndicator）。 */}
        <BoardFoldIndicator />
        {/* 特性头 = 打开弹窗的落点（preventDefault：点它不触发折叠切换——那是 summary 的默认动作）。
            #54-4 点击分区与列表一致：编号+名称+执行者区 = 开弹窗；段位/角标/计数区 = 折叠。
            #55 S-2：分组头内容走共用零件（差异作 props：base 字号 + 当前执行者附加片）。 */}
        <BoardFeatureGroupHeaderContent
          feature={feature}
          cardCount={cardCount}
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
          titleClassName="text-ui-base font-medium text-foreground"
          titleAccessory={
            feature.currentAssignee !== null ? (
              <span
                data-board-feature-assignee={feature.currentAssignee}
                className="shrink-0 text-ui-xs font-medium text-primary"
              >
                {feature.currentAssignee}
              </span>
            ) : null
          }
        />
      </summary>
      {feature.stage === "已取消" && feature.statusRule ? (
        // §13.2 树形「已取消」格：节点行尾徽章 + 取消原因（与列表/看板同一字段 statusRule）。
        <div data-board-status-rule="" className="truncate px-2 text-ui-xs text-foreground-subtle">
          {feature.statusRule}
        </div>
      ) : null}
      {updatedAtText || progressText ? (
        <div className="px-2 text-ui-xs text-foreground-subtle">
          {[updatedAtText, progressText].filter(Boolean).join(" · ")}
        </div>
      ) : null}
      <div className="flex flex-col">
        {groups.map((group) => (
          <section
            key={group.section ?? "__no_section__"}
            {...(group.section !== null ? { "data-board-section": group.section } : {})}
            className="flex flex-col"
          >
            {group.section !== null ? (
              // 计划稿章节子分组头（B2）：章节名来自计划稿标题（board.json 的 section 字段）
              <div className="px-2 pt-1.5 pb-0.5 text-ui-xs font-medium text-foreground-subtle">
                {group.section}
              </div>
            ) : null}
            {sinkCompletedTreeSiblings(group.tasks).map((task) => (
              <BoardTaskRow
                key={task.id}
                task={task}
                planCode={feature.planCode}
                {...(onOpenCard ? { onOpenCard } : {})}
                highlightCardId={highlightCardId}
              />
            ))}
          </section>
        ))}
      </div>
    </details>
  );
}

/**
 * 期次组（三层容器第二层；#87）：组头 = 合成层名（`KANB1`，AD-3）+ 该期稿数；体 = 期内稿块。
 * 整行是折叠落点（期次不是卡）；稿块嵌入形态（半径降一档，间距交给容器 gap）。
 * #168 起容器装配走 `BoardEpicLayerSection` 单点（树形/列表/看板共用；差异全在类名与字号）。
 */
function BoardPhaseSection({
  phase,
  onOpenCard,
  highlightCardId,
}: {
  phase: BoardPhaseGroup;
  onOpenCard?: (id: string) => void;
  highlightCardId: string | null;
}) {
  return (
    <BoardEpicLayerSection
      layer={{ kind: "phase", name: phase.name, planCount: phase.features.length }}
      title=""
      titleClassName="text-ui-xs font-medium text-foreground-subtle"
      className="group flex flex-col overflow-hidden rounded-lg border border-border/50"
      summaryClassName="flex cursor-pointer list-none items-center gap-2 px-2 py-1.5 hover:bg-surface-hover"
      bodyClassName="flex flex-col gap-1.5 px-1.5 pb-1.5"
    >
      {phase.features.map((feature) => (
        <BoardFeatureSection
          key={feature.id}
          feature={feature}
          nested
          {...(onOpenCard ? { onOpenCard } : {})}
          highlightCardId={highlightCardId}
        />
      ))}
    </BoardEpicLayerSection>
  );
}

/**
 * epic 章（三层容器第一层；#87）：章头 = 登记行层名（4 位码）+ 标题 + 终态标注（§10.5）+ 稿数/期数；
 * 体 = 期次组（升序）。**epic 不是卡**：无稳定号、无弹窗落点——章头整行是折叠落点（epic 弹窗退化
 * 形态的容器侧承接：点击路由只走折叠，不落空跳转）。
 */
function BoardEpicSection({
  group,
  onOpenCard,
  highlightCardId,
}: {
  group: BoardEpicGroup;
  onOpenCard?: (id: string) => void;
  highlightCardId: string | null;
}) {
  return (
    <BoardEpicLayerSection
      layer={{
        kind: "epic",
        name: group.epic.code,
        planCount: group.members.length,
        phaseCount: group.phases.length,
        status: group.epic.status,
      }}
      title={group.epic.title}
      titleClassName="text-ui-base font-medium text-foreground"
      className="group mb-3 flex flex-col overflow-hidden rounded-xl border border-border/60 bg-surface/40"
      summaryClassName="flex cursor-pointer list-none items-center gap-2 px-2 py-2 hover:bg-surface-hover"
      bodyClassName="flex flex-col gap-2 px-2 pb-2"
    >
      {group.phases.map((phase) => (
        <BoardPhaseSection
          key={phase.phase}
          phase={phase}
          {...(onOpenCard ? { onOpenCard } : {})}
          highlightCardId={highlightCardId}
        />
      ))}
    </BoardEpicLayerSection>
  );
}

export interface BoardTreeViewProps {
  board: BoardViewModel;
  /** 卡片点击（打开弹窗）；缺省时树形退化为只读展示。 */
  onOpenCard?: (id: string) => void;
  /** 跳转落点（该卡片元素带高亮锚点）。 */
  highlightCardId?: string | null;
}

/**
 * 树形视图：三层容器（epic 章 ⊃ 期次组 ⊃ 特性折叠块，按归属对归组）+ 章节子分组 + 任务卡片
 * （按结构深度缩进）。无归属稿（含孤儿引用/稳定号引用）顶层平铺在前、文档序——与 board.md 同序
 * （A3-2/#85）；零 epic 项目零变化（AD-8）。
 */
export function BoardTreeView({ board, onOpenCard, highlightCardId = null }: BoardTreeViewProps) {
  const grouping = groupBoardFeaturesByEpic(board);
  return (
    <div data-board-view="tree" className="min-h-0 flex-1 overflow-y-auto px-3 py-3">
      {grouping.ungrouped.map((feature) => (
        <BoardFeatureSection
          key={feature.id}
          feature={feature}
          {...(onOpenCard ? { onOpenCard } : {})}
          highlightCardId={highlightCardId}
        />
      ))}
      {grouping.epics.map((group) => (
        <BoardEpicSection
          key={group.epic.code}
          group={group}
          {...(onOpenCard ? { onOpenCard } : {})}
          highlightCardId={highlightCardId}
        />
      ))}
    </div>
  );
}
