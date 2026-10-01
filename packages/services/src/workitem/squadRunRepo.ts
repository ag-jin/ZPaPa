import type { DatabaseSync } from "node:sqlite";

/* 小队运行台账：squad_runs 表的读写。刻意不进 packages/services/src/index.ts——
   服务层（SquadRunLifecycle）才是唯一公开入口，导出 Repo 会让调用方绕过生命周期直接改运行状态。 */

/**
 * 运行状态全集（spec §6.2 的生命周期：派单 → 执行 → 审查 → 合并 / 抛弃）。
 * 这五个是**持久行上的列值**，不是内存状态：启动回收要靠它跨重启认活跃集合（硬约束 2）。
 */
export const SQUAD_RUN_STATUSES = ["open", "produced", "rejected", "merged", "discarded"] as const;

/**
 * 「仍然占着工作树 / 分支」的三个状态：已派单、已产出待审、审查被拒待修。
 * 回收器 `reap` 的活跃判据**只能**取这个集合（spec §6.2）——漏掉任何一个，
 * 对应的队员工作树都会在下次启动被**静默回收**，「审查被拒不提前删」当场落空。
 */
export const SQUAD_RUN_ACTIVE_STATUSES = ["open", "produced", "rejected"] as const;

export type SquadRunStatus = (typeof SQUAD_RUN_STATUSES)[number];

export type SquadRunRecord = {
  runId: string;
  workspaceKey: string;
  workspacePath: string;
  workItemId: string;
  parentWorkItemId: string;
  agentId: string;
  isLeaderTask: boolean;
  branch: string | null;
  dirName: string | null;
  status: SquadRunStatus;
  sessionId: string | null;
  createdAt: number;
  updatedAt: number;
};

/** `setStatus` 允许顺带补齐的列。身份列（runId / workItemId / …）不在其中：改身份不是「推进状态」。 */
export type SquadRunStatusPatch = Partial<Pick<SquadRunRecord, "branch" | "dirName" | "sessionId">>;

export interface SquadRunRepo {
  /** 写入一行。createdAt / updatedAt 由调用方给定（记录即真相，不在落盘时改写时刻）。 */
  insert(record: SquadRunRecord): void;
  get(runId: string): SquadRunRecord | null;
  listByWorkItem(workItemId: string): SquadRunRecord[];
  listByParent(parentWorkItemId: string): SquadRunRecord[];
  /** 硬约束 2 的**唯一口径来源**：本 workspace 下未合并（含被打回待修）的 run。 */
  listActive(workspaceKey: string): SquadRunRecord[];
  /**
   * 推进状态，可顺带 patch 工作树 / 会话列。
   *
   * 未找到该 runId 时**抛错**而不是静默 no-op：调用方（生命周期）以为自己在推进某个 run，
   * 行不在说明 runId 算错了或台账被删——静默跳过会让这次 run 永远停在不一致的状态里而无人知晓。
   */
  setStatus(runId: string, status: SquadRunStatus, patch?: SquadRunStatusPatch): void;
}

interface SquadRunRow {
  run_id: string;
  workspace_key: string;
  workspace_path: string;
  work_item_id: string;
  parent_work_item_id: string;
  agent_id: string;
  is_leader_task: number;
  branch: string | null;
  dir_name: string | null;
  status: string;
  session_id: string | null;
  created_at: number;
  updated_at: number;
}

/* 读回枚举列的契约违例断言（与 wakeRuleRepo.rowToWakeRule 同一裁定：宁可响亮失败，
   也不静默按默认值处理）。status 决定「这条 run 的成果该不该保留、工作树该不该回收」——
   手改库或跨版本残留造出的枚举外值若被静默当成某个默认状态，就成了
   「工作项状态已经不对了但没人知道」：回收与合并都会照着错的口径走且不报错。 */
function readStatus(value: string): SquadRunStatus {
  if (!(SQUAD_RUN_STATUSES as readonly string[]).includes(value)) {
    throw new Error(
      `squad_runs.status 读回非法值「${value}」：列被写坏或枚举被改小。静默按默认值处理会让` +
        "「这条 run 到底合没合」变成没人知道的事，故一律抛。",
    );
  }
  return value as SquadRunStatus;
}

/** 写路径的同一道闸：表列只有 SQUAD_RUN_STATUSES 这五个取值，写别的说明调用方传错了。 */
function assertStatus(status: SquadRunStatus): SquadRunStatus {
  if (!(SQUAD_RUN_STATUSES as readonly string[]).includes(status)) {
    throw new Error(
      `squad_runs.status 拒绝写入非法值「${String(status)}」（不在 SQUAD_RUN_STATUSES 内）`,
    );
  }
  return status;
}

