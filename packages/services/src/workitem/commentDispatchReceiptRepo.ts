import type { DatabaseSync } from "node:sqlite";

/* 协作域 X1.2：评论派发 receipt 的存储面（spec §8.1/§8.3/§8.4；迁移 0012）。
   **唯一写者面**——CommentService（X1.2）是上层唯一公开入口，导出本 repo 会让调用方绕过
   「同键重投不写第二条」的存储不变式直接写表。
   一行 = 一次「某条评论请求某目标 agent 处理」的事实：dispatch_key 是请求身份（§8.1 独立
   构造），outcome 是**那一刻队列状态窗的裁决结论**（pending = 尚无待开 run，实际派发归 X2.1）。
   只增：本文件结构上不存在 UPDATE/DELETE（同「事实只增不改」）；X2.1 的重投推进另立更新口。 */

/** outcome 闭集（表列取值域）。 */
export const COMMENT_DISPATCH_OUTCOMES = [
  "pending",
  "opened",
  "queued",
  "coalesced",
  "deferred",
  "blocked",
  "failed",
] as const;
export type CommentDispatchOutcome = (typeof COMMENT_DISPATCH_OUTCOMES)[number];

/** 触发源闭集（§4.5：五源，命中即止）。 */
export const COMMENT_DISPATCH_SOURCES = [
  "issue_assignee",
  "mention_agent",
  "mention_squad_leader",
  "thread_parent",
  "conversation_continuation",
] as const;
export type CommentDispatchSource = (typeof COMMENT_DISPATCH_SOURCES)[number];

export type CommentDispatchReceiptRecord = {
  dispatchKey: string;
  workspaceKey: string;
  workItemId: string;
  targetAgentId: string;
  commentId: string;
  threadId: string;
  source: CommentDispatchSource;
  outcome: CommentDispatchOutcome;
  detail: Record<string, unknown>;
  attemptCount: number;
  createdAt: number;
  updatedAt: number;
};

export type AddCommentDispatchReceiptInput = {
  dispatchKey: string;
  workspaceKey: string;
  workItemId: string;
  targetAgentId: string;
  commentId: string;
  threadId: string;
  source: CommentDispatchSource;
  outcome: CommentDispatchOutcome;
  detail?: Record<string, unknown>;
  /** 缺省 1（首次写入即第一次尝试）。 */
  attemptCount?: number;
  createdAt: number;
};

export interface CommentDispatchReceiptRepo {
  /**
   * **幂等写入**（§8.1/§8.3）：`INSERT OR IGNORE` + 读回——同 dispatchKey 重投返回**既存行**，
   * 不写第二条、不覆盖既存 outcome（首写即事实；队列状态窗的结论不因重投被改写）。
   * 幂等靠主键冲突，不靠「先查后插」（并发下两次查都可能看不到对方）。
   */
  insertIfAbsent(input: AddCommentDispatchReceiptInput): CommentDispatchReceiptRecord;
  get(dispatchKey: string): CommentDispatchReceiptRecord | null;
  /** 某工作项下的 receipt（时间线口径，created_at ASC → dispatch_key ASC）。 */
  listByWorkItem(workspaceKey: string, workItemId: string): CommentDispatchReceiptRecord[];
}

interface ReceiptRow {
  dispatch_key: string;
  workspace_key: string;
  work_item_id: string;
  target_agent_id: string;
  comment_id: string;
  thread_id: string;
  source: string;
  outcome: string;
  detail_json: string;
  attempt_count: number;
  created_at: number;
  updated_at: number;
}

/* 读回枚举闸（readStatus 纪律）：枚举外值响亮抛——静默按默认处理会让
   「这条请求到底派没派出去 / 是谁触发的」变成没人知道的事。 */
function readOutcome(value: string): CommentDispatchOutcome {
  if (!(COMMENT_DISPATCH_OUTCOMES as readonly string[]).includes(value)) {
    throw new Error(
      `comment_dispatch_receipts.outcome 读回非法值「${value}」：列被写坏或闭集被改小，一律抛。`,
    );
  }
  return value as CommentDispatchOutcome;
}

