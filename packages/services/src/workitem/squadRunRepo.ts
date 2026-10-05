/* oxlint-disable eslint(max-lines) -- squad_runs 的唯一写者面：三段原子 INSERT…SELECT（队长合并 /
   成员并发闸 / 队长闸+吸收）刻意内联——「判定写进语句本身」是防并发竞态的既定裁定
   （见 insertLeaderRunIfNotInProgress 的注释）；拆文件会把同一张表的全部写入形状拆散。 */
import type { DatabaseSync } from "node:sqlite";
import { DISPATCH_CAUSES, type DispatchCause } from "./squadDispatchRequests.js";

/* 小队运行台账：squad_runs 表的读写。刻意不进 packages/services/src/index.ts——
   服务层（SquadRunLifecycle）才是唯一公开入口，导出 Repo 会让调用方绕过生命周期直接改运行状态。 */

/**
 * 运行状态全集（spec §6.2 的生命周期：派单 → 执行 → 审查 → 合并 / 抛弃；C2 起追加 queued）。
 * 这六个是**持久行上的列值**，不是内存状态：启动回收要靠它跨重启认活跃集合（硬约束 2）。
 * `queued`（排队待开，C2/⑤刀 Concurrency 半边）：**无树无分支无会话**——写路径拒绝带
 * branch/dir_name 的 queued 行；它等待的只是容量，**不**在活跃集（SQUAD_RUN_ACTIVE_STATUSES 三值不动，
 * 混进去会静默污染快照/启动和解/队长判据，C0 2.1 整表后果）。
 */
export const SQUAD_RUN_STATUSES = [
  "open",
  "produced",
  "rejected",
  "merged",
  "discarded",
  "queued",
] as const;

/**
 * 「仍然占着工作树 / 分支」的三个状态：已派单、已产出待审、审查被拒待修。
 * 回收器 `reap` 的活跃判据**只能**取这个集合（spec §6.2）——漏掉任何一个，
 * 对应的队员工作树都会在下次启动被**静默回收**，「审查被拒不提前删」当场落空。
 */
export const SQUAD_RUN_ACTIVE_STATUSES = ["open", "produced", "rejected"] as const;

export type SquadRunStatus = (typeof SQUAD_RUN_STATUSES)[number];

/** `insertMemberRunOrQueue` 的判别结论（C0 2.2-I；生命周期/host 的接线在 C3）：
 *  - `opened`：容量未满且无既存排队行 ⇒ 本次直接开 run（行照既有 open 形态落盘）；
 *  - `queued`：容量已满 ⇒ 本 runId 落为排队行（至多一个待开 per (workspace,workItem,agent)）；
 *  - `coalesced`：该目标已有排队行 ⇒ 并入（不另起行），`targetRunId` = 既存排队行，留痕见明细表。 */
export type InsertMemberRunOrQueueResult =
  | { kind: "opened" }
  | { kind: "queued"; runId: string }
  | { kind: "coalesced"; targetRunId: string };

