import { useCallback, useEffect, useState } from "react";
import { resolveTeamAgentMaxConcurrentRuns, type TeamAgent } from "@zcode/shared";
import { isTerminalWorkItemStatus, type WorkItem } from "@zcode/shared";
import type { SquadRunRecord, SquadSnapshot } from "@zcode/services";
import { Button } from "@/components/ui/button.js";
import { cn } from "@/components/lib/utils.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { useServices } from "@/hooks/useServices.js";
import { SUBAGENT_COLOR_CLASS, resolveSubagentColorFromName } from "@/lib/subagentColors.js";
import { buildAgentPresence } from "./squadPresenceViewModel.js";
import { resolveSquadRuntimeService } from "./squadRuntimeAccess.js";
import { logger } from "@/logger.js";

/* ④刀（用户 2026-10-06 裁定①：新独立视图）——agent 详情页骨架（4a）：
   概览区（定义字段 + presence + 并发展示「运行中 N / 上限 M」——resolve 单源）；
   任务表/运行历史/DM 直通/并发编辑控件在 4b 落地（台账第 94 轮切分）。 */

const BADGE_CLASSNAME = "text-ui-xs text-foreground-subtlest";
const SECTION_CLASSNAME = "rounded-lg border border-border px-3 py-2";

export function SquadAgentDetailPage({
  workspacePath,
  workspaceIdentity,
  agentId,
  onBack,
  onOpenWorkItem,
  onStartConversation,
  canStartConversation,
}: {
  workspacePath: string;
  workspaceIdentity?: string;
  /** 详情页的 id 寻址（App 级意图态；列表行点击时刷新）。 */
  agentId: string | null;
  /** 返回智能体列表（shell 顶栏返回同一条判据）。 */
  onBack: () => void;
  /** B5.1：打开任务表里某条任务的工作项详情（由 shell 注入；返回目标 = 本 agent 详情页）。 */
  onOpenWorkItem: (workItemId: string) => void;
  /** 4b DM 直通（用户裁定③：新建会话 + 预填提及该智能体——复用 startDraft + 预填机制）。 */
  onStartConversation: (agentName: string) => void;
  /** 只读 workspace ⇒ DM 入口隐藏（通路在只读态是静默返回，入口不该出现）。 */
  canStartConversation: boolean;
}) {
  const { intl } = useZCodeIntl();
  const t = (id: string, values?: Record<string, string | number>) =>
    intl.formatMessage({ id }, values);
  const services = useServices();
  const [snapshot, setSnapshot] = useState<SquadSnapshot | null>(null);
  /** 4b 运行历史（全量历史，服务面无分页——前端按 agent 过滤倒序截断）。 */
  const [runHistory, setRunHistory] = useState<SquadRunRecord[] | null>(null);
  const [failure, setFailure] = useState<string | null>(null);

  const target = { path: workspacePath, identity: workspaceIdentity ?? "" };
  const reload = useCallback(async () => {
    if (!workspacePath) return;
    try {
      const service = resolveSquadRuntimeService(services);
      setSnapshot(await service.getSnapshot(target));
      setRunHistory(await service.listSquadRuns(target));
      setFailure(null);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error("[SquadAgentDetailPage] 读取快照失败", { error: message });
      setFailure(message);
    }
  }, [services, workspacePath, workspaceIdentity]);

  useEffect(() => {
    void reload();
  }, [reload]);

  if (agentId === null) {
    return (
      <div data-testid="squad-agent-detail-page" className="flex flex-col gap-2 py-8">
        <p className="text-ui-base text-foreground">{t("squad.agentDetail.noSelection")}</p>
        <Button size="sm" variant="outline" onClick={onBack} data-testid="squad-agent-detail-back">
          {t("squad.agentDetail.back")}
        </Button>
      </div>
    );
  }

  const agent = snapshot?.teamAgents.find((entry) => entry.id === agentId) ?? null;

  return (
    <div data-testid="squad-agent-detail-page" className="flex flex-col gap-3 py-2">
      <div className="flex items-center gap-2">
        <Button size="sm" variant="outline" onClick={onBack} data-testid="squad-agent-detail-back">
          {t("squad.agentDetail.back")}
        </Button>
        {failure ? (
          <span className="text-ui-sm text-destructive">{t("squad.sidebar.loadFailedAlias")}</span>
        ) : null}
      </div>

      {snapshot && agent ? (
        <>
          <OverviewZone
            agent={agent}
            snapshot={snapshot}
            onStartConversation={onStartConversation}
            canStartConversation={canStartConversation}
          />
          <TasksZone
            workItems={snapshot.workItems}
            agentId={agent.id}
            onOpenWorkItem={onOpenWorkItem}
          />
          <RunsZone runs={runHistory} agentId={agent.id} />
        </>
      ) : !failure ? (
        <p className="text-ui-sm text-foreground-subtlest">{t("squad.agentDetail.loading")}</p>
      ) : null}
    </div>
  );
}

