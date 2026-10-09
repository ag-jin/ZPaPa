import {
  closestCenter,
  DndContext,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  sortableKeyboardCoordinates,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import {
  CircleCheck,
  CircleDashed,
  CircleDot,
  CircleSlash,
  Folder,
  FolderMinus,
  Plus,
  type LucideIcon,
} from "lucide-react";
import type { WorkItem, WorkItemStatusCategory } from "@zcode/shared";
import { Button } from "@/components/ui/button.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { parseAssigneeValue } from "./squadEntryViewModel.js";
import { workItemBoardDrop } from "./workItemPositionViewModel.js";
import {
  WORK_ITEM_NO_PROJECT_LANE_KEY,
  workItemProjectLaneDisplay,
} from "./workItemProjectViewModel.js";
import { AssigneeMarker, type WorkItemRowReorder } from "./workItemRowParts.js";
import { WorkItemRowList, type WorkItemRowEnvironment } from "./WorkItemRows.js";
import {
  WORK_ITEM_STATUS_CATEGORY_MESSAGE_IDS,
  flattenWorkItemBoard,
  groupWorkItemBoard,
  workItemLaneAssigneeName,
  type WorkItemBoardLane,
  type WorkItemLaneDimension,
} from "./workItemsViewModel.js";

/* 「工作项」页面的**看板视图**（board）：分组（泳道）+ 行列表的壳。

   行本身**不在这里**（阶段二 · T-P2-R1 起）：行 JSX / 行 DOM 引用 / 聚焦注册 / 时间线挂载点
   全部在 `WorkItemRows`（跨三视图共用的唯一模块）。本文件只决定「行按什么次序、套在哪层壳里」——
   这样 list / table 视图（R2/R3）消费同一批行时不会各写一份行渲染（复制一份 = 聚焦注册在某条
   路径上静默缺失，收件箱「打开工作项」的滚动 + 高亮当场失效且不报错）。

   时间线的挂载点仍在**行**上（批根行给「时间线」展开钮，展开时在该行下方同一个 `<li>` 内渲染
   `SquadTimelineSection`）；「哪些行是批根」用服务面导出的**唯一实现** `isSquadBatchRoot`
   （与「放弃整批」、启动重驱同一份定义）—— 行模块不得另写一份"什么是批"。

   泳道分组只切根、子树整体随根落位（见 `groupWorkItemBoard`）；泳道 v1 不做折叠，行全部挂载
   ⇒ 聚焦/高亮在任一视图下语义相同。

   **拖拽改序（T-P2-R6b）**：只在宿主给了 `environment.reorder` 时包一层 `DndContext`
   （宿主按 `workItemBoardReorderEnabled` 投影：看板 + statusCategory + 手动档 + 页面接了写入口）。
   未启用时**零 DOM 变化**（不分组与泳道两条既有路径的逐字节基线因此不受影响）。一次落点的
   处理（取事件 id → 找泳道 → 算位置值 → 交回页面写库）收在纯函数 `workItemBoardDrop` 里
   （本层只做事件绑定与调用）——"拖到哪一列、写什么"只有一处实现。 */

/* 列宽常量（spec §2 的 `BOARD_COL_WIDTH` 同款）：列宽固定、卡片宽由几何推导
   （列 280 − 列 p-2(16) − 列体 p-1(8) = 256）。写常量而不是散落的魔法数：几何只有一处。 */
const WORK_ITEM_BOARD_COLUMN_WIDTH = 280;

/* 状态类别 → 列头字形 / 图标色 / 列底色（**用户 2026-10-09 裁定**：列底色准入 —— 它编码的正是
   **状态类别**，不违反「语义色只编码状态」）。底色取 ZPaPa 语义 token 的低透明变体：
   未开始/已关闭走中性 `bg-surface`(3%)；进行中 `bg-warning/5`；已完成 `bg-success/5`
   —— 本仓主题**没有** `--color-info`（multica 用 info），`--color-success` 是 ZPaPa 里「完成」
   那一档语义色（登记为偏差）。优先级 / 标签**保持中性**（不照搬 multica 的优先级语义色）。 */
const STATUS_CATEGORY_CHROME: Record<
  WorkItemStatusCategory,
  { column: string; icon: string; Icon: LucideIcon }
> = {
  unstarted: { column: "bg-surface", icon: "text-foreground-subtle", Icon: CircleDashed },
  started: { column: "bg-warning/5", icon: "text-warning", Icon: CircleDot },
  done: { column: "bg-success/5", icon: "text-success", Icon: CircleCheck },
  closed: { column: "bg-surface", icon: "text-foreground-subtle", Icon: CircleSlash },
};

export function WorkItemsBoard({
  workItems,
  laneDimension,
  environment,
  onRequestCreate,
}: {
  /** 本视图要显示的项（宿主投影后的可见集；默认状态下与输入同一份）。 */
  workItems: WorkItem[];
  /** 分组维度（看板泳道）：`none` = 单 ul（现状 DOM 逐字保留）；其余按泳道分组（只切根）。 */
  laneDimension: WorkItemLaneDimension;
  /** 三视图共用的行环境（宿主装配一次；行模块消费它）。项目清单也在它里面
      （`environment.projects`，与行上的 project chip **同一份** —— 第二个通道 = 两处迟早说的不是一件事）。 */
  environment: WorkItemRowEnvironment;
  /** 列头新建入口的**意图出口**（列头 `+`）：宿主接到既有的唯一写路径上（聚焦快速创建条）。
      缺省 ⇒ 列头不渲染该钮（没有写路径的入口比没有更糟）。 */
  onRequestCreate?: () => void;
}) {
  const { intl } = useZCodeIntl();
  const t = (id: string, values?: Record<string, string | number>) =>
    intl.formatMessage({ id }, values);
  /* 传感器**无条件**创建（钩子不得在分支里）：未启用拖拽时没有 DndContext，它们不接任何东西。
     指针需 4px 位移才起拖（点击行内按钮/拖动滚动条不会误触起拖）；键盘走 dnd-kit 的坐标读取器
     （把键盘可达性交给库的既有实现，不自造一套）。 */
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  /* 不分组 = **现状 DOM 逐字保留**（单 `<ul data-testid="work-items-list">`，无泳道壳）：
     这条路径的界面零变化（用户 2026-10-09 裁定把**默认值**改为「按阶段分组」—— 变的是默认值，
     不是「不分组」这条路径；它仍是 Group by 的可选项）。 */
  if (laneDimension === "none") {
    return (
      <WorkItemRowList
        rows={flattenWorkItemBoard(workItems)}
        environment={environment}
        testId="work-items-list"
      />
    );
  }

  /** 泳道名：状态维度走穷尽的 category 文案；指派维度走 `resolveAssigneeName` 单源
      （`null` = 当前用户，由本地化文案补；未知对象的 id 后面补一句说明，避免被读成「没指派」）；
      项目维度走 `workItemProjectLaneDisplay` 单源（无项目 / 项目名 / 未知挂接回落 id 三态分开）。 */
  const laneTitle = (key: string): string => {
    if (laneDimension === "statusCategory") {
      return t(WORK_ITEM_STATUS_CATEGORY_MESSAGE_IDS[key as WorkItemStatusCategory]);
    }
    if (laneDimension === "project") {
      const display = workItemProjectLaneDisplay({ laneKey: key, projects: projectList });
      if (display.kind === "none") return t("squad.workItems.project.none");
      return display.kind === "project" ? display.name : display.id;
    }
    if (key === "user") return t("squad.workItems.lane.assignee.user");
    const resolved = workItemLaneAssigneeName(environment.snapshot, parseAssigneeValue(key));
    if (resolved.name === null) return t("squad.workItems.lane.assignee.user");
    return resolved.known
      ? resolved.name
      : resolved.name + t("squad.workItems.lane.assignee.unknownSuffix");
  };

  const reorder = environment.reorder;
  const projectList = environment.projects ?? [];
  const lanes = groupWorkItemBoard({
    items: workItems,
    dimension: laneDimension,
    roster: environment.snapshot,
    projects: projectList,
  });

  /** 一次拖拽的落点：**只做事件绑定与调用** —— 取 id、找泳道、算计划、交回写路径全在
      `workItemBoardDrop` 里（纯函数，逐格可测；T-P2-V §8 缺口 1：这四步当时零覆盖，
      把整段短路后 ui 整包仍全绿）。 */
  const handleDragEnd = (event: DragEndEvent, reorderCapability: WorkItemRowReorder) => {
    workItemBoardDrop({
      activeId: String(event.active.id),
      overId: event.over === null ? null : String(event.over.id),
      lanes: lanes.map((boardLane) =>
        boardLane.rows.map((row) => ({ id: row.item.id, position: row.item.position })),
      ),
      onPlan: reorderCapability.onPlan,
    });
  };

  /* 泳道视图：只加「外层容器 + 头部」，行仍由共用行模块渲染（单点）。
     泳道**不做折叠**（v1）：行全部挂载 ⇒ 聚焦注册完整，收件箱聚焦/高亮在任一视图下逐字不变。

     **轴换向（2026-10-09 用户裁定「看板 multica 形态重排」）**：分组从**纵堆泳道**改为
     **横排固定 280px 列**（形态真源：`reports/2026-10-09-multica-board-ui-spec.md` §10-A1/A2）：
     · 容器 `overflow-x-auto` + `gap-4`(16px) + `p-2`(8px)：列排不下就横滚，不是换行/挤压；
     · 列宽走**常量 + 内联 style**（spec §2 的 `BOARD_COL_WIDTH` 同款）：卡片宽 256 =
       280 − 列 p-2(16) − 列体 p-1(8)，算术闭合在一处，卡片不写死宽度；
     · 高度链：容器 `max-h-[calc(100dvh-16rem)]`（≈ 视口 − 面包屑/视图条/动作行/快速创建条/内边距）
       ⇒ 列被拉伸成等高、列体（`WorkItemRowList` 的 card 容器）独立纵向滚（spec §10-A2）。
       完整 flex 高度链（去掉整页纵向滚）**本轮做不到**：本页在看板之下还有两个分区
       （待收尾运行 / 唤醒规则，`WorkItemsPage.tsx`），去页面滚会让它们不可达 —— 登记为偏差。 */
  const laneShell = (
    <div
      className="flex max-h-[calc(100dvh-16rem)] min-h-0 flex-1 gap-4 overflow-x-auto p-2"
      data-testid="work-items-lanes"
    >
      {lanes.map((lane: WorkItemBoardLane) => {
        const rows = <WorkItemRowList rows={lane.rows} environment={environment} card />;
        /* 列头（spec §2 列头 / §10-A4）：左「类别图标 + 加粗名称 + 计数胶囊」，右「列级动作」。
           状态维度的图标/底色走 `STATUS_CATEGORY_CHROME`（**状态类别**编码）；指派维度没有类别，
           列头给身份点（`AssigneeMarker`：只表达身份，不编码状态）—— 底色保持中性。 */
        const chrome =
          laneDimension === "statusCategory"
            ? STATUS_CATEGORY_CHROME[lane.key as WorkItemStatusCategory]
            : undefined;
        const CategoryIcon = chrome?.Icon;
        /* 项目维度的列头图标（**中性色**：项目是分类，不编码状态 —— DESIGN「语义色只编码状态」）：
           无项目列 = 空文件夹（multica `FolderMinus`），项目列 = 文件夹；未知挂接也是文件夹
           （它挂在某个项目上，只是名字没读到）。 */
        const ProjectIcon =
          laneDimension !== "project"
            ? null
            : lane.key === WORK_ITEM_NO_PROJECT_LANE_KEY
              ? FolderMinus
              : Folder;
        return (
          <section
            key={lane.key}
            className={`flex shrink-0 flex-col rounded-xl p-2 ${chrome?.column ?? "bg-surface"}`}
            style={{ width: WORK_ITEM_BOARD_COLUMN_WIDTH }}
            data-testid="work-items-lane"
            data-lane-key={lane.key}
          >
            <div
              className="mb-2 flex items-center justify-between gap-2 px-1.5"
              data-testid="work-items-lane-header"
            >
              <span className="flex min-w-0 items-center gap-1.5">
                {CategoryIcon === undefined ? (
                  ProjectIcon === null ? (
                    <span className="flex size-3 shrink-0 items-center justify-center">
                      <AssigneeMarker
                        snapshot={environment.snapshot}
                        assignee={parseAssigneeValue(lane.key)}
                      />
                    </span>
                  ) : (
                    <ProjectIcon aria-hidden className="size-3 shrink-0 text-foreground-subtle" />
                  )
                ) : (
                  <CategoryIcon
                    aria-hidden
                    className={`size-3 shrink-0 ${chrome?.icon ?? ""}`.trimEnd()}
                  />
                )}
                <span className="truncate text-ui-sm font-semibold text-foreground">
                  {laneTitle(lane.key)}
                </span>
                <span
                  className="shrink-0 rounded-md bg-surface px-1.5 py-0.5 text-ui-xs tabular-nums text-foreground-subtle"
                  data-testid="work-items-lane-count"
                >
                  {t("squad.workItems.lane.count", { count: lane.count })}
                </span>
              </span>
              {/* 列级动作：本轮只做**新建**（multica 列头 `+`；隐藏列面板在 spec §10-B，可后置）。
                  落到**唯一**写路径的入口上（聚焦既有的快速创建条）：没有 `onRequestCreate`
                  ⇒ 连按钮都不渲染（与「没写路径就不给入口」同款纪律，零新键 —— 可及名称走既有键）。 */}
              {onRequestCreate === undefined ? null : (
                <Button
                  size="icon-sm"
                  variant="ghost"
                  data-testid="work-items-lane-create"
                  aria-label={t("squad.workItems.create")}
                  onClick={onRequestCreate}
                >
                  <Plus aria-hidden className="size-3.5" />
                </Button>
              )}
            </div>
            {/* 拖拽启用时给每一条泳道包一层 `SortableContext`（items = 这一列的行 id）：
                跨列拖拽的落点不在本列 ⇒ 纯函数给 `none`（v1 不做跨列，= 改状态语义，不发明）。 */}
            {reorder === undefined ? (
              rows
            ) : (
              <SortableContext
                items={lane.rows.map((row) => row.item.id)}
                strategy={verticalListSortingStrategy}
              >
                {rows}
              </SortableContext>
            )}
          </section>
        );
      })}
    </div>
  );
  if (reorder === undefined) return laneShell;
  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCenter}
      onDragEnd={(event) => handleDragEnd(event, reorder)}
    >
      {laneShell}
    </DndContext>
  );
}
