import type { WorkItem } from "@zcode/shared";
import type { SquadSnapshot } from "@zcode/services";
import { isSquadBatchRoot } from "@zcode/services";
import { Button } from "@/components/ui/button.js";
import { cn } from "@/components/lib/utils.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { SUBAGENT_COLOR_CLASS, resolveSubagentColorFromName } from "@/lib/subagentColors.js";
import { SquadTimelineSection } from "./SquadTimelineSection.js";
import { resolveAssigneeName } from "./squadEntryViewModel.js";
import { flattenWorkItemBoard, workItemStatusMessageId } from "./workItemsViewModel.js";

/* 「工作项」页面的**纯呈现**看板（取数与动作都在 WorkItemsPage）。

   拆出来是为了两件事（与 SquadAgentsList / SquadsList 同款）：① 单文件不越 400 行；
   ② 列表与动作解耦后，「哪些行给哪些按钮」与「树怎么压平」只在共享纯函数里出现
   （`flattenWorkItemBoard` / `squadDiscardableWorkItemIds`），本层只照结论画。

   **空态在这里**（空看板 + 引导）：空态不是"没有内容"，而是"这里该有什么、怎么开始"
   的那句话，与列表是同一条渲染分支，分开写会漂移。

   **时间线的挂载点也在本层**（controller 2026-10-03 收口）：批根行给「时间线」展开钮，
   展开时在**该行下方**（同一个 `<li>` 内）渲染 `SquadTimelineSection`（它自己取数、收起即卸载）。
   「哪些行是批根」用服务面导出的**唯一实现** `isSquadBatchRoot`（与「放弃整批」、启动重驱
   同一份定义）—— 本层不得另写一份"什么是批"。

   缩进沿用 `WikiCatalogTree` 的既有手法（`paddingLeft: depth * 12 + 8` px）：深度由纯函数
   算好，本层只负责按它缩进 —— 组件里递归 = 不可测。 */

const LIST_CLASSNAME = "flex flex-col gap-2";
/** 行容器：比所在卡片（rounded-xl）低一级（spec §11.3 的圆角层级）。 */
const ROW_CLASSNAME = "rounded-lg border border-border px-3 py-2";

/**
 * 指派人前面的圆点（**只表达身份，不编码状态**，spec §11.3）：
 * · 智能体 ⇒ 实心点，用它自带的 `color`；未设色时按名字稳定取一个（照 SquadAgentsList）；
 * · 小队 ⇒ **没有 `color` 字段**（实体如此），用一个中性空心圆环（`border`，非九色板）——
 *   与智能体的实心点只差"型别"，不差"状态"；不替它编一个颜色（编出来的颜色是假的）；
 * · 用户 ⇒ 不画点（"我"由本地化文案表达，不需要身份色）。
 */
function AssigneeMarker({
  snapshot,
  assignee,
}: {
  snapshot: SquadSnapshot;
  assignee: WorkItem["assignee"];
}) {
  if (assignee.type === "user") return null;
  if (assignee.type === "agent") {
    const agent = snapshot.teamAgents.find((entry) => entry.id === assignee.id);
    return (
      <span
        className={cn(
          "size-2 shrink-0 rounded-full",
          SUBAGENT_COLOR_CLASS[
            agent?.color ?? resolveSubagentColorFromName(agent?.name ?? assignee.id)
          ],
        )}
        aria-hidden
      />
    );
  }
  return (
    <span className="size-2 shrink-0 rounded-full border border-foreground-subtlest" aria-hidden />
  );
}

