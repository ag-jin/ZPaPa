import { useCallback, useEffect, useMemo, useState } from "react";
import type { Squad } from "@zcode/shared";
import type { SquadSnapshot, ISquadRuntimeServiceShape } from "@zcode/services";
import { Alert, AlertAction, AlertDescription, AlertTitle } from "@/components/ui/alert.js";
import { Button } from "@/components/ui/button.js";
import { Spinner } from "@/components/ui/spinner.js";
import { toast } from "@/components/ui/toast.js";
import { useServices } from "@/hooks/useServices.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { logger } from "@/logger.js";
import { useConfirmDialogStore } from "@/store/confirmDialogStore.js";
import { SquadDialog } from "./SquadCreateDialogs.js";
import { SquadsList } from "./SquadsList.js";
import { squadSurfaceViewState } from "./squadSurfaceViewModel.js";
import {
  dispatchableTeamAgents,
  squadEntryErrorFeedback,
  squadMemberCandidateAgents,
  squadServiceUnavailableFeedback,
  type SquadEntryFeedback,
} from "./squadEntryViewModel.js";
import {
  SQUAD_RUNTIME_SERVICE_UNAVAILABLE_CODE,
  resolveSquadRuntimeService,
  squadWorkspaceTarget,
} from "./squadRuntimeAccess.js";
import {
  squadCreateEnabled,
  squadEditLeaderCandidates,
  squadEditMemberCandidates,
} from "./squadsViewModel.js";

/* 「小队」一级入口的**完整功能面**（与「智能体」面逐条同形；用户 2026-10-03 裁定：
   入口不藏设置；「UI 功能需要打磨完整，不要缺少东西」）。列表 / 新建 / 编辑 / 启停 / 归档，
   以及空态、加载态、错误态（带原因与重试）、实验已关闭横幅、两语文案 —— 一个都不少。

   为什么目标 workspace 从 **props** 拿（与 SquadAgentsPage 同款理由）：本页由
   WorkspaceShellLayout 渲染，shell 手里就有 `workspaceAbsPath` / `workspaceIdentity`；
   再从 tab store 读一份等于同一语义两处来源 —— shell 显示的项目与页面查询的项目可能分叉，
   而分叉不报错。

   取数通路必须经 `resolveSquadRuntimeService`（缺服务时**响亮抛**），不得直接读 accessor 上的
   小队运行时成员（那条路会把"服务没接上"静默成 undefined，界面一片空白）。
   **不是门禁**：`snapshot.enabled === false` 只用来挂横幅；拦新派发是服务层单点
   `assertDispatchEnabled` 的事（这里不写第二份判据）。名册管理（编辑/启停/归档）在实验关闭时
   本页**仍可用** —— 服务面那两个新方法有意不过门禁（见 squadRuntimeService 的 doc）。

   **归档的后果必须说清**：本页直接调既有的 `archiveSquadAndTransfer`（归档 + 把指派给该小队的
   工作项**转交给队长**）—— 服务面刻意**不为归档新增方法**（组合语义只有那一处实现）。
   因此确认文案必须提到「工作项会转交给队长」，否则用户看到的后果与文案不符。

   状态机与行动作判据在 squadSurfaceViewModel（面无关的纯函数，与智能体页**共用同一份**实现，
   可被 node:test 钉住）；本页只做投影（`snapshot.squads`）与编排。 */

