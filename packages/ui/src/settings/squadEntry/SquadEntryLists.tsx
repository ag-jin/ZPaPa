import type { Squad, TeamAgent, WorkItem } from "@zcode/shared";
import type { SquadRunRecord, SquadSnapshot } from "@zcode/services";
import { Button } from "@/components/ui/button.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { cn } from "@/components/lib/utils.js";
import { SUBAGENT_COLOR_CLASS, resolveSubagentColorFromName } from "@/lib/subagentColors.js";
import {
  resolveAssigneeName,
  resolveTeamAgentName,
  squadRunStatusMessageId,
} from "./squadEntryViewModel.js";

/* 最小入口四段列表的**纯呈现**（取数与动作都在 SquadMinimalView）。
   拆出来是为了两件事：① 单文件不越 400 行；② 列表与动作解耦后，动作（审查 / 新建）的
   语义只在一处出现，列表这一层只把给定的数据画全。
   本阶段**全量渲染**（spec §11.4 的虚拟化留到 P2c），不做分页也不做截断。 */

const LIST_CLASSNAME = "flex flex-col gap-2";
/** 行容器：比所在卡片（rounded-xl）低一级（spec §11.3 的圆角层级）。 */
const ROW_CLASSNAME = "rounded-lg border border-border px-3 py-2";

export function SquadTeamAgentList({ agents }: { agents: TeamAgent[] }) {
  const { intl } = useZCodeIntl();
  return (
    <ul className={LIST_CLASSNAME}>
      {agents.map((agent) => (
        <li key={agent.id} className={cn(ROW_CLASSNAME, "flex items-center justify-between gap-3")}>
          <span className="flex min-w-0 items-center gap-2">
            <span
              className={cn(
                "size-2 shrink-0 rounded-full",
                // 九色板只表达身份，不编码状态（spec §11.3）；未设色时按名字稳定取一个。
                SUBAGENT_COLOR_CLASS[agent.color ?? resolveSubagentColorFromName(agent.name)],
              )}
              aria-hidden
            />
            <span className="break-words text-ui-base text-foreground">{agent.name}</span>
          </span>
          <span className="flex shrink-0 items-center gap-2">
            {agent.archivedAt !== undefined ? (
              <span className="text-ui-xs text-foreground-subtlest">
                {intl.formatMessage({ id: "settings.experiments.squad.archived" })}
              </span>
            ) : null}
            {!agent.enabled ? (
              <span className="text-ui-xs text-foreground-subtlest">
                {intl.formatMessage({ id: "settings.experiments.squad.disabled" })}
              </span>
            ) : null}
          </span>
        </li>
      ))}
    </ul>
  );
}

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
}: {
  workItems: WorkItem[];
  snapshot: SquadSnapshot;
}) {
  const { intl } = useZCodeIntl();
  return (
    <ul className={LIST_CLASSNAME}>
      {workItems.map((workItem) => {
        const assigneeName = resolveAssigneeName(snapshot, workItem.assignee);
        return (
          <li key={workItem.id} className={cn(ROW_CLASSNAME, "flex items-center justify-between gap-3")}>
            <span className="min-w-0 break-words text-ui-base text-foreground">{workItem.title}</span>
            <span className="shrink-0 text-ui-xs text-foreground-subtle">
              {/* `null` = 指派给当前用户；由这里的本地化文案补上，纯函数不碰 i18n。 */}
              {assigneeName ?? intl.formatMessage({ id: "settings.experiments.squad.assignee.user" })}
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
        <li key={run.runId} className={cn(ROW_CLASSNAME, "flex items-center justify-between gap-3")}>
          <span className="flex min-w-0 flex-col gap-1">
            <span className="break-all text-ui-base text-foreground">{run.branch ?? run.runId}</span>
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
