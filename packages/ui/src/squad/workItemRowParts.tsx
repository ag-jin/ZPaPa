import type { ReactNode } from "react";
import type { WorkItem } from "@zcode/shared";
import type { SquadSnapshot } from "@zcode/services";
import { Checkbox } from "@/components/ui/checkbox.js";
import { cn } from "@/components/lib/utils.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { SUBAGENT_COLOR_CLASS, resolveSubagentColorFromName } from "@/lib/subagentColors.js";
import type { WorkItemInlineEditApi } from "./useWorkItemInlineEdit.js";
import { workItemBulkSelectable, type WorkItemRowSelection } from "./workItemBulkViewModel.js";

/* 行模块的**零件与契约**（阶段二 · T-P2-R3 抽出）。
 *
 * 为什么这些不放在 `WorkItemRows.tsx` 里：那个文件是**行渲染的单点实现**，守卫把锚点、
 * 聚焦注册、动作簇、时间线挂载点、行列表全都钉在它里面（拆出去 = 守卫锚定的字面量离开唯一
 * 实现点）；而 `.oxlintrc.json` 的 `max-lines = 400` 是全局硬线。表格视图（R3）给行元素加了
 * 「容器参数化 + 单元格 + 展开行」之后，把**没有守卫锚点**的零散件搬到这里换余量：
 * · 指派圆点（纯呈现，行与表格单元格共用）；
 * · 行的契约类型（环境 / 聚焦注册表 —— 只有类型，无行为）；
 * · 表格布局的展开行（时间线那一行：内容由行模块给，这里只负责 `<tr>` 与跨列的 `<td>`）；
 * · 行的**勾选件**（批量选择，T-P2-R5：`WorkItemRows` 是它唯一的消费方 —— 迁到这里是**换余量**，
 *   单点性质不变，全 src 树守卫仍断言「产出勾选件的模块恰一个」）。
 *
 * 行为**零变化**：看板/列表的 DOM 由 `workItemsSurfaceBaseline` 的逐字节基线兜底，表格的
 * 行/列结构由 `workItemTableView.test.ts` 的真渲染用例兜底。 */

/**
 * 行的**环境**（三视图共用）：行需要的一切输入都在这里，视图只负责把宿主给的这一份透传。
 * 之所以打包成一个对象：三视图的 props 若各自展开十几项，「某视图少传一项」这种静默缺口的
 * 表面积就跟着行数增长；打包后「行怎么渲染」只有一处契约。
 */
export type WorkItemRowEnvironment = {
  snapshot: SquadSnapshot;
  /** 「放弃整批」入口出现的工作项（判据见 `squadDiscardableWorkItemIds`：只有**破坏性**动作才需要判据）。 */
  discardableIds: ReadonlySet<string>;
  busyWorkItemId: string | null;
  /** 当前展开了时间线的那条批根（页面的**单一**状态：一次只展开一批，见 WorkItemsPage）。 */
  timelineExpandedWorkItemId: string | null;
  rowFocus: WorkItemRowFocus;
  /** 行内编辑状态（宿主创建**一份**：整块 surface 共享同一份编辑态，见 useWorkItemInlineEdit）。 */
  inlineEdit: WorkItemInlineEditApi;
  /** 批量选择（阶段二 · T-P2-R5）：`undefined` = 未进入批量选择模式 ⇒ 行**不渲染**勾选件
      （默认界面的行结构因此逐槽不变，见 `WorkItemRows` 的结构纪律）。 */
  selection?: WorkItemRowSelection;
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
};

/** 聚焦注册表（宿主创建**一次**、三视图共用）：`registerRow` 由行在挂载时调用，
    `highlightedWorkItemId` 供行决定是否画那道一次性高亮环。 */
export type WorkItemRowFocus = {
  highlightedWorkItemId: string | null;
  /** 行元素（`<li>` 或表格的 `<tr>`）：聚焦只关心「是个可滚动的元素」，故类型是 `HTMLElement`
      （T-P2-R3 的加法参数化 —— 原为 `HTMLLIElement`）。 */
  registerRow: (id: string, element: HTMLElement | null) => void;
};

/**
 * 指派人前面的圆点（**只表达身份，不编码状态**，spec §11.3）：
 * · 智能体 ⇒ 实心点，用它自带的 `color`；未设色时按名字稳定取一个（照 SquadAgentsList）；
 * · 小队 ⇒ **没有 `color` 字段**（实体如此），用一个中性空心圆环（`border`，非九色板）——
 *   与智能体的实心点只差"型别"，不差"状态"；不替它编一个颜色（编出来的颜色是假的）；
 * · 用户 ⇒ 不画点（"我"由本地化文案表达，不需要身份色）。
 */
export function AssigneeMarker({
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

/**
 * 行**勾选件**（阶段二 · T-P2-R5）：多选行的行级控件，与 `AssigneeMarker` / 展开行同属「行模块的零件」。
 *
 * 为什么放在这里而不是行渲染模块里：那个文件是**行渲染的单点实现**，`max-lines = 400` 是全局硬线
 * （R3 已把无锚点的零散件搬到这里换余量）。**单点性质不变**：全 `src` 树只有这一处产出勾选件，
 * 行模块是它**唯一**的消费方（视图与单元格模块不得自带第二份 —— 用例外另有全树守卫）。
 *
 * 三条：① 可写判据复用 `workItemBulkSelectable`（= 行内编辑入口同一份结论：归档行不给勾选件）；
 * ② 可及名称带**行标题**（一排同名复选框读屏时分不出哪一行）；③ 用既有 `Checkbox` 原语
 * （Radix + DESIGN token），不另写一套勾选外观与键盘语义。
 */
export function WorkItemRowSelect({
  item,
  selection,
}: {
  item: WorkItem;
  /** `undefined` = 未进入批量选择模式（连勾选件都不渲染 —— 行结构因此逐槽不变）。 */
  selection?: WorkItemRowSelection;
}) {
  const { intl } = useZCodeIntl();
  if (selection === undefined || !workItemBulkSelectable(item)) return null;
  return (
    <Checkbox
      className="relative z-10 shrink-0"
      data-testid="work-item-select"
      aria-label={intl.formatMessage(
        { id: "squad.workItems.bulk.selectRow" },
        { title: item.title },
      )}
      checked={selection.selectedIds.has(item.id)}
      disabled={selection.disabled}
      onCheckedChange={() => selection.onToggle(item.id)}
    />
  );
}

/** 展开态时间线所在的整行格：内容自适应高度（它不是数据行，不给 44px 行高）。 */
const TABLE_TIMELINE_CELL_CLASSNAME = "border-b border-border px-3 py-2 align-top";

/**
 * 表格布局的**展开行**（那一行的时间线要跨全部列）。
 *
 * 为什么是独立的一行而不是 `<td>` 塞在数据行里：块级内容塞进同一行的单元格会破坏表格的
 * 列对齐（这一行的其余单元格会被拉高、错位）。`timeline` 由行模块给（它持有展开态与上下文），
 * 这里只负责容器与跨列。
 */
export function WorkItemTableTimelineRow({
  timeline,
  columnCount,
}: {
  /** 展开的分区（`null` = 没展开 ⇒ 整行不渲染）。 */
  timeline: ReactNode;
  /** 数据列数（不含标题列与动作列）。 */
  columnCount: number;
}) {
  if (timeline === null) return null;
  return (
    <tr data-testid="work-items-timeline-row">
      <td colSpan={columnCount + 2} className={TABLE_TIMELINE_CELL_CLASSNAME}>
        {timeline}
      </td>
    </tr>
  );
}
