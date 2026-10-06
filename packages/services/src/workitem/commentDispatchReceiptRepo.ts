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

/**
 * **未收敛**的 outcome（X2.1 的回写口据此认领）：
 * · `pending`：评论已落事实，但 host 派发入口还没执行（桥不可用 / 进程重启 ⇒ 重投）；
 * · `deferred`：已登记完成重放义务，等义务到期由评论重放通道回写。
 * 其余五值（opened/queued/coalesced/blocked/failed）是**终局**：首写结论即事实，不得被迟到的重投覆写。
 */
export const COMMENT_DISPATCH_UNSETTLED_OUTCOMES = ["pending", "deferred"] as const;
export type CommentDispatchUnsettledOutcome = (typeof COMMENT_DISPATCH_UNSETTLED_OUTCOMES)[number];

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
  /**
   * **X2.2：本 workspace 的未收敛 receipt**（补投扫描的取数面；时间线口径同 `listByWorkItem`）。
   *
   * 判据取 `COMMENT_DISPATCH_UNSETTLED_OUTCOMES` 常量（与存储面的条件回写、host 的未收敛判据
   * 同源）——SQL 里写死字面量会让「闭集加值」时扫描面静默漏读。只读不写：
   * 「哪些请求还没有执行者 / 还在等义务重放」是 host 补投的**唯一**取数口。
   */
  listUnsettledByWorkspace(workspaceKey: string): CommentDispatchReceiptRecord[];
  /**
   * **回写口**（X2.1 新增；文件头的「只增」纪律在此**有意开了唯一的推进口**）：
   * host 评论派发通道执行完一次派发后，把当时的队列状态窗结论写回 receipt。
   *
   * 为什么是**条件更新**（`WHERE outcome IN ('pending','deferred')`）：回写不是普通覆盖，
   * 而是「认领这次执行」——两条并发路径（在线派发入口 / 义务重放通道）可能同时读到同一条未收敛行，
   * 条件更新让**恰一个赢家**（`changes === 1`）把结论落定，输家拿到 `false` 后只留痕、不改写。
   * 同时保证首写即事实的另一半：已终局的行（opened/queued/coalesced/blocked/failed）绝不因
   * 迟到的重投被改写成别的结论（`insertIfAbsent` 的幂等语义在推进面上同样成立）。
   *
   * 只改 `outcome / detail / attempt_count / updated_at` 四列：`dispatch_key / workspace_key /
   * work_item_id / target_agent_id / comment_id / thread_id / source / created_at` 是**请求身份**
   * 与首写时间戳，任何推进都不得改写。未命中（dispatchKey 不存在，或已是终局）⇒ `false`，不造行。
   */
  settleIfUnsettled(input: {
    dispatchKey: string;
    outcome: CommentDispatchOutcome;
    detail?: Record<string, unknown>;
    /** 回写时刻（显式传入：存储面不自己读时钟，测试与回放口径同源）。 */
    updatedAt: number;
  }): boolean;
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

    listUnsettledByWorkspace(workspaceKey) {
      // IN 子句由闭集常量生成（见接口注释：写死字面量会在闭集加值时静默漏读）。
      const placeholders = COMMENT_DISPATCH_UNSETTLED_OUTCOMES.map(() => "?").join(", ");
      const rows = db
        .prepare(
          `SELECT * FROM comment_dispatch_receipts WHERE workspace_key = ? AND outcome IN (${placeholders}) ${ORDER}`,
        )
        .all(workspaceKey, ...COMMENT_DISPATCH_UNSETTLED_OUTCOMES) as unknown as ReceiptRow[];
      return rows.map(rowToReceipt);
    },

    settleIfUnsettled(input) {
      // 写路径闸与 insertIfAbsent 同款：闭集外 outcome 绝不落盘（别把失败推迟到读回）。
      assertOutcome(input.outcome);
      const changes = db
        .prepare(
          `UPDATE comment_dispatch_receipts
              SET outcome = ?, detail_json = ?, attempt_count = attempt_count + 1, updated_at = ?
            WHERE dispatch_key = ?
              AND outcome IN ('pending', 'deferred')`,
        )
        .run(
          input.outcome,
          JSON.stringify(input.detail ?? {}),
          input.updatedAt,
          input.dispatchKey,
        ).changes;
      return changes === 1;
    },
  };
}
