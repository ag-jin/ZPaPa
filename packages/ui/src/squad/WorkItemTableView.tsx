import type { WorkItem } from "@zcode/shared";
import { WorkItemRowList, type WorkItemRowEnvironment } from "./WorkItemRows.js";
import { flattenWorkItemBoard } from "./workItemsViewModel.js";

/* **table 视图**（阶段二 · T-P2-R1 先给最小实现；列模型 / 排序表头 / 单元格归 T-P2-R3）。

   最小实现**只给分支与容器锚点**，行仍是共用行模块渲染的同一批行 —— 刻意**不预置**表格结构：
   列目录（`WORK_ITEM_SURFACE_COLUMNS`）与排序键（`WORK_ITEM_SORT_KEYS`）已在视图模型里冻结，
   R3 落真表格时按目录建列、按闭集建排序表头即可；本轮若先造一套 `<table>` 骨架，R3 就得
   在「先删再写」的中间态上工作（或者更糟：两套列渲染并存）。

   行单点纪律不变：本文件不得出现 `data-work-item-id` / 行 DOM 引用（行只有 `WorkItemRows` 那一份）。 */

export function WorkItemTableView({
  items,
  environment,
}: {
  /** 已投影的可见项（宿主给的：过滤/搜索/排序都已完成）。 */
  items: WorkItem[];
  environment: WorkItemRowEnvironment;
}) {
  return (
    <WorkItemRowList
      rows={flattenWorkItemBoard(items)}
      environment={environment}
      testId="work-items-table-view"
    />
  );
}
