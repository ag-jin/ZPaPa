import type { DatabaseSync } from "node:sqlite";
import { DISPATCH_CAUSES, type DispatchCause } from "./squadDispatchRequests.js";

/* C2（⑤刀 Concurrency 半边）：deferred 重放义务表 `squad_run_deferred_dispatches` 的读写。
   义务 ≠ 排队（squad_runs 的 queued 行）：排队等的是**容量**；义务等的是**目标对离开活跃集**
   （S6 §12.1-2「运行中不排队不注入，登记完成后重放」——produced/rejected 仍占树，按 run 收尾
   触发重放会撞活分支）。两类资格判据不同故分表：混进队列表会被后续推进统一当 queued 处理，
   静默开出撞分支的树。
   唯一公开入口纪律：与 squadRunRepo 同款——不进 services 导出面，服务层组合根才可消费；
   写入/推进/履约的**调用方**（闸与重放）在 C3/C4 落地。 */

/* G4（X1.3 阻塞项）：义务**来源**闭集——评论 deferred 义务与 R2（改派）义务同表。
   没有判别列时 claimDue 一视同仁认领，host 会把评论 dispatchKey 当 eventKey 重放（X2.1 归属前的
   静默撞车）。origin 与 dispatch_cause 是两件事：cause 是「这次派发因何而起」（受 C2 闭集约束，
   评论成因尚未扩展所以为 NULL），origin 是「这条义务由哪条通道登记」（本轮只落数据面，
   分流消费在 X2.1 的 host 侧）。
   W3 追加第三值 `watchdog`：看门狗结算后的**自动重试**义务（设计 §3.5）。它与 R2 义务共用
   「目标对离开活跃集 ⇒ 到期 ⇒ 重放」的机制，但重放的**派发成因与身份**都来自被结算的那条 run，
   故必须能与 R2/评论两支分流（混用会把一次重试记成改派重放）。列是 TEXT（0013），加值零迁移。 */
export const DEFERRED_DISPATCH_ORIGINS = ["reassign", "comment", "watchdog"] as const;
export type DeferredDispatchOrigin = (typeof DEFERRED_DISPATCH_ORIGINS)[number];

export type SquadDeferredDispatchRecord = {
  /** 义务 id（= 触发它的派发请求 runId：一行 = 一条「目标收尾后要重放」的事实）。 */
  runId: string;
  workspaceKey: string;
  workItemId: string;
  agentId: string;
  /** 派发成因（闭集见 DispatchCause；NULL = 遗留/未知，读回不得猜）。 */
  dispatchCause: DispatchCause | null;
  /** 义务来源（闭集，非空）：'reassign' = R2 改派；'comment' = 评论派发请求；'watchdog' = 看门狗自动重试。 */
  origin: DeferredDispatchOrigin;
  createdAt: number;
  updatedAt: number;
};

/** 写入形状：origin 缺省 'reassign'（与列默认值同源）——既有 R2 写入方/历史调用不必改。 */
export type SquadDeferredDispatchInput = Omit<SquadDeferredDispatchRecord, "origin"> & {
  origin?: DeferredDispatchOrigin;
};

export interface SquadDeferredDispatchRepo {
  /**
   * 原子登记义务（前置写进语句，与 insertLeaderRunIfNotInProgress 同法）：
   * 同 `(workspace, workItem, agent)` 已有义务 ⇒ **不写第二行**、返回 `false`（本次并入，
   * 调用方走合并留痕）；返回 `true` = 本次真的登记了。UNIQUE 约束在语句前置之外兜并发。
   */
  insertIfAbsent(record: SquadDeferredDispatchInput): boolean;
  /** 按键取既存义务（并入时拿目标 runId 用）；无 ⇒ null。 */
  find(
    workspaceKey: string,
    workItemId: string,
    agentId: string,
  ): SquadDeferredDispatchRecord | null;
  /** 本 workspace 全部义务（启动扫描/重放遍历用），按 created_at 序。 */
  list(workspaceKey: string): SquadDeferredDispatchRecord[];
  /**
   * 义务达成（重放已开出/目标已终态不再需要）⇒ 删行。未命中**响亮抛**：
   * 静默 no-op 会让义务凭空滞留，下次启动又被「重放」一遍（重复派发且不报错）。
   */
  fulfill(workspaceKey: string, workItemId: string, agentId: string): void;
  /**
   * **到期认领**（C4b 重放，恰一次）：义务到期 = 目标对 (workItem,agent) **已离开活跃集**
   * （无 open/produced/rejected 行——produced/rejected 仍占树，按 run 收尾会撞活分支，C0 2.3 事实 3）。
   * 条件 DELETE（到期子查询写进语句）changes===1 才算认领——并发/重复结算不会重放第二次。
   */
  claimDue(workspaceKey: string): SquadDeferredDispatchRecord[];
}

interface DeferredRow {
  run_id: string;
  workspace_key: string;
  work_item_id: string;
  agent_id: string;
  dispatch_cause: string | null;
  origin: string | null;
  created_at: number;
  updated_at: number;
}

/* 枚举读写闸（与 squadRunRepo 的 readDispatchCause / assertDispatchCause 同款裁定：
   成因决定「这条义务是谁派的」，静默按默认处理会让它变成没人知道的事，故枚举外值一律抛；
   NULL 是合法值（遗留/未知），原样返回。 */
function readDispatchCause(value: string | null): DispatchCause | null {
  if (value === null) return null;
  if (!(DISPATCH_CAUSES as readonly string[]).includes(value)) {
    throw new Error(
      `squad_run_deferred_dispatches.dispatch_cause 读回非法值「${value}」：列被写坏或枚举被改小，一律抛。`,
    );
  }
  return value as DispatchCause;
}

