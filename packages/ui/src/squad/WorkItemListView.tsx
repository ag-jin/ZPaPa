import type { WorkItem } from "@zcode/shared";
import { WorkItemRowList, type WorkItemRowEnvironment } from "./WorkItemRows.js";
import { flattenWorkItemBoard } from "./workItemsViewModel.js";

/* **list 视图**（阶段二 · T-P2-R1 先给最小实现；密度与批次子树呈现归 T-P2-R2）。

   本文件存在的理由（接口冻结的硬约束）：宿主 `WorkItemsSurface` 的三视图分支由 T-P2-R1 **预置**，
   非 board 的实现落在**各自的文件**里 —— 这样 R2（list）/ R3（table）换实现时**不改宿主**
   （宿主是串行点文件，两个并行作业都碰它就会互相踩），也**不复制行 JSX**（行渲染的唯一实现在
   `WorkItemRows`）。

   最小实现的边界：行集与深度仍来自**同一份** `flattenWorkItemBoard`（本轮不新增第二次 DFS）；
   R2 在此基础上做密度/批根入口的呈现，不改这里的取数口径。 */

export function WorkItemListView({
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
      testId="work-items-list-view"
    />
  );
}
