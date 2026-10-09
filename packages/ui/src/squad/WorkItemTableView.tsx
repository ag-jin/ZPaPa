import type { WorkItem } from "@zcode/shared";
import { ArrowDown, ArrowUp } from "lucide-react";
import { Button } from "@/components/ui/button.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { WorkItemRowList, type WorkItemRowEnvironment } from "./WorkItemRows.js";
import { WorkItemTableRowCells } from "./WorkItemTableCell.js";
import {
  WORK_ITEM_COLUMN_MESSAGE_IDS,
  WORK_ITEM_SORT_DIRECTION_MESSAGE_IDS,
  WORK_ITEM_SURFACE_COLUMNS,
  visibleWorkItemColumns,
  type WorkItemSortKey,
  type WorkItemSurfaceIntent,
  type WorkItemSurfaceState,
} from "./workItemSurfaceViewModel.js";
import {
  WORK_ITEM_TABLE_TITLE_SORT_KEY,
  workItemTableColumnSortKey,
  workItemTableSortAria,
  workItemTableSortIntent,
} from "./workItemTableViewModel.js";
import { flattenWorkItemBoard } from "./workItemsViewModel.js";

/* **table 视图**（阶段二 · T-P2-R3）：真表格 —— 列模型驱动的列（显示/隐藏 = 页面的会话内状态）、
   排序表头（只回传 R1 的排序键意图）、只读单元格。
 *
   三条口径（各自的理由都在源码里）：
   ① **真 `<table>`**：行/列关联交给原生语义（`<th scope="col">` ↔ `<td>`），不给 `<li>` 硬贴
      role —— 读屏的表导航、`aria-sort` 的归属都依赖原生表格结构。
   ② **表头不自排**：点击只把结论（`workItemTableSortIntent` 的意图）交给页面；排序只有 R1 的
      `workItemSurfaceVisibleItems` 一份实现。列显隐同理（`toggleColumn` 意图 + `visibleWorkItemColumns`
      纯函数）——视图里没有 `useState`，列配置不是视图的私有状态（R6 的命名视图要还原它）。
   ③ **行仍只有一份**：行元素/锚点/聚焦注册/动作簇仍在 `WorkItemRows`（本视图只给列与单元格内容，
      见该模块的 `tableCells`）；本文件**不得**出现 `data-work-item-id`。

   本视图的锚点是**自己的容器**（`work-items-table-view` + `data-view="table"`），不再借共用行列表的
   容器元素 —— 与 R2 的 list 同一条理由：面锚点不耦合共用模块的内部结构。 */

/** 表头单元（低调的紧凑标签：DESIGN 的 text-ui-xs 覆盖 compact labels）。 */
const TABLE_HEAD_CELL_CLASSNAME =
  "border-b border-border px-3 py-1.5 text-left text-ui-xs font-medium text-foreground-subtle";
/** 表头的排序按钮：原生命中（键盘可达），焦点环用语义 token。 */
const TABLE_SORT_BUTTON_CLASSNAME =
  "inline-flex items-center gap-1 rounded-sm text-left hover:text-foreground focus-visible:ring-2 focus-visible:ring-brand";
/* 窄屏：列多时横向滚动而不是把列压扁（移动端形态归阶段三，登记人工演示）。 */
const TABLE_SCROLL_CLASSNAME = "overflow-x-auto";

