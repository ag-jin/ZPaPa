/**
 * 看板树形视图（卡 #32 tracer 的既有视图；卡 #34 补卡片点击与跳转高亮）。
 *
 * 单一真源：消费契约 §3.1/§3.3（特性节点行与卡片行骨架、缩进层级、最近执行行）+
 * §6（「点击节点/卡片 → 弹窗」）。判据（缩进层级、lastRun 文案、缺口徽章）全在纯函数层与
 * 共用零件（`boardNodeParts`），本组件只做投影 + 回传意图。
 */
import { Badge } from "@/components/ui/badge.js";
import { cn } from "@/components/lib/utils.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { boardCardHighlightProps, boardCardOpenProps } from "./boardCardInteraction.js";
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
  formatBoardActiveRunText,
  formatBoardLastRunText,
  formatBoardRunTime,
} from "./boardPresentation.js";
import type { BoardFeatureNode, BoardTaskNode, BoardViewModel } from "./boardViewModel.js";

/** 缩进层级 → 左侧内边距（层级=label 段数；未领号卡按第二层）。 */
const TASK_INDENT_CLASSES = ["pl-2", "pl-6", "pl-10", "pl-14"] as const;

function taskIndentClass(level: number): string {
  return (
    TASK_INDENT_CLASSES[Math.min(Math.max(level, 0), TASK_INDENT_CLASSES.length - 1)] ?? "pl-2"
  );
}

function BoardTaskRow({
  task,
  depth,
  onOpenCard,
  highlightCardId,
}: {
  task: BoardTaskNode;
  depth: number;
  onOpenCard?: (id: string) => void;
  highlightCardId: string | null;
}) {
  const { intl } = useZCodeIntl();
  const lastRunText = formatBoardLastRunText(task.lastRun, intl.formatMessage);
  const highlighted = boardCardHighlightProps(task.id, highlightCardId);
  return (
    <>
      <div
        data-board-task={task.id}
        data-board-card={task.id}
        data-board-indent={depth}
        {...highlighted}
        {...boardCardOpenProps({ id: task.id, ...(onOpenCard ? { onOpenCard } : {}) })}
        className={cn(
          "flex flex-col gap-0.5 rounded-lg px-2 py-1.5 hover:bg-surface-hover",
          taskIndentClass(depth),
          highlighted["data-board-card-highlight"] ? "bg-warning/15" : null,
        )}
      >
        <div className="flex min-w-0 items-center gap-2">
          <BoardNodeNumber no={task.no} label={task.label} />
          <span className="min-w-0 flex-1 truncate text-ui-sm text-foreground">{task.title}</span>
          <BoardStageBadge stage={task.stage} />
          {task.draft ? <BoardDraftBadge /> : null}
          <BoardAttentionBadges attention={task.attention} lastRun={task.lastRun} />
          <BoardBlockerBadge count={task.blockers.length} />
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
        <BoardTaskRow
          key={child.id}
          task={child}
          depth={depth + 1}
          {...(onOpenCard ? { onOpenCard } : {})}
          highlightCardId={highlightCardId}
        />
      ))}
    </>
  );
}

function BoardFeatureSection({
  feature,
  onOpenCard,
  highlightCardId,
}: {
  feature: BoardFeatureNode;
  onOpenCard?: (id: string) => void;
  highlightCardId: string | null;
}) {
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
      <div
        data-board-card={feature.id}
        {...boardCardHighlightProps(feature.id, highlightCardId)}
        {...boardCardOpenProps({ id: feature.id, ...(onOpenCard ? { onOpenCard } : {}) })}
        className="flex min-w-0 items-center gap-2 rounded-lg bg-surface px-2 py-1.5"
      >
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
          <BoardTaskRow
            key={task.id}
            task={task}
            depth={boardTaskLabelIndentLevel(task.label)}
            {...(onOpenCard ? { onOpenCard } : {})}
            highlightCardId={highlightCardId}
          />
        ))}
      </div>
    </section>
  );
}

export interface BoardTreeViewProps {
  board: BoardViewModel;
  /** 卡片点击（打开弹窗）；缺省时树形退化为只读展示。 */
  onOpenCard?: (id: string) => void;
  /** 跳转落点（该卡片元素带高亮锚点）。 */
  highlightCardId?: string | null;
}

/** 树形视图：特性节点（第一层）+ 其任务卡片（第二层及更深，按 label 段数缩进）。 */
export function BoardTreeView({ board, onOpenCard, highlightCardId = null }: BoardTreeViewProps) {
  return (
    <div data-board-view="tree" className="min-h-0 flex-1 overflow-y-auto px-3 py-3">
      {board.features.map((feature) => (
        <BoardFeatureSection
          key={feature.id}
          feature={feature}
          {...(onOpenCard ? { onOpenCard } : {})}
          highlightCardId={highlightCardId}
        />
      ))}
    </div>
  );
}
