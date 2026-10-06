import { useMemo, useRef } from "react";
import type {
  WorkItemActivityKind,
  WorkItemCollaborationRead,
  WorkItemCommentReactionRecord,
  WorkItemCommentRecord,
  WorkItemDecisionRecord,
} from "@zcode/services";
import {
  AlarmClock,
  AtSign,
  Ban,
  CircleCheck,
  CircleCheckBig,
  CircleDot,
  CircleX,
  GitMerge,
  MessageSquarePlus,
  Play,
  Scale,
  Send,
  SmilePlus,
  SquareStack,
  Trash2,
  UserRoundCheck,
  type LucideIcon,
} from "lucide-react";
import { Button } from "@/components/ui/button.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { WorkItemCommentEntry } from "./WorkItemCommentEntry.js";
import {
  buildWorkItemTimelineEntries,
  commentIndentLevel,
  commentReplyParent,
  WORK_ITEM_ACTIVITY_KIND_MESSAGE_IDS,
  type MentionRoster,
} from "./workItemCollaborationViewModel.js";

/* B5.1 轮 1：**唯一混排**的活动时间线（设计案 §2.2）。

   不设「评论 / 活动 / 决定」分区：分区会切断「提出评论 → 请求派发 → Run 开始 → 决定 → 状态改变」
   的审计因果链。主序 = `WorkItemActivity.sequence`（由 `buildWorkItemTimelineEntries` 投影，
   本组件**不重新推导**任何领域语义、不排序）。

   三类主条目 + 缺锚局部错误行：评论条目委托 `WorkItemCommentEntry`；决定与系统事实是本文件里的
   结构化行。系统事实用**图标 + 文字**区分（绝不只靠颜色）。 */

const ICONS: Record<WorkItemActivityKind, LucideIcon> = {
  comment_created: MessageSquarePlus,
  comment_mention_parsed: AtSign,
  comment_dispatch_requested: Send,
  comment_dispatch_suppressed: Ban,
  comment_deleted: Trash2,
  comment_resolved: CircleCheckBig,
  comment_reaction_added: SmilePlus,
  decision_created: Scale,
  status_changed: CircleDot,
  assignee_changed: UserRoundCheck,
  run_started: Play,
  run_completed: CircleCheck,
  run_failed: CircleX,
  run_cancelled: Ban,
  worktree_created: SquareStack,
  worktree_merged: GitMerge,
  worktree_discarded: Trash2,
  wake_rule_fired: AlarmClock,
};