function rowToSquadRun(row: SquadRunRow): SquadRunRecord {
  return {
    runId: row.run_id,
    workspaceKey: row.workspace_key,
    workspacePath: row.workspace_path,
    workItemId: row.work_item_id,
    parentWorkItemId: row.parent_work_item_id,
    agentId: row.agent_id,
    isLeaderTask: row.is_leader_task === 1,
    branch: row.branch,
    dirName: row.dir_name,
    status: readStatus(row.status),
    sessionId: row.session_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

// 由 SQUAD_RUN_ACTIVE_STATUSES 拼占位符而不是写 SQL 字面量：活跃集合只有一处定义，
// 将来改集合不会出现「常量改了、SQL 还认旧状态」的静默不一致。
const ACTIVE_STATUS_PLACEHOLDERS = SQUAD_RUN_ACTIVE_STATUSES.map(() => "?").join(", ");

// 排序统一按 created_at、再按 run_id：批次处理顺序必须确定，否则同刻写入的 run
// 会随存储顺序漂移，让「谁先被合并 / 回收」变得不可复现。
const ORDER_BY_CREATED = "ORDER BY created_at ASC, run_id ASC";

export function createSquadRunRepo(db: DatabaseSync): SquadRunRepo {
  return {
    insert(record) {
      assertStatus(record.status);
      db.prepare(
        `INSERT INTO squad_runs (
          run_id, workspace_key, workspace_path, work_item_id, parent_work_item_id, agent_id,
          is_leader_task, branch, dir_name, status, session_id, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        record.runId,
        record.workspaceKey,
        record.workspacePath,
        record.workItemId,
        record.parentWorkItemId,
        record.agentId,
        record.isLeaderTask ? 1 : 0,
        record.branch,
        record.dirName,
        record.status,
        record.sessionId,
        record.createdAt,
        record.updatedAt,
      );
    },

    get(runId) {
      const row = db.prepare("SELECT * FROM squad_runs WHERE run_id = ?").get(runId) as
        | SquadRunRow
        | undefined;
      return row ? rowToSquadRun(row) : null;
    },

    listByWorkItem(workItemId) {
      const rows = db
        .prepare(`SELECT * FROM squad_runs WHERE work_item_id = ? ${ORDER_BY_CREATED}`)
        .all(workItemId) as unknown as SquadRunRow[];
      return rows.map(rowToSquadRun);
    },

    // 整批取（含 merged / discarded）：看门狗与收尾要能看到已结束的 run，不能只取活跃的。
    listByParent(parentWorkItemId) {
      const rows = db
        .prepare(`SELECT * FROM squad_runs WHERE parent_work_item_id = ? ${ORDER_BY_CREATED}`)
        .all(parentWorkItemId) as unknown as SquadRunRow[];
      return rows.map(rowToSquadRun);
    },

    // 一条 SQL 过滤（走 idx_squad_runs_active），不读回后内存筛：活跃判据是启动回收的热路径。
    // branch 为 null 的队长 run 同样落在这个集合里（它不占工作树，但仍是「未合并」的 run）。
    listActive(workspaceKey) {
      const rows = db
        .prepare(
          `SELECT * FROM squad_runs WHERE workspace_key = ? AND status IN (${ACTIVE_STATUS_PLACEHOLDERS}) ${ORDER_BY_CREATED}`,
        )
        .all(workspaceKey, ...SQUAD_RUN_ACTIVE_STATUSES) as unknown as SquadRunRow[];
      return rows.map(rowToSquadRun);
    },

    setStatus(runId, status, patch) {
      // 状态先过写路径闸：非法值绝不落盘（否则读回校验会在下次启动才炸，把失败推迟到无人值守的时刻）。
      assertStatus(status);
      // 只更新 patch 里**出现过**的列（未出现 = 不动；显式给 null = 清空）。
      // 用「出现即更新」而不是 COALESCE：COALESCE 让「清空」与「不动」不可区分，会把一个
      // 明确想清掉 session 的调用静默变成 no-op。
      const sets = ["status = ?", "updated_at = ?"];
      const args: Array<string | number | null> = [status, Date.now()];
      for (const [column, key] of [
        ["branch", "branch"],
        ["dir_name", "dirName"],
        ["session_id", "sessionId"],
      ] as const) {
        if (patch && key in patch) {
          sets.push(`${column} = ?`);
          args.push(patch[key] ?? null);
        }
      }
      args.push(runId);
      const result = db
        .prepare(`UPDATE squad_runs SET ${sets.join(", ")} WHERE run_id = ?`)
        .run(...args);
      if (result.changes !== 1) {
        throw new Error(
          `squad_runs 没有 runId=「${runId}」的行，无法推进状态：调用方传错 runId，或台账行已被删除。` +
            "静默 no-op 会让这次 run 永远停在不一致的状态里而没人知道，故一律抛。",
        );
      }
    },
  };
}
