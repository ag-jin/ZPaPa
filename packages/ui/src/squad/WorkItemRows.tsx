import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { WorkItem } from "@zcode/shared";
import { isSquadBatchRoot } from "@zcode/services";
import { Button } from "@/components/ui/button.js";
import { Input } from "@/components/ui/input.js";
import { cn } from "@/components/lib/utils.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { SquadTimelineSection } from "./SquadTimelineSection.js";
import { resolveAssigneeName } from "./squadEntryViewModel.js";
import {
  WorkItemInlineEditFailureLine,
  WorkItemPriorityPicker,
} from "./WorkItemInlineEditParts.js";
import {
  AssigneeMarker,
  WorkItemRowSelect,
  WorkItemTableTimelineRow,
  type WorkItemRowEnvironment,
  type WorkItemRowFocus,
} from "./workItemRowParts.js";
import { workItemInlineEditUnavailableReason } from "./workItemInlineEditViewModel.js";
import {
  workItemIdentifierText,
  workItemPriorityMessageId,
} from "./workItemPropertiesViewModel.js";
import {
  workItemLabelChips,
  workItemStatusMessageId,
  type WorkItemBoardRow,
} from "./workItemsViewModel.js";

/* 行环境 / 聚焦注册表的**类型**从 `workItemRowParts` 转出（那里是它们的新家：见该文件头
   「为什么这些不放在 WorkItemRows 里」），消费方仍从本模块 import —— 契约的入口不变。 */
export type { WorkItemRowEnvironment, WorkItemRowFocus } from "./workItemRowParts.js";

/* 工作项**行的呈现词汇与行渲染**（阶段二 · T-P2-R1 抽件）：**跨三视图共用的唯一模块**。

   为什么要有这个模块（口径从「Board 内单点」改为「跨三视图共用同一模块」）：
   阶段一的行渲染是 `WorkItemsBoard` 里的一个 `renderRow`，守卫断言「看板文件里恰一处」。
   阶段二起三个视图（board / list / table）都要渲染**同一批行**；若各自复制一份行 JSX，
   typecheck 照样通过，但聚焦注册（`rowElementsRef`）会在某条路径上**静默缺失** ——
   收件箱「打开工作项」的滚动 + 高亮当场失效且不报错。所以行 JSX、行 DOM 引用、聚焦消费
   全部收进本模块：三视图只决定「行从哪来、外面套什么壳」，行本身**只有一份实现**。

   本模块同时是**行词汇的拥有者**（标签 chip / 优先级徽标的外观常量与组件）：详情页概览复用
   `WorkItemLabelChip` / `WorkItemPriorityBadge`，不得自带第二份 class 常量（两份外观迟早
   长得不一样，且不会有人发现）。

   缩进沿用 `WikiCatalogTree` 的既有手法（`paddingLeft: depth * 12 + 8` px）：深度由纯函数算好，
   本层只负责按它缩进 —— 组件里递归 = 不可测。

   **结构纪律（T-P2-R5 起显式写在文件头，后续轮必读）**：行容器的**孩子槽位**是行为的一部分 ——
   React 把「这一层的孩子数」编进 `useId`（SSR 实测：同一棵子树，兄弟数从 1 变 2 会把 Radix 的
   `aria-controls` 从 `_R_0_` 变成 `_R_2_`），所以**多一个槽位（哪怕渲染成 null）也会让默认路径的
   锚点漂移**，`workItemsSurfaceBaseline` 的逐字节对照当场红。三条落地：
   ① 列表行**直接返回那个 `<li>`**（不套 Fragment；表格布局才有第二个 `<tr>`）；
   ② 新增行级件（本轮的勾选件）与已有的「打开详情」覆盖层**共用第一个槽位**（三元分支），
      不是并排两个槽位；
   ③ 未进入批量模式时整个槽位序列与今天**逐槽相同**（`selection` 缺席 ⇒ 不渲染勾选件）。 */

/** 行列表容器：**不留行间沟**（差距报告 §5 的密度口径）——分隔线相邻成列；
    留沟会把行拆成一块块卡片，hover surface 也跟着断开。 */