export function WorkItemTableView({
  items,
  environment,
  surface,
  onSurfaceIntent,
}: {
  /** 已投影的可见项（宿主给的：过滤/搜索/排序都已完成）。 */
  items: WorkItem[];
  environment: WorkItemRowEnvironment;
  /** Surface 状态（页面持有）：本视图消费列配置与排序态。 */
  surface: WorkItemSurfaceState;
  /** 只回传意图（R1 的 `applyWorkItemSurfaceIntent` 是唯一折叠实现）。 */
  onSurfaceIntent: (intent: WorkItemSurfaceIntent) => void;
}) {
  const { intl } = useZCodeIntl();
  const t = (id: string) => intl.formatMessage({ id });

  /* 可见列 = 目录顺序减去隐藏集（判据在 R1 的纯函数里；这里只消费结论）。 */
  const columns = visibleWorkItemColumns(surface.columns);

  /** 一个表头单元：可排序列给按钮 + `aria-sort`；不可排序列只读且不带该属性。 */
  const headerCell = (input: {
    column: string;
    label: string;
    sortKey: WorkItemSortKey | null;
  }) => {
    const { sortKey } = input;
    return (
      <th
        key={input.column}
        scope="col"
        data-column={input.column}
        aria-sort={
          sortKey === null ? undefined : workItemTableSortAria({ sort: surface.sort, key: sortKey })
        }
        className={TABLE_HEAD_CELL_CLASSNAME}
      >
        {sortKey === null ? (
          input.label
        ) : (
          <button
            type="button"
            data-testid={`work-items-table-sort-${input.column}`}
            onClick={() =>
              onSurfaceIntent(workItemTableSortIntent({ current: surface.sort, key: sortKey }))
            }
            className={TABLE_SORT_BUTTON_CLASSNAME}
          >
            {input.label}
            {surface.sort.key === sortKey ? (
              <>
                {/* 方向的**可读**副本（aria-sort 是规范 token，不是文案）：读屏听到「标题 降序 按钮」。 */}
                <span className="sr-only">
                  {t(WORK_ITEM_SORT_DIRECTION_MESSAGE_IDS[surface.sort.direction])}
                </span>
                {surface.sort.direction === "asc" ? (
                  <ArrowUp className="size-3" aria-hidden />
                ) : (
                  <ArrowDown className="size-3" aria-hidden />
                )}
              </>
            ) : null}
          </button>
        )}
      </th>
    );
  };

  return (
    <div className="flex flex-col gap-2" data-testid="work-items-table-view" data-view="table">
      {/* 列配置：目录 8 列各一枚开关，按下态 = 可见；点它只回传 `toggleColumn` 意图。 */}
      <div
        role="group"
        aria-label={t("squad.workItems.columns.label")}
        className="flex flex-wrap items-center gap-1"
      >
        {WORK_ITEM_SURFACE_COLUMNS.map((column) => (
          <Button
            key={column}
            type="button"
            variant="outline"
            size="sm"
            aria-pressed={columns.includes(column)}
            data-testid={`work-items-column-toggle-${column}`}
            onClick={() => onSurfaceIntent({ kind: "toggleColumn", column })}
          >
            {t(WORK_ITEM_COLUMN_MESSAGE_IDS[column])}
          </Button>
        ))}
      </div>
      <div className={TABLE_SCROLL_CLASSNAME}>
        <table className="w-full border-collapse text-left">
          <thead>
            <tr>
              {/* 勾选列（T-P2-R5）：**只在批量模式下**存在 —— 未进入批量模式时表格结构与 R3 落地时
                  逐项相同（列身份 = 标题 + 目录列 + 动作列）。列名给可及名称（读屏听到的是一列
                  「批量操作」的勾选格，而不是一列没有名字的复选框）。 */}
              {environment.selection === undefined ? null : (
                <th
                  scope="col"
                  data-column="select"
                  aria-label={t("squad.workItems.bulk.label")}
                  className={TABLE_HEAD_CELL_CLASSNAME}
                />
              )}
              {headerCell({
                column: "title",
                label: t("squad.common.title"),
                sortKey: WORK_ITEM_TABLE_TITLE_SORT_KEY,
              })}
              {columns.map((column) =>
                headerCell({
                  column,
                  label: t(WORK_ITEM_COLUMN_MESSAGE_IDS[column]),
                  sortKey: workItemTableColumnSortKey(column),
                }),
              )}
              {/* 动作列：行级入口的宿主（编辑/改派/放弃/时间线）——它是**面的列**，不是数据列，
                  因此不在列目录里、也不参与列配置；没有「操作」这枚冻结文案键，表头留空。 */}
              <th scope="col" data-column="actions" className={TABLE_HEAD_CELL_CLASSNAME} />
            </tr>
          </thead>
          <WorkItemRowList
            rows={flattenWorkItemBoard(items)}
            environment={environment}
            table={{
              columnCount: columns.length,
              cells: (row, actions, select) => (
                <WorkItemTableRowCells
                  row={row}
                  columns={columns}
                  snapshot={environment.snapshot}
                  onOpenWorkItemDetail={environment.onOpenWorkItemDetail}
                  actions={actions}
                  select={select}
                />
              ),
            }}
          />
        </table>
      </div>
    </div>
  );
}
