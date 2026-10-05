import { useCallback, useEffect, useMemo, useState } from "react";
import type { TeamAgent } from "@zcode/shared";
import type { SquadSnapshot, ISquadRuntimeServiceShape } from "@zcode/services";
import { Alert, AlertAction, AlertDescription, AlertTitle } from "@/components/ui/alert.js";
import { Button } from "@/components/ui/button.js";
import { Spinner } from "@/components/ui/spinner.js";
import { toast } from "@/components/ui/toast.js";
import { useServices } from "@/hooks/useServices.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { logger } from "@/logger.js";
import { useConfirmDialogStore } from "@/store/confirmDialogStore.js";
import { TeamAgentDialog } from "./SquadCreateDialogs.js";
import { SquadAgentsList } from "./SquadAgentsList.js";
import { squadSurfaceViewState } from "./squadSurfaceViewModel.js";
import {
  squadEntryErrorFeedback,
  squadServiceUnavailableFeedback,
  type SquadEntryFeedback,
} from "./squadEntryViewModel.js";
import {
  SQUAD_RUNTIME_SERVICE_UNAVAILABLE_CODE,
  resolveSquadRuntimeService,
  squadWorkspaceTarget,
} from "./squadRuntimeAccess.js";

/* 「智能体」一级入口的**完整功能面**（用户 2026-10-03 裁定：入口不藏设置；「UI 功能需要打磨完整，
   不要缺少东西」）。列表 / 新建 / 编辑 / 启停 / 归档，以及空态、加载态、错误态（带原因与重试）、
   实验已关闭横幅、两语文案 —— 一个都不少。

   为什么目标 workspace 从 **props** 拿（而不是像设置卡的 SquadMinimalView 那样读 tab store）：
   本页由 WorkspaceShellLayout 渲染，shell 手里就有 `workspaceAbsPath` / `workspaceIdentity`
   （与 AutomationsSection / PluginStorePage 同款形态）。再从 store 读一份，等于同一语义两处来源 ——
   shell 显示的项目与页面查询的项目可能分叉，而分叉不报错。设置卡能用 store 是因为它就长在设置页里，
   没有 shell 的那份上下文。

   取数通路必须经 `resolveSquadRuntimeService`（缺服务时**响亮抛**），不得直接读 accessor 上的
   小队运行时成员（那条路会把"服务没接上"静默成 undefined，界面一片空白；结构守卫钉住本页
   不出现该成员名）。
   **不是门禁**：`snapshot.enabled === false` 只用来挂横幅；拦新派发是服务层单点
   `assertDispatchEnabled` 的事（这里不写第二份判据）。名册管理（编辑/启停/归档）在实验关闭时
   本页**仍可用** —— 服务面那三个方法有意不过门禁（见 squadRuntimeService 的 doc）。

   动作判据（哪些行给哪些按钮）与状态机在 squadSurfaceViewModel（纯函数，可被 node:test 钉住；
   小队页与这里共用**同一份**实现，状态结论不各写一遍）。 */

