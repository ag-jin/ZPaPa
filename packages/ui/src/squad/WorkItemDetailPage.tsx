import { useCallback, useEffect, useMemo, useState } from "react";
import type {
  IWorkItemCollaborationServiceShape,
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
import { WorkItemLabelChip } from "./WorkItemsBoard.js";
import { WorkItemCollaborationTimeline } from "./WorkItemCollaborationTimeline.js";
import { WorkItemCommentComposer } from "./WorkItemCommentComposer.js";
import { WorkItemCommentDeleteDialog } from "./WorkItemCommentDeleteDialog.js";
import { WorkItemDecisionRecorder, type DecisionSubmitInput } from "./WorkItemDecisionDialog.js";
import { WorkItemDeliverablesSection } from "./WorkItemDeliverablesSection.js";
import { buildReceiptsByComment, buildReactionsByComment } from "./workItemCollaborationGroups.js";
import { useWorkItemCollaboration } from "./useWorkItemCollaboration.js";
import {
  COMMENT_DELETE_CONFIRM_IDLE,
  confirmCommentDelete,
  executeCommentDelete,
  workItemDetailAssigneeLabel,
  writeDisabledReason,
  type CommentDeleteConfirmState,
} from "./workItemCollaborationViewModel.js";
import { workItemPropertyValueText, workItemStatusMessageId } from "./workItemsViewModel.js";

/* B5.1 轮 1 / B5.2 轮 2：工作项**详情页**（设计案 §2.1 的挂载点结论：独立页，不是抽屉/对话框）。

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

  if (workItemId === null) {
    return (
      <div data-testid="work-item-detail-page" className="flex flex-col gap-3 py-2">
        {notFound}
      </div>
    );
  }
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
  if (state.read === null) {
    return (
      <div data-testid="work-item-detail-page" className="flex flex-col gap-3 py-2">
        {notFound}
      </div>
    );
  }

  const read = state.read;
  const workItem = read.workItem;
  const assigneeLabel =
    (roster ? workItemDetailAssigneeLabel(workItem, roster) : null) ??
    t("squad.common.assignee.user");
  const reactionsByComment = buildReactionsByComment(read.reactions);
  const receiptsByComment = buildReceiptsByComment(read.receipts);
  /** 决定写入的禁用原因（与评论同一条判据，只换文案族）：归档 > 刷新失败 > 可写。 */
  const decisionDisabledReason = writeDisabledReason("decision", workItem, state.refreshFailure);

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

      <section
        data-testid="work-item-detail-overview"
        className="flex flex-col gap-2 rounded-xl border border-card-border bg-card px-4 py-4"
      >
        <span className="flex flex-wrap items-center gap-2 text-ui-xs text-foreground-subtle">
          <span>{t(workItemStatusMessageId(workItem.status))}</span>
          <span>{assigneeLabel}</span>
          {workItem.archivedAt === undefined ? null : <span>{t("squad.common.archived")}</span>}
        </span>
        <h1 className="text-ui-lg font-medium text-foreground">{workItem.title}</h1>
        {/* 标签（#11 v1）：**全量**呈现、不截断（看板行的 3 个上限是行的约束，不是这条记录的约束），
            取自 `state.read.workItem`（协作读模型含归档行 —— 用快照的话归档项的标签会凭空消失）。
            空标签给一句「无标签」而不是整块消失：字段是这一轮新加的，什么都没有会被读成「页面坏了」。 */}
        <span className="flex flex-wrap items-center gap-1" data-testid="work-item-detail-labels">
          <span className="text-ui-xs text-foreground-subtle">
            {t("squad.workItemDetail.overview.labels")}
          </span>
          {workItem.labels.length === 0 ? (
            <span className="text-ui-xs text-foreground-subtlest">
              {t("squad.workItemDetail.overview.labelsEmpty")}
            </span>
          ) : (
            workItem.labels.map((label) => <WorkItemLabelChip key={label} label={label} />)
          )}
        </span>
        {/* 自定义属性（#11 v1）：**只读**呈现（零写者字段不做编辑器 —— 值域没有类型契约，
            先造编辑器就是替设计补一个没裁过的决定）。非字符串值原样显示 JSON 文本；
            没有属性则整块不渲染（空行是噪音，与 MCP 徽标同一裁定）。 */}
        {Object.entries(workItem.properties).length === 0 ? null : (
          <span
            className="flex flex-wrap items-center gap-2 text-ui-xs"
            data-testid="work-item-detail-properties"
          >
            <span className="text-foreground-subtle">
              {t("squad.workItemDetail.overview.properties")}
            </span>
            {Object.entries(workItem.properties).map(([key, value]) => (
              <span
                key={key}
                className="flex items-center gap-1 rounded border border-border px-1.5 py-0.5"
                data-testid="work-item-detail-property"
              >
                <span className="text-foreground-subtle">{key}</span>
                <span className="text-foreground-subtlest">{workItemPropertyValueText(value)}</span>
              </span>
            ))}
          </span>
        )}
        {workItem.body.trim().length === 0 ? null : (
          <>
            <Button
              size="xs"
              variant="ghost"
              className="self-start"
              aria-expanded={bodyExpanded}
              data-testid="work-item-detail-body-toggle"
              onClick={() => setBodyExpanded((previous) => !previous)}
            >
              {bodyExpanded
                ? t("squad.workItemDetail.overview.bodyHide")
                : t("squad.workItemDetail.overview.bodyShow")}
            </Button>
            {bodyExpanded ? (
              <p className="text-ui-base text-foreground-subtle whitespace-pre-wrap break-words">
                {workItem.body}
              </p>
            ) : null}
          </>
        )}
      </section>

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
