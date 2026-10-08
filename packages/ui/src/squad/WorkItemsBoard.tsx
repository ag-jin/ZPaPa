import { useEffect, useRef, useState } from "react";
import type { WorkItem, WorkItemStatusCategory } from "@zcode/shared";
import type { SquadSnapshot } from "@zcode/services";
import { isSquadBatchRoot } from "@zcode/services";
import { Button } from "@/components/ui/button.js";
import { Input } from "@/components/ui/input.js";
import { cn } from "@/components/lib/utils.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { SUBAGENT_COLOR_CLASS, resolveSubagentColorFromName } from "@/lib/subagentColors.js";
import { SquadTimelineSection } from "./SquadTimelineSection.js";
import { parseAssigneeValue, resolveAssigneeName } from "./squadEntryViewModel.js";
import type { SquadEntryFeedback } from "./squadEntryViewModel.js";
import {
  WorkItemInlineEditFailureLine,
  WorkItemPriorityPicker,
} from "./WorkItemInlineEditParts.js";
import { useWorkItemInlineEdit } from "./useWorkItemInlineEdit.js";
import {
  workItemInlineEditUnavailableReason,
  type WorkItemInlineEditPatch,
} from "./workItemInlineEditViewModel.js";
import {
  workItemIdentifierText,
  workItemPriorityMessageId,
} from "./workItemPropertiesViewModel.js";
import {
  WORK_ITEM_STATUS_CATEGORY_MESSAGE_IDS,
  flattenWorkItemBoard,
  groupWorkItemBoard,
  workItemLabelChips,
  workItemLaneAssigneeName,
  workItemStatusMessageId,
  type WorkItemBoardRow,
  type WorkItemLaneDimension,
} from "./workItemsViewModel.js";

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

/** 行列表容器：**不留行间沟**（差距报告 §5 的密度口径）——分隔线相邻成列；
    留沟会把行拆成一块块卡片，hover surface 也跟着断开。 */
const LIST_CLASSNAME = "flex flex-col";
/* 行容器（差距报告 §5 的视觉 token）：**细分隔线 + hover surface** 的高密度列表行，
   不再是「一张小卡片」（`rounded-lg border border-border` 的包裹感 + 行间 gap 是低密度形态）；
   行高不小于 44px（可点目标下限；行级「打开详情」是整行覆盖按钮，命中区域要够大）。
   最后一行不给分隔线（列尾留一条悬空的线只在视觉上多余）。 */
const ROW_CLASSNAME =
  "flex min-h-11 flex-col justify-center gap-1.5 border-b border-border px-3 py-1.5 transition-colors last:border-b-0 hover:bg-hover";
/* 标签 chip 的**中性**外观（#11 v1）：只用 `border` / `foreground-subtlest` ——
   标签是**描述**，不是状态（spec §11.3：状态只由语义色表达；借 success / destructive 上色
   会让「这个标签」被读成「这件事成了 / 出事了」）。常量一处定义，看板与详情页共用同一个组件。 */
const WORK_ITEM_LABEL_CHIP_CLASSNAME =
  "shrink-0 rounded border border-border px-1.5 py-0.5 text-ui-xs text-foreground-subtlest";
/* 优先级徽标的**中性**外观（阶段一轮 C）：同样不借语义色 —— 优先级是**分类**，不是「成了/出事了」；
   借用 success / destructive 让某一档「看起来更响」会把档位读成故障（DESIGN：语义色只编码状态）。
   常量一处定义，看板行与详情概览共用同一个组件（见 `WorkItemPriorityBadge`）。 */
const WORK_ITEM_PRIORITY_BADGE_CLASSNAME =
  "rounded border border-border px-1.5 py-0.5 text-ui-xs text-foreground-subtle";
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
 * 工作项优先级徽标（**一处定义，两个面共用**：看板行与详情概览）；未设置（NULL）⇒ 不渲染。
 *
 * 为什么也放在本文件：与标签 chip 同一条理由 —— 外观属于「工作项行的呈现词汇」，看板是这套
 * 词汇的拥有者，详情页只该复用它（各写一份外观迟早长得不一样，且不会有人发现）。
 * `testId` 由调用方给：两个面的稳定锚点不同（行锚 `work-item-priority` / 概览锚带 `-detail-`），
 * 锚点是**面的属性**，不是徽标的属性。
 *
 * 三档语义在这里只说一件事：**档位文案**（闭集四档，映射穷尽在 `workItemPropertiesViewModel`）。
 * 闭集外的值（坏数据 / 未来新增档位的旧界面）⇒ 整个徽标不渲染：显示一个看不懂的裸 key
 * 只会让人以为那是个合法档位。
 */
