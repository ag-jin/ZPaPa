import type { WorkItem, WorkItemStatusCategory } from "@zcode/shared";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { parseAssigneeValue } from "./squadEntryViewModel.js";
import { WorkItemRowList, type WorkItemRowEnvironment } from "./WorkItemRows.js";
import {
  WORK_ITEM_STATUS_CATEGORY_MESSAGE_IDS,
  flattenWorkItemBoard,
  groupWorkItemBoard,
  workItemLaneAssigneeName,
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
   ⇒ 聚焦/高亮在任一视图下语义相同。 */

export function WorkItemsBoard({
  workItems,
  laneDimension,
  environment,
}: {
  /** 本视图要显示的项（宿主投影后的可见集；默认状态下与输入同一份）。 */
  workItems: WorkItem[];
  /** 分组维度（看板泳道）：`none` = 单 ul（现状 DOM 逐字保留）；其余按泳道分组（只切根）。 */
  laneDimension: WorkItemLaneDimension;
  /** 三视图共用的行环境（宿主装配一次；行模块消费它）。 */
  environment: WorkItemRowEnvironment;
}) {
  const { intl } = useZCodeIntl();
  const t = (id: string, values?: Record<string, string | number>) =>
    intl.formatMessage({ id }, values);

  /* 不分组 = **现状 DOM 逐字保留**（单 `<ul data-testid="work-items-list">`，无泳道壳）：
     默认维度下所有既有用户看到的界面零变化 —— 「给出泳道」不等于「换掉看板」。 */
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
      （`null` = 当前用户，由本地化文案补；未知对象的 id 后面补一句说明，避免被读成「没指派」）。 */
  const laneTitle = (key: string): string => {
    if (laneDimension === "statusCategory") {
      return t(WORK_ITEM_STATUS_CATEGORY_MESSAGE_IDS[key as WorkItemStatusCategory]);
    }
    if (key === "user") return t("squad.workItems.lane.assignee.user");
    const resolved = workItemLaneAssigneeName(environment.snapshot, parseAssigneeValue(key));
    if (resolved.name === null) return t("squad.workItems.lane.assignee.user");
    return resolved.known
      ? resolved.name
      : resolved.name + t("squad.workItems.lane.assignee.unknownSuffix");
  };

  /* 泳道视图：只加「外层容器 + 头部」，行仍由共用行模块渲染（单点）。
     泳道**不做折叠**（v1）：行全部挂载 ⇒ 聚焦注册完整，收件箱聚焦/高亮在任一视图下逐字不变。 */
  return (
    <div className="flex flex-col gap-3" data-testid="work-items-lanes">
      {groupWorkItemBoard({
        items: workItems,
        dimension: laneDimension,
        roster: environment.snapshot,
      }).map((lane) => (
        <section
          key={lane.key}
          className="flex flex-col gap-1"
          data-testid="work-items-lane"
          data-lane-key={lane.key}
        >
          <span className="flex items-center gap-2 px-1 text-ui-xs text-foreground-subtle">
            <span className="font-medium">{laneTitle(lane.key)}</span>
            <span className="text-foreground-subtlest">
              {t("squad.workItems.lane.count", { count: lane.count })}
            </span>
          </span>
          <WorkItemRowList rows={lane.rows} environment={environment} />
        </section>
      ))}
    </div>
  );
}
