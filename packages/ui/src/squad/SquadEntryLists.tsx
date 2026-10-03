import type { Squad, WorkItem } from "@zcode/shared";
import type { SquadRunRecord, SquadSnapshot } from "@zcode/services";
import { Button } from "@/components/ui/button.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { cn } from "@/components/lib/utils.js";
import {
  resolveAssigneeName,
  resolveTeamAgentName,
  squadRunStatusMessageId,
} from "./squadEntryViewModel.js";

/* 最小入口三段列表的**纯呈现**（小队 / 工作项 / 待收尾的运行；取数与动作都在 SquadMinimalView）。
   拆出来是为了两件事：① 单文件不越 400 行；② 列表与动作解耦后，动作（审查 / 新建）的
   语义只在一处出现，列表这一层只把给定的数据画全。
   本阶段**全量渲染**（spec §11.4 的虚拟化留到 P2c），不做分页也不做截断。 */

const LIST_CLASSNAME = "flex flex-col gap-2";
/** 行容器：比所在卡片（rounded-xl）低一级（spec §11.3 的圆角层级）。 */
const ROW_CLASSNAME = "rounded-lg border border-border px-3 py-2";

/* 智能体名册的列表**已搬家**：`SquadTeamAgentList`（旧的设置卡专用列表）随名册一起退役，
   现在长在 `SquadAgentsList.tsx`（一级入口「智能体」用）。这里不保留旧组件 ——
   零调用方的第二份列表就是「同一语义两处实现」的种子：将来改了这处没改那处，且不报错。 */

export function SquadList({ squads, snapshot }: { squads: Squad[]; snapshot: SquadSnapshot }) {
  const { intl } = useZCodeIntl();
  return (
    <ul className={LIST_CLASSNAME}>
      {squads.map((squad) => (
        <li key={squad.id} className={cn(ROW_CLASSNAME, "flex flex-col gap-1")}>
          <span className="break-words text-ui-base text-foreground">{squad.name}</span>
          <span className="text-ui-xs text-foreground-subtle">
            {intl.formatMessage({ id: "settings.experiments.squad.leader" })}：
            {resolveTeamAgentName(snapshot, squad.leaderAgentId)} ·{" "}
            {intl.formatMessage(
              { id: "settings.experiments.squad.membersCount" },
              { count: squad.members.length },
            )}
          </span>
        </li>
      ))}
    </ul>
  );
}

export function SquadWorkItemList({
  workItems,
  snapshot,
  discardableIds,
  busyWorkItemId,
  onDiscard,
}: {
  workItems: WorkItem[];
  snapshot: SquadSnapshot;
  /** 「放弃整批」入口出现的工作项（判据见 `squadDiscardableWorkItemIds`：只有**破坏性**动作才需要判据）。 */
  discardableIds: ReadonlySet<string>;
  busyWorkItemId: string | null;
  /** 点「放弃整批」⇒ **只进入待确认态**（本层拿不到服务，结构上不可能直接执行）。 */
  onDiscard: (workItemId: string) => void;
}) {
  const { intl } = useZCodeIntl();
  return (
    <ul className={LIST_CLASSNAME}>
      {workItems.map((workItem) => {
        const assigneeName = resolveAssigneeName(snapshot, workItem.assignee);
        return (
          <li
            key={workItem.id}
            className={cn(ROW_CLASSNAME, "flex items-center justify-between gap-3")}
          >
            <span className="min-w-0 break-words text-ui-base text-foreground">
              {workItem.title}
            </span>
            <span className="flex shrink-0 items-center gap-2">
              <span className="text-ui-xs text-foreground-subtle">
                {/* `null` = 指派给当前用户；由这里的本地化文案补上，纯函数不碰 i18n。 */}
                {assigneeName ??
                  intl.formatMessage({ id: "settings.experiments.squad.assignee.user" })}
              </span>
              {discardableIds.has(workItem.id) ? (
                <Button
                  size="sm"
                  variant="outline"
                  disabled={busyWorkItemId === workItem.id}
                  onClick={() => onDiscard(workItem.id)}
                >
                  {intl.formatMessage({ id: "settings.experiments.squad.discard.action" })}
                </Button>
              ) : null}
            </span>
          </li>
        );
      })}
    </ul>
  );
}

export function SquadRunList({
  runs,
  busyRunId,
  onReview,
}: {
  runs: SquadRunRecord[];
  busyRunId: string | null;
  onReview: (runId: string, verdict: "approved" | "rejected") => void;
}) {
  const { intl } = useZCodeIntl();
  return (
    <ul className={LIST_CLASSNAME}>
      {runs.map((run) => (
        <li
          key={run.runId}
          className={cn(ROW_CLASSNAME, "flex items-center justify-between gap-3")}
        >
          <span className="flex min-w-0 flex-col gap-1">
            <span className="break-all text-ui-base text-foreground">
              {run.branch ?? run.runId}
            </span>
            <span className="text-ui-xs text-foreground-subtle">
              {intl.formatMessage({ id: squadRunStatusMessageId(run.status) })}
              {run.isLeaderTask
                ? ` · ${intl.formatMessage({ id: "settings.experiments.squad.leader" })}`
                : ""}
            </span>
          </span>
          <span className="flex shrink-0 items-center gap-2">
            <Button
              size="sm"
              disabled={busyRunId === run.runId}
              onClick={() => onReview(run.runId, "approved")}
            >
              {intl.formatMessage({ id: "settings.experiments.squad.review.approve" })}
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={busyRunId === run.runId}
              onClick={() => onReview(run.runId, "rejected")}
            >
              {intl.formatMessage({ id: "settings.experiments.squad.review.reject" })}
            </Button>
          </span>
        </li>
      ))}
    </ul>
  );
}
