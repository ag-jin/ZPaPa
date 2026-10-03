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
import { SquadDialog, TeamAgentDialog, WorkItemDialog } from "./SquadCreateDialogs.js";
import { SquadDiscardDialog } from "./SquadDiscardDialog.js";
import {
  SquadList,
  SquadRunList,
  SquadTeamAgentList,
  SquadWorkItemList,
} from "./SquadEntryLists.js";
import {
  SQUAD_RUNTIME_SERVICE_UNAVAILABLE_CODE,
  resolveSquadRuntimeService,
  squadWorkspaceTarget,
} from "./squadRuntimeAccess.js";
import {
  SQUAD_DISCARD_CONFIRM_IDLE,
  cancelSquadDiscard,
  confirmSquadDiscard,
  dispatchableTeamAgents,
  executeSquadDiscard,
  requestSquadDiscard,
  reviewOutcomeFeedback,
  squadDiscardableWorkItemIds,
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
  /** 「放弃整批」的**二次确认**状态（纯逻辑在视图模型：点按钮只进入待确认态，执行只发生在确认路径）。 */
  const [discardConfirm, setDiscardConfirm] = useState(SQUAD_DISCARD_CONFIRM_IDLE);
  const [discardingId, setDiscardingId] = useState<string | null>(null);

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
  /** 给了入口的工作项（破坏性动作的判据在视图模型里，可被 node:test 钉住）。 */
  const discardableIds = useMemo(
    () => (snapshot ? squadDiscardableWorkItemIds(snapshot) : new Set<string>()),
    [snapshot],
  );
  /** 待确认的那一条：取不到（快照刚变过）就不渲染对话框 —— 绝不用一个「大概的那条」去确认删除。 */
  const discardTargetItem =
    snapshot && discardConfirm.pendingWorkItemId
      ? (snapshot.workItems.find((item) => item.id === discardConfirm.pendingWorkItemId) ?? null)
      : null;

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

  /**
   * 「放弃整批」的**唯一执行点**（只在确认对话框的确认动作里被调到）。
   *
   * 为什么执行目标必须来自 `confirmSquadDiscard` 的返回值：那是本视图里**唯一**能产出「可执行的那一条」
   * 的地方，`workItemId` 为 `null`（= 没确认过）时下面直接返回 —— 于是「未确认就执行」在接线层面
   * 也没法凑出来（组件里不出现 `discardBatch`；服务调用只在 `executeSquadDiscard` 一处）。
   *
   * 状态与执行分离：先把待确认态收回到空闲（对话框随之关闭）再执行，所以重复点确认不会执行第二次。
   */
  const runDiscard = useCallback(async () => {
    const decision = confirmSquadDiscard(discardConfirm);
    setDiscardConfirm(decision.next);
    if (!target || decision.workItemId === null) return;
    setDiscardingId(decision.workItemId);
    try {
      // 成功与失败都有可见归宿：executeSquadDiscard 把两种结果都翻成提示（失败带原始细节，不吞错）。
      notify(
        await executeSquadDiscard({
          service: resolveSquadRuntimeService(services),
          target,
          decision,
        }),
      );
      await reload();
    } catch (error) {
      // 取数通路缺失（服务没接上）在这里冒出：不吞，翻成可见提示。
      logger.warn("[SquadMinimalView] 放弃整批失败", {
        error: error instanceof Error ? error.message : String(error),
      });
      notify(squadEntryErrorFeedback(error));
    } finally {
      setDiscardingId(null);
    }
  }, [discardConfirm, notify, reload, services, target]);

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

      {/* 三个「新建」**始终渲染**（读不通当前 workspace 时**置灰**，而不是整块消失）。
          2026-10-03 实测教训：用户开了实验开关、打开这张卡，看到的是「操作失败 + 刷新」——
          因为入口原本包在 `snapshot && sections` 里，**读失败就把入口一起藏掉了** ⇒
          「被错误挡住」看起来和「产品没做这个入口」一模一样（用户的原话就是「前端没有 UI 承接操作吗？」）。
          判据：**入口的可见性不得依赖取数成功**；取数失败时由上面的状态行说明原因，按钮置灰即可。 */}
      {target ? (
        <>
          <SettingsRow
            label={t("settings.experiments.squad.teamAgents")}
            description={
              sections?.teamAgents.empty
                ? t("settings.experiments.squad.teamAgents.empty")
                : undefined
            }
            control={
              <Button size="sm" disabled={!snapshot} onClick={() => setDialog("teamAgent")}>
                {t("settings.experiments.squad.createTeamAgent")}
              </Button>
            }
            detail={
              snapshot && sections && !sections.teamAgents.empty ? (
                <SquadTeamAgentList agents={sections.teamAgents.items} />
              ) : undefined
            }
          />

          <SettingsRow
            label={t("settings.experiments.squad.squads")}
            description={
              sections?.squads.empty ? t("settings.experiments.squad.squads.empty") : undefined
            }
            control={
              <Button size="sm" disabled={!snapshot} onClick={() => setDialog("squad")}>
                {t("settings.experiments.squad.createSquad")}
              </Button>
            }
            detail={
              snapshot && sections && !sections.squads.empty ? (
                <SquadList squads={sections.squads.items} snapshot={snapshot} />
              ) : undefined
            }
          />

          <SettingsRow
            label={t("settings.experiments.squad.workItems")}
            description={
              sections?.workItems.empty
                ? t("settings.experiments.squad.workItems.empty")
                : undefined
            }
            control={
              <Button size="sm" disabled={!snapshot} onClick={() => setDialog("workItem")}>
                {t("settings.experiments.squad.createWorkItem")}
              </Button>
            }
            detail={
              snapshot && sections && !sections.workItems.empty ? (
                <SquadWorkItemList
                  workItems={sections.workItems.items}
                  snapshot={snapshot}
                  discardableIds={discardableIds}
                  busyWorkItemId={discardingId}
                  onDiscard={(workItemId) => {
                    // **只进入待确认态**：真正的删除必须经对话框确认（不得一键即毁）。
                    setDiscardConfirm(requestSquadDiscard(workItemId));
                  }}
                />
              ) : undefined
            }
          />

          {/* 审查列表没有「新建」入口，只在取数成功后才有内容可渲染。 */}
          {snapshot && sections ? (
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
          ) : null}
        </>
      ) : null}

      {/* 二次确认：**只在确认后**才执行放弃（执行目标由 confirmSquadDiscard 产出）。
          文案必须说清后果（删哪些分支、工作树会被清、该批判为什么）。 */}
      {discardTargetItem ? (
        <SquadDiscardDialog
          workItem={discardTargetItem}
          pending={discardingId !== null}
          onCancel={() => setDiscardConfirm(cancelSquadDiscard())}
          onConfirm={() => {
            void runDiscard();
          }}
        />
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