export function SquadsPage({
  workspacePath,
  workspaceIdentity,
}: {
  workspacePath: string;
  workspaceIdentity?: string;
}) {
  const { intl } = useZCodeIntl();
  const services = useServices();

  const target = useMemo(
    () => squadWorkspaceTarget(workspacePath, workspaceIdentity),
    [workspacePath, workspaceIdentity],
  );

  const [snapshot, setSnapshot] = useState<SquadSnapshot | null>(null);
  const [loading, setLoading] = useState(false);
  const [failure, setFailure] = useState<SquadEntryFeedback | null>(null);
  /** 有请求在飞的行 id（照 SquadMinimalView 的 busyRunId 形态）；新建走 `*`（不会撞上真实 id）。 */
  const [busySquadId, setBusySquadId] = useState<string | null>(null);
  const [dialog, setDialog] = useState<{ kind: "create" } | { kind: "edit"; squad: Squad } | null>(
    null,
  );

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

  /* 重载：**失败不清空已有快照** —— 刷新失败要变成 ready 之上的横幅，而不是把
     "你的小队都没了"这句话说出来（数据仍在，只是这次没读到）。 */
  const reload = useCallback(async () => {
    if (!target) return;
    setLoading(true);
    try {
      const service = resolveSquadRuntimeService(services);
      setSnapshot(await service.getSnapshot(target));
      setFailure(null);
    } catch (error) {
      logger.error("[SquadsPage] 读取小队失败", {
        error: error instanceof Error ? error.message : String(error),
      });
      setFailure(
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

  /**
   * 一次动作的公共执行路径：置忙 → 调服务 → 成功提示 + 重载 / 失败提示（不吞错）→ 复位。
   * 所有写动作都走这里，于是"失败可见"只有一处实现（少一处就少一个静默吞错的口子）。
   */
  const runAction = useCallback(
    async (
      squadId: string,
      action: (service: ISquadRuntimeServiceShape) => Promise<unknown>,
      successMessageId: string,
    ) => {
      if (!target) return;
      setBusySquadId(squadId);
      try {
        await action(resolveSquadRuntimeService(services));
        setDialog(null);
        notify({ tone: "success", messageId: successMessageId });
        await reload();
      } catch (error) {
        logger.warn("[SquadsPage] 小队操作失败", {
          error: error instanceof Error ? error.message : String(error),
        });
        notify(squadEntryErrorFeedback(error));
      } finally {
        setBusySquadId(null);
      }
    },
    [notify, reload, services, target],
  );

  /**
   * 归档：破坏性且**不可撤销** ⇒ 必须二次确认（仓里既有的确认对话框单例）。
   * 文案必须说清三件事（见 `squad.squads.archiveConfirmDescription`）：①指派给该小队的
   * **工作项会转交给队长**（`archiveSquadAndTransfer` 的真实后果，不许漏）；②花名册与指令保留；
   * ③不可撤销。
   */
  const requestArchive = useCallback(
    async (squad: Squad) => {
      const confirmed = await useConfirmDialogStore.getState().requestConfirmation({
        title: intl.formatMessage({ id: "squad.squads.archiveConfirmTitle" }, { name: squad.name }),
        description: intl.formatMessage({ id: "squad.squads.archiveConfirmDescription" }),
        confirmVariant: "destructive",
        confirmLabel: intl.formatMessage({ id: "squad.common.archive" }),
        cancelLabel: intl.formatMessage({ id: "squad.common.cancel" }),
      });
      // 未确认 ⇒ 一个服务调用都不发（破坏性动作的"没发生"必须是可读出来的）。
      if (!confirmed || !target) return;
      await runAction(
        squad.id,
        // 归档**不新增服务面方法**：UI 直接调既有的 archiveSquadAndTransfer（归档 + 转交）。
        (service) => service.archiveSquadAndTransfer(target, squad.id),
        "squad.squads.archiveSucceeded",
      );
    },
    [intl, runAction, target],
  );

  /** 启用 / 停用：直接动作（无二次确认 —— 可逆，且归档才是有终态语义的那件事）。 */
  const toggleSquad = useCallback(
    async (squad: Squad) => {
      if (!target) return;
      await runAction(
        squad.id,
        (service) => service.setSquadEnabled(target, { id: squad.id, enabled: !squad.enabled }),
        squad.enabled ? "squad.squads.disabledToast" : "squad.squads.enabledToast",
      );
    },
    [runAction, target],
  );

  const state = squadSurfaceViewState({
    hasTarget: target !== null,
    snapshot,
    loading,
    failure,
  });

  /* 新建 / 编辑共用一个对话框：提交期间（busySquadId 非空）忽略重复提交 ——
     表单是同一份实现，重复点提交不该建出两支小队。 */
  const submitDialog = useCallback(
    (input: {
      name: string;
      leaderAgentId: string;
      members: string[];
      instructions: { stopCondition: string; maxRounds: string };
    }) => {
      if (busySquadId !== null || !target) return;
      if (dialog?.kind === "create") {
        void runAction(
          "*",
          (service) => service.createSquad(target, input),
          "squad.squads.created",
        );
        return;
      }
      if (dialog?.kind === "edit") {
        const id = dialog.squad.id;
        void runAction(
          id,
          // patch 形状与表单提交形状一致：name / leaderAgentId / members / instructions，
          // 正是服务面 SquadRosterPatch 的白名单（`instructions` 走逐槽合并，未编辑的槽位保留）。
          (service) => service.updateSquad(target, { id, patch: input }),
          "squad.squads.updated",
        );
      }
    },
    [busySquadId, dialog, runAction, target],
  );

  /* 新建可不可点：纯函数 squadCreateEnabled（有目标 + 已取到快照 + 有可派发候选）。
     快照没读到（加载中/失败）时置灰 —— 对话框的队长候选来自快照，读不到就开不出可提交的表单
     （「点得开但通往死路」比置灰更糟）；按钮本身**始终渲染**（可见性不依赖取数成功）。 */
  const createDisabled = !squadCreateEnabled({ hasTarget: target !== null, snapshot });

  return (
    <div data-testid="squads-page" className="flex flex-col gap-4">
      {/* 动作行**常驻**：入口的可见性不得依赖取数成功（2026-10-03 用户实测教训）——
          读不通时置灰即可，藏掉入口会让人以为"产品没做这个功能"。 */}
      <div className="flex flex-wrap items-center justify-end gap-2">
        <Button
          variant="outline"
          size="sm"
          disabled={!target || loading}
          data-testid="squads-refresh"
          onClick={() => {
            void reload();
          }}
        >
          {loading ? <Spinner className="size-3.5" /> : null}
          {t("squad.common.refresh")}
        </Button>
        <Button
          size="sm"
          disabled={createDisabled}
          data-testid="squads-create"
          onClick={() => setDialog({ kind: "create" })}
        >
          {t("squad.squads.create")}
        </Button>
      </div>

      {/* 实验已关闭：呈现横幅（入口的隐藏由 squadEntryVisible 负责；拦新派发是服务层门禁）。
          明说"此处的名册管理仍可用"，否则用户会以为整页都废了。 */}
      {state.mode === "ready" && state.experimentDisabled ? (
        <Alert variant="warning" data-testid="squads-experiment-off">
          <AlertTitle>{t("squad.common.experimentOff")}</AlertTitle>
        </Alert>
      ) : null}

      {/* 有数据但刷新失败 ⇒ 横幅（含原因 + 重试）；**不清空已有数据**。 */}
      {state.mode === "ready" && state.loadFailure ? (
        <Alert variant="destructive" data-testid="squads-load-failure">
          <AlertTitle>{t("squad.squads.loadFailed")}</AlertTitle>
          <AlertDescription>
            {t(state.loadFailure.messageId)}
            {state.loadFailure.detail ? `：${state.loadFailure.detail}` : ""}
          </AlertDescription>
          <AlertAction>
            <Button variant="outline" size="sm" onClick={() => void reload()}>
              {t("squad.common.refresh")}
            </Button>
          </AlertAction>
        </Alert>
      ) : null}

      {state.mode === "no-workspace" ? (
        <Alert data-testid="squads-no-workspace">
          <AlertTitle>{t("squad.common.noWorkspace")}</AlertTitle>
        </Alert>
      ) : null}

      {state.mode === "loading" ? (
        <div
          className="flex items-center gap-2 text-ui-base text-foreground-subtle"
          data-testid="squads-loading"
        >
          <Spinner className="size-3.5" />
          {t("squad.squads.loading")}
        </div>
      ) : null}

      {/* 无数据 + 失败 ⇒ 整页错误（**必须带原因**）+ 重试。 */}
      {state.mode === "error" ? (
        <Alert variant="destructive" data-testid="squads-error">
          <AlertTitle>{t("squad.squads.loadFailed")}</AlertTitle>
          <AlertDescription>
            {t(state.feedback.messageId)}
            {state.feedback.detail ? `：${state.feedback.detail}` : ""}
          </AlertDescription>
          <AlertAction>
            <Button variant="outline" size="sm" onClick={() => void reload()}>
              {t("squad.common.refresh")}
            </Button>
          </AlertAction>
        </Alert>
      ) : null}

      {state.mode === "ready" ? (
        <SquadsList
          squads={state.snapshot.squads}
          snapshot={state.snapshot}
          busySquadId={busySquadId}
          onEdit={(squad) => setDialog({ kind: "edit", squad })}
          onToggle={(squad) => {
            void toggleSquad(squad);
          }}
          onArchive={(squad) => {
            void requestArchive(squad);
          }}
        />
      ) : null}

      {/* 候选与队员候选都取自既有纯函数（不在这里再写一遍「什么算可派发」）。 */}
      {dialog?.kind === "create" ? (
        <SquadDialog
          candidates={snapshot ? dispatchableTeamAgents(snapshot) : []}
          members={snapshot ? squadMemberCandidateAgents(snapshot, null) : []}
          onClose={() => setDialog(null)}
          onSubmit={submitDialog}
        />
      ) : null}

      {/* 编辑：候选与勾选源走 squadEditLeaderCandidates / squadEditMemberCandidates ——
          当前队长/成员即使已停用或归档也**在列**（否则队长名显示成空白、成员没法被移除，
          见 squadsViewModel 的详注）；**新增**仍只限于可派发的智能体。队员初值 =
          名册去掉队长（队长由 leaderAgentId 表达；spec §3.3 自动并入）。 */}
      {dialog?.kind === "edit" ? (
        <SquadDialog
          candidates={snapshot ? squadEditLeaderCandidates(snapshot, dialog.squad) : []}
          members={snapshot ? squadEditMemberCandidates(snapshot, dialog.squad) : []}
          onClose={() => setDialog(null)}
          onSubmit={submitDialog}
          titleId="squad.squads.editTitle"
          submitLabelId="squad.common.save"
          initial={{
            name: dialog.squad.name,
            leaderAgentId: dialog.squad.leaderAgentId,
            memberIds: dialog.squad.members
              .map((member) => member.agentId)
              .filter((agentId) => agentId !== dialog.squad.leaderAgentId),
            stopCondition: dialog.squad.instructions.stopCondition ?? "",
            maxRounds: dialog.squad.instructions.maxRounds ?? "",
          }}
        />
      ) : null}
    </div>
  );
}