/** `insertLeaderRunOrQueue` 的判别结论（C3/A8）：吸收（既有不变式）优先于排队。 */
export type InsertLeaderRunOrQueueResult =
  | { kind: "recorded" }
  | { kind: "absorbed" }
  | { kind: "queued"; runId: string }
  | { kind: "coalesced"; targetRunId: string };

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
  /**
   * 本次派发的**成因**（`dispatch_cause`，闭集见 `DispatchCause`）。
   * **NULL = 遗留行 / 未知成因**（加列之前的行，或 host 没给）—— **读回不得猜**：
   * 枚举外值读回响亮抛（`readDispatchCause`），落 NULL 只表示「不知道」，不表示任何具体成因。
   */
  dispatchCause: DispatchCause | null;
  /**
   * 派发这条队员 run 的**队长 run**（`caused_by_run_id`）：仅 `leader_tool` 派发的队员行有值
   * （派发时刻该批根工作项上活跃的队长行，`findActiveLeaderRunId` 的唯一读法）；队长行与其余成因
   * 一律 NULL（队长 run 是批次起点，无入边）。自由字符串列（不枚举），故无守卫。
   */
  causedByRunId: string | null;
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
  /**
   * 带并发闸的**原子开跑或排队**（C2 存储面；`openMemberRun` 内部接线在 C3）。
   *
   * 判定**写进语句本身**（与 `insertLeaderRunIfNotInProgress` 同法，「先查后插」在并发下
   * 两次读都可能早于对方写入）：
   *  - 语句一：`count(open)×agent < maxConcurrentRuns` 且无既存排队行 ⇒ 直接插 open 行；
   *  - 语句二（语句一未命中时）：`NOT EXISTS` 前置插 **queued 行**（branch/dir_name 一律 NULL——
   *    排队不占树；部分唯一索引 `idx_squad_runs_one_queued_per_item_agent` 在语句前置之外兜并发）；
   *  - 两条都未命中 ⇒ 并入既存排队行 + `squad_run_coalesced_details` 留痕（幂等）。
   *
   * 容量口径：`count(status='open')`——produced/rejected 仍占树但**不占并发容量**（C0 十点之 10）。
   */
  insertMemberRunOrQueue(
    record: SquadRunRecord,
    maxConcurrentRuns: number,
  ): InsertMemberRunOrQueueResult;
  /** 排队行读取口（C5 快照计数/推进扫描共用）：本 workspace 全部 queued 行，`ORDER_BY_CREATED`。 */
  listQueued(workspaceKey: string): SquadRunRecord[];
  /**
   * 排队丢弃出口（queued → discarded 终态）。只收 queued 行：对 open 行或已终态行调用
   * **响亮抛**——静默 no-op 会让「这条排队派发到底还跑不跑」变成没人知道的事。
   */
  discardQueuedRun(runId: string): void;
  /**
   * 并入留痕（R3 裁定：明细表 `INSERT OR IGNORE` 幂等）：`requestRunId` = 本次被并入的请求，
   * `targetRunId` = 它并入的排队行/义务行。同一请求重投不产生第二行（主键即请求 id）。
   */
  recordCoalescedRequest(requestRunId: string, targetRunId: string): void;
  /**
   * 排队行的**认领升级**（C4 推进）：原子 `queued → open`，容量子查询在语句内（认领即占位，
   * 并发认领不超上限）。返回 false = 容量仍满或行已不在排队态（别的推进路径先到）。
   * 认领成功后由调用方（生命周期推进臂）建树并 patch branch/dir_name。
   */
  claimQueuedRunForPromotion(runId: string, maxConcurrentRuns: number): boolean;
  /**
   * 队长行的**带闸原子登记**（C3/A8：「吸收优先于排队」——已存在活跃队长行 ⇒ 照旧吸收，
   * 不问容量；无活跃队长行且容量满 ⇒ 落队长排队行；已有排队行 ⇒ 并入留痕）。
   * 单条语句同持两个前置（活跃队长行 NOT EXISTS + 容量 count），并发下不失不变式。
   */
  insertLeaderRunOrQueue(
    record: SquadRunRecord,
    maxConcurrentRuns: number,
  ): InsertLeaderRunOrQueueResult;
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
  dispatch_cause: string | null;
  caused_by_run_id: string | null;
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

/** 写路径的同一道闸：表列只有 SQUAD_RUN_STATUSES 这六个取值，写别的说明调用方传错了。 */
function assertStatus(status: SquadRunStatus): SquadRunStatus {
  if (!(SQUAD_RUN_STATUSES as readonly string[]).includes(status)) {
    throw new Error(
      `squad_runs.status 拒绝写入非法值「${String(status)}」（不在 SQUAD_RUN_STATUSES 内）`,
    );
  }
  return status;
}

/* 排队行实体不变式的写路径闸：queued ⇒ 无树无分支。排队占的只是「容量席位」，开树发生在
   推进（queued→open）之后；带 branch/dir_name 的 queued 行是把「已开树」与「未开树」混成一格，
   回收器按 branch 投影时会把它当成活树处理（或静默漏掉），两种都不可接受。 */
function assertQueuedHasNoTree(record: { status: SquadRunStatus; branch: string | null; dirName: string | null }): void {
  if (record.status === "queued" && (record.branch !== null || record.dirName !== null)) {
    throw new Error(
      "squad_runs 拒绝写入带 branch/dir_name 的 queued 行：排队行无树无分支，开树发生在推进为 open 之后" +
        `（branch=${String(record.branch)}，dir_name=${String(record.dirName)}）`,
    );
  }
}

/* `dispatch_cause` 的读回/写路径断言（与 readStatus / assertStatus 同款裁定）。
   为什么成因也要响亮：它决定「这条 run 是谁派的」——时间线画「队长→队员」弧线、回溯规则触发
   都读它。静默按默认处理（当成 NULL）会让成因变成没人知道的事：库里明明写着别的值，
   读出来却是「不知道」，而且不报错。故**枚举外值一律抛**。NULL 是合法值（遗留行/未知成因），
   原样返回 —— 列上的 NULL 与「枚举外值」是两件不同的事，不得混为一谈。 */
