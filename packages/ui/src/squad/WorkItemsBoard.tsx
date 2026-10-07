import { useEffect, useRef, useState } from "react";
import type { WorkItem } from "@zcode/shared";
import type { SquadSnapshot } from "@zcode/services";
import { isSquadBatchRoot } from "@zcode/services";
import { Button } from "@/components/ui/button.js";
import { cn } from "@/components/lib/utils.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { SUBAGENT_COLOR_CLASS, resolveSubagentColorFromName } from "@/lib/subagentColors.js";
import { SquadTimelineSection } from "./SquadTimelineSection.js";
import { resolveAssigneeName } from "./squadEntryViewModel.js";
import { flattenWorkItemBoard, workItemLabelChips, workItemStatusMessageId } from "./workItemsViewModel.js";

/* 「工作项」页面的**纯呈现**看板（取数与动作都在 WorkItemsPage）。

   拆出来是为了两件事（与 SquadAgentsList / SquadsList 同款）：① 单文件不越 400 行；
   ② 列表与动作解耦后，「哪些行给哪些按钮」与「树怎么压平」只在共享纯函数里出现
   （`flattenWorkItemBoard` / `squadDiscardableWorkItemIds`），本层只照结论画。

   **空态在这里**（空看板 + 引导）：空态不是"没有内容"，而是"这里该有什么、怎么开始"
   的那句话，与列表是同一条渲染分支，分开写会漂移。

   **时间线的挂载点也在本层**（controller 2026-10-03 收口）：批根行给「时间线」展开钮，
   展开时在**该行下方**（同一个 `<li>` 内）渲染 `SquadTimelineSection`（它自己取数、收起即卸载）。
   「哪些行是批根」用服务面导出的**唯一实现** `isSquadBatchRoot`（与「放弃整批」、启动重驱
   同一份定义）—— 本层不得另写一份"什么是批"。

   缩进沿用 `WikiCatalogTree` 的既有手法（`paddingLeft: depth * 12 + 8` px）：深度由纯函数
   算好，本层只负责按它缩进 —— 组件里递归 = 不可测。

   **聚焦（收件箱「打开工作项」的落点）在本层**：只有这里拿着"渲染后的行"，"目标在不在列表"
   才答得准。`focusWorkItemId` 到了就 `scrollIntoView({ block: "nearest" })`（只滚最小距离）
   + 一条**短暂环形高亮**（语义色 token，§11.3；不是状态编码），然后调 `onFocusConsumed()`
   把意图清掉；**目标不在当前列表同样消费**（父项被归档等 —— 不留悬挂意图、不报错）。 */

const LIST_CLASSNAME = "flex flex-col gap-2";
/** 行容器：比所在卡片（rounded-xl）低一级（spec §11.3 的圆角层级）。 */
const ROW_CLASSNAME = "rounded-lg border border-border px-3 py-2";
/* 标签 chip 的**中性**外观（#11 v1）：只用 `border` / `foreground-subtlest` ——
   标签是**描述**，不是状态（spec §11.3：状态只由语义色表达；借 success / destructive 上色
   会让「这个标签」被读成「这件事成了 / 出事了」）。常量一处定义，看板与详情页共用同一个组件。 */
const WORK_ITEM_LABEL_CHIP_CLASSNAME =
  "shrink-0 rounded border border-border px-1.5 py-0.5 text-ui-xs text-foreground-subtlest";
/* 聚焦高亮的驻留时长（ms）：够看见"它在这里"，然后就消失 —— 高亮是**一次性提示**，
   不是状态编码（spec §11.3：状态只由语义色表达；这个环只借语义色 token 说"看这里"）。 */
const FOCUS_HIGHLIGHT_MS = 1600;

/**
 * 工作项标签 chip（**一处定义，两个面共用**：看板行与详情页概览）。
 *
 * 为什么放在本文件：chip 的外观属于「工作项行的呈现词汇」，而看板是这套词汇的拥有者
 * （`.zcode` 里第二个面 —— 详情页 —— 只该复用它，不得自带第二份 class 常量：两份外观迟早
 * 长得不一样，且不会有人发现）。它是**纯呈现**（无状态、无判据），故不违反「本文件是纯呈现层」。
 */
