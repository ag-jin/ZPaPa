import { useMemo, useState, type KeyboardEvent } from "react";
import type { WorkItem } from "@zcode/shared";
import type { SquadSnapshot } from "@zcode/services";
import { Button } from "@/components/ui/button.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import type { SquadEntryFeedback } from "./squadEntryViewModel.js";
import { squadWorkspaceTarget } from "./squadRuntimeAccess.js";
import type { WorkItemRowSelection } from "./workItemBulkViewModel.js";
import type { WorkItemInlineEditPatch } from "./workItemInlineEditViewModel.js";
import { WorkItemListView } from "./WorkItemListView.js";
import { WorkItemMobileSheet } from "./WorkItemMobileSheet.js";
import { WorkItemQuickCreate } from "./WorkItemQuickCreate.js";
import { useWorkItemRowFocus, type WorkItemRowEnvironment } from "./WorkItemRows.js";
import { WorkItemTableView } from "./WorkItemTableView.js";
import { useWorkItemInlineEdit } from "./useWorkItemInlineEdit.js";
import { useWorkItemSurfaceViewport } from "./useWorkItemSurfaceViewport.js";
import { WorkItemsBoard } from "./WorkItemsBoard.js";
import type { WorkItemRowReorder } from "./workItemRowParts.js";
import type { WorkItemPositionPlan } from "./workItemPositionViewModel.js";
import { workItemBoardReorderEnabled } from "./workItemViewsViewModel.js";
import {
  workItemCompactSheetKeyIntent,
  workItemCompactSheetTarget,
  type WorkItemSurfaceViewport,
} from "./workItemResponsiveViewModel.js";
import {
  workItemSurfaceEmptyKind,
  workItemSurfaceVisibleItems,
  type WorkItemSurfaceIntent,
  type WorkItemSurfaceState,
} from "./workItemSurfaceViewModel.js";
import { workItemCreateEnabled, type WorkItemLaneDimension } from "./workItemsViewModel.js";
import type { WorkItemQuickCreateRequest } from "./workItemQuickCreateViewModel.js";

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
   否则用户会以为自己的数据没了）。

   快速创建（T-P3-R1）也由这里挂载：写入口 `onQuickCreate` **可选**（缺省 ⇒ 整块不渲染，
   三份逐字节基线不受影响），请求构造与可点性判据在下方的 `WorkItemQuickCreate` 与
   `workItemQuickCreateViewModel`；本宿主只做两件事 —— 把快照的**原始**列表给候选、
   把"能不能建"的结论（`workItemCreateEnabled`）与"有没有写在飞"（`busyWorkItemId`）投给它。
   **已知行为（2026-10-09 登记，不修）**：点行进详情页 ⇒ 本 Surface 卸载 ⇒ 快速创建的草稿随
   卸载丢失。这是「导航 = 页面级跳转」的固有结果，与 multica 同款（那边点卡片也是导航，草稿
   同样不跨页面保留）；在 Surface 内**不换树根**（见下）解决的只是"面板开合不丢草稿"，
   不承诺跨页面保留。

   侧边 peek（T-P3-R2）**已下线**（用户裁定 2026-10-09「点击进详情页，预览先下线」）：multica 的
   卡片本质是链接 —— **默认点击 = 进详情页**，预览要显式手势（Shift+点击 / Space）且是完整可编辑
   面板（不是摘要）。因此本宿主不再持有打开态（原 `peekWorkItemId`）、不再渲染 `WorkItemPeek`、
   不再经行环境加法（原 peek 预览意图字段）接收预览意图 —— 行/卡片/表格标题格的点击一律走
   `onOpenWorkItemDetail`（同一路由）。面板组件本身保留（后续升级完整面板的底子，组件级守卫见
   `workItemPeek.test.ts`），只是**没有任何挂载点**。

   由此 F1/F2 的「恒定壳」也随之退役（2026-10-09 结构恒定裁定当时是为了「开关 peek 不换树根」）：
   peek 下线后没有开关，桌面（含 SSR 默认）**直接返回 body** —— 恒定性由「没有第二条返回路径」
   保证（body 的父链在两次渲染之间恒等），不再需要 `work-items-surface-split` 分栏壳。

   响应式收口（T-P3-R4）：**窄屏 = 底部抽屉、桌面 = 行内**，两档**互斥**（不是靠 CSS 藏一套——
   藏起来的那套仍在 DOM 里，两套同时在场就是卡面明令的变异）。形态判据全在纯函数里
   （`workItemResponsiveViewModel`：断点与 Tailwind `md:` 同一枚；判不出宽度 ⇒ 桌面默认），
   本宿主只消费结论：窄屏分支**提前返回**（桌面返回在它之后 ⇒ 结构性不可达），抽屉至多一个
   （`workItemCompactSheetTarget`；peek 下线后只剩快速创建这一个目标），快速创建的窄屏入口是
   触发钮 + 抽屉里的**同一个** `WorkItemQuickCreate`（写路径、可点性、失败就地显示全部照旧）。
   `viewport` 是形态的**唯一注入点**（缺省 ⇒ 去问浏览器；测试/嵌入方注入时不订阅）。 */

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
  onReorderPosition,
  onQuickCreate,
  viewport: viewportOverride,
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
  /** 拖拽改序的写入口（页面注入；缺省 ⇒ 不给拖拽把手 —— 点得动但写不下去的入口比没有更糟）。 */
  onReorderPosition?: (plan: WorkItemPositionPlan) => void;
  /** 快速创建的写入口（T-P3-R1，页面经接线层注入；**缺省 ⇒ 整块不渲染** —— 与 reorder 同款纪律：
      没有写路径的入口只会被读成功能坏了）。请求由本宿主下方的 `WorkItemQuickCreate` 构造
      （默认值判据在 `workItemQuickCreateViewModel`），接线层负责调 `createWorkItem` 单源 +
      **服务回读**刷新（本层不做乐观插入、不碰行）。 */
  onQuickCreate?: (request: WorkItemQuickCreateRequest) => Promise<SquadEntryFeedback | null>;
  /** 形态的**唯一注入点**（T-P3-R4）：缺省 ⇒ 按 `matchMedia` 的窄屏查询判（判不出来 ⇒ 桌面）；
      注入时不订阅浏览器（测试注入两档，也供嵌入方接管）。 */
  viewport?: WorkItemSurfaceViewport;
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

  /* 形态与抽屉（T-P3-R4）：视口形态经**唯一注入点**求值；窄屏快速创建的打开态是会话内状态
     （本宿主自持）——触发钮只存在于窄屏分支，桌面这一支永远开不起来。
     2026-10-09 peek 下线后抽屉目标只剩快速创建这一个（`workItemCompactSheetTarget` 同步收窄）。 */
  const viewportMode = useWorkItemSurfaceViewport(viewportOverride);
  const [quickCreateOpen, setQuickCreateOpen] = useState(false);
  /* 列头 `+` 的**聚焦令牌**（形态重排轮）：递增 ⇒ 快速创建条把光标送进标题框（桌面）或
     打开抽屉（窄屏，见 `requestCreate`）。用令牌而不是布尔：连点两次 `+` 每次都要落到输入框。 */
  const [quickCreateFocusToken, setQuickCreateFocusToken] = useState(0);
  const sheetTarget =
    viewportMode === "compact" ? workItemCompactSheetTarget({ quickCreateOpen }) : "none";
  /* 窄屏键盘层：Esc 关**当前**那一个抽屉（peek 下线后只剩快速创建）—— 键位判据复用 peek
     那一枚（`workItemPeekKeyIntent`，随组件保留的纯判据），「关谁」由纯函数回答
     （不在这里另写一份键位链）。 */
  const compactKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.defaultPrevented) return;
    const intent = workItemCompactSheetKeyIntent({ key: event.key, quickCreateOpen });
    if (intent === "quickCreate") setQuickCreateOpen(false);
  };

  /* 拖拽能力（T-P2-R6b）：**唯一判据**在 `workItemBoardReorderEnabled`（看板 + statusCategory +
     手动档 + 有写入口）。未启用 ⇒ 环境里没有这个键 ⇒ 行连把手都不渲染（结构槽位逐槽不变）。 */
  const reorderCapability: WorkItemRowReorder | undefined =
    onReorderPosition === undefined ||
    !workItemBoardReorderEnabled({
      view: surface.view,
      laneDimension,
      sortKey: surface.sort.key,
      hasWriter: true,
    })
      ? undefined
      : { onPlan: onReorderPosition };

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
    reorder: reorderCapability,
  };

  const emptyKind = workItemSurfaceEmptyKind({
    total: workItems.length,
    visible: visibleItems.length,
  });

  /* 快速创建条（T-P3-R1）：**写入口缺省 ⇒ 整块不渲染**（连容器都不进 DOM）—— 三份逐字节基线
     因此仍逐字节不变，而"点得动但写不下去"在接线层面凑不出来（与拖拽把手同款纪律）。
     可点性沿用**既有判据** `workItemCreateEnabled`（本域唯一一处"能不能建"）：无工作区目标 ⇒ 置灰；
     "快照未就绪"这一半由**位置**保证 —— 宿主只在 ready 态被挂载（页面按状态机分支渲染），
     且判据本身仍按原样问一遍（不因为"反正不在"就省掉这一问）。target 用与页面**同一枚纯函数**
     （`squadWorkspaceTarget`）+ 同一对输入求值，结论恒等（宿主不持有第二个权威）。 */
  const quickCreateEnabled = workItemCreateEnabled({
    hasTarget: squadWorkspaceTarget(workspacePath, workspaceIdentity) !== null,
    snapshot,
  });
  const quickCreate =
    onQuickCreate === undefined ? null : (
      <WorkItemQuickCreate
        /* 父项候选 = 快照的**原始**投影（不是 `visibleItems`）：搜索/过滤只作用于行，
           不该让"选一个父项"这件事凭空少掉候选（服务面才是合法性判据）。 */
        workItems={workItems}
        createEnabled={quickCreateEnabled}
        busy={busyWorkItemId !== null}
        onSubmit={onQuickCreate}
        /* 列头 `+` 的落点（形态重排轮）：把光标送进这条**唯一**的创建入口（不新开写路径）。 */
        focusToken={quickCreateFocusToken}
      />
    );

  /* 列头新建入口（`WorkItemsBoard` 的 `onRequestCreate`）：**只在有写路径时**给出 ——
     桌面把光标聚焦进快速创建条；窄屏额外把抽屉打开（那里才是这条入口的宿主）。 */
  const requestCreate =
    quickCreate === null
      ? undefined
      : () => {
          setQuickCreateOpen(true);
          setQuickCreateFocusToken((token) => token + 1);
        };

  const surfaceBody =
    emptyKind === "none" ? (
      <div className="flex flex-col gap-1" data-testid="work-items-empty">
        <p className="text-ui-base text-foreground">{t("squad.workItems.empty")}</p>
        <p className="text-ui-sm text-foreground-subtlest">{t("squad.workItems.emptyHint")}</p>
      </div>
    ) : emptyKind === "filtered" ? (
      <div className="flex flex-col gap-1" data-testid="work-items-filtered-empty">
        <p className="text-ui-base text-foreground">{t("squad.workItems.filteredEmpty")}</p>
        <p className="text-ui-sm text-foreground-subtlest">
          {t("squad.workItems.filteredEmptyHint")}
        </p>
      </div>
    ) : surface.view === "list" ? (
      <WorkItemListView items={visibleItems} environment={environment} />
    ) : surface.view === "table" ? (
      <WorkItemTableView
        items={visibleItems}
        environment={environment}
        surface={surface}
        onSurfaceIntent={onSurfaceIntent}
      />
    ) : (
      <WorkItemsBoard
        workItems={visibleItems}
        laneDimension={laneDimension}
        environment={environment}
        onRequestCreate={requestCreate}
      />
    );

  /* 没有写入口 ⇒ **原样返回**（不套壳）：默认路径的 DOM 逐槽与新增该能力之前相同。
     有写入口但没有选中条目时同样不套壳（快速创建那一层已是既有形态）。 */
  const body =
    quickCreate === null ? (
      surfaceBody
    ) : (
      <div className="flex flex-col gap-2">
        {quickCreate}
        {surfaceBody}
      </div>
    );

  /* 窄屏 ⇒ **提前返回**（桌面返回在它之后 ⇒ 结构性不可达）：快速创建换成触发钮 + 抽屉里的同一条，
     至多一个抽屉（peek 下线后只剩快速创建）。**不套任何壳** —— 藏一套不如不渲染一套。 */
  if (viewportMode === "compact") {
    return (
      <div className="flex flex-col gap-2" onKeyDown={compactKeyDown}>
        {quickCreate === null ? null : (
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="self-start"
            data-testid="work-items-quick-create-open"
            onClick={() => setQuickCreateOpen(true)}
          >
            {t("squad.workItems.quickCreate.open")}
          </Button>
        )}
        {surfaceBody}
        {sheetTarget === "none" ? null : (
          <WorkItemMobileSheet
            title={t("squad.workItems.quickCreate.open")}
            onClose={() => setQuickCreateOpen(false)}
          >
            {quickCreate}
          </WorkItemMobileSheet>
        )}
      </div>
    );
  }

  /* 桌面（含 SSR 默认）：**直接返回 body**（2026-10-09 peek 下线后的恒定 body）。body 是这一支
     唯一返回路径 —— 没有开关、没有第二条返回路径 ⇒ body 的父链在两次渲染之间恒等（F1/F2 的
     结构恒定结论不变），快速创建的草稿/失败/提交中不会因任何开关被卸载重挂。 */
  return body;
}
