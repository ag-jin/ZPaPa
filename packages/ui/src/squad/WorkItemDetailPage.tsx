import { useCallback, useEffect, useMemo, useState } from "react";
import type {
  IWorkItemCollaborationServiceShape,
  PullRequestSyncReport,
  SquadSnapshot,
  SquadWorkspaceTarget,
  WorkItemCommentRecord,
} from "@zcode/services";
import { Button } from "@/components/ui/button.js";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert.js";
import { cn } from "@/components/lib/utils.js";
import { useServices } from "@/hooks/useServices.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { logger } from "@/logger.js";
import { resolveSquadRuntimeService, squadWorkspaceTarget } from "./squadRuntimeAccess.js";
import { resolveWorkItemCollaborationService } from "./workItemCollaborationAccess.js";
import { WorkItemCollaborationTimeline } from "./WorkItemCollaborationTimeline.js";
import { WorkItemCommentComposer } from "./WorkItemCommentComposer.js";
import { WorkItemCommentDeleteDialog } from "./WorkItemCommentDeleteDialog.js";
import { WorkItemDecisionRecorder, type DecisionSubmitInput } from "./WorkItemDecisionDialog.js";
import { WorkItemDetailOverview } from "./WorkItemDetailOverview.js";
import { WorkItemSubscriptionControl } from "./WorkItemSubscriptionControl.js";
import {
  subscriptionRequestFor,
  type SubscriptionIntent,
} from "./workItemSubscriptionViewModel.js";
import { WorkItemDeliverablesSection } from "./WorkItemDeliverablesSection.js";
import { WorkItemPullRequestsSection } from "./WorkItemPullRequestsSection.js";
import { buildReceiptsByComment, buildReactionsByComment } from "./workItemCollaborationGroups.js";
import { pullRequestGateNoticeMessageId } from "./workItemPullRequestsViewModel.js";
import { useWorkItemCollaboration } from "./useWorkItemCollaboration.js";
import {
  COMMENT_DELETE_CONFIRM_IDLE,
  confirmCommentDelete,
  executeCommentDelete,
  workItemDetailAssigneeLabel,
  writeDisabledReason,
  type CommentDeleteConfirmState,
} from "./workItemCollaborationViewModel.js";

/* B5.1 轮 1 / B5.2 轮 2：工作项**详情页** = **接线中心**（设计案 §2.1 的挂载点结论：独立页，
   不是抽屉/对话框）。三个区（概览/协作/交付物+PR）的挂载与「一次动作一个执行器」必须同处一屏才能
   被读出来 —— 各区自己取服务、自己写，就会重新长出第二份「谁在写」的判据（B5.1/B5.2 的立身之本）。
   本体逻辑全在独立模块里（`WorkItemDetailOverview` / `WorkItemDeliverablesSection` /
   `WorkItemPullRequestsSection` / 各 viewmodel），本文件只做挂载与回调转发；
   T-P1-R2 把概览区也搬成独立模块后，本文件回到 400 行以内，**不再需要 max-lines 豁免**。

   导航语义（§1.3）：详情页**不猜历史**，返回只调 `onBack` —— 回哪个视图由 App 的
   `returnView` 决定（从看板进 ⇒ 回看板；从 agent 任务表进 ⇒ 回 agent 详情）。

   三个**失败域**分开（§3.4）：
   · 协作读整体失败 ⇒ 本页全页失败分支（没有工作项本体可说，故不硬撑概览）；
   · 刷新失败 ⇒ 旧数据照常可读 + 协作区一条区域告警（不把已读到的正文清空）；
   · **动作失败** ⇒ 协作区的动作错误条（写入的失败不改变已经读到的事实，也不清空草稿：
     提交失败另有 composer 的就地提示与「重试发送」）。

   轮 2 的两条结构纪律：
   ① **一次动作只刷新一个事实源**：写入成功后只调 `reload()`（协作读模型）；快照只供名册，
      写入路径里**不出现** `getSnapshot(`（第二次取快照会让名册与协作数据各自漂移）；
   ② 写入调用只在下面的 `runCollaborationAction` 一处：模板与子组件都拿到「做什么」的回调，
      而不是拿到服务对象自己调（要能一眼看出「谁在写」）。C3.2 起它同时承载**决定**的写入
      （评论与决定的失败域相同：动作错误条 / 就地失败提示），唯一执行器仍是这一处。 */

