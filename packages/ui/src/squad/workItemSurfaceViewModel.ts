import {
  WORK_ITEM_PRIORITY_KEYS,
  WORK_ITEM_STATUS_CATEGORY,
  resolveWorkItemPriorityRank,
  type WorkItem,
  type WorkItemPriorityKey,
  type WorkItemStatusCategory,
} from "@zcode/shared";
import { workItemIdentifierText } from "./workItemPropertiesViewModel.js";
import { workItemBoardTrees } from "./workItemsViewModel.js";

/* 工作项 **Surface 视图模型**（阶段二 · T-P2-R1 接口冻结轮）：视图模式 / 过滤 / 本地搜索 /
   排序 / 列配置的**判据全在这里**。

   为什么必须是纯函数层（不是为了好看）：① 本包没有渲染测试设施，判据写进组件就等于不可测
   （照 `workItemsViewModel` / `squadSurfaceViewModel` 的既定做法）；② 这些判据的坏法全是**静默**的
   —— 默认路径被顺手排一次序（行序变了、锚点还在）、搜索的大小写/trim 口径两处各写一遍（一处改、
   一处不改）、闭集漏一个值（界面上少一个选项，没有报错）；③ 阶段二的三视图（R2/R3/R4/R5）
   必须消费**同一份**投影 —— 第二份判据分叉时不报错，只会「列表和看板说的不一样」。

   本文件不 import React、不 import UI 原语、不碰 i18n 文案正文（只给**消息 id**）。
   状态（视图模式等）是**会话内**状态，由 `WorkItemsPage` 持有；本层只做「状态 + 数据 → 结论」
   的纯映射，以及「意图 → 新状态」的纯折叠。 */

/* ---------------- 视图模式（闭集） ---------------- */

/** 三视图（**闭集**：加一个视图 ⇒ 类型报错拖出宿主的分支、控件带的选项与文案映射）。 */
export type WorkItemViewMode = "board" | "list" | "table";

export const WORK_ITEM_VIEW_MODES: readonly WorkItemViewMode[] = ["board", "list", "table"];

/** 视图名文案（`Record<…>` 穷尽：加视图 ⇒ 编译期在这里报缺失，而不是界面上多一个裸 key）。 */
export const WORK_ITEM_VIEW_MODE_MESSAGE_IDS: Record<WorkItemViewMode, string> = {
  board: "squad.workItems.view.board",
  list: "squad.workItems.view.list",
  table: "squad.workItems.view.table",
};

/* ---------------- 排序键与方向（闭集） ---------------- */

/**
 * 排序键（**闭集**）。`manual` = 仓库给定的次序（`position → created_at → id`，即今天的行序），
 * 其余按字段排。没有「更新时间」这一档：领域对象今天**没有** `updatedAt`（0018 也没加），
 * 给一个不存在的字段造排序键就是替服务面编事实（登记为后续）。
 */
export type WorkItemSortKey = "manual" | "priority" | "startDate" | "dueDate" | "title";

export const WORK_ITEM_SORT_KEYS: readonly WorkItemSortKey[] = [
  "manual",
  "priority",
  "startDate",
  "dueDate",
  "title",
];

export const WORK_ITEM_SORT_MESSAGE_IDS: Record<WorkItemSortKey, string> = {
  manual: "squad.workItems.sort.manual",
  priority: "squad.workItems.sort.priority",
  startDate: "squad.workItems.sort.startDate",
  dueDate: "squad.workItems.sort.dueDate",
  title: "squad.workItems.sort.title",
};

/** 排序方向（闭集二值）。 */
export type WorkItemSortDirection = "asc" | "desc";

export const WORK_ITEM_SORT_DIRECTIONS: readonly WorkItemSortDirection[] = ["asc", "desc"];

export const WORK_ITEM_SORT_DIRECTION_MESSAGE_IDS: Record<WorkItemSortDirection, string> = {
  asc: "squad.workItems.sort.asc",
  desc: "squad.workItems.sort.desc",
};