const LIST_CLASSNAME = "flex flex-col";
/* 行容器（差距报告 §5 的视觉 token）：**细分隔线 + hover surface** 的高密度列表行，
   不再是「一张小卡片」（`rounded-lg border border-border` 的包裹感 + 行间 gap 是低密度形态）；
   行高不小于 44px（可点目标下限；行级「打开详情」是整行覆盖按钮，命中区域要够大）。
   最后一行不给分隔线（列尾留一条悬空的线只在视觉上多余）。 */
const ROW_CLASSNAME =
  "flex min-h-11 flex-col justify-center gap-1.5 border-b border-border px-3 py-1.5 transition-colors last:border-b-0 hover:bg-hover";
/* 表格布局的行（T-P2-R3）：`<tr>` 不接受 padding/圆角，故行只保留 hover 与过渡；
   分隔线、行高（44px 可点目标下限）落在**单元格**上（数据格与动作格都在 `WorkItemTableCell`）。 */
const TABLE_ROW_CLASSNAME = "transition-colors hover:bg-hover";
/* 标签 chip 的**中性**外观（#11 v1）：只用 `border` / `foreground-subtlest` ——
   标签是**描述**，不是状态（spec §11.3：状态只由语义色表达；借 success / destructive 上色
   会让「这个标签」被读成「这件事成了 / 出事了」）。常量一处定义，三视图与详情页共用同一个组件。 */
const WORK_ITEM_LABEL_CHIP_CLASSNAME =
  "shrink-0 rounded border border-border px-1.5 py-0.5 text-ui-xs text-foreground-subtlest";
/* 优先级徽标的**中性**外观（阶段一轮 C）：同样不借语义色 —— 优先级是**分类**，不是「成了/出事了」；
   借用 success / destructive 让某一档「看起来更响」会把档位读成故障（DESIGN：语义色只编码状态）。
   常量一处定义，行与详情概览共用同一个组件（见 `WorkItemPriorityBadge`）。 */
const WORK_ITEM_PRIORITY_BADGE_CLASSNAME =
  "rounded border border-border px-1.5 py-0.5 text-ui-xs text-foreground-subtle";
/* 聚焦高亮的驻留时长（ms）：够看见"它在这里"，然后就消失 —— 高亮是**一次性提示**，
   不是状态编码（spec §11.3：状态只由语义色表达；这个环只借语义色 token 说"看这里"）。 */
const FOCUS_HIGHLIGHT_MS = 1600;

/**
 * 工作项标签 chip（**一处定义，多面共用**：三视图的行与详情页概览）。
 * 它是**纯呈现**（无状态、无判据），故不违反「本模块是行呈现层」。
 */
export function WorkItemLabelChip({ label }: { label: string }) {
  return (
    <span className={WORK_ITEM_LABEL_CHIP_CLASSNAME} data-testid="work-item-label">
      {label}
    </span>
  );
}

/**
 * 标签「+N」折合 chip（**一处定义，多面共用**：行的标签块与 table 的标签单元格）。
 * 外观与普通 chip 同一个常量 —— 它不是另一种东西，只是「还有几个没显示」。
 */
export function WorkItemLabelMoreChip({ hiddenCount }: { hiddenCount: number }) {
  const { intl } = useZCodeIntl();
  return (
    <span className={WORK_ITEM_LABEL_CHIP_CLASSNAME} data-testid="work-item-label-more">
      {intl.formatMessage({ id: "squad.workItems.labelsMore" }, { count: hiddenCount })}
    </span>
  );
}

/**
 * 行级「打开详情」的**透明覆盖按钮**（**一处定义，多面共用**：看板/列表的整行与 table 的标题格）。
 *
 * 为什么是覆盖层而不是整行 button：行内本来就有按钮，button 嵌套 button 是非法 HTML
 * （点内层会连带触发外层）。覆盖层只盖标题区域，行内动作区抬到 `relative z-10`。
 */