/** 概览区（4a）：定义字段 + presence + 并发展示。任务/运行/DM 在 4b。 */
function OverviewZone({
  agent,
  snapshot,
  onStartConversation,
  canStartConversation,
}: {
  agent: TeamAgent;
  snapshot: SquadSnapshot;
  onStartConversation: (agentName: string) => void;
  canStartConversation: boolean;
}) {
  const { intl } = useZCodeIntl();
  const t = (id: string, values?: Record<string, string | number>) =>
    intl.formatMessage({ id }, values);
  const presence = buildAgentPresence(agent, snapshot.runs, snapshot.queuedRuns);
  const capacity = resolveTeamAgentMaxConcurrentRuns(agent);

  return (
    <section className={cn(SECTION_CLASSNAME, "flex flex-col gap-2")} data-testid="squad-agent-detail-overview">
      <span className="flex items-center gap-2">
        <span
          className={cn(
            "size-2.5 shrink-0 rounded-full",
            SUBAGENT_COLOR_CLASS[agent.color ?? resolveSubagentColorFromName(agent.name)],
          )}
          aria-hidden
        />
        <span className="break-words text-ui-base text-foreground">{agent.name}</span>
        {agent.archivedAt !== undefined ? (
          <span className={BADGE_CLASSNAME}>{t("squad.common.archived")}</span>
        ) : null}
        {!agent.enabled ? <span className={BADGE_CLASSNAME}>{t("squad.common.disabled")}</span> : null}
      </span>
      {agent.description ? (
        <span className="text-ui-sm text-foreground-subtlest">{agent.description}</span>
      ) : null}
      {canStartConversation ? (
        <span>
          <Button
            size="sm"
            variant="outline"
            data-testid="squad-agent-detail-start-conversation"
            onClick={() => onStartConversation(agent.name)}
          >
            {t("squad.agentDetail.startConversation")}
          </Button>
        </span>
      ) : null}
      <span className="flex flex-wrap gap-2">
        <span className={BADGE_CLASSNAME}>
          {t("squad.agentDetail.capacity", {
            running: presence.runningCount,
            max: capacity,
          })}
        </span>
        {agent.modelSelection ? (
          <span className={BADGE_CLASSNAME}>
            {agent.modelSelection.modelId}
            {agent.modelSelection.options?.reasoningLevel
              ? ` · ${agent.modelSelection.options.reasoningLevel}`
              : ""}
          </span>
        ) : (
          <span className={BADGE_CLASSNAME}>{t("squad.agents.modelDefault")}</span>
        )}
        <span className={BADGE_CLASSNAME}>
          {t(`squad.common.memoryScope.${agent.memoryScope}`)}
        </span>
        {agent.permissionMode ? (
          <span className={BADGE_CLASSNAME}>
            {t(`squad.common.permissionMode.${agent.permissionMode}`)}
          </span>
        ) : null}
        {agent.skills.length > 0 ? (
          <span className={BADGE_CLASSNAME}>{agent.skills.join(" · ")}</span>
        ) : null}
      </span>
    </section>
  );
}