/* ---------------- 过滤 facet（闭集） ---------------- */

/** 状态 facet：`all` + 4 个 **category**（机器判据；不认 6 键 —— 与泳道同一条口径）。 */
export type WorkItemStatusFilterValue = WorkItemStatusCategory | "all";

export const WORK_ITEM_STATUS_FILTER_VALUES: readonly WorkItemStatusFilterValue[] = [
  "all",
  "unstarted",
  "started",
  "done",
  "closed",
];

/** facet 选项文案：`all` 走新键，category 复用泳道的 category 文案（同一套词汇，不抄第二份）。 */
export const WORK_ITEM_STATUS_FILTER_MESSAGE_IDS: Record<WorkItemStatusFilterValue, string> = {
  all: "squad.workItems.filter.all",
  unstarted: "squad.workItems.lane.statusCategory.unstarted",
  started: "squad.workItems.lane.statusCategory.started",
  done: "squad.workItems.lane.statusCategory.done",
  closed: "squad.workItems.lane.statusCategory.closed",
};

/**
 * 优先级 facet：`all` + 四档 + **`unset`**。
 *
 * 为什么 `unset` 是一个独立选项：领域里 `NULL` = 未设置（与「显式选了某一档」不是同一态，
 * 见 shared 的裁定）—— 过滤里不把它单列，就等于「未设置」这一态永远查不出来，而它恰恰是
 * 存量行的真实状态。
 */
export type WorkItemPriorityFilterValue = WorkItemPriorityKey | "unset" | "all";

export const WORK_ITEM_PRIORITY_FILTER_VALUES: readonly WorkItemPriorityFilterValue[] = [
  "all",
  ...WORK_ITEM_PRIORITY_KEYS,
  "unset",
];

/** facet 选项文案：档位复用优先级档位文案，「未设置」复用同一枚键（同一个概念一句话）。 */
export const WORK_ITEM_PRIORITY_FILTER_MESSAGE_IDS: Record<WorkItemPriorityFilterValue, string> = {
  all: "squad.workItems.filter.all",
  urgent: "squad.workItems.priority.urgent",
  high: "squad.workItems.priority.high",
  medium: "squad.workItems.priority.medium",
  low: "squad.workItems.priority.low",
  unset: "squad.workItems.priority.unset",
};

/* ---------------- 列目录（闭集） ---------------- */

/**
 * 列目录（**闭集**）：表格视图（R3）与列配置（R3）消费它。**只有领域对象上真有的字段**
 * —— 差距清单里的 project / parent-child progress / updated 本阶段**没有**数据面
 * （服务面零改动是本轮硬约束），不造空列（登记为后续）。
 */
export type WorkItemSurfaceColumnKey =
  | "identifier"
  | "status"
  | "priority"
  | "assignee"
  | "labels"
  | "startDate"
  | "dueDate"
  | "creator";

export const WORK_ITEM_SURFACE_COLUMNS: readonly WorkItemSurfaceColumnKey[] = [
  "identifier",
  "status",
  "priority",
  "assignee",
  "labels",
  "startDate",
  "dueDate",
  "creator",
];

/** 列标题文案：能复用既有字段词汇的就复用（同一概念一句话），只补缺的三枚。 */
export const WORK_ITEM_COLUMN_MESSAGE_IDS: Record<WorkItemSurfaceColumnKey, string> = {
  identifier: "squad.workItems.field.identifier",
  status: "squad.workItems.field.status",
  priority: "squad.workItems.priority",
  assignee: "squad.workItems.field.assignee",
  labels: "squad.workItems.labels",
  startDate: "squad.workItems.startDate",
  dueDate: "squad.workItems.dueDate",
  creator: "squad.workItems.creator",
};

/** 列配置：只记**隐藏了哪些**（可见 = 目录顺序减去隐藏集）—— 加列时旧配置自动包含新列。 */
export type WorkItemSurfaceColumnConfig = { hidden: readonly WorkItemSurfaceColumnKey[] };