export function WorkItemRowOpenDetailOverlay({
  title,
  onOpen,
}: {
  /** 用于可及名称（读屏听到「打开工作项「标题」」）。 */
  title: string;
  onOpen: () => void;
}) {
  const { intl } = useZCodeIntl();
  return (
    <button
      type="button"
      aria-label={intl.formatMessage({ id: "squad.workItemDetail.activity.open" }, { title })}
      data-testid="work-item-row-open-detail"
      onClick={onOpen}
      className="absolute inset-0 z-0 rounded-lg focus-visible:ring-2 focus-visible:ring-brand"
    />
  );
}

/**
 * 工作项优先级徽标（**一处定义，多面共用**：行的 picker 与详情概览）；未设置（NULL）⇒ 不渲染。
 * `testId` 由调用方给：两个面的稳定锚点不同（行锚 `work-item-priority` / 概览锚带 `-detail-`），
 * 锚点是**面的属性**，不是徽标的属性。
 *
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
 * 聚焦（收件箱「打开工作项」的落点）：行 DOM 引用按 id 收在 ref 里（不用 querySelector：
 * 它是字符串拼选择器，id 里将来出现特殊字符就静默找不到）。
 *
 * 为什么由**宿主**调用一次、而不是每个视图各调一次：三个视图（以及泳道的每一条）如果各自
 * 持有一份 map，聚焦只会在「当前视图恰好注册过」的那一份里命中 —— 换视图就静默失效。
 * 一处 map + 所有行共用它，是「聚焦在任何视图下语义相同」的唯一实现。
 */
export function useWorkItemRowFocus(input: {
  focusWorkItemId?: string | null;
  onFocusConsumed?: () => void;
  /** 当前视图的行集（内容变化时让一次待消费的聚焦意图重新尝试定位）。 */
  items: readonly WorkItem[];
}): WorkItemRowFocus {
  const { focusWorkItemId, onFocusConsumed, items } = input;
  const rowElementsRef = useRef(new Map<string, HTMLElement>());
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
  }, [focusWorkItemId, onFocusConsumed, items]);
  // 卸载时别把定时器留成孤儿（它 setState 的目标已经不在了）。
  useEffect(
    () => () => {
      if (highlightTimerRef.current !== null) window.clearTimeout(highlightTimerRef.current);
    },
    [],
  );

  return {
    highlightedWorkItemId,
    registerRow: (id, element) => {
      if (element) rowElementsRef.current.set(id, element);
      else rowElementsRef.current.delete(id);
    },
  };
}

/**
 * 行渲染**单点**：三视图渲染的是**同一个**函数——行 JSX（含 `rowElementsRef` 注册、
 * `data-work-item-id`、时间线钮、动作按钮、透明覆盖）只出现一次。复制一份「列表版/表格版行
 * 渲染」能通过 typecheck，却会让焦点注册在其中一条路径上静默缺失 —— 收件箱「打开工作项」的
 * 滚动 + 高亮当场失效，而且不报错。
 */
