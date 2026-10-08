import type { ReactNode } from "react";
import type { WorkItem } from "@zcode/shared";
import type { SquadSnapshot } from "@zcode/services";
import { useSortable } from "@dnd-kit/sortable";
import { GripVertical } from "lucide-react";
import { Button } from "@/components/ui/button.js";
import { Checkbox } from "@/components/ui/checkbox.js";
import { cn } from "@/components/lib/utils.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { SUBAGENT_COLOR_CLASS, resolveSubagentColorFromName } from "@/lib/subagentColors.js";
import type { WorkItemBoardRow } from "./workItemsViewModel.js";
import type { WorkItemPositionPlan } from "./workItemPositionViewModel.js";
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
  /** 拖拽改序（阶段二 · T-P2-R6b）：`undefined` = 不给把手（非看板 / 非状态分组 / 非手动档 /
      页面没接写入口）。判据在 `workItemBoardReorderEnabled`（宿主投影，行与视图不各判一遍）。 */
  reorder?: WorkItemRowReorder;
  onEdit: (item: WorkItem) => void;
  /** 点「改派」⇒ 交给页面打开改派对话框（本层不持有状态、也不执行服务调用）。 */
  onReassign: (item: WorkItem) => void;
  /** 点「放弃整批」⇒ **只进入待确认态**（本层拿不到服务，结构上不可能直接执行）。 */
  onDiscard: (workItemId: string) => void;
  /** 点「时间线」⇒ 交给页面切换展开态（同一条再点 = 收起；本层不持有状态）。 */
  onToggleTimeline: (item: WorkItem) => void;
  /** B5.1：打开这条工作项的详情页（页面 → App 的意图态；本层不持有导航状态）。 */
  onOpenWorkItemDetail: (workItemId: string) => void;
  /** 侧边 peek（阶段三 · T-P3-R2）：行级「打开」的**预览意图** —— 存在时行打开的是右侧轻量面板
      （面板里再经 `onOpenWorkItemDetail` 进完整详情页）；**缺省 ⇒ 保持既有详情页导航**（缺省零 peek），
      于是"点得动但什么都不发生"在接线层面凑不出来（与 reorder 把手同款纪律）。
      本层只把意图交回宿主：打开态属于宿主，行不持有任何面板状态。 */
  onOpenPeek?: (workItemId: string) => void;
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

/**
 * 行**拖拽把手**（阶段二 · T-P2-R6b）：看板在 statusCategory 泳道 + 手动排序下给的行级控件。
 *
 * 为什么放在行零件的家（与勾选件同一条理由）：`WorkItemRows` 是行渲染的单点实现且有 `max-lines`
 * 硬线；**单点性质不变** —— 全 `src` 树只有这一处产出拖拽把手，行模块是它唯一的消费方。
 *
 * 为什么未启用时不渲染整个组件（而不是渲染一个禁用钮）：行容器的**孩子槽位**是行为的一部分
 * （见 `WorkItemRows` 的结构纪律）—— 多一个槽位（哪怕渲染成 null）会让同层兄弟的 `useId` 漂移，
 * 默认路径的逐字节基线当场红。这里的两段式（外层判启用 → 内层才 `useSortable`）同时满足：
 * 未启用 ⇒ 连元素都不挂；启用 ⇒ 才接 dnd-kit 的上下文（钩子不在条件分支里）。
 */
export function WorkItemRowDragHandle({
  itemId,
  reorder,
}: {
  itemId: string;
  /** `undefined` = 不启用（非看板 / 非状态分组 / 非手动档 / 页面没接写入口）。 */
  reorder?: WorkItemRowReorder;
}) {
  if (reorder === undefined) return null;
  return <SortableRowDragHandle itemId={itemId} />;
}

/** 内层：只有启用时才挂载 ⇒ `useSortable` 的上下文一定在（或安全缺席 —— 无 DndContext 时它是 no-op）。 */
function SortableRowDragHandle({ itemId }: { itemId: string }) {
  const { intl } = useZCodeIntl();
  /* 无 SortableContext / DndContext 时 dnd-kit 返回安全缺省（实测其 context 有 default 值，
     不抛）—— 这让"某个视图忘了包上下文"退化成"拖不动"，而不是整页崩。 */
  const { attributes, listeners, setNodeRef, isDragging } = useSortable({ id: itemId });
  return (
    <Button
      ref={setNodeRef}
      type="button"
      size="icon-sm"
      variant="ghost"
      data-testid="work-item-drag-handle"
      data-dragging={isDragging ? "true" : "false"}
      aria-label={intl.formatMessage({ id: "squad.workItems.sort.manual" })}
      {...attributes}
      {...listeners}
    >
      <GripVertical aria-hidden className="size-3.5" />
    </Button>
  );
}

/**
 * 表格布局下每行的**内容**（列目录与可见列是视图的状态，故由视图投影）：`actions` 是行模块
 * 交给它的**动作簇**、`select` 是行模块交给它的**勾选件**（两者都只有一个实现，只是换个宿主格子）。
 * `select === null` = 未进入批量选择模式 ⇒ 那个格子（连同列）**整格不渲染**。
 *
 * 住在行零件文件里（T-P2-R6b 搬来换余量）：这两个类型**没有守卫锚点**，而 `WorkItemRows`
 * 的 `max-lines = 400` 是硬线 —— 与 R3/R5 把零散件搬到这里同款，行的契约入口不变。
 */
export type WorkItemTableCells = (
  row: WorkItemBoardRow,
  actions: ReactNode,
  select: ReactNode,
) => ReactNode;

/** 表格布局的入参：有它 = 行元素是 `<tr>`、容器是 `<tbody>`（没有 = 列表/看板的原样）。 */
export type WorkItemTableRowInput = { cells: WorkItemTableCells; columnCount: number };

/** 行拖拽的能力对象：行只据此决定"挂不挂把手"，落点由看板算好后**经这一份**交回页面写库。 */
export type WorkItemRowReorder = {
  /** 一次拖拽的落点计划（位置值已按纯函数算好；页面是唯一写入口）。 */
  onPlan: (plan: WorkItemPositionPlan) => void;
};
