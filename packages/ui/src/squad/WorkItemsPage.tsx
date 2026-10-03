import { useCallback, useEffect, useMemo, useState } from "react";
import type { WorkItem } from "@zcode/shared";
import type { SquadSnapshot, ISquadRuntimeServiceShape } from "@zcode/services";
import { Alert, AlertAction, AlertDescription, AlertTitle } from "@/components/ui/alert.js";
import { Button } from "@/components/ui/button.js";
import { Spinner } from "@/components/ui/spinner.js";
import { toast } from "@/components/ui/toast.js";
import { useServices } from "@/hooks/useServices.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { logger } from "@/logger.js";
import { WorkItemDialog, type WorkItemDialogSubmitInput } from "./SquadCreateDialogs.js";
import { SquadDiscardDialog } from "./SquadDiscardDialog.js";
import { SquadRunsReview } from "./SquadRunsReview.js";
import { WorkItemsBoard } from "./WorkItemsBoard.js";
import {
  SQUAD_DISCARD_CONFIRM_IDLE,
  cancelSquadDiscard,
  confirmSquadDiscard,
  executeSquadDiscard,
  requestSquadDiscard,
  reviewOutcomeFeedback,
  squadDiscardableWorkItemIds,
  squadEntryErrorFeedback,
  squadServiceUnavailableFeedback,
  type SquadEntryFeedback,
} from "./squadEntryViewModel.js";
import {
  SQUAD_RUNTIME_SERVICE_UNAVAILABLE_CODE,
  resolveSquadRuntimeService,
  squadWorkspaceTarget,
} from "./squadRuntimeAccess.js";
import { squadSurfaceViewState } from "./squadSurfaceViewModel.js";
import { workItemCreateEnabled } from "./workItemsViewModel.js";

/* 「工作项」一级入口的**完整功能面**（用户 2026-10-03 裁定：入口不藏设置；「UI 功能需要打磨
   完整，不要缺少东西」）。树形看板（父项批次 → 子项）/ 新建 / 编辑 / 放弃整批 / 待收尾运行的
   审查（通过 / 打回 / 打开会话），以及空态、加载态、错误态（带原因与重试）、实验已关闭横幅、
   两语文案 —— 一个都不少。

   为什么目标 workspace 从 **props** 拿（与 SquadAgentsPage / SquadsPage 同款理由）：本页由
   WorkspaceShellLayout 渲染，shell 手里就有 `workspaceAbsPath` / `workspaceIdentity`；
   再从 tab store 读一份等于同一语义两处来源 —— shell 显示的项目与页面查询的项目可能分叉，
   而分叉不报错。`onOpenSession` 也由 shell 注入（run 的会话穿透走 shell 既有的
   `handleSelectTaskInChat`，本页不自己拼导航）。

   取数通路必须经 `resolveSquadRuntimeService`（缺服务时**响亮抛**），不得直接读 accessor 上的
   小队运行时成员（那条路会把"服务没接上"静默成 undefined，界面一片空白）。
   **不是门禁**：`snapshot.enabled === false` 只用来挂横幅；拦新派发是服务层单点
   `assertDispatchEnabled` 的事（这里不写第二份判据）。编辑 / 审查 / 放弃在实验关闭时
   本页**仍可用** —— 服务面那几个方法有意不过门禁（见 squadRuntimeService 的 doc）。

   状态机与行动作在 squadSurfaceViewModel（面无关的纯函数，三个面**共用同一份**实现）；
   看板排树与新建判据在 workItemsViewModel；本页只做投影（`snapshot.workItems` / `snapshot.runs`）
   与编排。 */