export function WorkItemsBoard({
  workItems,
  snapshot,
  discardableIds,
  busyWorkItemId,
  timelineExpandedWorkItemId,
  onEdit,
  onReassign,
  onDiscard,
  onToggleTimeline,
  workspacePath,
  workspaceIdentity,
  onOpenSession,
}: {
  workItems: WorkItem[];
  snapshot: SquadSnapshot;
  /** 「放弃整批」入口出现的工作项（判据见 `squadDiscardableWorkItemIds`：只有**破坏性**动作才需要判据）。 */
  discardableIds: ReadonlySet<string>;
  busyWorkItemId: string | null;
  /** 当前展开了时间线的那条批根（页面的**单一**状态：一次只展开一批，见 WorkItemsPage）。 */
  timelineExpandedWorkItemId: string | null;
  onEdit: (item: WorkItem) => void;
  /** 点「改派」⇒ 交给页面打开改派对话框（本层不持有状态、也不执行服务调用）。 */
  onReassign: (item: WorkItem) => void;
  /** 点「放弃整批」⇒ **只进入待确认态**（本层拿不到服务，结构上不可能直接执行）。 */
  onDiscard: (workItemId: string) => void;
  /** 点「时间线」⇒ 交给页面切换展开态（同一条再点 = 收起；本层不持有状态）。 */
  onToggleTimeline: (item: WorkItem) => void;
  /** 展开的时间线要查哪个 workspace（页面把 shell 给的目标原样透传）。 */
  workspacePath: string;
  workspaceIdentity?: string;
  /** 打开某次运行的会话（透传给时间线分区；不传 ⇒ 站点不可点）。 */
  onOpenSession?: (sessionId: string) => void;
}) {
  const { intl } = useZCodeIntl();
  const t = (id: string) => intl.formatMessage({ id });

  if (workItems.length === 0) {
    return (
      <div className="flex flex-col gap-1" data-testid="work-items-empty">
        <p className="text-ui-base text-foreground">{t("squad.workItems.empty")}</p>
        <p className="text-ui-sm text-foreground-subtlest">{t("squad.workItems.emptyHint")}</p>
      </div>
    );
  }

  // 「是不是批根」的唯一输入：本 workspace 的 run 行按 parentWorkItemId 归拢（与页面
  // squadDiscardableWorkItemIds 同一份口径 —— 从 snapshot.runs 取，不另查一次）。
  const runParentWorkItemIds = snapshot.runs.map((run) => run.parentWorkItemId);

  return (
    <ul className={LIST_CLASSNAME} data-testid="work-items-list">
      {flattenWorkItemBoard(workItems).map(({ item, depth }) => {
        const assigneeName = resolveAssigneeName(snapshot, item.assignee);
        const busy = busyWorkItemId === item.id;
        const timelineExpanded = timelineExpandedWorkItemId === item.id;
        return (
          <li
            key={item.id}
            data-work-item-id={item.id}
            data-depth={depth}
            style={{ paddingLeft: `${depth * 12 + 8}px` }}
            className={cn(ROW_CLASSNAME, "flex flex-col gap-2")}
          >
            <div className="flex items-center justify-between gap-3">
              <span className="flex min-w-0 items-center gap-2">
                <span className="break-words text-ui-base text-foreground">{item.title}</span>
                {/* 状态徽标：六态各自文案（`WORK_ITEM_STATUS_MESSAGE_IDS` 强制穷尽）。 */}
                <span className="shrink-0 text-ui-xs text-foreground-subtle">
                  {t(workItemStatusMessageId(item.status))}
                </span>
                <span className="flex shrink-0 items-center gap-1.5 text-ui-xs text-foreground-subtle">
                  <AssigneeMarker snapshot={snapshot} assignee={item.assignee} />
                  {/* `null` = 指派给当前用户；由这里的本地化文案补上，纯函数不碰 i18n。 */}
                  {assigneeName ?? t("squad.common.assignee.user")}
                </span>
              </span>
              <span className="flex shrink-0 items-center gap-2">
                {/* 时间线展开钮：**只在批根行**给（判据 = 服务面唯一实现 isSquadBatchRoot）。
                    展开的内容在行下方（同一个 <li> 内），收起即卸载（数据丢弃，无展开态记忆）。 */}
                {isSquadBatchRoot({ workItem: item, runParentWorkItemIds }) ? (
                  <Button
                    size="sm"
                    variant="outline"
                    aria-expanded={timelineExpanded}
                    data-testid="work-item-timeline-toggle"
                    onClick={() => onToggleTimeline(item)}
                  >
                    {t("squad.timeline.toggle")}
                  </Button>
                ) : null}
                <Button
                  size="sm"
                  variant="outline"
                  disabled={busy}
                  data-testid="work-item-edit"
                  onClick={() => onEdit(item)}
                >
                  {t("squad.common.edit")}
                </Button>
                {/* 改派：**所有行都给**（含子项）—— 改负责人是派发语义（改派 = 新派发），
                    与"改个错别字"（编辑）是两类动作，故单列一个钮；点它只把意图交给页面。 */}
                <Button
                  size="sm"
                  variant="outline"
                  disabled={busy}
                  data-testid="work-item-reassign"
                  onClick={() => onReassign(item)}
                >
                  {t("squad.workItems.reassign")}
                </Button>
                {/* 放弃整批：只给判据（纯函数）认下的行；点它**只进入待确认态**。 */}
                {discardableIds.has(item.id) ? (
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={busy}
                    data-testid="work-item-discard"
                    onClick={() => onDiscard(item.id)}
                  >
                    {t("squad.discard.action")}
                  </Button>
                ) : null}
              </span>
            </div>
            {/* 内联展开：本批历史（listSquadRuns by parentWorkItemId）的泳道时间线。 */}
            {timelineExpanded ? (
              <SquadTimelineSection
                workItemId={item.id}
                workspacePath={workspacePath}
                workspaceIdentity={workspaceIdentity}
                teamAgents={snapshot.teamAgents}
                workItems={snapshot.workItems}
                onOpenSession={onOpenSession}
              />
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}