export function WorkItemCollaborationTimeline({
  read,
  reactionsByComment,
  roster,
  onReply,
}: {
  /** 协作读模型（页面的唯一数据源）：投影只在这里做一次，组件不重新推导领域语义。 */
  read: WorkItemCollaborationRead;
  reactionsByComment: ReadonlyMap<string, WorkItemCommentReactionRecord[]>;
  roster: MentionRoster;
  onReply: (comment: WorkItemCommentRecord) => void;
}) {
  const { intl } = useZCodeIntl();
  const t = (id: string, values?: Record<string, string | number>) =>
    intl.formatMessage({ id }, values);
  const listRef = useRef<HTMLOListElement | null>(null);
  const commentsById = useMemo(
    () => new Map(read.comments.map((comment) => [comment.id, comment])),
    [read.comments],
  );
  const entries = useMemo(
    () =>
      buildWorkItemTimelineEntries({
        comments: read.comments,
        activities: read.activities,
        decisions: read.decisions,
      }),
    [read.comments, read.activities, read.decisions],
  );

  /* 「跳到最新」（设计案 §2.2 末段）：时间线升序、最新在底部，composer 紧随其后。
     首次定位到尾部不做（那会抢走用户进入页面时的滚动支配权），只给一个可见按钮。 */
  const jumpToLatest = () => {
    listRef.current?.lastElementChild?.scrollIntoView({ block: "nearest" });
  };

  if (entries.length === 0) {
    return (
      <p data-testid="work-item-activity-empty" className="text-ui-sm text-foreground-subtlest">
        {t("squad.workItemDetail.activity.empty")}
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-2">
      <ol ref={listRef} data-testid="work-item-activity-timeline" className="flex flex-col">
        {entries.map((entry) => {
          if (entry.kind === "comment") {
            return (
              <li key={entry.key} data-testid="timeline-entry-comment">
                <WorkItemCommentEntry
                  comment={entry.comment}
                  reactions={reactionsByComment.get(entry.comment.id) ?? []}
                  indent={commentIndentLevel(entry.comment, commentsById)}
                  parent={commentReplyParent(entry.comment, commentsById)}
                  roster={roster}
                  onReply={onReply}
                />
              </li>
            );
          }
          if (entry.kind === "decision") {
            return (
              <li
                key={entry.key}
                data-testid="timeline-entry-decision"
                className="border-t border-border py-3 first:border-t-0"
              >
                <DecisionEntry decision={entry.decision} />
              </li>
            );
          }
          if (entry.kind === "link-error") {
            return (
              <li
                key={entry.key}
                data-testid="timeline-entry-link-error"
                className="flex items-center gap-2 border-t border-border py-3 text-ui-sm text-foreground-subtle first:border-t-0"
              >
                <Ban aria-hidden className="size-4 shrink-0" />
                {t("squad.workItemDetail.activity.linkUnavailable")}
              </li>
            );
          }
          const Icon = ICONS[entry.activity.kind];
          return (
            <li
              key={entry.key}
              data-testid="timeline-entry-system"
              className="flex flex-wrap items-center gap-2 border-t border-border py-3 text-ui-sm text-foreground-subtle first:border-t-0"
            >
              <Icon aria-hidden className="size-4 shrink-0" />
              <span className="text-foreground">
                {entry.activity.actor.displayName ?? entry.activity.actor.id}
              </span>
              <span>{t(WORK_ITEM_ACTIVITY_KIND_MESSAGE_IDS[entry.activity.kind])}</span>
              <time
                className="text-ui-xs text-foreground-subtlest"
                dateTime={new Date(entry.activity.occurredAt).toISOString()}
              >
                {new Date(entry.activity.occurredAt).toLocaleString()}
              </time>
            </li>
          );
        })}
      </ol>
      <div>
        <Button
          size="xs"
          variant="ghost"
          data-testid="work-item-activity-jump-latest"
          onClick={jumpToLatest}
        >
          {t("squad.workItemDetail.activity.jumpToLatest")}
        </Button>
      </div>
    </div>
  );
}

/** 结构化裁决事实行（设计案 §2.4）：弱表面 + 图标，不用成功/失败大色块；本轮只读。 */
function DecisionEntry({ decision }: { decision: WorkItemDecisionRecord }) {
  const { intl } = useZCodeIntl();
  const t = (id: string) => intl.formatMessage({ id });
  const kindMessageId =
    decision.kind === "proposal"
      ? "squad.workItemDetail.decision.proposal"
      : decision.kind === "accepted"
        ? "squad.workItemDetail.decision.accepted"
        : decision.kind === "rejected"
          ? "squad.workItemDetail.decision.rejected"
          : decision.kind === "superseded"
            ? "squad.workItemDetail.decision.superseded"
            : "squad.workItemDetail.decision.reopened";
  return (
    <div className="flex flex-col gap-1 rounded-lg border border-border bg-accent px-3 py-2">
      <span className="flex items-center gap-2 text-ui-xs text-foreground-subtle">
        <Scale aria-hidden className="size-4" />
        {t("squad.workItemDetail.decision.label")}
        <span>{t(kindMessageId)}</span>
      </span>
      <p className="text-ui-base font-medium text-foreground">{decision.subject}</p>
      {decision.rationale ? (
        <p className="text-ui-sm text-foreground-subtle">{decision.rationale}</p>
      ) : null}
    </div>
  );
}