function WorkItemRow({
  row,
  environment,
  runParentWorkItemIds,
  table,
}: {
  row: WorkItemBoardRow;
  environment: WorkItemRowEnvironment;
  /** 「是不是批根」的输入（`isSquadBatchRoot` 的第二个参数）：由行列表**一次**算好传给每行，
      不在行内重算（每行都 map 一遍 snapshot.runs = 行数 × run 数 的无谓重复）。 */
  runParentWorkItemIds: readonly string[];
  /** 表格布局（`undefined` = 列表/看板的横排信息带）；见 `WorkItemTableRowInput`。 */
  table?: WorkItemTableRowInput;
}) {
  const { item, depth } = row;
  const { intl } = useZCodeIntl();
  const t = (id: string, values?: Record<string, string | number>) =>
    intl.formatMessage({ id }, values);
  const {
    snapshot,
    discardableIds,
    busyWorkItemId,
    timelineExpandedWorkItemId,
    rowFocus,
    inlineEdit,
    selection,
    onEdit,
    onReassign,
    onDiscard,
    onToggleTimeline,
    onOpenWorkItemDetail,
    workspacePath,
    workspaceIdentity,
    onOpenSession,
  } = environment;

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
  /* 行勾选件（**零件在 `workItemRowParts`：那里是行模块的无锚点零散件的家**，本模块是它唯一的
     消费方 —— 单点性质不变，见 R5 的全树守卫）。未进入批量模式（`selection` 缺席）⇒ `null`：
     行结构逐槽不变（见文件头「结构纪律」）。 */
  const rowSelectControl =
    selection === undefined ? null : <WorkItemRowSelect item={item} selection={selection} />;
  /* 行级「打开详情」的透明覆盖按钮（**一处定义，多面共用**的组件在这里挂载一次；
     表格布局由单元格模块挂载同一份组件）。抽成变量是为了让它与勾选件共用同一个槽位。 */
  const openDetailOverlay = (
    <WorkItemRowOpenDetailOverlay title={item.title} onOpen={() => onOpenWorkItemDetail(item.id)} />
  );
  /* 行内动作簇（编辑 / 改派 / 放弃整批 / 时间线）：**一处定义，两种布局共用** ——
     表格的动作列不是第二份动作簇，只是同一个簇换了个宿主格子（`<td data-column="actions">`）。 */
  const actions = (
    <span className="relative z-10 flex shrink-0 items-center gap-2">
      {/* 时间线展开钮：**只在批根行**给（判据 = 服务面唯一实现 isSquadBatchRoot）。 */}
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
  );
  /* 展开的时间线（批根行）：列表布局挂在 `<li>` 内；表格布局渲染为**独立的 `<tr>`**
     （块级内容塞进 `<td>` 同行会破坏表格结构）。同一个值，两种宿主。 */
  const timeline = timelineExpanded ? (
    <SquadTimelineSection
      workItemId={item.id}
      workspacePath={workspacePath}
      workspaceIdentity={workspaceIdentity}
      teamAgents={snapshot.teamAgents}
      workItems={snapshot.workItems}
      onOpenSession={onOpenSession}
    />
  ) : null;
  /* 行的**容器元素**由布局决定（`<li>` / `<tr>`）：锚点、ref 注册、动作簇**只写一次** ——
     「复制一份表格版行渲染」正是本模块要禁的形态（锚点/注册各恰一处，见 T-P2-R1/R3 守卫）。 */
  const RowElement = table === undefined ? "li" : "tr";
  const rowElement = (
    <RowElement
      key={item.id}
      data-work-item-id={item.id}
      data-depth={depth}
      ref={(element: HTMLElement | null) => {
        rowFocus.registerRow(item.id, element);
      }}
      style={table === undefined ? { paddingLeft: `${depth * 12 + 8}px` } : undefined}
      className={cn(
        table === undefined ? ROW_CLASSNAME : TABLE_ROW_CLASSNAME,
        table === undefined ? "flex flex-col gap-2" : undefined,
        // 聚焦高亮：**语义色 token**（brand 环，照 WhiteboardPane 的既有手法），
        // 不引九色板、不编码状态 —— 它只回答"刚才是这一条"。
        rowFocus.highlightedWorkItemId === item.id && "ring-2 ring-brand",
      )}
    >
      {table !== undefined ? (
        /* 表格的行内容（单元格 + 动作格）：列投影属于视图，动作簇与勾选件由本模块**传进去**
           （两者都仍只有一份实现，见 `WorkItemTableRowInput`）。 */
        table.cells(row, actions, rowSelectControl)
      ) : (
        <>
          <div className="relative flex items-center justify-between gap-3">
            {/* 行级「打开详情」：**透明覆盖按钮**（整行 button 会与行内既有按钮嵌套非法）。
                覆盖层只盖**标题行**（不含展开的时间线），动作区抬到 `relative z-10` ——
                点击命中是硬要求，不是样式偏好。
                ⚠️ 勾选件与覆盖层**共用第一个槽位**（三元而不是多一个兄弟槽位）：React 把「这一层的
                孩子数」编进 `useId`，多一个槽位（哪怕渲染成 null）就会让 Radix 的 `aria-controls`
                漂移、R1 的逐字节基线红（实测：删掉 `_R_b5_` → `_R_2_`）。 */}
            {rowSelectControl === null ? (
              openDetailOverlay
            ) : (
              <>
                {rowSelectControl}
                {openDetailOverlay}
              </>
            )}
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
                    <WorkItemLabelMoreChip hiddenCount={labelChips.hiddenCount} />
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
            {actions}
          </div>
          {/* 行内编辑的**就地**失败原因（阶段一轮 D）：不清行 —— 用户能在原处改完再提交。 */}
          {inlineFailure === null ? null : (
            <WorkItemInlineEditFailureLine failure={inlineFailure} />
          )}
          {/* 内联展开：本批历史（listSquadRuns by parentWorkItemId）的泳道时间线。 */}
          {timeline}
        </>
      )}
    </RowElement>
  );
  /* **列表布局必须返回那个 `<li>` 本身**（不套 Fragment）：React 把「这一层的孩子数」编进
     `useId` 的自动 id —— 组件根多一个兄弟节点，Radix 的 `aria-controls` 当场变化，
     R1 的逐字节基线会红（实测：`_R_b5_` → `_R_1cl_`）。表格布局没有基线包袱：
     展开行要挂第二个 `<tr>`，那一支才用 Fragment。 */
  if (table === undefined) return rowElement;
  return (
    <>
      {rowElement}
      <WorkItemTableTimelineRow
        timeline={timeline}
        /* 跨列宽 = 数据列 + （标题列、动作列）+ 批量模式下的勾选列 —— 展开行的 `<td>` 必须与
           表头的列数逐项对齐，否则这行会横向错位（表格结构是硬要求）。 */
        columnCount={table.columnCount + (rowSelectControl === null ? 0 : 1)}
      />
    </>
  );
}

