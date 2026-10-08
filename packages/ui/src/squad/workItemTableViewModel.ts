import {
  type WorkItemSortDirection,
  type WorkItemSortKey,
  type WorkItemSurfaceColumnKey,
  type WorkItemSurfaceIntent,
  type WorkItemSurfaceState,
} from "./workItemSurfaceViewModel.js";

/* 工作项 **table 视图**（阶段二 · T-P2-R3）的纯判据：列 → 排序键的映射、表头点击 → R1 意图、
   表头的 `aria-sort` 取值。
 *
 * 为什么单独一个文件（不塞进 table 视图组件、也不塞进 R1 的冻结视图模型）：
 * ① 本包没有渲染测试设施，判据写进组件就等于不可测；
 * ② **表头不得自排**（卡面验收 2「无第二份排序实现」）：表头能做的只有「回传 R1 的意图」
 *    —— 把「点哪一列 ⇒ 什么意图」收进纯函数，视图里就只剩 `onSurfaceIntent(结论)`；
 * ③ R1 的 `workItemSurfaceViewModel` 是**冻结**接口（阶段二并行组的前提），本轮的表格判据
 *    不该反向扩它的面。
 *
 * 本文件不 import React、不 import UI 原语、不碰 i18n 文案正文（只给**键的映射**，正文在 locales）。 */

/**
 * 列 → 排序键（**穷尽**映射：加一列 ⇒ 编译期在这里报缺失）。
 *
 * `null` = 这一列**没有**冻结的排序键 ⇒ 表头只读。为什么不顺手给每列都补一个键：
 * 阶段二的排序键闭集（5 枚）与文案键在 R1 已**冻结**（零键增纪律）—— 就地造一个
 * `identifier` 排序键等于破闭集，而且没有对应的两语文案。缺的这几列登记为后续，
 * 不在这里发明。
 */
export const WORK_ITEM_TABLE_COLUMN_SORT_KEYS: Record<
  WorkItemSurfaceColumnKey,
  WorkItemSortKey | null
> = {
  identifier: null,
  status: null,
  priority: "priority",
  assignee: null,
  labels: null,
  startDate: "startDate",
  dueDate: "dueDate",
  creator: null,
};

/** 列头的排序键（`null` = 只读表头）。 */
export function workItemTableColumnSortKey(
  column: WorkItemSurfaceColumnKey,
): WorkItemSortKey | null {
  return WORK_ITEM_TABLE_COLUMN_SORT_KEYS[column];
}

/**
 * 标题列的排序键：标题**不在** `WORK_ITEM_SURFACE_COLUMNS` 里（它是行的身份，不是可配置列 ——
 * 它可以隐藏的话，表格就没有「这是哪一条」的锚），但它有冻结的排序键 `title`。
 */
export const WORK_ITEM_TABLE_TITLE_SORT_KEY: WorkItemSortKey = "title";

/**
 * 表头点击 → R1 的意图（**唯一**的「表头怎么排序」判据）。
 *
 * 两种情形，都**不在这里排序**：
 * · 点的是另一列 ⇒ `setSortKey`（方向沿用 R1 的折叠语义：换键保留方向）；
 * · 点的是当前排序列 ⇒ `setSortDirection`（升 ⇄ 降，标准表头行为）。
 *
 * 比较/排序本身只有一份实现（R1 的 `workItemSurfaceVisibleItems`）—— 表头两次点击后的
 * 行序由它给出，本函数只把「用户点了什么」翻译成意图。
 */
export function workItemTableSortIntent(input: {
  current: WorkItemSurfaceState["sort"];
  key: WorkItemSortKey;
}): WorkItemSurfaceIntent {
  if (input.current.key === input.key) {
    const direction: WorkItemSortDirection = input.current.direction === "asc" ? "desc" : "asc";
    return { kind: "setSortDirection", direction };
  }
  return { kind: "setSortKey", key: input.key };
}

/**
 * 表头的 `aria-sort` 取值（**WAI-ARIA 规范 token**，不是本地化文案）：
 * 当前排序列按方向给 `ascending` / `descending`，其余可排序列给 `none`。
 *
 * 为什么非当前列也给 `none` 而不是省掉这个属性：`none` 是「这一列可排，但当前不是排序列」
 * 的显式说法（读屏据此把表头读成可排序表头）；只有**不可排**的列才整块省掉该属性
 * （省掉 = 没有排序这回事）。
 */
export function workItemTableSortAria(input: {
  sort: WorkItemSurfaceState["sort"];
  key: WorkItemSortKey;
}): "ascending" | "descending" | "none" {
  if (input.sort.key !== input.key) return "none";
  return input.sort.direction === "asc" ? "ascending" : "descending";
}