/** 可见列（目录顺序，去掉隐藏集；隐藏集里的未知键自然无效 —— 目录是唯一真源）。 */
export function visibleWorkItemColumns(
  config: WorkItemSurfaceColumnConfig,
): WorkItemSurfaceColumnKey[] {
  return WORK_ITEM_SURFACE_COLUMNS.filter((column) => !config.hidden.includes(column));
}

/* ---------------- Surface 状态与默认值 ---------------- */

/** 过滤 facet 的当前取值（`all` = 不筛）。 */
export type WorkItemSurfaceFilter = {
  statusCategory: WorkItemStatusFilterValue;
  priority: WorkItemPriorityFilterValue;
};

/** Surface 的**会话内**状态（页面持有；与 `laneDimension` 同款：本域无偏好持久化先例）。 */
export type WorkItemSurfaceState = {
  view: WorkItemViewMode;
  /** 本地搜索原文（`""` = 不搜）；口径（trim / 大小写）只在 `workItemSurfaceSearchText` 一处。 */
  search: string;
  filter: WorkItemSurfaceFilter;
  sort: { key: WorkItemSortKey; direction: WorkItemSortDirection };
  columns: WorkItemSurfaceColumnConfig;
};

/**
 * 默认状态（**逐字段写死**，不是从实现反推）：board + 无过滤 + 无搜索 + 无排序 + 零隐藏列。
 * 默认视图是**看板** —— 「给出多视图」不等于「换掉既有用户看到的界面」（与泳道默认 `none` 同款纪律）。
 * 每次返回**新对象**：状态是可变引用（React state），共享一份常量迟早被某处就地改到。
 */
export function workItemSurfaceDefaultState(): WorkItemSurfaceState {
  return {
    view: "board",
    search: "",
    filter: { statusCategory: "all", priority: "all" },
    sort: { key: "manual", direction: "asc" },
    columns: { hidden: [] },
  };
}

/**
 * 搜索文本的**归一化单源**（trim + 小写）：两处各写一遍「去空格、忽略大小写」，迟早一处改一处
 * 不改 —— 表现是「大写查得到、小写查不到」这种没人报的 bug。**不依赖 i18n**（不按 locale 折叠）：
 * 搜索是在**同一份原文**上做的，按语言折叠会让结果随界面语言变化。
 */
export function workItemSurfaceSearchText(raw: string): string {
  return raw.trim().toLowerCase();
}

/**
 * 一条工作项**命中搜索**吗：标题 / 标签 / identifier 展示文本（Q3 裁定），
 * 大小写与 trim 口径走 `workItemSurfaceSearchText` 单源；空查询 ⇒ `true`（不过滤）。
 *
 * identifier 走 `workItemIdentifierText` 单源（前缀常量只此一处）—— 按编号搜索才有意义
 * （「按编号找人」是 identifier 这个字段存在的理由）；标签是本地的内存匹配，不是索引。
 */
export function workItemMatchesSearch(
  item: Pick<WorkItem, "title" | "labels" | "identifierSeq">,
  rawQuery: string,
): boolean {
  const query = workItemSurfaceSearchText(rawQuery);
  if (query.length === 0) return true;
  if (workItemSurfaceSearchText(item.title).includes(query)) return true;
  if (item.labels.some((label) => workItemSurfaceSearchText(label).includes(query))) return true;
  const identifier = workItemIdentifierText(item.identifierSeq);
  return identifier !== null && workItemSurfaceSearchText(identifier).includes(query);
}

/** 有没有**生效的**过滤/搜索（空查询 + 全 `all` ⇒ false）。「清除筛选」的可点性、空结果态的
    措辞都问它 —— 两处各判一遍，迟早在「只有空格」这类输入上分叉。 */
export function workItemSurfaceHasActiveQuery(state: WorkItemSurfaceState): boolean {
  return (
    workItemSurfaceSearchText(state.search).length > 0 ||
    state.filter.statusCategory !== "all" ||
    state.filter.priority !== "all"
  );
}