function readDispatchCause(value: string | null): DispatchCause | null {
  if (value === null) return null;
  if (!(DISPATCH_CAUSES as readonly string[]).includes(value)) {
    throw new Error(
      `squad_runs.dispatch_cause 读回非法值「${value}」：列被写坏或枚举被改小。静默按默认处理会让` +
        "「这条 run 是谁派的」变成没人知道的事，故一律抛。",
    );
  }
  return value as DispatchCause;
}

/** 写路径的同一道闸：列值只有 `DISPATCH_CAUSES` 这几档（外加 NULL），写别的说明调用方传错了。 */
function assertDispatchCause(cause: DispatchCause | null): DispatchCause | null {
  if (cause !== null && !(DISPATCH_CAUSES as readonly string[]).includes(cause)) {
    throw new Error(
      `squad_runs.dispatch_cause 拒绝写入非法值「${String(cause)}」（不在 DISPATCH_CAUSES 内）`,
    );
  }
  return cause;
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
    dispatchCause: readDispatchCause(row.dispatch_cause),
    causedByRunId: row.caused_by_run_id,
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
      // 成因先过写路径闸：非法值绝不落盘（否则读回校验会在下次启动才炸，把失败推迟到无人值守的时刻）。
      assertDispatchCause(record.dispatchCause);
      assertQueuedHasNoTree(record);
      db.prepare(
        `INSERT INTO squad_runs (
          run_id, workspace_key, workspace_path, work_item_id, parent_work_item_id, agent_id,
          is_leader_task, branch, dir_name, status, session_id, created_at, updated_at,
          dispatch_cause, caused_by_run_id
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
        record.dispatchCause,
        record.causedByRunId,
      );
    },

    // 见接口注释：前置写进语句本身（单条语句原子），并发下同一工作项只可能有一条活跃队长行。
    // 参数顺序：先 SELECT 的 15 个值，再 NOT EXISTS 子句的 workspace_key / work_item_id，最后活跃状态集。
    insertLeaderRunIfNotInProgress(record) {
      assertStatus(record.status);
      assertDispatchCause(record.dispatchCause);
      const changes = db
        .prepare(
          `INSERT INTO squad_runs (
            run_id, workspace_key, workspace_path, work_item_id, parent_work_item_id, agent_id,
            is_leader_task, branch, dir_name, status, session_id, created_at, updated_at,
            dispatch_cause, caused_by_run_id
          )
          SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
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
          record.dispatchCause,
          record.causedByRunId,
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

    // 见接口注释：三段式语句（开跑 → 排队 → 并入），每段的判定都写进语句本身。
    insertMemberRunOrQueue(record, maxConcurrentRuns) {
      assertStatus(record.status);
      assertDispatchCause(record.dispatchCause);
      if (!Number.isInteger(maxConcurrentRuns) || maxConcurrentRuns < 1) {
        throw new Error(
          `insertMemberRunOrQueue 的 maxConcurrentRuns 必须是 ≥1 的整数（收到 ${String(maxConcurrentRuns)}）`,
        );
      }
      // 语句一：容量未满且无既存排队行 ⇒ 直接开跑（行照 record 原样落盘，含调用方给定的 branch/dirName）。
      const opened = db
        .prepare(
          `INSERT INTO squad_runs (
            run_id, workspace_key, workspace_path, work_item_id, parent_work_item_id, agent_id,
            is_leader_task, branch, dir_name, status, session_id, created_at, updated_at,
            dispatch_cause, caused_by_run_id
          )
          SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
           WHERE (SELECT COUNT(*) FROM squad_runs
                   WHERE workspace_key = ? AND agent_id = ? AND status = 'open') < ?
             AND NOT EXISTS (
               SELECT 1 FROM squad_runs
                WHERE workspace_key = ? AND work_item_id = ? AND agent_id = ? AND status = 'queued'
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
          record.dispatchCause,
          record.causedByRunId,
          record.workspaceKey,
          record.agentId,
          maxConcurrentRuns,
          record.workspaceKey,
          record.workItemId,
          record.agentId,
        ).changes;
      if (opened === 1) return { kind: "opened" };

      // 语句二：插排队行——branch/dir_name 一律 NULL（实体不变式，语句层强制，record 带了也不落）。
      const queued = db
        .prepare(
          `INSERT INTO squad_runs (
            run_id, workspace_key, workspace_path, work_item_id, parent_work_item_id, agent_id,
            is_leader_task, branch, dir_name, status, session_id, created_at, updated_at,
            dispatch_cause, caused_by_run_id
          )
          SELECT ?, ?, ?, ?, ?, ?, ?, NULL, NULL, 'queued', ?, ?, ?, ?, ?
           WHERE NOT EXISTS (
             SELECT 1 FROM squad_runs
              WHERE workspace_key = ? AND work_item_id = ? AND agent_id = ? AND status = 'queued'
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
          record.sessionId,
          record.createdAt,
          record.updatedAt,
          record.dispatchCause,
          record.causedByRunId,
          record.workspaceKey,
          record.workItemId,
          record.agentId,
        ).changes;
      if (queued === 1) return { kind: "queued", runId: record.runId };

      // 两条都未命中 ⇒ 并入既存排队行（唯一索引保证它存在）：留痕幂等，返回目标。
      const existing = db
        .prepare(
          `SELECT run_id FROM squad_runs
            WHERE workspace_key = ? AND work_item_id = ? AND agent_id = ? AND status = 'queued'
            ${ORDER_BY_CREATED} LIMIT 1`,
        )
        .get(record.workspaceKey, record.workItemId, record.agentId) as
        | { run_id: string }
        | undefined;
      if (!existing) {
        throw new Error(
          `insertMemberRunOrQueue 并入失败：(workspace=${record.workspaceKey}, workItem=${record.workItemId}, ` +
            `agent=${record.agentId}) 既无排队行也无法插入——并发窗口内行被移走且唯一索引阻止重插，属不可达态，须人工查库。`,
        );
      }
      db.prepare(
        "INSERT OR IGNORE INTO squad_run_coalesced_details (request_run_id, target_run_id, created_at) VALUES (?, ?, ?)",
      ).run(record.runId, existing.run_id, Date.now());
      return { kind: "coalesced", targetRunId: existing.run_id };
    },

    listQueued(workspaceKey) {
      const rows = db
        .prepare(
          `SELECT * FROM squad_runs WHERE workspace_key = ? AND status = 'queued' ${ORDER_BY_CREATED}`,
        )
        .all(workspaceKey) as unknown as SquadRunRow[];
      return rows.map(rowToSquadRun);
    },

    discardQueuedRun(runId) {
      const result = db
        .prepare(
          "UPDATE squad_runs SET status = 'discarded', branch = NULL, dir_name = NULL, updated_at = ? WHERE run_id = ? AND status = 'queued'",
        )
        .run(Date.now(), runId);
      if (result.changes !== 1) {
        throw new Error(
          `squad_runs 没有 runId=「${runId}」的 queued 行，无法丢弃：行不存在、已推进为 open、或已终态。` +
            "静默 no-op 会让「这条排队派发还跑不跑」变成没人知道的事，故一律抛。",
        );
      }
    },

    claimQueuedRunForPromotion(runId, maxConcurrentRuns) {
      if (!Number.isInteger(maxConcurrentRuns) || maxConcurrentRuns < 1) {
        throw new Error(
          `claimQueuedRunForPromotion 的 maxConcurrentRuns 必须是 ≥1 的整数（收到 ${String(maxConcurrentRuns)}）`,
        );
      }
      const row = db
        .prepare("SELECT workspace_key AS workspaceKey, agent_id AS agentId FROM squad_runs WHERE run_id = ? AND status = 'queued'")
        .get(runId) as { workspaceKey: string; agentId: string } | undefined;
      if (row === undefined) return false;
      const changes = db
        .prepare(
          `UPDATE squad_runs SET status = 'open', updated_at = ?
             WHERE run_id = ? AND status = 'queued'
               AND (SELECT COUNT(*) FROM squad_runs
                     WHERE workspace_key = ? AND agent_id = ? AND status = 'open') < ?`,
        )
        .run(Date.now(), runId, row.workspaceKey, row.agentId, maxConcurrentRuns).changes;
      return changes === 1;
    },

    recordCoalescedRequest(requestRunId, targetRunId) {
      db.prepare(
        "INSERT OR IGNORE INTO squad_run_coalesced_details (request_run_id, target_run_id, created_at) VALUES (?, ?, ?)",
      ).run(requestRunId, targetRunId, Date.now());
    },

    // 见接口注释：语句一同持「无活跃队长行 + 容量未满」两前置；未命中再排队/并入。
    insertLeaderRunOrQueue(record, maxConcurrentRuns) {
      assertStatus(record.status);
      assertDispatchCause(record.dispatchCause);
      if (!Number.isInteger(maxConcurrentRuns) || maxConcurrentRuns < 1) {
        throw new Error(
          `insertLeaderRunOrQueue 的 maxConcurrentRuns 必须是 ≥1 的整数（收到 ${String(maxConcurrentRuns)}）`,
        );
      }
      const recorded = db
        .prepare(
          `INSERT INTO squad_runs (
            run_id, workspace_key, workspace_path, work_item_id, parent_work_item_id, agent_id,
            is_leader_task, branch, dir_name, status, session_id, created_at, updated_at,
            dispatch_cause, caused_by_run_id
          )
          SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
           WHERE NOT EXISTS (
             SELECT 1 FROM squad_runs
              WHERE workspace_key = ? AND work_item_id = ? AND is_leader_task = 1
                AND status IN (${ACTIVE_STATUS_PLACEHOLDERS})
           )
             AND (SELECT COUNT(*) FROM squad_runs
                   WHERE workspace_key = ? AND agent_id = ? AND status = 'open') < ?`,
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
          record.dispatchCause,
          record.causedByRunId,
          record.workspaceKey,
          record.workItemId,
          ...SQUAD_RUN_ACTIVE_STATUSES,
          record.workspaceKey,
          record.agentId,
          maxConcurrentRuns,
        ).changes;
      if (recorded === 1) return { kind: "recorded" };

      // 吸收**优先于排队**（A8）：同工作项已有活跃队长行 ⇒ 吸收结论，**不得**排队
      //（把重复指派变成排队正是 S13 明令禁止的「排在 busy 之后的第二次 run」形态）。
      // 必须在排队语句之前判：排队语句的 NOT EXISTS 只看排队行，看不见活跃队长行。
      const activeLeader = db
        .prepare(
          `SELECT 1 FROM squad_runs
            WHERE workspace_key = ? AND work_item_id = ? AND is_leader_task = 1
              AND status IN (${ACTIVE_STATUS_PLACEHOLDERS}) LIMIT 1`,
        )
        .get(record.workspaceKey, record.workItemId, ...SQUAD_RUN_ACTIVE_STATUSES);
      if (activeLeader !== undefined) return { kind: "absorbed" };

      // 容量满且无活跃队长行 ⇒ 尝试排队行（branch/dir_name 一律 NULL）。
      const queued = db
        .prepare(
          `INSERT INTO squad_runs (
            run_id, workspace_key, workspace_path, work_item_id, parent_work_item_id, agent_id,
            is_leader_task, branch, dir_name, status, session_id, created_at, updated_at,
            dispatch_cause, caused_by_run_id
          )
          SELECT ?, ?, ?, ?, ?, ?, ?, NULL, NULL, 'queued', ?, ?, ?, ?, ?
           WHERE NOT EXISTS (
             SELECT 1 FROM squad_runs
              WHERE workspace_key = ? AND work_item_id = ? AND agent_id = ? AND status = 'queued'
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
          record.sessionId,
          record.createdAt,
          record.updatedAt,
          record.dispatchCause,
          record.causedByRunId,
          record.workspaceKey,
          record.workItemId,
          record.agentId,
        ).changes;
      if (queued === 1) return { kind: "queued", runId: record.runId };

      // 排队语句也未命中 ⇒ 并入既存排队行（唯一索引保证存在）：留痕幂等，返回目标。
      const existingQueued = db
        .prepare(
          `SELECT run_id FROM squad_runs
            WHERE workspace_key = ? AND work_item_id = ? AND agent_id = ? AND status = 'queued'
            ${ORDER_BY_CREATED} LIMIT 1`,
        )
        .get(record.workspaceKey, record.workItemId, record.agentId) as
        | { run_id: string }
        | undefined;
      if (!existingQueued) {
        throw new Error(
          `insertLeaderRunOrQueue 未命中任何分支（workspace=${record.workspaceKey}, workItem=${record.workItemId}, ` +
            `agent=${record.agentId}）：既非可登记、非吸收、也无可并入的排队行，属不可达态，须人工查库。`,
        );
      }
      db.prepare(
        "INSERT OR IGNORE INTO squad_run_coalesced_details (request_run_id, target_run_id, created_at) VALUES (?, ?, ?)",
      ).run(record.runId, existingQueued.run_id, Date.now());
      return { kind: "coalesced", targetRunId: existingQueued.run_id };
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
