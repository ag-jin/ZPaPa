import type { DatabaseSync } from "node:sqlite";
import type { AuthorRef } from "./workItemCommentRepo.js";

/* 协作域 X0.1：表情回应的存储面（spec §3.2 裁定#5——对齐 multica 026）。
   轻实体：(commentId, author, emoji) 唯一 + INSERT OR IGNORE 幂等；永不触发派发（§4.4）。 */

export type WorkItemCommentReactionRecord = {
  id: string;
  workspaceKey: string;
  commentId: string;
  author: AuthorRef;
  emoji: string;
  createdAt: number;
};

export interface WorkItemCommentReactionRepo {
  /** 幂等添加（唯一索引兜底）：同键重投不产生第二行，返回既存/新行。 */
  add(input: {
    id: string;
    workspaceKey: string;
    commentId: string;
    author: AuthorRef;
    emoji: string;
    createdAt: number;
  }): WorkItemCommentReactionRecord;
  listByComment(commentId: string): WorkItemCommentReactionRecord[];
}

interface ReactionRow {
  id: string;
  workspace_key: string;
  comment_id: string;
  author_kind: string;
  author_id: string;
  author_display_name: string | null;
  emoji: string;
  created_at: number;
}

function rowToReaction(row: ReactionRow): WorkItemCommentReactionRecord {
  if (!["human", "agent", "system"].includes(row.author_kind)) {
    throw new Error(
      `work_item_comment_reactions.author_kind 读回非法值「${row.author_kind}」：一律抛。`,
    );
  }
  return {
    id: row.id,
    workspaceKey: row.workspace_key,
    commentId: row.comment_id,
    author: {
      kind: row.author_kind as AuthorRef["kind"],
      id: row.author_id,
      ...(row.author_display_name !== null ? { displayName: row.author_display_name } : {}),
    },
    emoji: row.emoji,
    createdAt: row.created_at,
  };
}

export function createWorkItemCommentReactionRepo(db: DatabaseSync): WorkItemCommentReactionRepo {
  return {
    add(input) {
      // 注意：0010 表没有 author_display_name 列（回应轻实体不存展示名快照——
      // 曾误写过该列导致调用即抛 SQL logic error，X1.2 评审发现，本轮修复）。
      db.prepare(
        `INSERT OR IGNORE INTO work_item_comment_reactions (
          id, workspace_key, comment_id, author_kind, author_id, emoji, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        input.id,
        input.workspaceKey,
        input.commentId,
        input.author.kind,
        input.author.id,
        input.emoji,
        input.createdAt,
      );
      const row = db
        .prepare(
          `SELECT * FROM work_item_comment_reactions
            WHERE workspace_key = ? AND comment_id = ? AND author_kind = ? AND author_id = ? AND emoji = ?`,
        )
        .get(
          input.workspaceKey,
          input.commentId,
          input.author.kind,
          input.author.id,
          input.emoji,
        ) as unknown as ReactionRow;
      return rowToReaction(row);
    },

    listByComment(commentId) {
      const rows = db
        .prepare(
          "SELECT * FROM work_item_comment_reactions WHERE comment_id = ? ORDER BY created_at ASC, id ASC",
        )
        .all(commentId) as unknown as ReactionRow[];
      return rows.map(rowToReaction);
    },
  };
}
