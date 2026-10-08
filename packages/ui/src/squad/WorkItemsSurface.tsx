import { useMemo } from "react";
import type { WorkItem } from "@zcode/shared";
import type { SquadSnapshot } from "@zcode/services";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import type { SquadEntryFeedback } from "./squadEntryViewModel.js";
import type { WorkItemRowSelection } from "./workItemBulkViewModel.js";
import type { WorkItemInlineEditPatch } from "./workItemInlineEditViewModel.js";
import { WorkItemListView } from "./WorkItemListView.js";
import { useWorkItemRowFocus, type WorkItemRowEnvironment } from "./WorkItemRows.js";
import { WorkItemTableView } from "./WorkItemTableView.js";
import { useWorkItemInlineEdit } from "./useWorkItemInlineEdit.js";
import { WorkItemsBoard } from "./WorkItemsBoard.js";
import {
  workItemSurfaceEmptyKind,
  workItemSurfaceVisibleItems,
  type WorkItemSurfaceIntent,
  type WorkItemSurfaceState,
} from "./workItemSurfaceViewModel.js";
import type { WorkItemLaneDimension } from "./workItemsViewModel.js";

/* **工作项 Surface 宿主**（阶段二 · T-P2-R1 的接口冻结点）：三视图分派 + 投影 + 空态 + 共用状态。

   为什么要有宿主（而不是让页面直接渲染看板）：阶段二起「同一批工作项」有三种视图，
   视图的**取数口径必须只有一份** —— 投影（过滤/搜索/排序）在 `workItemSurfaceViewModel`（纯函数），
   **在这里被应用一次**，三个视图只消费结果。若让每个视图各自投影，三份口径迟早分叉
   （分叉不报错，只表现为「列表和看板说的不一样」）。

   状态所有权：**Surface 状态（视图模式/搜索/过滤/排序/列配置）由页面持有**（与 `laneDimension`
   同款：会话内状态、不持久化），因为控件带在页面的动作行里（取数失败时也要常驻）；本宿主只**消费**
   状态、并把行内编辑态与聚焦注册表各创建**一份**（三视图共用同一份交互态 —— 各建一份的话，
   换视图会把正在编辑的草稿悄悄丢掉，聚焦也会只在一个视图里生效）。

   空态也在这里（两种，**判据在纯函数**）：`none` = 一条都没有（既有文案与锚点逐字保留）；
   `filtered` = 有数据但被当前查询筛掉（另两句文案 —— 「无匹配」与「还没有工作项」必须分开说，
   否则用户会以为自己的数据没了）。 */

export function WorkItemsSurface({
  workItems,
  snapshot,
  discardableIds,
  busyWorkItemId,
  timelineExpandedWorkItemId,
  laneDimension,
  surface,
  onSurfaceIntent,
  selection,
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
  /** 页面的原始投影（`snapshot.workItems`）：过滤/搜索/排序由本宿主按 `surface` 应用。 */
  workItems: WorkItem[];
  snapshot: SquadSnapshot;
  discardableIds: ReadonlySet<string>;
  busyWorkItemId: string | null;
  timelineExpandedWorkItemId: string | null;
  /** 看板泳道维度（只对 board 视图生效；list/table 不用）。 */
  laneDimension: WorkItemLaneDimension;
  /** Surface 状态（页面持有）：视图模式 / 本地搜索 / 过滤 / 排序 / 列配置。 */
  surface: WorkItemSurfaceState;
  /** 视图回传的**意图**（T-P2-R3 起 table 的表头排序与列显隐消费它）：宿主只透传给视图，
      折叠仍只有一处实现（页面的 `applyWorkItemSurfaceIntent`）。 */
  onSurfaceIntent: (intent: WorkItemSurfaceIntent) => void;
  /** 批量选择（T-P2-R5）：`undefined` = 未进入批量选择模式 ⇒ 三视图的行都不渲染勾选件
      （默认界面的行结构因此逐槽不变）。选择集与收敛判据都在页面（本层只透传）。 */
  selection?: WorkItemRowSelection /** 收件箱穿透的**一次性聚焦意图**（`null` = 没有意图）。 */;
  focusWorkItemId?: string | null;
  /** 聚焦消费回调：找到就滚 + 高亮后调；**目标不在列表也调**（父项被归档等 —— 不留悬挂意图）。 */
  onFocusConsumed?: () => void;
  onEdit: (item: WorkItem) => void;
  /** 行内编辑提交：**唯一写路径在页面** —— 本层与行模块都不 import 服务、不拼请求。 */
  onInlineEdit: (
    item: WorkItem,
    patch: WorkItemInlineEditPatch,
  ) => Promise<SquadEntryFeedback | null>;
  onReassign: (item: WorkItem) => void;
  onDiscard: (workItemId: string) => void;
  onToggleTimeline: (item: WorkItem) => void;
  onOpenWorkItemDetail: (workItemId: string) => void;
  workspacePath: string;
  workspaceIdentity?: string;
  onOpenSession?: (sessionId: string) => void;
}) {
  const { intl } = useZCodeIntl();
  const t = (id: string) => intl.formatMessage({ id });

  /* 投影**一次**（三视图共用）：默认状态（无查询 + 手动次序）时纯函数原样返回输入，
     行序仍由 flattenWorkItemBoard 那一份 DFS 给。 */
  const visibleItems = useMemo(
    () => workItemSurfaceVisibleItems({ items: workItems, state: surface }),
    [workItems, surface],
  );

  /* 聚焦注册表与行内编辑态：各一份，三视图共用（见文件头「状态所有权」）。 */
  const rowFocus = useWorkItemRowFocus({
    focusWorkItemId,
    onFocusConsumed,
    items: visibleItems,
  });
  const inlineEdit = useWorkItemInlineEdit({ onInlineEdit });

  const environment: WorkItemRowEnvironment = {
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
  };

  const emptyKind = workItemSurfaceEmptyKind({
    total: workItems.length,
    visible: visibleItems.length,
  });
  if (emptyKind === "none") {
    return (
      <div className="flex flex-col gap-1" data-testid="work-items-empty">
        <p className="text-ui-base text-foreground">{t("squad.workItems.empty")}</p>
        <p className="text-ui-sm text-foreground-subtlest">{t("squad.workItems.emptyHint")}</p>
      </div>
    );
  }
  if (emptyKind === "filtered") {
    return (
      <div className="flex flex-col gap-1" data-testid="work-items-filtered-empty">
        <p className="text-ui-base text-foreground">{t("squad.workItems.filteredEmpty")}</p>
        <p className="text-ui-sm text-foreground-subtlest">
          {t("squad.workItems.filteredEmptyHint")}
        </p>
      </div>
    );
  }

  if (surface.view === "list") {
    return <WorkItemListView items={visibleItems} environment={environment} />;
  }
  if (surface.view === "table") {
    return (
      <WorkItemTableView
        items={visibleItems}
        environment={environment}
        surface={surface}
        onSurfaceIntent={onSurfaceIntent}
      />
    );
  }
  return (
    <WorkItemsBoard
      workItems={visibleItems}
      laneDimension={laneDimension}
      environment={environment}
    />
  );
}
