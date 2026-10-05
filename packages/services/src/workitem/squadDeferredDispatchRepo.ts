import type { DatabaseSync } from "node:sqlite";
import { DISPATCH_CAUSES, type DispatchCause } from "./squadDispatchRequests.js";

/* C2（⑤刀 Concurrency 半边）：deferred 重放义务表 `squad_run_deferred_dispatches` 的读写。
   义务 ≠ 排队（squad_runs 的 queued 行）：排队等的是**容量**；义务等的是**目标对离开活跃集**
   （S6 §12.1-2「运行中不排队不注入，登记完成后重放」——produced/rejected 仍占树，按 run 收尾
   触发重放会撞活分支）。两类资格判据不同故分表：混进队列表会被后续推进统一当 queued 处理，
   静默开出撞分支的树。
   唯一公开入口纪律：与 squadRunRepo 同款——不进 services 导出面，服务层组合根才可消费；
   写入/推进/履约的**调用方**（闸与重放）在 C3/C4 落地。 */

export type SquadDeferredDispatchRecord = {
  /** 义务 id（= 触发它的派发请求 runId：一行 = 一条「目标收尾后要重放」的事实）。 */
  runId: string;
  workspaceKey: string;
  workItemId: string;
  agentId: string;
  /** 派发成因（闭集见 DispatchCause；NULL = 遗留/未知，读回不得猜）。 */
  dispatchCause: DispatchCause | null;
  createdAt: number;
  updatedAt: number;
};

export interface SquadDeferredDispatchRepo {
  /**
   * 原子登记义务（前置写进语句，与 insertLeaderRunIfNotInProgress 同法）：
   * 同 `(workspace, workItem, agent)` 已有义务 ⇒ **不写第二行**、返回 `false`（本次并入，
   * 调用方走合并留痕）；返回 `true` = 本次真的登记了。UNIQUE 约束在语句前置之外兜并发。
   */
  insertIfAbsent(record: SquadDeferredDispatchRecord): boolean;
  /** 按键取既存义务（并入时拿目标 runId 用）；无 ⇒ null。 */
  find(workspaceKey: string, workItemId: string, agentId: string): SquadDeferredDispatchRecord | null;
  /** 本 workspace 全部义务（启动扫描/重放遍历用），按 created_at 序。 */
  list(workspaceKey: string): SquadDeferredDispatchRecord[];
  /**
   * 义务达成（重放已开出/目标已终态不再需要）⇒ 删行。未命中**响亮抛**：
   * 静默 no-op 会让义务凭空滞留，下次启动又被「重放」一遍（重复派发且不报错）。
   */
  fulfill(workspaceKey: string, workItemId: string, agentId: string): void;
}

interface DeferredRow {
  run_id: string;
  workspace_key: string;
  work_item_id: string;
  agent_id: string;
  dispatch_cause: string | null;
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

function rowToRecord(row: DeferredRow): SquadDeferredDispatchRecord {
  return {
    runId: row.run_id,
    workspaceKey: row.workspace_key,
    workItemId: row.work_item_id,
    agentId: row.agent_id,
    dispatchCause: readDispatchCause(row.dispatch_cause),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function createSquadDeferredDispatchRepo(db: DatabaseSync): SquadDeferredDispatchRepo {
  return {
    insertIfAbsent(record) {
      assertDispatchCause(record.dispatchCause);
      const changes = db
        .prepare(
          `INSERT INTO squad_run_deferred_dispatches (
            run_id, workspace_key, work_item_id, agent_id, dispatch_cause, created_at, updated_at
          )
          SELECT ?, ?, ?, ?, ?, ?, ?
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