export function WorkItemPriorityBadge({
  priority,
  testId,
}: {
  /** 工作项优先级原文（闭集判定在纯函数里；这里不猜、不折算）。 */
  priority: unknown;
  /** 本面的稳定锚点（e2e 依赖）。 */
  testId: string;
}) {
  const { intl } = useZCodeIntl();
  const messageId = workItemPriorityMessageId(priority);
  if (messageId === null) return null;
  return (
    <span className={WORK_ITEM_PRIORITY_BADGE_CLASSNAME} data-testid={testId}>
      {intl.formatMessage({ id: messageId })}
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
  laneDimension,
  focusWorkItemId,
  onFocusConsumed,
  onEdit,
  onInlineEdit,
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
  /** 分组维度（看板泳道，欠账 #15）：`none` = 现状（单 ul）；其余按泳道分组（只切根）。 */
  laneDimension: WorkItemLaneDimension;
  /** 收件箱穿透的**一次性聚焦意图**：哪一行要被滚到视野里 + 短暂高亮（`null` = 没有意图）。 */
  focusWorkItemId?: string | null;
  /** 聚焦消费回调：找到就滚 + 高亮后调；**目标不在列表也调**（父项被归档等 —— 不留悬挂意图）。 */
  onFocusConsumed?: () => void;
  onEdit: (item: WorkItem) => void;
  /** 行内编辑提交（阶段一轮 D）：**唯一写路径在页面** —— 本层不 import 服务、不拼请求，
      只把纯函数产出的 patch 交出去。返回 `null` = 写成功（页面已以服务回读刷新）；
      非 null = 就地失败原因（本层不清行、保留用户输入）。 */
  onInlineEdit: (
    item: WorkItem,
    patch: WorkItemInlineEditPatch,
  ) => Promise<SquadEntryFeedback | null>;
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

  /* 行内编辑态（阶段一轮 D）：**整块看板一份**（交互状态在 useWorkItemInlineEdit 里），
     且只在 `renderRow` 里被消费 —— 编辑器的 JSX 因此只出现一次（行渲染单点守卫继续成立）。 */
  const inlineEdit = useWorkItemInlineEdit({ onInlineEdit });

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
  // **只算一次**：两种视图（不分组 / 泳道）共用同一份判据输入。
  const runParentWorkItemIds = snapshot.runs.map((run) => run.parentWorkItemId);

  /**
   * 行渲染**单点**（欠账 #15 的硬守卫，2026-10-07）：不分组与泳道两个分支渲染的是**同一个**
   * 函数，行 JSX（含 `rowElementsRef` 注册、`data-work-item-id`、时间线钮、动作按钮、透明覆盖）
   * 只出现一次。复制一份「泳道版行渲染」能通过 typecheck，却会让焦点注册在其中一条路径上
   * 静默缺失 —— 收件箱「打开工作项」的滚动 + 高亮当场失效，而且不报错。
   */
  const renderRow = ({ item, depth }: WorkItemBoardRow) => {
    const assigneeName = resolveAssigneeName(snapshot, item.assignee);
    const busy = busyWorkItemId === item.id;
    const timelineExpanded = timelineExpandedWorkItemId === item.id;
    const labelChips = workItemLabelChips(item.labels);
    /* identifier（Q6：前缀不入库）：与详情概览**同一个**纯函数；未设置 ⇒ null ⇒ 不画。 */
    const identifierText = workItemIdentifierText(item.identifierSeq);
    /* 归档行不给行内编辑入口：判据复用详情写面同一份（`writeDisabledReason`），本层不写第二份。 */
    const inlineEditUnavailableReason = workItemInlineEditUnavailableReason(item);
    const titleDraft = inlineEdit.titleDraftOf(item);
    const inlineFailure = inlineEdit.failureOf(item);
    const priorityValue = inlineEdit.priorityValueOf(item);
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
            {/* identifier 在标题**之前**（它是这条记录的编号，等宽字形；DESIGN：标识符用 font-mono）。
                未设置（存量行）⇒ 不画，也不占位。 */}
            {identifierText === null ? null : (
              <span className="shrink-0 font-mono text-ui-xs text-foreground-subtlest">
                {identifierText}
              </span>
            )}
            {/* 标题（阶段一轮 D）：**行内编辑入口** —— 普通行是可点按钮（点开即编辑），
                归档行是纯文本（连入口都不给，且把原因写在 title 上）。
                编辑态在同一个位置换成输入框：blur / Enter 提交、Escape 恢复，期间事件不冒泡
                （行导航与全局快捷键不该吃这几个键；点进标题也不再打开详情 —— 这就是原文语义）。 */}
            {titleDraft !== null ? (
              <Input
                value={titleDraft}
                data-testid="work-item-title-input"
                aria-label={t("squad.common.title")}
                size="sm"
                autoFocus
                className="pointer-events-auto relative z-10 min-w-0"
                onChange={(event) => inlineEdit.changeTitleDraft(event.target.value)}
                {...inlineEdit.titleCompositionHandlers}
                onClick={(event) => event.stopPropagation()}
                onKeyDown={(event) => inlineEdit.handleTitleKeyDown(item, event)}
                onBlur={() => inlineEdit.commitTitleEdit(item)}
              />
            ) : inlineEditUnavailableReason === null ? (
              <button
                type="button"
                data-testid="work-item-title-edit"
                onClick={(event) => {
                  event.stopPropagation();
                  inlineEdit.beginTitleEdit(item);
                }}
                className="pointer-events-auto relative z-10 min-w-0 rounded-sm text-left break-words text-ui-base text-foreground hover:bg-hover focus-visible:ring-2 focus-visible:ring-brand"
              >
                {item.title}
              </button>
            ) : (
              <span
                className="break-words text-ui-base text-foreground"
                title={t(inlineEditUnavailableReason)}
              >
                {item.title}
              </span>
            )}
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
            {/* 优先级（阶段一轮 C 的徽标 + 阶段一轮 D 的**行内 picker**）：点徽标即入口。
                未设置给一枚中性占位 chip（不给入口就永远设不上这一档）；归档行只读（不给入口）。 */}
            {inlineEditUnavailableReason === null ? (
              <WorkItemPriorityPicker
                priority={priorityValue}
                busy={busy}
                onPick={(value) => inlineEdit.commitPriorityEdit(item, value)}
                unsetClassName={WORK_ITEM_PRIORITY_BADGE_CLASSNAME}
              >
                <WorkItemPriorityBadge priority={priorityValue} testId="work-item-priority" />
              </WorkItemPriorityPicker>
            ) : (
              <WorkItemPriorityBadge priority={item.priority} testId="work-item-priority" />
            )}
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
        {/* 行内编辑的**就地**失败原因（阶段一轮 D）：不清行 —— 用户能在原处改完再提交。 */}
        {inlineFailure === null ? null : <WorkItemInlineEditFailureLine failure={inlineFailure} />}
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
  };

  /* 不分组 = **现状 DOM 逐字保留**（单 `<ul data-testid="work-items-list">`，无泳道壳）：
     默认维度下所有既有用户看到的界面零变化 —— 「给出泳道」不等于「换掉看板」。 */
  if (laneDimension === "none") {
    return (
      <ul className={LIST_CLASSNAME} data-testid="work-items-list">
        {flattenWorkItemBoard(workItems).map(renderRow)}
      </ul>
    );
  }

  /** 泳道名：状态维度走穷尽的 category 文案；指派维度走 `resolveAssigneeName` 单源
      （`null` = 当前用户，由本地化文案补；未知对象的 id 后面补一句说明，避免被读成「没指派」）。 */
  const laneTitle = (key: string): string => {
    if (laneDimension === "statusCategory") {
      return t(WORK_ITEM_STATUS_CATEGORY_MESSAGE_IDS[key as WorkItemStatusCategory]);
    }
    if (key === "user") return t("squad.workItems.lane.assignee.user");
    const resolved = workItemLaneAssigneeName(snapshot, parseAssigneeValue(key));
    if (resolved.name === null) return t("squad.workItems.lane.assignee.user");
    return resolved.known
      ? resolved.name
      : resolved.name + t("squad.workItems.lane.assignee.unknownSuffix");
  };

  /* 泳道视图：只加「外层容器 + 头部」，行仍是上面那一个 renderRow（单点）。
     泳道**不做折叠**（v1）：行全部挂载 ⇒ `rowElementsRef` 完整，收件箱聚焦/高亮在任一视图下
     逐字不变（折叠会让「滚到目标行」在收起的目标上静默失效）。 */
  return (
    <div className="flex flex-col gap-3" data-testid="work-items-lanes">
      {groupWorkItemBoard({ items: workItems, dimension: laneDimension, roster: snapshot }).map(
        (lane) => (
          <section
            key={lane.key}
            className="flex flex-col gap-1"
            data-testid="work-items-lane"
            data-lane-key={lane.key}
          >
            <span className="flex items-center gap-2 px-1 text-ui-xs text-foreground-subtle">
              <span className="font-medium">{laneTitle(lane.key)}</span>
              <span className="text-foreground-subtlest">
                {t("squad.workItems.lane.count", { count: lane.count })}
              </span>
            </span>
            <ul className={LIST_CLASSNAME}>{lane.rows.map(renderRow)}</ul>
          </section>
        ),
      )}
    </div>
  );
}