export function WorkItemDetailPage({
  workspacePath,
  workspaceIdentity,
  workItemId,
  onBack,
}: {
  workspacePath: string;
  workspaceIdentity?: string;
  /** id 寻址（App 级意图态）。`null` = 未选中（与「读回 null」渲染同一个 not-found 分支）。 */
  workItemId: string | null;
  onBack: () => void;
}) {
  const { intl } = useZCodeIntl();
  const t = (id: string, values?: Record<string, string | number>) =>
    intl.formatMessage({ id }, values);
  const services = useServices();
  const target = useMemo(
    () => squadWorkspaceTarget(workspacePath, workspaceIdentity),
    [workspacePath, workspaceIdentity],
  );
  const { state, reload } = useWorkItemCollaboration({ target, workItemId });
  /* 名册**只供** mention 解析与指派显示（§9-C4：概览不从快照取工作项）——工作项本体来自协作读。 */
  const [roster, setRoster] = useState<SquadSnapshot | null>(null);
  const [replyTarget, setReplyTarget] = useState<WorkItemCommentRecord | null>(null);
  /* 概览正文**可折叠**（设计案 §2.1：避免长描述把协作入口推离首屏）——默认收起。 */
  const [bodyExpanded, setBodyExpanded] = useState(false);
  /** 待确认的删除（破坏性动作的**唯一**入口是确认对话框；见 confirmCommentDelete）。 */
  const [deleteConfirm, setDeleteConfirm] = useState<CommentDeleteConfirmState>(
    COMMENT_DELETE_CONFIRM_IDLE,
  );
  /** 有写在途的那条评论（按钮禁用；`null` = 空闲）。 */
  const [pendingCommentId, setPendingCommentId] = useState<string | null>(null);
  /** 动作失败的原因（区域错误条）：删除/解决/回应失败时显示；提交失败另有就地提示。 */
  const [actionError, setActionError] = useState<string | null>(null);

  useEffect(() => {
    if (!target) return;
    let cancelled = false;
    void (async () => {
      try {
        const snapshot = await resolveSquadRuntimeService(services).getSnapshot(target);
        if (!cancelled) setRoster(snapshot);
      } catch (error) {
        // 辅助失败域：不把整页打红，交由 composer 的「名册不可用」说明行承接（响亮、可见）。
        if (!cancelled) setRoster(null);
        logger.warn("[WorkItemDetailPage] 读取名册失败", {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [services, target]);

  const workItemIdForWrite = state.status === "ready" ? (state.read?.workItem.id ?? null) : null;

  /**
   * 页面里**唯一**的协作动作执行点（评论四入口 + C3.2 的决定写入）：写 → 只刷新协作读模型。
   *
   * 失败一律**留痕并抛回调用方**：提交（composer / 决定对话框）就地显示「未发送/未记录 + 重试」，
   * 其余动作落到上面的动作错误条。两条路都不吞异常 —— 一次「点了没反应」的动作在这个页面里凑不出来。
   * `commentId` 只是「禁用哪一条评论的动作」，与「写什么」无关（写什么由调用方给的函数决定；
   * 决定写入传 `null`）。
   */
  const runCollaborationAction = useCallback(
    async (
      /** 有写在途的那条评论的 id（决定写入传 `null`：没有评论条目要禁用）。 */
      pendingCommentId: string | null,
      run: (
        service: IWorkItemCollaborationServiceShape,
        target: SquadWorkspaceTarget,
      ) => Promise<unknown>,
    ): Promise<void> => {
      if (!target) return;
      setPendingCommentId(pendingCommentId);
      setActionError(null);
      try {
        await run(resolveWorkItemCollaborationService(services), target);
        // 一次动作只刷新一个事实源：协作读模型。快照（名册）不因评论动作失效 —— 评论不改名册。
        await reload();
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.warn("[WorkItemDetailPage] 评论动作失败", { error: message });
        setActionError(message);
        throw error;
      } finally {
        setPendingCommentId(null);
      }
    },
    [services, target, reload],
  );

  const submitComment = useCallback(
    async (input: { body: string; parentCommentId?: string; clientRequestId: string }) => {
      const id = workItemIdForWrite;
      // 没有工作项就不能提交：抛出去让 composer 显示「未发送」，**不**假装写成功。
      if (id === null) throw new Error("工作项尚未读出，无法提交评论。");
      await runCollaborationAction(null, (service, currentTarget) =>
        service.createWorkItemComment(currentTarget, {
          workItemId: id,
          body: input.body,
          ...(input.parentCommentId === undefined
            ? {}
            : { parentCommentId: input.parentCommentId }),
          clientRequestId: input.clientRequestId,
        }),
      );
    },
    [runCollaborationAction, workItemIdForWrite],
  );

  /**
   * 提交一条决定（C3.2）：与评论提交同一条执行器（写 → 只刷新协作读模型）。
   * `workItemId` 由读面带回的工作项补上（UI 不自己造 id，也不传身份/workspace —— D1-A）。
   */
  const submitDecision = useCallback(
    async (input: DecisionSubmitInput) => {
      const id = workItemIdForWrite;
      // 没有工作项就不能提交：抛出去让对话框显示「未记录」，**不**假装写成功。
      if (id === null) throw new Error("工作项尚未读出，无法记录决定。");
      await runCollaborationAction(null, (service, currentTarget) =>
        service.createWorkItemDecision(currentTarget, { ...input, workItemId: id }),
      );
    },
    [runCollaborationAction, workItemIdForWrite],
  );

  /**
   * 手动登记一条 **link** 交付物（#7 D1b）：与评论/决定同一条执行器（写 → 只刷新协作读模型）。
   * `workItemId` 由读面带回的工作项补上；`kind` 不由 UI 给（服务面只开 link）。
   */
  const submitDeliverableLink = useCallback(
    async (input: { title: string; url: string }) => {
      const id = workItemIdForWrite;
      // 没有工作项就不能登记：抛出去让交付物区显示「未登记」，**不**假装写成功。
      if (id === null) throw new Error("工作项尚未读出，无法登记交付物。");
      await runCollaborationAction(null, (service, currentTarget) =>
        service.registerWorkItemDeliverableLink(currentTarget, { workItemId: id, ...input }),
      );
    },
    [runCollaborationAction, workItemIdForWrite],
  );

  /**
   * 交付物正文按需读（#7 D1b）：**只读**不经 `runCollaborationAction`（那是写入的执行器），
   * 但仍只在这里碰服务对象 —— 组件拿回调，不拿服务。失败**不吞**：交给交付物区就地呈现
   * （读取失败与「正文缺失」是两件事，必须分得开）。
   */
  const loadDeliverableContent = useCallback(
    async (deliverableId: string) => {
      if (!target) return null;
      return resolveWorkItemCollaborationService(services).getWorkItemDeliverable(
        target,
        deliverableId,
      );
    },
    [services, target],
  );

  /**
   * 手动登记一条 **PR 关联**（#8 D2）：与交付物 link 同一条执行器（写 → 只刷新协作读模型）。
   * owner/repo/编号由服务面从 URL 归一化出来，UI 只贴地址；非 GitHub 地址由服务面响亮拒。
   */
  const submitPullRequestLink = useCallback(
    async (input: { url: string; title?: string }) => {
      const id = workItemIdForWrite;
      if (id === null) throw new Error("工作项尚未读出，无法登记 PR。");
      await runCollaborationAction(null, (service, currentTarget) =>
        service.linkWorkItemPullRequest(currentTarget, { workItemId: id, ...input }),
      );
    },
    [runCollaborationAction, workItemIdForWrite],
  );

  /** 解除一条 PR 关联（真删；返回值只用于「删到了没有」，失败仍然走动作错误条）。 */
  const unlinkPullRequest = useCallback(
    async (pullRequestId: string) => {
      await runCollaborationAction(null, (service, currentTarget) =>
        service.unlinkWorkItemPullRequest(currentTarget, { pullRequestId }),
      );
    },
    [runCollaborationAction],
  );

  /**
   * 按需刷新 PR 快照（#8 D2）：**手动触发**（没有后台轮询），与其它写入口同一条执行器 ——
   * 快照是写事实，刷完只刷新协作读模型。报告原样交给 PR 区呈现（四类结局各自可见）。
   * 未配 token 时报告里每条都是 unavailable（**不是**失败，不抛）。
   */
  const refreshPullRequests = useCallback(async () => {
    const id = workItemIdForWrite;
    if (id === null) throw new Error("工作项尚未读出，无法刷新 PR 快照。");
    let report: PullRequestSyncReport | null = null;
    await runCollaborationAction(null, async (service, currentTarget) => {
      report = await service.refreshWorkItemPullRequests(currentTarget, { workItemId: id });
    });
    if (report === null) throw new Error("刷新未执行（缺少目标 workspace）。");
    return report;
  }, [runCollaborationAction, workItemIdForWrite]);

  const requestDelete = useCallback((comment: WorkItemCommentRecord) => {
    setDeleteConfirm({ pendingCommentId: comment.id });
  }, []);
  /** 确认分支的执行：可执行的那一条**只能**来自确认态（`confirmCommentDelete`）。 */
  const runDelete = useCallback(() => {
    const decision = confirmCommentDelete(deleteConfirm);
    setDeleteConfirm(decision.next);
    if (decision.commentId === null) {
      logger.warn("[WorkItemDetailPage] 删除未确认：一级都不执行");
      return;
    }
    void runCollaborationAction(decision.commentId, (service, currentTarget) =>
      executeCommentDelete({ service, target: currentTarget, decision }),
    ).catch(() => undefined);
  }, [deleteConfirm, runCollaborationAction]);

  const runResolve = useCallback(
    (comment: WorkItemCommentRecord, resolved: boolean) => {
      void runCollaborationAction(comment.id, (service, currentTarget) =>
        service.setWorkItemCommentResolved(currentTarget, {
          commentId: comment.id,
          resolved,
        }),
      ).catch(() => undefined);
    },
    [runCollaborationAction],
  );

  const runReact = useCallback(
    (comment: WorkItemCommentRecord, emoji: string) => {
      void runCollaborationAction(comment.id, (service, currentTarget) =>
        service.addWorkItemCommentReaction(currentTarget, { commentId: comment.id, emoji }),
      ).catch(() => undefined);
    },
    [runCollaborationAction],
  );

  /**
   * 手动订阅 / 退订（SUB.3a，第六写入口的 UI）：与其余写入口**同一条执行器**（写 → 只刷新协作
   * 读模型）。请求形状由 `subscriptionRequestFor` 单源产出（判别联合不在页面里拼：「退订必带范围」
   * 由类型保证，漏带是编译错而不是猜一个默认档）。失败经唯一执行器落动作错误条（不吞、不假装成功）。
   */
  const runSubscription = useCallback(
    async (intent: SubscriptionIntent): Promise<void> => {
      const id = workItemIdForWrite;
      // 没有工作项就不能改订阅：与其余动作同一条「响亮不假成功」的口径（这里落动作错误条）。
      if (id === null) return setActionError("工作项尚未读出，无法更新订阅。");
      await runCollaborationAction(null, (service, currentTarget) =>
        service.setWorkItemSubscription(currentTarget, subscriptionRequestFor(id, intent)),
      ).catch(() => undefined);
    },
    [runCollaborationAction, workItemIdForWrite],
  );

  const backButton = (
    <Button size="sm" variant="outline" data-testid="work-item-detail-back" onClick={onBack}>
      {t("squad.workItemDetail.back")}
    </Button>
  );
  const notFound = (
    <div data-testid="work-item-detail-not-found" className="flex flex-col gap-2 py-8">
      <p className="text-ui-base text-foreground">{t("squad.workItemDetail.notFound")}</p>
      {backButton}
    </div>
  );

  /* 未选中（App 级意图态）与**读回 null**（本条不存在）在界面上是同一件事（「没有可显示的工作项」），
     故共用同一份整页形态（`notFoundView`）—— 页根 testid 全域一处，改一处漏一处的经典形态。
     判据分两处写：第一条是 id 意图，第二条在状态机收窄之后（`read === null`）。 */
  const notFoundView = (
    <div data-testid="work-item-detail-page" className="flex flex-col gap-3 py-2">
      {notFound}
    </div>
  );
  if (workItemId === null) return notFoundView;
  if (state.status === "idle" || state.status === "loading") {
    return (
      <div data-testid="work-item-detail-page" className="flex flex-col gap-3 py-2">
        <p data-testid="work-item-detail-loading" className="text-ui-sm text-foreground-subtlest">
          {t("squad.workItemDetail.loading")}
        </p>
      </div>
    );
  }
  if (state.status === "failed") {
    return (
      <div data-testid="work-item-detail-page" className="flex flex-col gap-3 py-2">
        <Alert variant="destructive" data-testid="work-item-detail-load-failure">
          <AlertTitle>{t("squad.workItemDetail.loadFailed")}</AlertTitle>
          <AlertDescription className="flex flex-col gap-2">
            <span className="text-ui-xs">{state.error}</span>
            <Button size="sm" variant="outline" onClick={reload}>
              {t("squad.workItemDetail.retry")}
            </Button>
          </AlertDescription>
        </Alert>
        {backButton}
      </div>
    );
  }
  if (state.read === null) return notFoundView;
  const read = state.read;
  const workItem = read.workItem;
  const assigneeLabel =
    (roster ? workItemDetailAssigneeLabel(workItem, roster) : null) ??
    t("squad.common.assignee.user");
  const reactionsByComment = buildReactionsByComment(read.reactions);
  const receiptsByComment = buildReceiptsByComment(read.receipts);
  /** 决定写入的禁用原因（与评论同一条判据，只换文案族）：归档 > 刷新失败 > 可写。 */
  const decisionDisabledReason = writeDisabledReason("decision", workItem, state.refreshFailure);
  /** 订阅写入的禁用原因（SUB.3a 同一判据只换面名；归档项在服务面被 `requireOwnedWorkItem` 拒）。 */
  const subscriptionReason = writeDisabledReason("subscription", workItem, state.refreshFailure);

  return (
    <div data-testid="work-item-detail-page" className="flex flex-col gap-4 py-2">
      <div className="flex flex-wrap items-center gap-2">
        {backButton}
        {state.refreshing ? (
          <span className="text-ui-xs text-foreground-subtlest">
            {t("squad.workItemDetail.loading")}
          </span>
        ) : null}
      </div>

      <WorkItemDetailOverview
        workItem={workItem}
        assigneeLabel={assigneeLabel}
        bodyExpanded={bodyExpanded}
        onToggleBody={() => setBodyExpanded((previous) => !previous)}
      />

      {/* SUB.3a：订阅控件（状态三态 + 两档退订确认）。它吃**读模型两格**（订阅行 + 观察者身份）
          ——不新开取数、不自造身份；禁用原因复用 writeDisabledReason（归档 > 读取失败 > 可写）。 */}
      <WorkItemSubscriptionControl
        subscribers={read.subscribers}
        viewerActor={read.viewerActor}
        disabledReasonMessageId={subscriptionReason}
        onSetSubscription={runSubscription}
      />

      <WorkItemDeliverablesSection
        deliverables={read.deliverables}
        registerDisabledReasonMessageId={writeDisabledReason(
          "deliverable",
          workItem,
          state.refreshFailure,
        )}
        onRegisterLink={submitDeliverableLink}
        onLoadContent={loadDeliverableContent}
      />

      {/* #8 D2：关联 PR 区**紧接**交付物区（同屏相邻）——「产出留痕」与「远端镜像」是一件事的两面。
          #8 D3：pr-gate 状态提示由**纯函数**算好（`pullRequestGateNoticeMessageId`，可独立测）：
          等待 PR 合并 / 未配 token 的降级说明 —— 判据不在组件里，也不在页面里。 */}
      <WorkItemPullRequestsSection
        pullRequests={read.pullRequests}
        provider={read.pullRequestProvider}
        registerDisabledReasonMessageId={writeDisabledReason(
          "pullRequest",
          workItem,
          state.refreshFailure,
        )}
        noticeMessageId={pullRequestGateNoticeMessageId({
          workItemStatus: workItem.status,
          mergeMode: read.mergeMode,
          providerAvailable: read.pullRequestProvider.available,
          pullRequests: read.pullRequests,
        })}
        onLink={submitPullRequestLink}
        onUnlink={unlinkPullRequest}
        onRefresh={refreshPullRequests}
      />

      <section
        data-testid="work-item-collaboration"
        className={cn("flex flex-col gap-3 rounded-xl border border-card-border bg-card px-4 py-4")}
      >
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="text-ui-base font-medium text-foreground">
            {t("squad.workItemDetail.activity.title")}
          </h2>
          {/* C3.2 写入入口（Q5 裁定：挂协作区标题行）。归档 / 读取失败时**禁用并给原因**，
              不静默消失 —— 入口消失会让「为什么不能记录」变成只能靠猜的问题。 */}
          <WorkItemDecisionRecorder
            decisions={read.decisions}
            disabledReasonMessageId={decisionDisabledReason}
            onSubmit={submitDecision}
          />
        </div>
        {state.refreshFailure === null ? null : (
          <Alert variant="destructive" data-testid="work-item-collaboration-failure">
            <AlertTitle>{t("squad.workItemDetail.activity.loadFailed")}</AlertTitle>
            <AlertDescription className="flex flex-col gap-2">
              <span className="text-ui-xs">{state.refreshFailure}</span>
              <Button size="sm" variant="outline" onClick={reload}>
                {t("squad.workItemDetail.retry")}
              </Button>
            </AlertDescription>
          </Alert>
        )}
        {actionError === null ? null : (
          /* 动作失败**不清空已经读到的事实**，只加一条可关闭的区域告警（设计案 §3.4 的失败域分离）。 */
          <Alert variant="destructive" data-testid="work-item-collaboration-action-failure">
            <AlertTitle>{t("squad.common.operationFailed")}</AlertTitle>
            <AlertDescription className="flex flex-col gap-2">
              <span className="text-ui-xs">{actionError}</span>
              <Button size="sm" variant="outline" onClick={() => setActionError(null)}>
                {t("squad.common.cancel")}
              </Button>
            </AlertDescription>
          </Alert>
        )}
        <WorkItemCollaborationTimeline
          read={read}
          reactionsByComment={reactionsByComment}
          receiptsByComment={receiptsByComment}
          roster={{ agents: roster?.teamAgents ?? [], squads: roster?.squads ?? [] }}
          viewerActor={read.viewerActor}
          pendingCommentId={pendingCommentId}
          onReply={setReplyTarget}
          onDelete={requestDelete}
          onResolve={runResolve}
          onReact={runReact}
        />
        <WorkItemCommentComposer
          roster={roster === null ? null : { agents: roster.teamAgents, squads: roster.squads }}
          replyTarget={replyTarget}
          onCancelReply={() => setReplyTarget(null)}
          disabledReasonMessageId={writeDisabledReason("comment", workItem, state.refreshFailure)}
          onSubmit={submitComment}
        />
      </section>

      {deleteConfirm.pendingCommentId === null ? null : (
        <WorkItemCommentDeleteDialog
          pending={pendingCommentId !== null}
          onCancel={() => setDeleteConfirm(COMMENT_DELETE_CONFIRM_IDLE)}
          onConfirm={runDelete}
        />
      )}
    </div>
  );
}
