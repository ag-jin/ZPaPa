import { useCallback, useEffect, useMemo, useState } from "react";
import type { SquadSnapshot, ISquadRuntimeServiceShape } from "@zcode/services";
import { Button } from "@/components/ui/button.js";
import { Spinner } from "@/components/ui/spinner.js";
import { toast } from "@/components/ui/toast.js";
import { useServices } from "@/hooks/useServices.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { logger } from "@/logger.js";
import { SettingsGroupCard, SettingsRow } from "@/settings/SettingsPageParts.js";
import { useTabStore } from "@/store/TabStoreProvider.js";
import {
  SquadDialog,
  TeamAgentDialog,
  WorkItemDialog,
} from "./SquadCreateDialogs.js";
import { SquadList, SquadRunList, SquadTeamAgentList, SquadWorkItemList } from "./SquadEntryLists.js";
import {
  SQUAD_RUNTIME_SERVICE_UNAVAILABLE_CODE,
  resolveSquadRuntimeService,
  squadWorkspaceTarget,
} from "./squadRuntimeAccess.js";
import {
  dispatchableTeamAgents,
  reviewOutcomeFeedback,
  squadEntryErrorFeedback,
  squadEntrySectionState,
  squadMemberCandidateAgents,
  squadServiceUnavailableFeedback,
  type SquadEntryFeedback,
} from "./squadEntryViewModel.js";

/* 「实验功能 ▸ 多智能体小队」的**最小入口**（spec §11.1「名册在设置」+ §16 S8）。

   本阶段只做呈现与最小闭环：建协作智能体 / 建小队 / 建工作项并指派 / 对未合并的 run 通过或打回。
   时间线、虚拟化、评论与「汇报 / 请求审查」两个工具都属 P2c（见 loopHint 文案，不替本阶段许诺）。

   **不是门禁**（确认 2）：开关只用来**显隐**（由 ExperimentsSection 调用 squadEntryVisible）。
   服务层单点 `ISquadRuntimeService.assertDispatchEnabled` 才是判据；这里既不读开关决定派发，
   也不自己判一遍 —— 服务层拒绝时只把稳定错误码翻译成提示（`squadEntryErrorFeedback`）。

   每个调用都**显式带目标 workspace**（确认 3：runtime 按目标现构、不缓存，没有隐式默认 workspace）；
   目标取自 UI 已有的激活 workspace，解析不出唯一目标时就不渲染数据，也不在这里现挑一个。

   本组件只做**编排**：列表在 SquadEntryLists、三个创建表单在 SquadCreateDialogs、
   判定逻辑（空段 / 候选 / 结果提示）在 squadEntryViewModel —— 那些都是可被 node:test 钉住的纯函数。 */

