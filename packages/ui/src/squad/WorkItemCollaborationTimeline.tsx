import { useMemo, useRef } from "react";
import type {
  AuthorRef,
  CommentDispatchReceiptRecord,
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
  FileDiff,
  GitMerge,
  MessageSquarePlus,
  Play,
  Scale,
  Send,
  SmilePlus,
  SquareStack,
  Trash2,
  Undo2,
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
import {
  DECISION_PARENT_PREFIX_MESSAGE_IDS,
  decisionKindMessageId,
  decisionParentReference,
} from "./workItemDecisionViewModel.js";

/* B5.1 轮 1 / B5.2 轮 2：**唯一混排**的活动时间线（设计案 §2.2）。

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
  /* 第 19 枚（2026-10-08 用户裁定）：打回待修 = 「退回」的语义，故用 Undo2（与 run_cancelled 的
     Ban 分形；同一闭集里 Ban/Trash2 已有重复使用，此处仍取可区分的形状）。 */
  run_rejected: Undo2,
  worktree_created: SquareStack,
  worktree_merged: GitMerge,
  worktree_discarded: Trash2,
  wake_rule_fired: AlarmClock,
  /* 第 20 枚（#7 交付物 D1a）：交付物的主体形态是 diff（分支合并后即删，diff 是唯一留痕），
     故用 FileDiff 这个「带改动的文件」形状。 */
  deliverable_registered: FileDiff,
};

export function WorkItemCollaborationTimeline({
  read,
  reactionsByComment,
  receiptsByComment,
  roster,
  viewerActor,
  pendingCommentId,
  onReply,
  onDelete,
  onResolve,
  onReact,
}: {
  /** 协作读模型（页面的唯一数据源）：投影只在这里做一次，组件不重新推导领域语义。 */
  read: WorkItemCollaborationRead;
  reactionsByComment: ReadonlyMap<string, WorkItemCommentReactionRecord[]>;
  /** 派发 receipt 按评论分组（只读插槽的输入；本条没有 ⇒ 空数组 ⇒ 插槽不渲染）。 */
  receiptsByComment: ReadonlyMap<string, CommentDispatchReceiptRecord[]>;
  roster: MentionRoster;
  /** 本地人类身份（D1-A，读面带回）：`mine` 的判据。 */
  viewerActor: AuthorRef | null;
  /** 有一次写在这条评论上在途（按钮禁用，避免重复提交）。 */
  pendingCommentId: string | null;
  onReply: (comment: WorkItemCommentRecord) => void;
  onDelete: (comment: WorkItemCommentRecord) => void;
  onResolve: (comment: WorkItemCommentRecord, resolved: boolean) => void;
  onReact: (comment: WorkItemCommentRecord, emoji: string) => void;
}) {
  const { intl } = useZCodeIntl();
  const t = (id: string, values?: Record<string, string | number>) =>
    intl.formatMessage({ id }, values);
  const listRef = useRef<HTMLOListElement | null>(null);
  const commentsById = useMemo(
    () => new Map(read.comments.map((comment) => [comment.id, comment])),
    [read.comments],
  );
  /** 决定的父链解析面（父在本工作项内；不可解析时只显示 id —— 见 decisionParentReference）。 */
  const decisionsById = useMemo(
    () => new Map(read.decisions.map((decision) => [decision.id, decision])),
    [read.decisions],
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
                  receipts={receiptsByComment.get(entry.comment.id) ?? []}
                  activities={read.activities}
                  indent={commentIndentLevel(entry.comment, commentsById)}
                  parent={commentReplyParent(entry.comment, commentsById)}
                  roster={roster}
                  viewerActor={viewerActor}
                  pending={pendingCommentId === entry.comment.id}
                  onReply={onReply}
                  onDelete={onDelete}
                  onResolve={onResolve}
                  onReact={onReact}
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
                <DecisionEntry decision={entry.decision} decisionsById={decisionsById} />
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

/**
 * 结构化裁决事实行（设计案 §2.4）：弱表面 + 图标，不用成功/失败大色块；本轮只读。
 *
 * C3.2 起它要回答 §3.4 的那两个问题：**谁作的裁决**（作者 byline，复用 comment.author.* 词）、
 * **后来由什么取代**（父引用行：可解析 ⇒「取代了/重新审议：{父 kind} · {父 subject}」；
 * 不可解析 ⇒ **只显示 id**，不编名字 —— 编出来的名字是时间线上一句确定的假话）。
 * kind 标签只经 `decisionKindMessageId`（闭集穷尽映射）：B5.1 的 if/else 链最后一个 else
 * 会把未知 kind 说成「已重新审议」，而这里宁可不显示也不可能说错。
 */
function DecisionEntry({
  decision,
  decisionsById,
}: {
  decision: WorkItemDecisionRecord;
  decisionsById: ReadonlyMap<string, WorkItemDecisionRecord>;
}) {
  const { intl } = useZCodeIntl();
  const t = (id: string, values?: Record<string, string | number>) =>
    intl.formatMessage({ id }, values);
  const parent = decisionParentReference(decision, decisionsById);
  return (
    <div className="flex flex-col gap-1 rounded-lg border border-border bg-accent px-3 py-2">
      <span className="flex flex-wrap items-center gap-2 text-ui-xs text-foreground-subtle">
        <Scale aria-hidden className="size-4" />
        {t("squad.workItemDetail.decision.label")}
        <span>{t(decisionKindMessageId(decision.kind))}</span>
        <span>{decision.author.displayName ?? decision.author.id}</span>
        <span>
          {decision.author.kind === "human"
            ? t("squad.workItemDetail.comment.author.human")
            : t("squad.workItemDetail.comment.author.agent")}
        </span>
        <time
          className="text-ui-xs text-foreground-subtlest"
          dateTime={new Date(decision.effectiveAt).toISOString()}
        >
          {new Date(decision.effectiveAt).toLocaleString()}
        </time>
      </span>
      <p className="text-ui-base font-medium text-foreground">{decision.subject}</p>
      {decision.rationale ? (
        <p className="text-ui-sm text-foreground-subtle">{decision.rationale}</p>
      ) : null}
      {parent === null ? null : (
        <p data-testid="timeline-decision-parent" className="text-ui-xs text-foreground-subtle">
          {parent.kind === "resolved"
            ? t(DECISION_PARENT_PREFIX_MESSAGE_IDS[decision.kind], {
                kind: t(decisionKindMessageId(parent.parent.kind)),
                subject: parent.parent.subject,
              })
            : t("squad.workItemDetail.decision.parentUnresolved", { id: parent.id })}
        </p>
      )}
    </div>
  );
}
