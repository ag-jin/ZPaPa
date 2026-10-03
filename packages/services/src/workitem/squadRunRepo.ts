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
  /**
   * 队长行的**原子登记**（§5.7(1)/S13 的存储层不变式：同一工作项**至多一条活跃队长行**）。
   *
   * 为什么不能「先 `listActive` 读一次、再 `insert`」：两条派发**并发**时，两次读都可能早于对方的
   * 写入 ⇒ 两条活跃队长行 ⇒ 两个会话干同一件事，而且**不报错**（上层的读法判据是给「决定」用的，
   * 它挡不住这个窗口）。这里把前置**写进语句本身**（`INSERT … SELECT … WHERE NOT EXISTS(活跃队长行)`）：
   * 单条语句在 SQLite 下即原子，谁先谁后都只会有一条。
   *
   * 返回 `true` = 本次真的登记了；`false` = 该工作项已有活跃队长行 ⇒ **本次并入**（不写第二行）。
   * 调用方必须把 `false` 当**结论**处理（跳过本次派发），不是当错误、也不是静默忽略。
   * 同 `runId` 重复不靠这里兜：那种情况下主键会抛（复用 runId 是调用方 bug，必须响亮）。
   *
   * 活跃集合由 `SQUAD_RUN_ACTIVE_STATUSES` **单源**拼装（与 `listActive` 同一处常量）：
   * 各写一份状态字面量，改了常量就会出现「读法说没有活跃行、这条 SQL 也说没有」的静默分叉。
   */
  insertLeaderRunIfNotInProgress(record: SquadRunRecord): boolean;
  get(runId: string): SquadRunRecord | null;
  listByWorkItem(workItemId: string): SquadRunRecord[];
  listByParent(parentWorkItemId: string): SquadRunRecord[];
  /** 硬约束 2 的**唯一口径来源**：本 workspace 下未合并（含被打回待修）的 run。 */
  listActive(workspaceKey: string): SquadRunRecord[];
  /**
   * **全部历史**的口径（活动时间线用）：本 workspace 下的**所有** run，含已合并 / 已抛弃的终态行。
   *
   * 与 `listActive` 的分工**不得互相替代**：`listActive` 回答「还欠收尾的是哪些」（启动回收、
   * 快照、处置入口都按它走 —— 终态 run 的活已结算，混进来会让那些判据把历史当成在途）；
   * 本方法回答「历史上跑过什么」（时间线要把 merged / discarded 也画出来 —— 一笔写进终态的 run
   * 同样是一次发生过的活动，只画活跃 run 会得到一张永远在自我修剪的假图）。
   * 用错口径不会报错：回收拿它当活跃集会把终态 run 的工作树当残枝再清一次；
   * 时间线拿 `listActive` 当历史会让已收尾的活动凭空消失 —— 两种都是静默错，故两边各自显式。
   *
   * 排序与 `listActive` / `listByParent` 同一条（`ORDER_BY_CREATED`：created_at ASC, run_id ASC）：
   * 时间线从左到右、同刻按 id 定序，同一份台账读两次的行序逐字一致。
   */
  listByWorkspace(workspaceKey: string): SquadRunRecord[];
  /**
   * 推进状态，可顺带 patch 工作树 / 会话列。
   *
   * 未找到该 runId 时**抛错**而不是静默 no-op：调用方（生命周期）以为自己在推进某个 run，
   * 行不在说明 runId 算错了或台账被删——静默跳过会让这次 run 永远停在不一致的状态里而无人知晓。
   */
  setStatus(runId: string, status: SquadRunStatus, patch?: SquadRunStatusPatch): void;
  /**
   * 把会话绑定到 run（Important-4，2026-10-02 裁定）：**只写 `session_id` 一列**，不碰 `status`。
   *
   * 为什么不复用 `setStatus(runId, 当前status, { sessionId })`：那要调用方先读一次 status 再写回，
   * 而读→写之间 `completeMemberRun` 可能已把它推到 `produced` ⇒ 回写会把 `produced` **改回** `open`
   * （状态回退，且不报错）。单列更新从结构上消除这个竞态：session 与 state 是两件正交的事。
   * 未命中该 runId 时**抛**（与 `setStatus` 同一口径：调用方以为绑上了，而行不在）。
   */
  bindSession(runId: string, sessionId: string): void;
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

    // 见接口注释：前置写进语句本身（单条语句原子），并发下同一工作项只可能有一条活跃队长行。
    // 参数顺序：先 SELECT 的 13 个值，再 NOT EXISTS 子句的 workspace_key / work_item_id，最后活跃状态集。
    insertLeaderRunIfNotInProgress(record) {
      assertStatus(record.status);
      const changes = db
        .prepare(
          `INSERT INTO squad_runs (
            run_id, workspace_key, workspace_path, work_item_id, parent_work_item_id, agent_id,
            is_leader_task, branch, dir_name, status, session_id, created_at, updated_at
          )
          SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
           WHERE NOT EXISTS (
             SELECT 1 FROM squad_runs
              WHERE workspace_key = ? AND work_item_id = ? AND is_leader_task = 1
                AND status IN (${ACTIVE_STATUS_PLACEHOLDERS})
           )`,
        )
        .run(
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
          record.workspaceKey,
          record.workItemId,
          ...SQUAD_RUN_ACTIVE_STATUSES,
        ).changes;
      return changes === 1;
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

    // 全状态（见接口注释：这是「全部历史」的口径，与 listActive 的「还欠收尾」不得互替）。
    // 与上面刻意**不共用一个 SQL 前缀**：两处各自写全 WHERE，读代码时不必先跳去常量处
    // 才能确认这条查询到底带不带状态过滤 —— 而这两条口径之差只在一个 `status IN` 上，
    // 恰是最容易被顺手复制错的地方。
    listByWorkspace(workspaceKey) {
      const rows = db
        .prepare(`SELECT * FROM squad_runs WHERE workspace_key = ? ${ORDER_BY_CREATED}`)
        .all(workspaceKey) as unknown as SquadRunRow[];
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

    bindSession(runId, sessionId) {
      // 单列更新 + changes 校验：不动 status（见接口注释里的竞态理由），未命中即抛。
      const result = db
        .prepare("UPDATE squad_runs SET session_id = ?, updated_at = ? WHERE run_id = ?")
        .run(sessionId, Date.now(), runId);
      if (result.changes !== 1) {
        throw new Error(
          `squad_runs 没有 runId=「${runId}」的行，无法绑定会话：调用方传错 runId，或台账行已被删除。` +
            "静默 no-op 会让「这个 run 用哪个会话」变成没人知道的事，故一律抛。",
        );
      }
    },
  };
}