export function WorkItemLabelChip({ label }: { label: string }) {
  return (
    <span className={WORK_ITEM_LABEL_CHIP_CLASSNAME} data-testid="work-item-label">
      {label}
    </span>
  );
}

/**
 * 指派人前面的圆点（**只表达身份，不编码状态**，spec §11.3）：
 * · 智能体 ⇒ 实心点，用它自带的 `color`；未设色时按名字稳定取一个（照 SquadAgentsList）；
 * · 小队 ⇒ **没有 `color` 字段**（实体如此），用一个中性空心圆环（`border`，非九色板）——
 *   与智能体的实心点只差"型别"，不差"状态"；不替它编一个颜色（编出来的颜色是假的）；
 * · 用户 ⇒ 不画点（"我"由本地化文案表达，不需要身份色）。
 */
function AssigneeMarker({
  snapshot,
  assignee,
}: {
  snapshot: SquadSnapshot;
  assignee: WorkItem["assignee"];
}) {
  if (assignee.type === "user") return null;
  if (assignee.type === "agent") {
    const agent = snapshot.teamAgents.find((entry) => entry.id === assignee.id);
    return (
      <span
        className={cn(
          "size-2 shrink-0 rounded-full",
          SUBAGENT_COLOR_CLASS[
            agent?.color ?? resolveSubagentColorFromName(agent?.name ?? assignee.id)
          ],
        )}
        aria-hidden
      />
    );
  }
  return (
    <span className="size-2 shrink-0 rounded-full border border-foreground-subtlest" aria-hidden />
  );
}

