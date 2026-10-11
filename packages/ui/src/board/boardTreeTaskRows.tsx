/**
 * 树形视图的任务行装配（#175 拆文件不拆语义：`BoardTreeView` 逼近仓库 oxlint `max-lines`（400）
 * 上限，把「同级卡列表 → 行」这段整体搬出；对外导出面只有 `BoardSunkTaskRows` 一个）。
 *
 * 单一真源：
 * - 行骨架与缩进 = 消费契约 §3.1/§3.3（卡片行 + 最近执行行）+ 既有 `data-board-indent` 口径；
 * - 行序 = 卡 #65 的同级沉底（纯函数 `sinkCompletedTreeSiblings` 稳定分区，未完成保持文档序在前、
 *   已完成沉到同级末尾）；
 * - 弱分隔 = 卡 #175 ①（来源证据 T6465d design-review 第 2 条【归 #60】）：长组里已完成块与活卡
 *   的边界原先只靠位置 + 段位徽章表达，扫读容易把两块并成一段——在真实边界插一条最弱描边。
 */
import { Fragment } from "react";
import { cn } from "@/components/lib/utils.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { boardCardHighlightProps, boardCardOpenProps } from "./boardCardInteraction.js";
import { BoardNodeBadges, BoardNodeNumber, BoardStageBadge } from "./boardNodeParts.js";
import { formatBoardLastRunText } from "./boardPresentation.js";
import { BOARD_COMPLETED_STAGE, sinkCompletedTreeSiblings } from "./boardViewSorting.js";
import type { BoardTaskNode } from "./boardViewModel.js";

/** 缩进层级 → 左侧内边距（层级 = 结构深度：1 = 特性下第一层；不信 label 段数）。 */
const TASK_INDENT_CLASSES = ["pl-2", "pl-6", "pl-10", "pl-14"] as const;

function taskIndentClass(depth: number): string {
  const index = Math.min(Math.max(depth, 1), TASK_INDENT_CLASSES.length) - 1;
  return TASK_INDENT_CLASSES[index] ?? "pl-2";
}

function BoardTaskRow({
  task,
  planCode,
  onOpenCard,
  highlightCardId,
  nested,
}: {
  task: BoardTaskNode;
  /** 所属特性的计划码（短编号省略的是它的前缀；#46 B1）。 */
  planCode: string | null;
  onOpenCard?: (id: string) => void;
  highlightCardId: string | null;
  /**
   * 所在稿块是否嵌在容器层（epic ⊃ 期次）里（#90/A4-4 D6）：嵌着时最近圆角容器 = 稿块
   * （rounded-md），行降到 rounded-sm（DESIGN.md 半径阶梯逐级递减；不再 lg > md 倒挂）。
   */
  nested?: boolean;
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
          "flex flex-col gap-0.5 px-2 py-1.5 hover:bg-surface-hover",
          nested ? "rounded-sm" : "rounded-lg",
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
      {task.children.length > 0 ? (
        // 嵌套同级沉底（#65）同样逐层生效：已完成子卡沉到同级末尾，其余保持文档序；
        // 边界弱分隔（#175 ①）与章节组共用同一条渲染路径。
        <BoardSunkTaskRows
          tasks={task.children}
          planCode={planCode}
          {...(onOpenCard ? { onOpenCard } : {})}
          highlightCardId={highlightCardId}
          {...(nested ? { nested } : {})}
        />
      ) : null}
    </>
  );
}

/**
 * 同级卡列表的单点装配（#65 沉底 + #175 ① 弱分隔）：两处沉底点（章节子分组 / 嵌套子卡列表）
 * 共用同一条渲染路径。边界判据 = 沉底分区里第一张已完成卡的位置，且其前还有活卡——整组全完成
 * 的组没有「活卡 → 完成」的跨越，不插线（不造假边界）。
 */
export function BoardSunkTaskRows({
  tasks,
  planCode,
  onOpenCard,
  highlightCardId,
  nested,
}: {
  tasks: BoardTaskNode[];
  planCode: string | null;
  onOpenCard?: (id: string) => void;
  highlightCardId: string | null;
  nested?: boolean;
}) {
  const ordered = sinkCompletedTreeSiblings(tasks);
  const boundary = ordered.findIndex((task) => task.stage === BOARD_COMPLETED_STAGE);
  return (
    <>
      {ordered.map((task, index) => (
        <Fragment key={task.id}>
          {boundary > 0 && index === boundary ? <BoardCompletedDivider /> : null}
          <BoardTaskRow
            task={task}
            planCode={planCode}
            {...(onOpenCard ? { onOpenCard } : {})}
            highlightCardId={highlightCardId}
            {...(nested ? { nested } : {})}
          />
        </Fragment>
      ))}
    </>
  );
}

/**
 * 完成块弱分隔（#175 ①）：只加一条最弱描边（`border-border/40`，与表格行分隔同一 token；
 * DESIGN.md「优先文本层级、克制边框」下的弱分隔形态）——不加实心底色、不借成功色
 * （评审点名的反例：大面积成功色填充）。
 */
function BoardCompletedDivider() {
  return (
    <div
      data-board-completed-divider=""
      aria-hidden="true"
      className="mx-2 my-0.5 border-t border-border/40"
    />
  );
}