/**
 * 可见项投影（三视图**共用同一份**）：先按「整棵树作为一个单元」过滤/搜索，再按排序键排**根**。
 *
 * 树单元口径（与泳道「只切根」同一条纪律，理由同源）：批次是行的视觉单元（批根承载时间线 /
 * 放弃整批入口），把一棵树按行拆开会让子项脱离批根、批入口跟着错位；而且「谁留下」若按行判定，
 * 就会在过滤结果上**再算一次**「谁是根」（子项因父被筛掉而升格为根）—— 第二份根判据分叉时不报错。
 * 因此：树内**任一行**命中（facet ∧ 搜索）⇒ **整棵树**留下；行序与深度仍由 `flattenWorkItemBoard`
 * 那一份 DFS 给（本函数不改行序、只改「哪些树留下」与「树之间的次序」）。
 *
 * **根判定在未过滤的输入上完成**（本函数不参与「谁是根」）：这是「过滤不得改变树形状」的落地。
 */
export function workItemSurfaceVisibleItems(input: {
  items: WorkItem[];
  state: WorkItemSurfaceState;
}): WorkItem[] {
  const { items, state } = input;
  /* 默认路径（无查询 + 手动次序）**零加工**：原样返回输入 —— 行序仍由 flattenWorkItemBoard 给，
     这一步不复制、不重排（承重验收 2：默认行集与既有用户看到的逐格一致）。 */
  if (!workItemSurfaceHasActiveQuery(state) && state.sort.key === "manual") return items;
  const trees = workItemBoardTrees(items).filter((tree) =>
    tree.rows.some((row) => workItemMatchesSurfaceQuery(row.item, state)),
  );
  // 排序只动**树之间的次序**（树内次序与深度仍来自那一份 DFS）：`manual` 不排。
  if (state.sort.key !== "manual") {
    trees.sort((left, right) => compareWorkItemRoots(left.root, right.root, state.sort));
  }
  const visible: WorkItem[] = [];
  for (const tree of trees) {
    for (const row of tree.rows) visible.push(row.item);
  }
  return visible;
}

/**
 * 排序比较：**未设置永远排在最后**（两个方向一致），其余按方向反过来。
 *
 * 为什么未设置不参与反向：`null` 位次是「没人定过」而不是某一个位次（shared 的裁定）——
 * 让它跟着降序跑到最前面，等于替用户把「没定过」当成「最弱/最强」处理。没有值的项不占位次，
 * 也就不该因为方向切换而换位置。
 */
function compareWorkItemRoots(
  left: WorkItem,
  right: WorkItem,
  sort: WorkItemSurfaceState["sort"],
): number {
  switch (sort.key) {
    case "priority":
      return compareOptionalValues(
        resolveWorkItemPriorityRank(left.priority),
        resolveWorkItemPriorityRank(right.priority),
        sort.direction,
        (a, b) => a - b,
      );
    case "startDate":
      return compareOptionalValues(
        left.startDate ?? null,
        right.startDate ?? null,
        sort.direction,
        compareWorkItemText,
      );
    case "dueDate":
      return compareOptionalValues(
        left.dueDate ?? null,
        right.dueDate ?? null,
        sort.direction,
        compareWorkItemText,
      );
    case "title":
      return compareOptionalValues(left.title, right.title, sort.direction, compareWorkItemText);
    case "manual":
      return 0;
  }
}

function compareOptionalValues<T>(
  left: T | null,
  right: T | null,
  direction: WorkItemSortDirection,
  compare: (a: T, b: T) => number,
): number {
  if (left === null && right === null) return 0;
  if (left === null) return 1;
  if (right === null) return -1;
  const order = compare(left, right);
  return direction === "desc" ? -order : order;
}

/** 文本比较用**码位序**（`<` / `>`），不用 `localeCompare`：排序结果不得随界面语言变化，
    也不得随运行环境改变（本仓对泳道顺序有同款纪律：顺序不依赖 locale）。 */