/**
 * 表格布局下每行的**内容**（列目录与可见列是视图的状态，故由视图投影）：`actions` 是行模块
 * 交给它的**动作簇**、`select` 是行模块交给它的**勾选件**（两者都只有一个实现，只是换个宿主格子）。
 * `select === null` = 未进入批量选择模式 ⇒ 那个格子（连同列）**整格不渲染**。
 */
export type WorkItemTableCells = (
  row: WorkItemBoardRow,
  actions: ReactNode,
  select: ReactNode,
) => ReactNode;

/** 表格布局的入参：有它 = 行元素是 `<tr>`、容器是 `<tbody>`（没有 = 列表/看板的原样）。 */
export type WorkItemTableRowInput = { cells: WorkItemTableCells; columnCount: number };

/**
 * 行列表（三视图**共用**的容器）：`testId` 由调用方给（board 的既有锚点 `work-items-list` /
 * list / table 各自的容器锚点），行本身仍是上面那**一个** `WorkItemRow`。
 */
export function WorkItemRowList({
  rows,
  environment,
  testId,
  table,
}: {
  rows: WorkItemBoardRow[];
  environment: WorkItemRowEnvironment;
  testId?: string;
  /** 表格布局（`undefined` = 列表/看板；有它 ⇒ 容器是 `<tbody>`，由视图放进自己的 `<table>`）。 */
  table?: WorkItemTableRowInput;
}) {
  // 「是不是批根」的唯一输入：本 workspace 的 run 行按 parentWorkItemId 归拢（与页面
  // squadDiscardableWorkItemIds 同一份口径 —— 从 snapshot.runs 取，不另查一次）。
  // **一次算好、传给每行**：本层是三种视图共用的唯一列表实现，故这份输入也只在唯一处算一次。
  const runParentWorkItemIds = useMemo(
    () => environment.snapshot.runs.map((run) => run.parentWorkItemId),
    [environment.snapshot.runs],
  );
  const rowElements = rows.map((row) => (
    <WorkItemRow
      key={row.item.id}
      row={row}
      environment={environment}
      runParentWorkItemIds={runParentWorkItemIds}
      table={table}
    />
  ));
  if (table !== undefined) {
    // 表格的行容器：`<tbody>`（表格结构由视图的 `<table>`/`<thead>` 提供）。
    return <tbody>{rowElements}</tbody>;
  }
  return (
    <ul className={LIST_CLASSNAME} data-testid={testId}>
      {rowElements}
    </ul>
  );
}
