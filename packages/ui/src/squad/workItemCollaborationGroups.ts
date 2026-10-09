import type { CommentDispatchReceiptRecord, WorkItemCommentReactionRecord } from "@zcode/services";

/* #7 D1b：详情页两处分组的**纯函数**（从 `WorkItemDetailPage` 搬出：该页贴着 400 行上限，
   而这两件事与页面状态毫无关系）。分组语义只有这一处：`groupCommentReactions`（受测纯函数）
   按 `commentId` 分组，receipt 用同一手法 —— 顺序**原样保留**（repo 已按 createdAt ASC →
   dispatchKey ASC 给），因此这里绝不能再 sort。 */

/** 回应按评论分组（一次遍历；分组语义在 `groupCommentReactions` 里）。 */
export function buildReactionsByComment(
  reactions: WorkItemCommentReactionRecord[],
): Map<string, WorkItemCommentReactionRecord[]> {
  return groupBy(reactions, (reaction) => reaction.commentId);
}

/** receipt 按评论分组（同上；顺序原样保留 —— repo 已按 createdAt ASC → dispatchKey ASC 给）。 */
export function buildReceiptsByComment(
  receipts: CommentDispatchReceiptRecord[],
): Map<string, CommentDispatchReceiptRecord[]> {
  return groupBy(receipts, (receipt) => receipt.commentId);
}

function groupBy<T>(items: T[], keyOf: (item: T) => string): Map<string, T[]> {
  const grouped = new Map<string, T[]>();
  for (const item of items) {
    const key = keyOf(item);
    const bucket = grouped.get(key);
    if (bucket) bucket.push(item);
    else grouped.set(key, [item]);
  }
  return grouped;
}