export function WorkItemsPage({
  workspacePath,
  workspaceIdentity,
  onOpenSession,
}: {
  workspacePath: string;
  workspaceIdentity?: string;
  /** 打开某个 run 的独立会话（由 shell 注入：目标 workspace 就是本页那个）。
      必填而不是可选：可选会留下"按钮在、点了没反应"的静默路径（onOpenSession?.(…) 无声吞掉）
      —— shell 恒会传（`handleSelectTaskInChat` 接线），把契约钉在类型上。 */
  onOpenSession: (sessionId: string) => void;
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
  /** 有请求在飞的工作项行 id（照 SquadMinimalView 的 busyRunId 形态）；新建走 `*`（不会撞上真实 id）。 */
  const [busyWorkItemId, setBusyWorkItemId] = useState<string | null>(null);
  const [busyRunId, setBusyRunId] = useState<string | null>(null);
  const [dialog, setDialog] = useState<
    { kind: "create" } | { kind: "edit"; item: WorkItem } | null
  >(null);
  /** 「放弃整批」的**二次确认**状态（纯逻辑在视图模型：点按钮只进入待确认态，执行只发生在确认路径）。 */
  const [discardConfirm, setDiscardConfirm] = useState(SQUAD_DISCARD_CONFIRM_IDLE);
  const [discardingId, setDiscardingId] = useState<string | null>(null);
  /* 展开了时间线的**那一条**批根（一次只展开一批：状态就是一个 id）。收起/切换都只改这一处，
     不做展开态记忆；SquadTimelineSection 随条件渲染挂载/卸载，数据随之丢弃。 */
  const [expandedTimelineWorkItemId, setExpandedTimelineWorkItemId] = useState<string | null>(null);

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
     "你的工作项都没了"这句话说出来（数据仍在，只是这次没读到）。 */
  const reload = useCallback(async () => {
    if (!target) return;
    setLoading(true);
    try {
      const service = resolveSquadRuntimeService(services);
      setSnapshot(await service.getSnapshot(target));
      setFailure(null);
    } catch (error) {
      logger.error("[WorkItemsPage] 读取工作项失败", {
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
   * 一次写动作的公共执行路径：置忙 → 调服务 → 成功提示 + 重载 / 失败提示（不吞错）→ 复位。
   * 所有写动作（新建 / 编辑）都走这里，于是"失败可见"只有一处实现。
   */
  const runAction = useCallback(
    async (
      workItemId: string,
      action: (service: ISquadRuntimeServiceShape) => Promise<unknown>,
      successMessageId: string,
    ) => {
      if (!target) return;
      setBusyWorkItemId(workItemId);
      try {
        await action(resolveSquadRuntimeService(services));
        setDialog(null);
        notify({ tone: "success", messageId: successMessageId });
        await reload();
      } catch (error) {
        logger.warn("[WorkItemsPage] 工作项操作失败", {
          error: error instanceof Error ? error.message : String(error),
        });
        notify(squadEntryErrorFeedback(error));
      } finally {
        setBusyWorkItemId(null);
      }
    },
    [notify, reload, services, target],
  );

  /** 审查裁决：四种结果各有其词（`reviewOutcomeFeedback`），失败同样可见（不吞错）。 */
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
        logger.warn("[WorkItemsPage] 审查裁决失败", {
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
   * 执行目标必须来自 `confirmSquadDiscard` 的返回值：那是本页里**唯一**能产出「可执行的那一条」
   * 的地方，`workItemId` 为 `null`（= 没确认过）时直接返回 —— 「未确认就执行」在接线层面也
   * 凑不出来（页面里不出现 `discardBatch`；服务调用只在 `executeSquadDiscard` 一处）。
   * 状态与执行分离：先把待确认态收回到空闲（对话框随之关闭）再执行，重复点确认不会执行第二次。
   */
  const runDiscard = useCallback(async () => {
    const decision = confirmSquadDiscard(discardConfirm);
    setDiscardConfirm(decision.next);
    if (!target || decision.workItemId === null) return;
    setDiscardingId(decision.workItemId);
    try {
      // 成功与失败都有可见归宿：executeSquadDiscard 把两种结果都翻成提示（失败带原始细节）。
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
      logger.warn("[WorkItemsPage] 放弃整批失败", {
        error: error instanceof Error ? error.message : String(error),
      });
      notify(squadEntryErrorFeedback(error));
    } finally {
      setDiscardingId(null);
    }
  }, [discardConfirm, notify, reload, services, target]);

  const state = squadSurfaceViewState({
    hasTarget: target !== null,
    snapshot,
    loading,
    failure,
  });

  /** 给了「放弃整批」入口的工作项（破坏性动作的判据在视图模型里，可被 node:test 钉住）。 */
  const discardableIds = useMemo(
    () => (snapshot ? squadDiscardableWorkItemIds(snapshot) : new Set<string>()),
    [snapshot],
  );
  /** 待确认的那一条：取不到（快照刚变过）就不渲染对话框 —— 绝不用一个「大概的那条」去确认删除。 */
  const discardTargetItem =
    snapshot && discardConfirm.pendingWorkItemId
      ? (snapshot.workItems.find((item) => item.id === discardConfirm.pendingWorkItemId) ?? null)
      : null;

  /* 新建 / 编辑共用一个对话框：提交期间（busyWorkItemId 非空）忽略重复提交 ——
     表单是同一份实现，重复点提交不该建出两条工作项。 */
  const submitDialog = useCallback(
    (input: WorkItemDialogSubmitInput) => {
      if (busyWorkItemId !== null || !target) return;
      if (input.mode === "create") {
        void runAction(
          "*",
          (service) =>
            service.createWorkItem(target, {
              title: input.title,
              body: input.body,
              parentId: input.parentId,
              assignee: input.assignee,
            }),
          "squad.workItems.created",
        );
        return;
      }
      // 编辑：只把标题 / 正文交给服务面（`updateWorkItem` 的白名单就只有这两个）——
      // 指派与父项不在编辑里（理由见 WorkItemDialog 的注释）。
      if (dialog?.kind !== "edit") return;
      const id = dialog.item.id;
      void runAction(
        id,
        (service) =>
          service.updateWorkItem(target, {
            id,
            patch: { title: input.title, body: input.body },
          }),
        "squad.workItems.updated",
      );
    },
    [busyWorkItemId, dialog, runAction, target],
  );

  /* 新建可不可点：纯函数 workItemCreateEnabled（有目标 + 已取到快照）。
     快照没读到（加载中/失败）时置灰 —— 对话框的指派人 / 父项候选来自快照，读不到就开不出
     有选择的表单（「点得开但通往死路」比置灰更糟）；按钮本身**始终渲染**。 */
  const createDisabled = !workItemCreateEnabled({ hasTarget: target !== null, snapshot });

  /** 「时间线」展开钮：同一条再点 = 收起；点别的条 = 换过去（换过去 = 旧的卸载、数据丢弃）。 */
  const toggleTimeline = useCallback((item: WorkItem) => {
    setExpandedTimelineWorkItemId((previous) => (previous === item.id ? null : item.id));
  }, []);

  return (
    <div data-testid="work-items-page" className="flex flex-col gap-4">
      {/* 动作行**常驻**：入口的可见性不得依赖取数成功（2026-10-03 用户实测教训）——
          读不通时置灰即可，藏掉入口会让人以为"产品没做这个功能"。 */}
      <div className="flex flex-wrap items-center justify-end gap-2">
        <Button
          variant="outline"
          size="sm"
          disabled={!target || loading}
          data-testid="work-items-refresh"
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
          data-testid="work-items-create"
          onClick={() => setDialog({ kind: "create" })}
        >
          {t("squad.workItems.create")}
        </Button>
      </div>

      {/* 实验已关闭：呈现横幅（入口的隐藏由 squadEntryVisible 负责；拦新派发是服务层门禁）。
          明说"此处的编辑 / 审查 / 放弃仍可用"，否则用户会以为整页都废了。 */}
      {state.mode === "ready" && state.experimentDisabled ? (
        <Alert variant="warning" data-testid="work-items-experiment-off">
          <AlertTitle>{t("squad.common.experimentOff")}</AlertTitle>
        </Alert>
      ) : null}

      {/* 有数据但刷新失败 ⇒ 横幅（含原因 + 重试）；**不清空已有数据**。 */}
      {state.mode === "ready" && state.loadFailure ? (
        <Alert variant="destructive" data-testid="work-items-load-failure">
          <AlertTitle>{t("squad.workItems.loadFailed")}</AlertTitle>
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
        <Alert data-testid="work-items-no-workspace">
          <AlertTitle>{t("squad.common.noWorkspace")}</AlertTitle>
        </Alert>
      ) : null}

      {state.mode === "loading" ? (
        <div
          className="flex items-center gap-2 text-ui-base text-foreground-subtle"
          data-testid="work-items-loading"
        >
          <Spinner className="size-3.5" />
          {t("squad.workItems.loading")}
        </div>
      ) : null}

      {/* 无数据 + 失败 ⇒ 整页错误（**必须带原因**）+ 重试。 */}
      {state.mode === "error" ? (
        <Alert variant="destructive" data-testid="work-items-error">
          <AlertTitle>{t("squad.workItems.loadFailed")}</AlertTitle>
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
        <>
          <WorkItemsBoard
            workItems={state.snapshot.workItems}
            snapshot={state.snapshot}
            discardableIds={discardableIds}
            busyWorkItemId={discardingId ?? busyWorkItemId}
            timelineExpandedWorkItemId={expandedTimelineWorkItemId}
            onEdit={(item) => setDialog({ kind: "edit", item })}
            onDiscard={(workItemId) => {
              // **只进入待确认态**：真正的删除必须经对话框确认（不得一键即毁）。
              setDiscardConfirm(requestSquadDiscard(workItemId));
            }}
            onToggleTimeline={toggleTimeline}
            workspacePath={workspacePath}
            workspaceIdentity={workspaceIdentity}
            onOpenSession={onOpenSession}
          />
          <SquadRunsReview
            runs={state.snapshot.runs}
            busyRunId={busyRunId}
            onReview={(runId, verdict) => {
              void review(runId, verdict);
            }}
            onOpenSession={onOpenSession}
          />
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

      {snapshot && target && dialog?.kind === "create" ? (
        <WorkItemDialog
          snapshot={snapshot}
          onClose={() => setDialog(null)}
          onSubmit={submitDialog}
        />
      ) : null}

      {/* 编辑：同一份表单（`mode="edit"` 只显示标题 / 正文，见 WorkItemDialog 注释）。 */}
      {snapshot && target && dialog?.kind === "edit" ? (
        <WorkItemDialog
          snapshot={snapshot}
          onClose={() => setDialog(null)}
          onSubmit={submitDialog}
          mode="edit"
          titleId="squad.workItems.editTitle"
          submitLabelId="squad.common.save"
          initial={{ title: dialog.item.title, body: dialog.item.body }}
        />
      ) : null}
    </div>
  );
}
