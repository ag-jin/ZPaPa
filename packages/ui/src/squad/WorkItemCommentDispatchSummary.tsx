import type {
  CommentDispatchReceiptRecord,
  WorkItemActivityRecord,
  CommentDispatchOutcome,
} from "@zcode/services";
import {
  Ban,
  Clock3,
  ClockArrowUp,
  Combine,
  CircleX,
  ListOrdered,
  Play,
  type LucideIcon,
} from "lucide-react";
import { cn } from "@/components/lib/utils.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import {
  commentDispatchNote,
  receiptTargetLabel,
  summarizeCommentDispatches,
  type CommentDispatchTone,
  type MentionRoster,
} from "./workItemCollaborationViewModel.js";

/* B5.2 轮 2：评论条目下方的**派发 receipt 只读插槽**（设计案 §5；轮 1 只留了挂点）。

   三条纪律：
   ① **没有 receipt 就什么都不渲染**（连空卡片都不留）——空壳会让「没有派发」看起来像
      「派发信息暂时没加载出来」，是两种完全不同的意思；
   ② **只读**：没有「重试派发」这个按钮（重试派发归 host 的补投通道，UI 一旦能重试就多了一条
      与 receipt 事实并行的执行路径）；
   ③ 抑制注记（`/note`、`@all`、`@人名`）**与 receipt 插槽互斥**，判据在纯函数
      `commentDispatchNote` 里（一条事实只说一遍，且不说错）。

   状态**不得只靠颜色表达**（设计案 §6）：每个 outcome 都有图标 + 本地化文案，色调用语义 token。 */

const OUTCOME_ICONS: Record<CommentDispatchOutcome, LucideIcon> = {
  pending: Clock3,
  opened: Play,
  queued: ListOrdered,
  coalesced: Combine,
  deferred: ClockArrowUp,
  blocked: Ban,
  failed: CircleX,
};

const TONE_CLASSNAME: Record<CommentDispatchTone, string> = {
  neutral: "text-foreground-subtle",
  emphasis: "text-primary",
  warning: "text-warning",
  destructive: "text-destructive",
};

export function WorkItemCommentDispatchSummary({
  commentId,
  receipts,
  activities,
  roster,
}: {
  commentId: string;
  /** 本条评论的 receipt（已按评论分组；口径 createdAt ASC → dispatchKey ASC）。 */
  receipts: CommentDispatchReceiptRecord[];
  /** 本工作项的全部活动（抑制注记要按 commentId 取本条的那几枚）。 */
  activities: WorkItemActivityRecord[];
  roster: MentionRoster;
}) {
  const { intl } = useZCodeIntl();
  const t = (id: string, values?: Record<string, string | number>) =>
    intl.formatMessage({ id }, values);
  const summary = summarizeCommentDispatches(receipts);
  const noteMessageId = commentDispatchNote({ commentId, activities, receipts });

  if (summary.inline.length === 0 && noteMessageId === null) {
    // 没有 receipt、也没有抑制事实 ⇒ 不留空壳（设计案 §5）。
    return null;
  }

  return (
    <div className="flex flex-col gap-1">
      {summary.inline.length === 0 ? null : (
        <ul
          data-testid="work-item-comment-dispatch-summary"
          className="flex flex-wrap items-center gap-2 text-ui-xs"
        >
          {summary.inline.map((item) => {
            const Icon = OUTCOME_ICONS[item.outcome];
            return (
              <li
                key={item.dispatchKey}
                data-testid={`work-item-comment-dispatch-${item.outcome}`}
                /* 详情（次数）放 title：不把「重试过几次」这种诊断信息摊到阅读层。 */
                title={`${receiptTargetLabel(item.targetAgentId, roster)} · ${item.attemptCount}`}
                className={cn("flex items-center gap-1", TONE_CLASSNAME[item.tone])}
              >
                <Icon aria-hidden className="size-3.5 shrink-0" />
                <span className="text-foreground-subtle">
                  {receiptTargetLabel(item.targetAgentId, roster)}
                </span>
                <span>{t(item.messageId)}</span>
              </li>
            );
          })}
          {summary.moreCount === 0 ? null : (
            <li className="text-foreground-subtlest">
              {t("squad.workItemDetail.dispatch.moreTargets", { count: summary.moreCount })}
            </li>
          )}
        </ul>
      )}
      {noteMessageId === null ? null : (
        <p
          data-testid="work-item-comment-suppressed"
          className="text-ui-xs text-foreground-subtlest"
        >
          {t(noteMessageId)}
        </p>
      )}
    </div>
  );
}