function assertDispatchCause(cause: DispatchCause | null): DispatchCause | null {
  if (cause !== null && !(DISPATCH_CAUSES as readonly string[]).includes(cause)) {
    throw new Error(
      `squad_run_deferred_dispatches.dispatch_cause 拒绝写入非法值「${String(cause)}」`,
    );
  }
  return cause;
}

/* 来源读写闸（与 dispatch_cause 同款纪律；列 NOT NULL DEFAULT 'reassign'，NULL 只可能是列被写坏）：
   来源决定「这条义务该由哪条重放通道消费」，静默按默认处理会把评论义务当 R2 重放。 */
function readOrigin(value: string | null): DeferredDispatchOrigin {
  if (value === null || !(DEFERRED_DISPATCH_ORIGINS as readonly string[]).includes(value)) {
    throw new Error(
      `squad_run_deferred_dispatches.origin 读回非法值「${value}」：列被写坏或闭集被改小，一律抛。`,
    );
  }
  return value as DeferredDispatchOrigin;
}

function assertOrigin(origin: DeferredDispatchOrigin | undefined): DeferredDispatchOrigin {
  const value = origin ?? "reassign";
  if (!(DEFERRED_DISPATCH_ORIGINS as readonly string[]).includes(value)) {
    throw new Error(
      `squad_run_deferred_dispatches.origin 拒绝写入非法值「${String(origin)}」（不在闭集内）`,
    );
  }
  return value;
}

function rowToRecord(row: DeferredRow): SquadDeferredDispatchRecord {
  return {
    runId: row.run_id,
    workspaceKey: row.workspace_key,
    workItemId: row.work_item_id,
    agentId: row.agent_id,
    dispatchCause: readDispatchCause(row.dispatch_cause),
    origin: readOrigin(row.origin),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function createSquadDeferredDispatchRepo(db: DatabaseSync): SquadDeferredDispatchRepo {
  return {
    insertIfAbsent(record) {
      assertDispatchCause(record.dispatchCause);
      const origin = assertOrigin(record.origin);
      const changes = db
        .prepare(
          `INSERT INTO squad_run_deferred_dispatches (
            run_id, workspace_key, work_item_id, agent_id, dispatch_cause, origin, created_at, updated_at
          )
          SELECT ?, ?, ?, ?, ?, ?, ?, ?
           WHERE NOT EXISTS (
             SELECT 1 FROM squad_run_deferred_dispatches
              WHERE workspace_key = ? AND work_item_id = ? AND agent_id = ?
           )`,
        )
        .run(
          record.runId,
          record.workspaceKey,
          record.workItemId,
          record.agentId,
          record.dispatchCause,
          origin,
          record.createdAt,
          record.updatedAt,
          record.workspaceKey,
          record.workItemId,
          record.agentId,
        ).changes;
      return changes === 1;
    },

    find(workspaceKey, workItemId, agentId) {
      const row = db
        .prepare(
          "SELECT * FROM squad_run_deferred_dispatches WHERE workspace_key = ? AND work_item_id = ? AND agent_id = ?",
        )
        .get(workspaceKey, workItemId, agentId) as DeferredRow | undefined;
      return row ? rowToRecord(row) : null;
    },

    list(workspaceKey) {
      const rows = db
        .prepare(
          "SELECT * FROM squad_run_deferred_dispatches WHERE workspace_key = ? ORDER BY created_at ASC, run_id ASC",
        )
        .all(workspaceKey) as unknown as DeferredRow[];
      return rows.map(rowToRecord);
    },

    claimDue(workspaceKey) {
      // 先读候选（到期判据在 DELETE 里再验一次：读与删之间的窗口由条件删除兜住）。
      const rows = db
        .prepare(
          `SELECT * FROM squad_run_deferred_dispatches WHERE workspace_key = ?

             ORDER BY created_at ASC, run_id ASC`,
        )
        .all(workspaceKey) as unknown as DeferredRow[];
      const claimed: SquadDeferredDispatchRecord[] = [];
      for (const row of rows) {
        /* F1（X2.1 修复）：**读回校验先于 DELETE**。反序（先删后映射）时，闭集外的 origin /
           dispatch_cause 会让抛错发生在行已被删除之后：该义务既不重放、也不留痕、也不清 receipt
           —— 静默蒸发。写坏只可能来自外部直写 SQL（两个写者都有写闸），但一旦发生，
           正确行为是响亮抛且行保留（重放账目与事实不脱节）。 */
        const record = rowToRecord(row);
        const changes = db
          .prepare(
            `DELETE FROM squad_run_deferred_dispatches
              WHERE run_id = ?
                AND NOT EXISTS (
                  SELECT 1 FROM squad_runs
                   WHERE workspace_key = ? AND work_item_id = ? AND agent_id = ?
                     AND status IN ('open', 'produced', 'rejected')
                )`,
          )
          .run(row.run_id, row.workspace_key, row.work_item_id, row.agent_id).changes;
        if (changes === 1) claimed.push(record);
      }
      return claimed;
    },

    fulfill(workspaceKey, workItemId, agentId) {
      const result = db
        .prepare(
          "DELETE FROM squad_run_deferred_dispatches WHERE workspace_key = ? AND work_item_id = ? AND agent_id = ?",
        )
        .run(workspaceKey, workItemId, agentId);
      if (result.changes !== 1) {
        throw new Error(
          `squad_run_deferred_dispatches 没有 (workspace=${workspaceKey}, workItem=${workItemId}, ` +
            `agent=${agentId}) 的义务行，无法履约：静默 no-op 会让重放义务的账目与事实脱节，故一律抛。`,
        );
      }
    },
  };
}