export function SquadMinimalView() {
  const { intl } = useZCodeIntl();
  const services = useServices();
  const activeWorkspacePath = useTabStore((state) => state.activeWorkspacePath);
  const activeWorkspaceIdentity = useTabStore((state) => state.activeWorkspaceIdentity);

  const target = useMemo(
    () => squadWorkspaceTarget(activeWorkspacePath, activeWorkspaceIdentity),
    [activeWorkspacePath, activeWorkspaceIdentity],
  );

  const [snapshot, setSnapshot] = useState<SquadSnapshot | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadFailure, setLoadFailure] = useState<SquadEntryFeedback | null>(null);
  const [busyRunId, setBusyRunId] = useState<string | null>(null);
  const [dialog, setDialog] = useState<"teamAgent" | "squad" | "workItem" | null>(null);

  const t = useCallback((id: string) => intl.formatMessage({ id }), [intl]);

  /** 提示一律**响亮**：warning 走 toast 变体；失败额外带原始细节（不吞错）。 */
  const notify = useCallback(
    (feedback: SquadEntryFeedback) => {
      const message = feedback.detail
        ? `${t(feedback.messageId)}：${feedback.detail}`
        : t(feedback.messageId);
      toast(message, feedback.tone === "warning" ? { variant: "warning" } : undefined);
    },
    [t],
  );

  const reload = useCallback(async () => {
    if (!target) return;
    setLoading(true);
    try {
      // 取数通路缺失由 resolveSquadRuntimeService 响亮抛出；这里翻成可见状态，不留白屏。
      const service = resolveSquadRuntimeService(services);
      setSnapshot(await service.getSnapshot(target));
      setLoadFailure(null);
    } catch (error) {
      logger.error("[SquadMinimalView] 读取小队数据失败", {
        error: error instanceof Error ? error.message : String(error),
      });
      setSnapshot(null);
      setLoadFailure(
        (error as { code?: unknown } | null)?.code === SQUAD_RUNTIME_SERVICE_UNAVAILABLE_CODE
          ? squadServiceUnavailableFeedback()
          : squadEntryErrorFeedback(error),
      );
    } finally {
      setLoading(false);
    }
  }, [services, target]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const sections = snapshot ? squadEntrySectionState(snapshot) : null;

  /** 三个「新建」共用一次提交：成功 ⇒ 提示 + 重载；失败 ⇒ 按稳定码翻译（含门禁拒绝）。 */
  const create = useCallback(
    async (
      action: (runtime: ISquadRuntimeServiceShape) => Promise<unknown>,
      successMessageId: string,
    ) => {
      if (!target) return;
      try {
        await action(resolveSquadRuntimeService(services));
        setDialog(null);
        notify({ tone: "success", messageId: successMessageId });
        await reload();
      } catch (error) {
        logger.warn("[SquadMinimalView] 小队操作失败", {
          error: error instanceof Error ? error.message : String(error),
        });
        notify(squadEntryErrorFeedback(error));
      }
    },
    [notify, reload, services, target],
  );

  const review = useCallback(
    async (runId: string, verdict: "approved" | "rejected") => {
      if (!target) return;
      setBusyRunId(runId);
      try {
        const outcome = await resolveSquadRuntimeService(services).reviewMemberRun(target, {
          runId,
          verdict,
        });
        notify(reviewOutcomeFeedback(outcome));
        await reload();
      } catch (error) {
        logger.warn("[SquadMinimalView] 审查裁决失败", {
          error: error instanceof Error ? error.message : String(error),
        });
        notify(squadEntryErrorFeedback(error));
      } finally {
        setBusyRunId(null);
      }
    },
    [notify, reload, services, target],
  );

  return (
    <SettingsGroupCard>
      <SettingsRow
        label={t("settings.experiments.squad.viewTitle")}
        description={t("settings.experiments.squad.loopHint")}
        control={
          <Button
            variant="outline"
            size="sm"
            disabled={!target || loading}
            onClick={() => {
              void reload();
            }}
          >
            {loading ? <Spinner className="size-3.5" /> : null}
            {t("settings.experiments.squad.refresh")}
          </Button>
        }
      />

      {/* 状态行：没有激活 workspace / 服务未接上 / 读取失败 —— 都**明说**，不把界面留成空白。 */}
      {!target ? (
        <SettingsRow label={t("settings.experiments.squad.noWorkspace")} control={null} />
      ) : null}
      {target && loadFailure && snapshot === null && !loading ? (
        <SettingsRow
          label={t(loadFailure.messageId)}
          description={loadFailure.detail}
          control={null}
        />
      ) : null}

      {snapshot && sections && target ? (
        <>
          <SettingsRow
            label={t("settings.experiments.squad.teamAgents")}
            description={
              sections.teamAgents.empty
                ? t("settings.experiments.squad.teamAgents.empty")
                : undefined
            }
            control={
              <Button size="sm" onClick={() => setDialog("teamAgent")}>
                {t("settings.experiments.squad.createTeamAgent")}
              </Button>
            }
            detail={
              sections.teamAgents.empty ? undefined : (
                <SquadTeamAgentList agents={sections.teamAgents.items} />
              )
            }
          />

          <SettingsRow
            label={t("settings.experiments.squad.squads")}
            description={
              sections.squads.empty ? t("settings.experiments.squad.squads.empty") : undefined
            }
            control={
              <Button size="sm" onClick={() => setDialog("squad")}>
                {t("settings.experiments.squad.createSquad")}
              </Button>
            }
            detail={
              sections.squads.empty ? undefined : (
                <SquadList squads={sections.squads.items} snapshot={snapshot} />
              )
            }
          />

          <SettingsRow
            label={t("settings.experiments.squad.workItems")}
            description={
              sections.workItems.empty ? t("settings.experiments.squad.workItems.empty") : undefined
            }
            control={
              <Button size="sm" onClick={() => setDialog("workItem")}>
                {t("settings.experiments.squad.createWorkItem")}
              </Button>
            }
            detail={
              sections.workItems.empty ? undefined : (
                <SquadWorkItemList workItems={sections.workItems.items} snapshot={snapshot} />
              )
            }
          />

          <SettingsRow
            label={t("settings.experiments.squad.review.title")}
            description={
              sections.runs.empty ? t("settings.experiments.squad.review.empty") : undefined
            }
            control={null}
            detail={
              sections.runs.empty ? undefined : (
                <SquadRunList
                  runs={sections.runs.items}
                  busyRunId={busyRunId}
                  onReview={(runId, verdict) => {
                    void review(runId, verdict);
                  }}
                />
              )
            }
          />
        </>
      ) : null}

      {snapshot && target && dialog === "teamAgent" ? (
        <TeamAgentDialog
          onClose={() => setDialog(null)}
          onSubmit={(input) => {
            void create(
              (runtime) => runtime.createTeamAgent(target, input),
              "settings.experiments.squad.agentCreated",
            );
          }}
        />
      ) : null}

      {snapshot && target && dialog === "squad" ? (
        <SquadDialog
          candidates={dispatchableTeamAgents(snapshot)}
          members={squadMemberCandidateAgents(snapshot, null)}
          onClose={() => setDialog(null)}
          onSubmit={(input) => {
            void create(
              (runtime) => runtime.createSquad(target, input),
              "settings.experiments.squad.squadCreated",
            );
          }}
        />
      ) : null}

      {snapshot && target && dialog === "workItem" ? (
        <WorkItemDialog
          snapshot={snapshot}
          onClose={() => setDialog(null)}
          onSubmit={(input) => {
            void create(
              (runtime) => runtime.createWorkItem(target, input),
              "settings.experiments.squad.workItemCreated",
            );
          }}
        />
      ) : null}
    </SettingsGroupCard>
  );
}