function compareWorkItemText(left: string, right: string): number {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

/** 一条行命中当前过滤/搜索吗（facet ∧ 搜索）—— 内部判据，消费方走 `workItemSurfaceVisibleItems`。 */
function workItemMatchesSurfaceQuery(item: WorkItem, state: WorkItemSurfaceState): boolean {
  if (
    state.filter.statusCategory !== "all" &&
    WORK_ITEM_STATUS_CATEGORY[item.status] !== state.filter.statusCategory
  ) {
    return false;
  }
  if (!workItemMatchesPriorityFilter(item.priority, state.filter.priority)) return false;
  return workItemMatchesSearch(item, state.search);
}

/** 优先级 facet：`all` 全过；`unset` = 未设置（`undefined`/`null`，与「显式选了某一档」分开）；其余要求精确相等。 */
function workItemMatchesPriorityFilter(
  priority: WorkItemPriorityKey | undefined,
  filter: WorkItemPriorityFilterValue,
): boolean {
  if (filter === "all") return true;
  if (filter === "unset") return priority === undefined;
  return priority === filter;
}

/**
 * 控件带回的**意图**（闭集判别联合）：控件（R4 的控件带 / R3 的列配置）**只回传意图**，
 * 状态怎么变只有 `applyWorkItemSurfaceIntent` 一处实现 —— 两处各写一遍 setState，
 * 迟早「清除筛选」漏掉一个 facet（漏掉的表现是界面看着清了、结果里还在筛）。
 */
export type WorkItemSurfaceIntent =
  | { kind: "setView"; view: WorkItemViewMode }
  | { kind: "setSearch"; search: string }
  | { kind: "setStatusFilter"; value: WorkItemStatusFilterValue }
  | { kind: "setPriorityFilter"; value: WorkItemPriorityFilterValue }
  | { kind: "setSortKey"; key: WorkItemSortKey }
  | { kind: "setSortDirection"; direction: WorkItemSortDirection }
  | { kind: "toggleColumn"; column: WorkItemSurfaceColumnKey }
  | { kind: "clearQuery" };

/**
 * 意图 → 新状态（**纯**：不改入参；未提及的字段原样保留）。
 *
 * `toggleColumn` 是唯一「往返」意图（同一枚列键两次回到原状）；`clearQuery` 只清搜索与两个 facet，
 * **不动**视图 / 排序 / 列配置 —— 用户点的是「去掉这个筛选条件」，不是「把我配好的视图重置」。
 */
export function applyWorkItemSurfaceIntent(
  state: WorkItemSurfaceState,
  intent: WorkItemSurfaceIntent,
): WorkItemSurfaceState {
  switch (intent.kind) {
    case "setView":
      return { ...state, view: intent.view };
    case "setSearch":
      return { ...state, search: intent.search };
    case "setStatusFilter":
      return { ...state, filter: { ...state.filter, statusCategory: intent.value } };
    case "setPriorityFilter":
      return { ...state, filter: { ...state.filter, priority: intent.value } };
    case "setSortKey":
      return { ...state, sort: { ...state.sort, key: intent.key } };
    case "setSortDirection":
      return { ...state, sort: { ...state.sort, direction: intent.direction } };
    case "toggleColumn": {
      const hidden = state.columns.hidden.includes(intent.column)
        ? state.columns.hidden.filter((column) => column !== intent.column)
        : [...state.columns.hidden, intent.column];
      return { ...state, columns: { hidden } };
    }
    case "clearQuery":
      return {
        ...state,
        search: "",
        filter: { statusCategory: "all", priority: "all" },
      };
  }
}

/** 空态的**类型**：`none` = 一条都没有（既有空态文案）；`filtered` = 有数据但被筛掉（另两句文案，
    R4 的「无匹配」与「还没有工作项」两态由此分开）；`null` = 有可见行。 */
export function workItemSurfaceEmptyKind(input: {
  total: number;
  visible: number;
}): "none" | "filtered" | null {
  if (input.total === 0) return "none";
  if (input.visible === 0) return "filtered";
  return null;
}
