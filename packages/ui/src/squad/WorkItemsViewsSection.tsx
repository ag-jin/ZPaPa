import { WorkItemViewDialogs } from "./WorkItemViewDialogs.js";
import { WorkItemViewsBar } from "./WorkItemViewsBar.js";
import type { WorkItemsViewsBridge } from "./useWorkItemsViewsBridge.js";

/* 「工作项」页面的**视图区**（阶段二 · T-P2-R6b）：视图条 + 它的三个对话框。

   为什么合成一个组件（而不是让页面各挂一处）：`WorkItemsPage` 有 `max-lines = 400` 的硬线
   （R5 抽 `useWorkItemBulk` 是同一个理由），而这两块本来就是**同一件事** —— "当前在看哪一份视图"
   （条）与"对视图本身的管理动作"（对话框）。三个对话框经 Radix 的 **portal** 渲染，所以
   "条在动作行之上、对话框在页面尾部"这个视觉事实**不依赖 DOM 位置**。

   纪律（与页面其它装配区同款）：本组件只**投影**状态机（`controller`）并把意图原样回传 ——
   不读 store、不解析 target、不执行任何服务调用；判据全在 `workItemViewsViewModel` 与状态机里。 */

export function WorkItemsViewsSection({ bridge }: { bridge: WorkItemsViewsBridge }) {
  const { views } = bridge;
  return (
    <>
      <WorkItemViewsBar
        tabs={views.tabs}
        activeViewId={views.activeViewId}
        busy={views.busy}
        /* 入口常驻：没有读写面（无 workspace 目标）时只置灰，不消失 —— 与刷新/新建同一条姿态。 */
        disabled={!bridge.ioReady}
        onOpen={bridge.openView}
        onNew={bridge.openCreateDialog}
        onManage={bridge.openManage}
      />
      {/* 表单 / 删除确认 / 管理面板：装配区只投影状态机的状态（不判任何权限与标题）。 */}
      <WorkItemViewDialogs controller={views} />
    </>
  );
}
