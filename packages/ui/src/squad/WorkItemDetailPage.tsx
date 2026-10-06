import { useEffect, useMemo, useState } from "react";
import type {
  SquadSnapshot,
  WorkItemCommentReactionRecord,
  WorkItemCommentRecord,
} from "@zcode/services";
import { Button } from "@/components/ui/button.js";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert.js";
import { cn } from "@/components/lib/utils.js";
import { useServices } from "@/hooks/useServices.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { logger } from "@/logger.js";
import { resolveSquadRuntimeService, squadWorkspaceTarget } from "./squadRuntimeAccess.js";
import { WorkItemCollaborationTimeline } from "./WorkItemCollaborationTimeline.js";
import { WorkItemCommentComposer } from "./WorkItemCommentComposer.js";
import { useWorkItemCollaboration } from "./useWorkItemCollaboration.js";
import { workItemDetailAssigneeLabel } from "./workItemCollaborationViewModel.js";
import { workItemStatusMessageId } from "./workItemsViewModel.js";

/* B5.1 轮 1：工作项**详情页**（设计案 §2.1 的挂载点结论：独立页，不是抽屉/对话框）。

   导航语义（§1.3）：详情页**不猜历史**，返回只调 `onBack` —— 回哪个视图由 App 的
   `returnView` 决定（从看板进 ⇒ 回看板；从 agent 任务表进 ⇒ 回 agent 详情）。

   两个**失败域**分开（§3.4）：
   · 协作读整体失败 ⇒ 本页全页失败分支（没有工作项本体可说，故不硬撑概览）；
   · 刷新失败 ⇒ 旧数据照常可读 + 协作区一条区域告警（不把已读到的正文清空）。
   名册（快照）是**第三个**、辅助的失败域：读不到 ⇒ 名册为 null ⇒ mention 菜单明确说
   「名册不可用」，而不是静默不出菜单（也很可能只是这一条读不到）。

   **本轮不写任何行**：composer 是明确不可用态（写面未接通），概览动作区只给工作项页已有的
   入口语义（编辑 / 改派仍在看板，不在此页重复造一份写路径）。 */

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

      <section
        data-testid="work-item-collaboration"
        className={cn("flex flex-col gap-3 rounded-xl border border-card-border bg-card px-4 py-4")}
      >
        <h2 className="text-ui-base font-medium text-foreground">
          {t("squad.workItemDetail.activity.title")}
        </h2>
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
        <WorkItemCollaborationTimeline
          read={read}
          reactionsByComment={reactionsByComment}
          roster={{ agents: roster?.teamAgents ?? [], squads: roster?.squads ?? [] }}
          onReply={setReplyTarget}
        />
        <WorkItemCommentComposer
          roster={roster === null ? null : { agents: roster.teamAgents, squads: roster.squads }}
          replyTarget={replyTarget}
          onCancelReply={() => setReplyTarget(null)}
          disabledReasonMessageId={composerDisabledReason(workItem, state.refreshFailure)}
        />
      </section>
    </div>
  );
}

/** 提交不可用的原因（设计案 §4.1 + §3.4）：归档 > 刷新失败 > 写面未接通（轮 1 的默认）。 */
function composerDisabledReason(
  workItem: { archivedAt?: number },
  refreshFailure: string | null,
): string {
  if (workItem.archivedAt !== undefined) return "squad.workItemDetail.comment.disabled.archived";
  if (refreshFailure !== null) return "squad.workItemDetail.comment.disabled.readFailed";
  return "squad.workItemDetail.comment.disabled.writeUnavailable";
}

/** 回应按评论分组（一次遍历；分组语义在纯函数 `groupCommentReactions` 里）。 */
function buildReactionsByComment(
  reactions: WorkItemCommentReactionRecord[],
): Map<string, WorkItemCommentReactionRecord[]> {
  const grouped = new Map<string, WorkItemCommentReactionRecord[]>();
  for (const reaction of reactions) {
    const bucket = grouped.get(reaction.commentId);
    if (bucket) bucket.push(reaction);
    else grouped.set(reaction.commentId, [reaction]);
  }
  return grouped;
}