export function WorkItemsBoard({
  workItems,
  snapshot,
  discardableIds,
  busyWorkItemId,
  timelineExpandedWorkItemId,
  focusWorkItemId,
  onFocusConsumed,
  onEdit,
  onReassign,
  onDiscard,
  onToggleTimeline,
  onOpenWorkItemDetail,
  workspacePath,
  workspaceIdentity,
  onOpenSession,
}: {
  workItems: WorkItem[];
  snapshot: SquadSnapshot;
  /** 「放弃整批」入口出现的工作项（判据见 `squadDiscardableWorkItemIds`：只有**破坏性**动作才需要判据）。 */
  discardableIds: ReadonlySet<string>;
  busyWorkItemId: string | null;
  /** 当前展开了时间线的那条批根（页面的**单一**状态：一次只展开一批，见 WorkItemsPage）。 */
  timelineExpandedWorkItemId: string | null;
  /** 收件箱穿透的**一次性聚焦意图**：哪一行要被滚到视野里 + 短暂高亮（`null` = 没有意图）。 */
  focusWorkItemId?: string | null;
  /** 聚焦消费回调：找到就滚 + 高亮后调；**目标不在列表也调**（父项被归档等 —— 不留悬挂意图）。 */
  onFocusConsumed?: () => void;
  onEdit: (item: WorkItem) => void;
  /** 点「改派」⇒ 交给页面打开改派对话框（本层不持有状态、也不执行服务调用）。 */
  onReassign: (item: WorkItem) => void;
  /** 点「放弃整批」⇒ **只进入待确认态**（本层拿不到服务，结构上不可能直接执行）。 */
  onDiscard: (workItemId: string) => void;
  /** 点「时间线」⇒ 交给页面切换展开态（同一条再点 = 收起；本层不持有状态）。 */
  onToggleTimeline: (item: WorkItem) => void;
  /** B5.1：打开这条工作项的详情页（页面 → App 的意图态；本层不持有导航状态）。 */
  onOpenWorkItemDetail: (workItemId: string) => void;
  /** 展开的时间线要查哪个 workspace（页面把 shell 给的目标原样透传）。 */
  workspacePath: string;
  workspaceIdentity?: string;
  /** 打开某次运行的会话（透传给时间线分区；不传 ⇒ 站点不可点）。 */
  onOpenSession?: (sessionId: string) => void;
}) {
  const { intl } = useZCodeIntl();
  const t = (id: string, values?: Record<string, string | number>) =>
    intl.formatMessage({ id }, values);

  /* 聚焦（收件箱「打开工作项」的落点）：行 DOM 引用按 id 收在 ref 里（不用 querySelector：
     它是字符串拼选择器，id 里将来出现特殊字符就静默找不到）。 */
  const rowElementsRef = useRef(new Map<string, HTMLLIElement>());
  /** 当前正在高亮的那一行（一次性提示，定时器到点清掉）。 */
  const [highlightedWorkItemId, setHighlightedWorkItemId] = useState<string | null>(null);
  const highlightTimerRef = useRef<number | null>(null);

  useEffect(() => {
    // 意图只在**有值**时消费一次；消费（或确认缺席）后由 onFocusConsumed 把意图清成 null。
    if (!focusWorkItemId) return;
    const row = rowElementsRef.current.get(focusWorkItemId);
    if (row) {
      // 只滚最小距离：聚焦一条不该把整页甩走（`nearest` 已在视野内则不动）。
      row.scrollIntoView({ block: "nearest" });
      setHighlightedWorkItemId(focusWorkItemId);
      if (highlightTimerRef.current !== null) window.clearTimeout(highlightTimerRef.current);
      highlightTimerRef.current = window.setTimeout(() => {
        setHighlightedWorkItemId(null);
        highlightTimerRef.current = null;
      }, FOCUS_HIGHLIGHT_MS);
    }
    /* **目标不在当前列表也消费**（父项被归档、条目引自别的 workspace 的旧意图等）：
       不消费会让意图挂在那里，下次进这一页又试一次（永远找不到、永远重试）；
       也不报错 —— "这条已经不在这份列表里"是合法事实，不是故障。 */
    onFocusConsumed?.();
  }, [focusWorkItemId, onFocusConsumed, workItems]);
  // 卸载时别把定时器留成孤儿（它 setState 的目标已经不在了）。
  useEffect(
    () => () => {
      if (highlightTimerRef.current !== null) window.clearTimeout(highlightTimerRef.current);
    },
    [],
  );

  if (workItems.length === 0) {
    return (
      <div className="flex flex-col gap-1" data-testid="work-items-empty">
        <p className="text-ui-base text-foreground">{t("squad.workItems.empty")}</p>
        <p className="text-ui-sm text-foreground-subtlest">{t("squad.workItems.emptyHint")}</p>
      </div>
    );
  }

  // 「是不是批根」的唯一输入：本 workspace 的 run 行按 parentWorkItemId 归拢（与页面
  // squadDiscardableWorkItemIds 同一份口径 —— 从 snapshot.runs 取，不另查一次）。
  const runParentWorkItemIds = snapshot.runs.map((run) => run.parentWorkItemId);

  return (
    <ul className={LIST_CLASSNAME} data-testid="work-items-list">
      {flattenWorkItemBoard(workItems).map(({ item, depth }) => {
        const assigneeName = resolveAssigneeName(snapshot, item.assignee);
        const busy = busyWorkItemId === item.id;
        const timelineExpanded = timelineExpandedWorkItemId === item.id;
        const labelChips = workItemLabelChips(item.labels);
        return (
          <li
            key={item.id}
            data-work-item-id={item.id}
            data-depth={depth}
            ref={(element) => {
              if (element) rowElementsRef.current.set(item.id, element);
              else rowElementsRef.current.delete(item.id);
            }}
            style={{ paddingLeft: `${depth * 12 + 8}px` }}
            className={cn(
              ROW_CLASSNAME,
              "flex flex-col gap-2",
              // 聚焦高亮：**语义色 token**（brand 环，照 WhiteboardPane 的既有手法），
              // 不引九色板、不编码状态 —— 它只回答"刚才是这一条"。
              highlightedWorkItemId === item.id && "ring-2 ring-brand",
            )}
          >
            {/* 行级「打开详情」：**透明覆盖按钮**（整行 button 会与行内既有按钮嵌套非法）。
                覆盖层只盖**标题行**（不含展开的时间线），动作区抬到 `relative z-10` ——
                点击命中是硬要求，不是样式偏好。 */}
            <div className="relative flex items-center justify-between gap-3">
              <button
                type="button"
                aria-label={intl.formatMessage(
                  { id: "squad.workItemDetail.activity.open" },
                  { title: item.title },
                )}
                data-testid="work-item-row-open-detail"
                onClick={() => onOpenWorkItemDetail(item.id)}
                className="absolute inset-0 z-0 rounded-lg focus-visible:ring-2 focus-visible:ring-brand"
              />
              <span className="pointer-events-none relative z-10 flex min-w-0 items-center gap-2">
                <span className="break-words text-ui-base text-foreground">{item.title}</span>
                {/* 标签（#11 v1）：中性 chip，最多 3 个 + 「+N」（截断投影在纯函数里；0 个 ⇒ 整块不渲染）。
                    放在标题**之后**、状态文案之前：标题是行的主信息，标签是它的修饰。 */}
                {labelChips.shown.length > 0 ? (
                  <span className="flex shrink-0 items-center gap-1">
                    {labelChips.shown.map((label) => (
                      <WorkItemLabelChip key={label} label={label} />
                    ))}
                    {labelChips.hiddenCount > 0 ? (
                      <span
                        className={WORK_ITEM_LABEL_CHIP_CLASSNAME}
                        data-testid="work-item-label-more"
                      >
                        {t("squad.workItems.labelsMore", { count: labelChips.hiddenCount })}
                      </span>
                    ) : null}
                  </span>
                ) : null}
                {/* 状态徽标：六态各自文案（`WORK_ITEM_STATUS_MESSAGE_IDS` 强制穷尽）。 */}
                <span className="shrink-0 text-ui-xs text-foreground-subtle">
                  {t(workItemStatusMessageId(item.status))}
                </span>
                <span className="flex shrink-0 items-center gap-1.5 text-ui-xs text-foreground-subtle">
                  <AssigneeMarker snapshot={snapshot} assignee={item.assignee} />
                  {/* `null` = 指派给当前用户；由这里的本地化文案补上，纯函数不碰 i18n。 */}
                  {assigneeName ?? t("squad.common.assignee.user")}
                </span>
              </span>
              <span className="relative z-10 flex shrink-0 items-center gap-2">
                {/* 时间线展开钮：**只在批根行**给（判据 = 服务面唯一实现 isSquadBatchRoot）。
                    展开的内容在行下方（同一个 <li> 内），收起即卸载（数据丢弃，无展开态记忆）。 */}
                {isSquadBatchRoot({ workItem: item, runParentWorkItemIds }) ? (
                  <Button
                    size="sm"
                    variant="outline"
                    aria-expanded={timelineExpanded}
                    data-testid="work-item-timeline-toggle"
                    onClick={() => onToggleTimeline(item)}
                  >
                    {t("squad.timeline.toggle")}
                  </Button>
                ) : null}
                <Button
                  size="sm"
                  variant="outline"
                  disabled={busy}
                  data-testid="work-item-edit"
                  onClick={() => onEdit(item)}
                >
                  {t("squad.common.edit")}
                </Button>
                {/* 改派：**所有行都给**（含子项）—— 改负责人是派发语义（改派 = 新派发），
                    与"改个错别字"（编辑）是两类动作，故单列一个钮；点它只把意图交给页面。 */}
                <Button
                  size="sm"
                  variant="outline"
                  disabled={busy}
                  data-testid="work-item-reassign"
                  onClick={() => onReassign(item)}
                >
                  {t("squad.workItems.reassign")}
                </Button>
                {/* 放弃整批：只给判据（纯函数）认下的行；点它**只进入待确认态**。 */}
                {discardableIds.has(item.id) ? (
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={busy}
                    data-testid="work-item-discard"
                    onClick={() => onDiscard(item.id)}
                  >
                    {t("squad.discard.action")}
                  </Button>
                ) : null}
              </span>
            </div>
            {/* 内联展开：本批历史（listSquadRuns by parentWorkItemId）的泳道时间线。 */}
            {timelineExpanded ? (
              <SquadTimelineSection
                workItemId={item.id}
                workspacePath={workspacePath}
                workspaceIdentity={workspaceIdentity}
                teamAgents={snapshot.teamAgents}
                workItems={snapshot.workItems}
                onOpenSession={onOpenSession}
              />
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}