/** 4b 任务表区：指派给该 agent 的工作项（只读——用户裁定⑥；动作归工作项页）。
    B5.1：行标题成为**可访问入口**（打开工作项详情）——只加导航，不在此页造写路径。 */
function TasksZone({
  workItems,
  agentId,
  onOpenWorkItem,
}: {
  workItems: WorkItem[];
  agentId: string;
  onOpenWorkItem: (workItemId: string) => void;
}) {
  const { intl } = useZCodeIntl();
  const t = (id: string) => intl.formatMessage({ id });
  const assigned = workItems.filter(
    (item) => item.assignee.type === "agent" && item.assignee.id === agentId,
  );
  return (
    <section className={SECTION_CLASSNAME} data-testid="squad-agent-detail-tasks">
      <p className="text-ui-sm font-medium text-foreground">
        {t("squad.agentDetail.tasksTitle")}
      </p>
      {assigned.length === 0 ? (
        <p className="text-ui-sm text-foreground-subtlest">{t("squad.agentDetail.tasksEmpty")}</p>
      ) : (
        <ul className="flex flex-col gap-1">
          {assigned.map((item) => (
            <li key={item.id} className="flex items-center gap-2 text-ui-sm">
              <Button
                size="xs"
                variant="ghost"
                className="min-w-0 flex-1 justify-start truncate"
                data-testid="squad-agent-detail-task-open"
                onClick={() => onOpenWorkItem(item.id)}
              >
                {item.title}
              </Button>
              <span className={BADGE_CLASSNAME}>{item.status}</span>
              {item.archivedAt !== undefined ? (
                <span className={BADGE_CLASSNAME}>{t("squad.common.archived")}</span>
              ) : null}
              {isTerminalWorkItemStatus(item.status) ? null : (
                <span className={BADGE_CLASSNAME}>{t("squad.agentDetail.tasksOpen")}</span>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/** 运行历史截断上限（用户裁定④：全历史 + 截断 50，超出显示计数）。 */
const RUN_HISTORY_LIMIT = 50;

/** 4b 运行数据区：该 agent 的全部 run 历史（含终态），倒序 + 截断。 */
function RunsZone({ runs, agentId }: { runs: SquadRunRecord[] | null; agentId: string }) {
  const { intl } = useZCodeIntl();
  const t = (id: string, values?: Record<string, string | number>) =>
    intl.formatMessage({ id }, values);
  const mine = (runs ?? [])
    .filter((run) => run.agentId === agentId)
    .sort((left, right) => right.createdAt - left.createdAt || (left.runId < right.runId ? 1 : -1));
  const visible = mine.slice(0, RUN_HISTORY_LIMIT);
  return (
    <section className={SECTION_CLASSNAME} data-testid="squad-agent-detail-runs">
      <p className="text-ui-sm font-medium text-foreground">
        {t("squad.agentDetail.runsTitle")}
        {mine.length > RUN_HISTORY_LIMIT
          ? t("squad.agentDetail.runsOverflow", { count: mine.length })
          : ""}
      </p>
      {runs === null ? (
        <p className="text-ui-sm text-foreground-subtlest">{t("squad.agentDetail.loading")}</p>
      ) : visible.length === 0 ? (
        <p className="text-ui-sm text-foreground-subtlest">{t("squad.agentDetail.runsEmpty")}</p>
      ) : (
        <ul className="flex flex-col gap-1">
          {visible.map((run) => (
            <li key={run.runId} className="flex items-center gap-2 text-ui-sm">
              <span className={BADGE_CLASSNAME}>{t(`squad.runs.status.${run.status}`)}</span>
              <span className="min-w-0 flex-1 truncate text-foreground-subtlest">
                {run.branch ?? run.runId}
              </span>
              {run.isLeaderTask ? (
                <span className={BADGE_CLASSNAME}>{t("squad.agentDetail.runsLeader")}</span>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