function readSource(value: string): CommentDispatchSource {
  if (!(COMMENT_DISPATCH_SOURCES as readonly string[]).includes(value)) {
    throw new Error(
      `comment_dispatch_receipts.source 读回非法值「${value}」：触发源是五源闭集，枚举外值一律抛。`,
    );
  }
  return value as CommentDispatchSource;
}

/** 写路径的同一道闸：非法值绝不落盘（否则读回校验会在无人值守的时刻才炸）。 */
function assertOutcome(outcome: CommentDispatchOutcome): CommentDispatchOutcome {
  if (!(COMMENT_DISPATCH_OUTCOMES as readonly string[]).includes(outcome)) {
    throw new Error(
      `comment_dispatch_receipts.outcome 拒绝写入非法值「${String(outcome)}」（不在闭集内）`,
    );
  }
  return outcome;
}

function assertSource(source: CommentDispatchSource): CommentDispatchSource {
  if (!(COMMENT_DISPATCH_SOURCES as readonly string[]).includes(source)) {
    throw new Error(
      `comment_dispatch_receipts.source 拒绝写入非法值「${String(source)}」（不在五源闭集内）`,
    );
  }
  return source;
}

function rowToReceipt(row: ReceiptRow): CommentDispatchReceiptRecord {
  let detail: Record<string, unknown>;
  try {
    detail = JSON.parse(row.detail_json) as Record<string, unknown>;
  } catch {
    throw new Error("comment_dispatch_receipts.detail_json 读回非法 JSON：列被写坏，一律抛。");
  }
  return {
    dispatchKey: row.dispatch_key,
    workspaceKey: row.workspace_key,
    workItemId: row.work_item_id,
    targetAgentId: row.target_agent_id,
    commentId: row.comment_id,
    threadId: row.thread_id,
    source: readSource(row.source),
    outcome: readOutcome(row.outcome),
    detail,
    attemptCount: row.attempt_count,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

const ORDER = "ORDER BY created_at ASC, dispatch_key ASC";

export function createCommentDispatchReceiptRepo(db: DatabaseSync): CommentDispatchReceiptRepo {
  return {
    insertIfAbsent(input) {
      assertOutcome(input.outcome);
      assertSource(input.source);
      db.prepare(
        `INSERT OR IGNORE INTO comment_dispatch_receipts (
          dispatch_key, workspace_key, work_item_id, target_agent_id, comment_id, thread_id,
          source, outcome, detail_json, attempt_count, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        input.dispatchKey,
        input.workspaceKey,
        input.workItemId,
        input.targetAgentId,
        input.commentId,
        input.threadId,
        input.source,
        input.outcome,
        JSON.stringify(input.detail ?? {}),
        input.attemptCount ?? 1,
        input.createdAt,
        input.createdAt,
      );
      const row = db
        .prepare("SELECT * FROM comment_dispatch_receipts WHERE dispatch_key = ?")
        .get(input.dispatchKey) as ReceiptRow | undefined;
      if (!row) {
        throw new Error(
          `comment_dispatch_receipts 写入后读不回（dispatchKey=${input.dispatchKey}）：不可达态，须查库。`,
        );
      }
      return rowToReceipt(row);
    },

    get(dispatchKey) {
      const row = db
        .prepare("SELECT * FROM comment_dispatch_receipts WHERE dispatch_key = ?")
        .get(dispatchKey) as ReceiptRow | undefined;
      return row ? rowToReceipt(row) : null;
    },

    listByWorkItem(workspaceKey, workItemId) {
      const rows = db
        .prepare(
          `SELECT * FROM comment_dispatch_receipts WHERE workspace_key = ? AND work_item_id = ? ${ORDER}`,
        )
        .all(workspaceKey, workItemId) as unknown as ReceiptRow[];
      return rows.map(rowToReceipt);
    },
  };
}
