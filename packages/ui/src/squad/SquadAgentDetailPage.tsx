import { useCallback, useEffect, useState } from "react";
import { resolveTeamAgentMaxConcurrentRuns, type TeamAgent } from "@zcode/shared";
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
}: {
  workspacePath: string;
  workspaceIdentity?: string;
  /** 详情页的 id 寻址（App 级意图态；列表行点击时刷新）。 */
  agentId: string | null;
  /** 返回智能体列表（shell 顶栏返回同一条判据）。 */
  onBack: () => void;
}) {
  const { intl } = useZCodeIntl();
  const t = (id: string, values?: Record<string, string | number>) =>
    intl.formatMessage({ id }, values);
  const services = useServices();
  const [snapshot, setSnapshot] = useState<SquadSnapshot | null>(null);
  const [failure, setFailure] = useState<string | null>(null);

  const target = { path: workspacePath, identity: workspaceIdentity ?? "" };
  const reload = useCallback(async () => {
    if (!workspacePath) return;
    try {
      const service = resolveSquadRuntimeService(services);
      setSnapshot(await service.getSnapshot(target));
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
        <Button
          size="sm"
          variant="outline"
          onClick={onBack}
          data-testid="squad-agent-detail-back"
        >
          {t("squad.agentDetail.back")}
        </Button>
        {failure ? (
          <span className="text-ui-sm text-destructive">{t("squad.sidebar.loadFailedAlias")}</span>
        ) : null}
      </div>

      {snapshot && agent ? (
        <OverviewZone agent={agent} snapshot={snapshot} />
      ) : !failure ? (
        <p className="text-ui-sm text-foreground-subtlest">{t("squad.agentDetail.loading")}</p>
      ) : null}
    </div>
  );
}

/** 概览区（4a）：定义字段 + presence + 并发展示。任务/运行/DM 在 4b。 */
function OverviewZone({ agent, snapshot }: { agent: TeamAgent; snapshot: SquadSnapshot }) {
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