export function SquadAgentsPage({
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
  const [busyAgentId, setBusyAgentId] = useState<string | null>(null);
  const [dialog, setDialog] = useState<
    { kind: "create" } | { kind: "edit"; agent: TeamAgent } | null
  >(null);

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
     "你的智能体都没了"这句话说出来（数据仍在，只是这次没读到）。 */
  const reload = useCallback(async () => {
    if (!target) return;
    setLoading(true);
    try {
      const service = resolveSquadRuntimeService(services);
      setSnapshot(await service.getSnapshot(target));
      setFailure(null);
    } catch (error) {
      logger.error("[SquadAgentsPage] 读取协作智能体失败", {
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
      agentId: string,
      action: (service: ISquadRuntimeServiceShape) => Promise<unknown>,
      successMessageId: string,
    ) => {
      if (!target) return;
      setBusyAgentId(agentId);
      try {
        await action(resolveSquadRuntimeService(services));
        setDialog(null);
        notify({ tone: "success", messageId: successMessageId });
        await reload();
      } catch (error) {
        logger.warn("[SquadAgentsPage] 协作智能体操作失败", {
          error: error instanceof Error ? error.message : String(error),
        });
        notify(squadEntryErrorFeedback(error));
      } finally {
        setBusyAgentId(null);
      }
    },
    [notify, reload, services, target],
  );

  /** 归档：破坏性且**不可撤销** ⇒ 必须二次确认（仓里既有的确认对话框单例）。 */
  const requestArchive = useCallback(
    async (agent: TeamAgent) => {
      const confirmed = await useConfirmDialogStore.getState().requestConfirmation({
        title: intl.formatMessage({ id: "squad.agents.archiveConfirmTitle" }, { name: agent.name }),
        description: intl.formatMessage({ id: "squad.agents.archiveConfirmDescription" }),
        confirmVariant: "destructive",
        confirmLabel: intl.formatMessage({ id: "squad.common.archive" }),
        cancelLabel: intl.formatMessage({ id: "squad.common.cancel" }),
      });
      // 未确认 ⇒ 一个服务调用都不发（破坏性动作的"没发生"必须是可读出来的）。
      if (!confirmed || !target) return;
      await runAction(
        agent.id,
        (service) => service.archiveTeamAgent(target, { id: agent.id }),
        "squad.agents.archiveSucceeded",
      );
    },
    [intl, runAction, target],
  );

  /** 启用 / 停用：直接动作（无二次确认 —— 可逆，且归档才是有终态语义的那件事）。 */
  const toggleAgent = useCallback(
    async (agent: TeamAgent) => {
      if (!target) return;
      await runAction(
        agent.id,
        (service) => service.setTeamAgentEnabled(target, { id: agent.id, enabled: !agent.enabled }),
        agent.enabled ? "squad.agents.disabledToast" : "squad.agents.enabledToast",
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

  /* 新建 / 编辑共用一个对话框：提交期间（busyAgentId 非空）忽略重复提交 ——
     表单是同一份实现，重复点提交不该建出两个智能体。 */
  const submitDialog = useCallback(
    (input: { name: string; systemPrompt: string; memoryScope: TeamAgent["memoryScope"] }) => {
      if (busyAgentId !== null || !target) return;
      if (dialog?.kind === "create") {
        void runAction(
          "*",
          (service) => service.createTeamAgent(target, input),
          "squad.agents.created",
        );
        return;
      }
      if (dialog?.kind === "edit") {
        const id = dialog.agent.id;
        void runAction(
          id,
          (service) => service.updateTeamAgent(target, { id, patch: input }),
          "squad.agents.updated",
        );
      }
    },
    [busyAgentId, dialog, runAction, target],
  );

  return (
    <div data-testid="squad-agents-page" className="flex flex-col gap-4">
      {/* 动作行**常驻**：入口的可见性不得依赖取数成功（2026-10-03 用户实测教训）——
          读不通时置灰即可，藏掉入口会让人以为"产品没做这个功能"。 */}
      <div className="flex flex-wrap items-center justify-end gap-2">
        <Button
          variant="outline"
          size="sm"
          disabled={!target || loading}
          data-testid="squad-agents-refresh"
          onClick={() => {
            void reload();
          }}
        >
          {loading ? <Spinner className="size-3.5" /> : null}
          {t("squad.common.refresh")}
        </Button>
        <Button
          size="sm"
          disabled={!target}
          data-testid="squad-agents-create"
          onClick={() => setDialog({ kind: "create" })}
        >
          {t("squad.agents.create")}
        </Button>
      </div>

      {/* 实验已关闭：呈现横幅（入口的隐藏由 squadEntryVisible 负责；拦新派发是服务层门禁）。
          明说"此处的名册管理仍可用"，否则用户会以为整页都废了。 */}
      {state.mode === "ready" && state.experimentDisabled ? (
        <Alert variant="warning" data-testid="squad-agents-experiment-off">
          <AlertTitle>{t("squad.common.experimentOff")}</AlertTitle>
        </Alert>
      ) : null}

      {/* 有数据但刷新失败 ⇒ 横幅（含原因 + 重试）；**不清空已有数据**。 */}
      {state.mode === "ready" && state.loadFailure ? (
        <Alert variant="destructive" data-testid="squad-agents-load-failure">
          <AlertTitle>{t("squad.agents.loadFailed")}</AlertTitle>
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
        <Alert data-testid="squad-agents-no-workspace">
          <AlertTitle>{t("squad.common.noWorkspace")}</AlertTitle>
        </Alert>
      ) : null}

      {state.mode === "loading" ? (
        <div
          className="flex items-center gap-2 text-ui-base text-foreground-subtle"
          data-testid="squad-agents-loading"
        >
          <Spinner className="size-3.5" />
          {t("squad.agents.loading")}
        </div>
      ) : null}

      {/* 无数据 + 失败 ⇒ 整页错误（**必须带原因**）+ 重试。 */}
      {state.mode === "error" ? (
        <Alert variant="destructive" data-testid="squad-agents-error">
          <AlertTitle>{t("squad.agents.loadFailed")}</AlertTitle>
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
        <SquadAgentsList
          agents={state.snapshot.teamAgents}
          runs={state.snapshot.runs}
          queuedRuns={state.snapshot.queuedRuns}
          busyAgentId={busyAgentId}
          onEdit={(agent) => setDialog({ kind: "edit", agent })}
          onToggle={(agent) => {
            void toggleAgent(agent);
          }}
          onArchive={(agent) => {
            void requestArchive(agent);
          }}
        />
      ) : null}

      {dialog?.kind === "create" ? (
        <TeamAgentDialog
          onClose={() => setDialog(null)}
          onSubmit={submitDialog}
          titleId="squad.agents.create"
          submitLabelId="squad.common.submit"
        />
      ) : null}

      {dialog?.kind === "edit" ? (
        <TeamAgentDialog
          onClose={() => setDialog(null)}
          onSubmit={submitDialog}
          titleId="squad.agents.editTitle"
          submitLabelId="squad.common.save"
          initial={{
            name: dialog.agent.name,
            systemPrompt: dialog.agent.systemPrompt,
            memoryScope: dialog.agent.memoryScope,
          }}
        />
      ) : null}
    </div>
  );
}
