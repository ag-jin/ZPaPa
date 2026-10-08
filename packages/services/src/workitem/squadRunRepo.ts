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

/* 0014（看门狗 W1）`settle_reason` 的**码值单源**：看门狗族（W3 的熔断窗口计数与重试预算
   按它们派生 SQL）+ 用户取消。写成常量而不是内联字面量：派生 SQL、判定面与取消路径三处若各自
   写串，「熔断窗口算哪几条」就会静默分叉（用户在窗口内取消几次被误算成熔断，或反之）。
   列本身**不是**闭集（失败原因原文也落这一列），故这里只钉「码值」不钉取值域。 */
export const SQUAD_RUN_SETTLE_REASON_WATCHDOG_DEAD_SESSION = "watchdog_dead_session";
export const SQUAD_RUN_SETTLE_REASON_WATCHDOG_TTL = "watchdog_ttl";
/**
 * 空闲档 stop 后**宽限到期仍无终态回调** ⇒ 兜底结算的码值（W2 的落点，W3 并入本族）。
 *
 * 它由 host 的 tick 执行臂写盘（`squadWatchdogTick` 的 `stop_then_wait_idle` 宽限分支），却必须与
 * 另两个码值**同源出**：用户 2026-10-07 裁定「空闲宽限到期结算计入熔断窗口 —— 与 watchdog 族同口径
 * （它就是看门狗结算）」。码值若留在 host、族留在 services，两边各有一份「哪些算看门狗结算」的答案，
 * 而分叉**不报错**：一次宽限摊牌不计入窗口 ⇒ 熔断晚一轮生效、重试预算也少认一次。
 */
export const SQUAD_RUN_SETTLE_REASON_WATCHDOG_IDLE_GRACE = "watchdog_idle_stop_grace_expired";
export const SQUAD_RUN_SETTLE_REASON_USER_CANCEL = "user_cancel";
/** 看门狗族（W3 的熔断窗口计数与重试预算计数只认这一族；用户取消**不计入**）。 */
export const SQUAD_RUN_WATCHDOG_SETTLE_REASONS = [
  SQUAD_RUN_SETTLE_REASON_WATCHDOG_DEAD_SESSION,
  SQUAD_RUN_SETTLE_REASON_WATCHDOG_TTL,
  SQUAD_RUN_SETTLE_REASON_WATCHDOG_IDLE_GRACE,
] as const;

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

/**
 * 用量快照：字段与来源逐字对齐协议 `v4/conversation/usage` 的 8 个数值字段
 * （`totalTokens / inputTokens / outputTokens / reasoningTokens / cacheCreationTokens /
 * cacheReadTokens / modelRequestCount / modelErrorCount`），**减去 `sessionId` 与
 * `inputBaselineBySource`**。
 *
 * 为什么不留 `inputBaselineBySource`：它是第二形状（JSON、按来源分桶），v1 无消费方；
 * 照「`detail_json` 只用于形状随产生点而变」的既有判据，这里形状是**封闭协议 schema**，拆列才对。
 * 为什么不带 `sessionId`：会话是台账自己的列（`session_id`），快照里再带一份就是第二个真相。
 */
export type SquadRunUsageSnapshot = {
  totalTokens: number;
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  modelRequestCount: number;
  modelErrorCount: number;
};

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
  /**
   * **本次进入 open** 的时刻（0014；TTL 的起算点，语义见 `SQUAD_RUN_WATCHDOG_SQL`）：
   * 直开 = insert 时刻、认领升级（queued→open）= 认领时刻（`claimQueuedRunForPromotion` 语句内写）、
   * C1 的「结算 + 同 runId 重开」臂 = 重开时刻；**queued 行恒 NULL**（还没开跑）。
   *
   * **可选（`?`）是给「行字面量」留的加法位**：读回恒有值（`rowToSquadRun` 原样映射列），
   * 写入走 `record.openedAt ?? null`——存量调用方（含不在本卡文件集里的 UI/host 夹具）不因加列
   * 而全体改字面量。**不得据此猜值**：读回 NULL 只表示「这一行从未进入过 open / 是排队行」，
   * 看门狗对 open 且 NULL 的行**不结算**（不按编造的起算点动手）。
   */
  openedAt?: number | null;
  /**
   * 结算原因（0014，自由文本列）：NULL = 常规结算 / 遗留行。看门狗族与用户取消的**码值**
   * 见 `SQUAD_RUN_SETTLE_REASON_*`（不得内联字面量）；`failMemberRun` 的失败原因原文也落这一列
   * （设计 §5 的「让它终于落盘」——三处消费：TTL 审计 / 熔断计数 / 重试预算）。
   * 可选的理由与 `openedAt` 同：读回恒有值，写入缺省不动该列。
   */
  settleReason?: string | null;
  /**
   * 用量快照的 8 个数值列（0015，#6 按 run 记账）：字段与来源见 `SquadRunUsageSnapshot`。
   * **读回恒有值**（NULL = 未记录）；8 列与 `usageRecordedAt` **同写同读**——它们一起构成一次快照，
   * 单独的某一列为 null 只出现在「未记录」的行上。**写入口唯一** = `recordUsage`（write-once），
   * 不走 `setStatus` 的 patch（用量不是「状态推进」，与 bindSession 同纪律）。
   * 可选（`?`）的理由与 `openedAt` 同：存量调用方的行字面量不因加列而全体改。
   */
  usageTotalTokens?: number | null;
  usageInputTokens?: number | null;
  usageOutputTokens?: number | null;
  usageReasoningTokens?: number | null;
  usageCacheCreationTokens?: number | null;
  usageCacheReadTokens?: number | null;
  usageModelRequestCount?: number | null;
  usageModelErrorCount?: number | null;
  /**
   * 记账时刻（0015 的**存在性开关**）：NULL = **未记录**（没有会话 / 补拉没成功 / 遗留行），
   * 与合法值 `0`（跑过但没消耗）必须可区分——读回**不得把 NULL 猜成 0**（照 `dispatchCause`
   * 的「读回不得猜」纪律）：渲染 0 会把「没记账」伪装成「没花用量」。
   *
   * 一旦非空，这一行的 9 列**不可再改写**（write-once，见 `recordUsage`）：来源是**会话累计值**
   * （重拉只会变大），取「先到者赢」让快照语义明确（结算时刻的值），也消除「两次值不同时谁赢」
   * 的第二份判据。**重开臂**（C1 结算后同 runId 重开、另建会话）只记**最后一次会话**的累计值
   * ——诚实登记，不假装是跨尝试总和。
   */
  usageRecordedAt?: number | null;
  createdAt: number;
  updatedAt: number;
};

/** `setStatus` 允许顺带补齐的列。身份列（runId / workItemId / …）不在其中：改身份不是「推进状态」。 */
export type SquadRunStatusPatch = Partial<
  Pick<SquadRunRecord, "branch" | "dirName" | "sessionId" | "openedAt" | "settleReason">
>;

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
   *
   * `reason`（0014 加法）：可选，写进 `settle_reason`（用户取消走
   * `SQUAD_RUN_SETTLE_REASON_USER_CANCEL`）。缺省**不动该列**——本方法有多个调用方
   * （A1 失效丢弃 / 批次放弃 / 取消），只有知道「为什么丢」的调用方该传码值（不猜）。
   */
  discardQueuedRun(runId: string, reason?: string): void;
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
  /** R2 判据一：该 (workspace,workItem,agent) 已有排队行（并入优先于义务，统一裁决表第 1 行）。 */
  hasQueuedRunForPair(workspaceKey: string, workItemId: string, agentId: string): boolean;
  /** R2 判据二：该 (workspace,workItem,agent) 已有活跃 run（open/produced/rejected——仍占树）。 */
  hasActiveRunForPair(workspaceKey: string, workItemId: string, agentId: string): boolean;
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
   * **呈现用分页历史**（欠账 #13，2026-10-07 裁定）：keyset 翻页，**最新在前**（DESC）。
   *
   * 这是台账的**第三个读口径**，与前两个各自显式、**不得互相替代**：
   * · `listByWorkspace` / `listByParent` 是**全量**台账（宿主判定与批内时间线要全集）；
   * · `listActive` 是「还欠收尾」的活跃集（快照/回收）；
   * · 本方法只为一件事存在：把「一个 agent 最近的运行」**有界**地交给界面，且 `agentId` 过滤
   *   **下推 SQL**。若在服务面/界面拉全量再前端过滤，一旦读口变成有界分页，第一页就可能
   *   一条该 agent 的行都不含 ⇒ 界面显示「暂无运行记录」而库里明明有，且**不报错**（假空）。
   *
   * 为什么 keyset 而不是 offset：台账在运行期**持续插入新行**（每次派发/重试都新增）。offset
   * 会因新行前插而重复/漏行，且同样不报错；keyset 的谓词与既有排序同键（`(created_at, run_id)`），
   * 不需要新语义。同刻多行靠 `run_id` tie-break（复合比较显式展开，不依赖 row-value 语法）。
   *
   * 游标是**不透明**字符串（`v2` 长度前缀：`<版本>:<created_at 位数>:<created_at>:<run_id 位数>:<run_id>`），
   * 编解码只在**本文件内**（单源）。长度前缀而非分隔符切片：生产 `run_id` = host 的 `eventKey`
   * （`assign:…` / `comment-dispatch:v1:…`）**含冒号是常态**，用 `:` 切分会让页边界行的游标被
   * 本实现自己拒收 —— 「加载更多」在第一页之后必失败（复验 §5-P1）：
   * 非法游标**响亮抛**，不回落第一页 —— 回落会把分页 bug 伪装成「又刷了一遍」，没人看得出来。
   * `limit` 必须是 ≥1 且 ≤200 的整数，否则抛（防「一次请求拉全量」，也防 0/负数/NaN 变成怪查询）。
   * 取 `limit + 1` 行判有无下一页；`nextCursor === null` 表示到底（**不返回** count(*)）。
   */
  listHistoryPage(
    workspaceKey: string,
    query: { agentId?: string; limit: number; cursor?: string },
  ): { rows: SquadRunRecord[]; nextCursor: string | null };
  /**
   * **熔断窗口计数**（W3 §3.6 的派生判据，零状态）：本 workspace 下 `settle_reason` ∈ **看门狗族**
   * （`SQUAD_RUN_WATCHDOG_SETTLE_REASONS`，含空闲宽限摊牌）且 `updated_at > sinceMs` 的行，
   * 按 agent 分组计数；没有命中的 agent **不出现**在结果里（缺省 = 0，不在查询里编造零行）。
   *
   * 为什么时间取 `updated_at`：终态迁移的 `setStatus` 恰好把它刷成结算时刻（`setStatus` 的实现），
   * 于是「窗口内的看门狗结算」不需要任何额外时间列。窗口起点由调用方给（服务面算，见
   * `ISquadRuntimeService.countWatchdogSettlementsByAgent`）—— 本层不取时钟。
   *
   * 为什么族**只认常量**：窗口口径是「多少次看门狗结算」，用户取消（`user_cancel`）不是看门狗结算，
   * 把它算进来会让「连续取消几次」变成熔断，而这不报错。判定与 SQL 必须读同一个族常量（此处）。
   */
  countWatchdogSettlementsByAgent(workspaceKey: string, sinceMs: number): Map<string, number>;
  /**
   * **重试预算**（W3 §3.5 的派生判据，零状态）：同 `(workspace, workItem, agent)` **另有**的
   * 看门狗族结算数是否已达 `budget`（`run_id <> excludeRunId` 只排除**触发本次重试的那一行**）？
   *
   * 「另有」是本判据的全部要点：被结算的那一条正是**触发**重试的那一行，若把它自己算进预算，
   * 第一次结算就永远不重试 —— 而且是静默的（预算是派生判据，没有任何地方会报「预算算错了」）。
   * 预算按 (workItem, agent) 对、**不设时间窗**（设计 §3.5：每对至多重试有限次，防重试风暴/死循环），
   * 故它是「这一对已经用掉几次重试」的终身口径，不受窗口滑动影响。
   *
   * **额度由调用方注入**（服务面传 shared 的 `SQUAD_RETRY_BUDGET` 单源常量）：本层不读策略常量
   * —— 「预算是几次」是策略，「计数是否达标」是判据。把额度烧死在 SQL 里（早前是 EXISTS，等价于
   * 恒为 1）会让改常量**静默无效**：改一行没人听，而两种口径都不报错。
   */
  hasOtherWatchdogSettledRunForPair(
    workspaceKey: string,
    workItemId: string,
    agentId: string,
    excludeRunId: string,
    budget: number,
  ): boolean;
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
  /**
   * **唯一用量的写入口**（0015，#6 按 run 记账）。**write-once**：`usage_recorded_at IS NULL` 才写，
   * 二次调用不改变行内容（含 `updated_at`——「没写」的可观察证据）。
   *
   * · 为什么 write-once 而不是「覆盖 / 取大」：来源是**会话累计值**（`getTaskTokenUsage` 读 CLI 侧
   *   SQLite 聚合；同一 run 重拉只会变大），一次落账 = 快照语义明确（「结算时刻的值」），
   *   且消除「两次值不同时谁赢」的第二份判据。
   * · 为什么「已记录」返回 `{written:false}` 而不是抛：重复补拉是**合法重投**（查询面超时重发安全），
   *   抛会把幂等重投误当调用方 bug；但 **runId 不存在仍响亮抛**（与 `bindSession` 同款：未命中即抛
   *   ——「没有该行」与「已记录」是两件不同的事，静默混同会让传错 runId 变成没人知道的事）。
   * · **只写 `usage_*` 9 列 + `updated_at`**：不碰 status / 身份列（与 `bindSession`「只写
   *   `session_id` 一列」同纪律）。8 个数值先过写路径闸（非负整数），非法值绝不落盘。
   */
  recordUsage(runId: string, usage: SquadRunUsageSnapshot): { written: boolean };
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
  opened_at: number | null;
  settle_reason: string | null;
  usage_total_tokens: number | null;
  usage_input_tokens: number | null;
  usage_output_tokens: number | null;
  usage_reasoning_tokens: number | null;
  usage_cache_creation_tokens: number | null;
  usage_cache_read_tokens: number | null;
  usage_model_request_count: number | null;
  usage_model_error_count: number | null;
  usage_recorded_at: number | null;
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
function assertQueuedHasNoTree(record: {
  status: SquadRunStatus;
  branch: string | null;
  dirName: string | null;
}): void {
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

/** `recordUsage` 的数值列名 → 快照键（写路径闸的报错要点名是哪一列）。 */
const USAGE_VALUE_KEYS = [
  ["totalTokens", "usage_total_tokens"],
  ["inputTokens", "usage_input_tokens"],
  ["outputTokens", "usage_output_tokens"],
  ["reasoningTokens", "usage_reasoning_tokens"],
  ["cacheCreationTokens", "usage_cache_creation_tokens"],
  ["cacheReadTokens", "usage_cache_read_tokens"],
  ["modelRequestCount", "usage_model_request_count"],
  ["modelErrorCount", "usage_model_error_count"],
] as const satisfies ReadonlyArray<readonly [keyof SquadRunUsageSnapshot, string]>;

/* `recordUsage` 的**写路径闸**（与 readStatus / assertStatus / assertDispatchCause 同款裁定）：
   8 个数值必须是**非负整数**（累计 token 计数与请求数）——负数/小数/NaN 只可能是调用方算错，
   而落盘后读回是一个「看起来像真的」的用量，且不报错（记账面正是最经不起编数字的地方）。
   校验在 SQL 之前：非法值根本没机会写进列。 */
function assertUsageValues(usage: SquadRunUsageSnapshot): void {
  for (const [key, column] of USAGE_VALUE_KEYS) {
    const value = usage[key];
    if (!Number.isInteger(value) || value < 0) {
      throw new Error(
        `squad_runs.${column} 拒绝写入非法值「${String(value)}」：用量计数必须是非负整数` +
          "（负数/小数只可能是调用方算错，落盘后会变成没人知道是假的用量）。",
      );
    }
  }
}

/** 9 个用量列的写入值（`record.usageX ?? null`）：读回恒有值、写入缺省不动该列（= NULL）。
 *  与 `settleReason ?? null` 同款：存量调用方的行字面量不因加列而全体改。 */
const usageInsertValues = (record: SquadRunRecord): Array<number | null> => [
  record.usageTotalTokens ?? null,
  record.usageInputTokens ?? null,
  record.usageOutputTokens ?? null,
  record.usageReasoningTokens ?? null,
  record.usageCacheCreationTokens ?? null,
  record.usageCacheReadTokens ?? null,
  record.usageModelRequestCount ?? null,
  record.usageModelErrorCount ?? null,
  record.usageRecordedAt ?? null,
];

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
    openedAt: row.opened_at,
    settleReason: row.settle_reason,
    // 0015：9 列原样透出（**不得 `?? 0`**：NULL = 未记录，折成 0 会把「没记账」伪装成「没消耗」）。
    usageTotalTokens: row.usage_total_tokens,
    usageInputTokens: row.usage_input_tokens,
    usageOutputTokens: row.usage_output_tokens,
    usageReasoningTokens: row.usage_reasoning_tokens,
    usageCacheCreationTokens: row.usage_cache_creation_tokens,
    usageCacheReadTokens: row.usage_cache_read_tokens,
    usageModelRequestCount: row.usage_model_request_count,
    usageModelErrorCount: row.usage_model_error_count,
    usageRecordedAt: row.usage_recorded_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

// 由 SQUAD_RUN_ACTIVE_STATUSES 拼占位符而不是写 SQL 字面量：活跃集合只有一处定义，
// 将来改集合不会出现「常量改了、SQL 还认旧状态」的静默不一致。
const ACTIVE_STATUS_PLACEHOLDERS = SQUAD_RUN_ACTIVE_STATUSES.map(() => "?").join(", ");

// 同款：看门狗族（W3 的窗口计数）的占位符由族常量拼 —— 族里加一值（如空闲宽限摊牌）时，
// 窗口口径自动跟上；反之若 SQL 里写死两个字面量，加值只改常量而查询照旧只认两个，且不报错。
const WATCHDOG_REASON_PLACEHOLDERS = SQUAD_RUN_WATCHDOG_SETTLE_REASONS.map(() => "?").join(", ");

// 排序统一按 created_at、再按 run_id：批次处理顺序必须确定，否则同刻写入的 run
// 会随存储顺序漂移，让「谁先被合并 / 回收」变得不可复现。
const ORDER_BY_CREATED = "ORDER BY created_at ASC, run_id ASC";

/* 呈现用分页历史（欠账 #13）的**游标编解码**：只在本文件内（单源）。
   形状 `v2:<created_at 位数>:<created_at 原文>:<run_id 位数>:<run_id 原文>`：自描述、带版本位，
   且**长度前缀**（先例：本仓 computeCommentDispatchKey，X1.2 的稳定键）。
   为什么从 v1 的 `v1:<created_at>:<run_id>` 升级（2026-10-07 P1 修复）：`:` 当字段分隔符时，
   生产 runId（= host 的 eventKey：`assign:wi-1:agent:ta-1:<uuid>` / `comment-dispatch:v1:…`）
   自带的冒号与结构冲突 —— 页边界行是这类 id 时，编出的 nextCursor 被**本实现自己**判非法，
   「加载更多」翻不过第一页（复验报告 §5-P1，已实际复现）。长度前缀让原文里的任何字符
   （含 `:` 与 `|`）都只是原文，不再与结构冲突。
   **不透明**是给调用方的契约：服务面与界面都不得解析它（解析 = 第二份判据，且会随格式一起漂移）
   —— 它们只负责把 nextCursor 原样带回来。版本位升到 v2 后旧 v1 游标**一律判非法**
   （不猜着解释：v1 形状在含冒号 id 上本就是坏的）。 */
const RUN_HISTORY_CURSOR_VERSION = "v2";
/** 一次最多取多少行：上限存在的意义是挡住「一次请求拉全量」（那正是本方法要取代的形态）。 */
const RUN_HISTORY_MAX_LIMIT = 200;

function encodeRunHistoryCursor(row: { createdAt: number; runId: string }): string {
  const createdAt = String(row.createdAt);
  return (
    `${RUN_HISTORY_CURSOR_VERSION}:${createdAt.length}:${createdAt}:` +
    `${row.runId.length}:${row.runId}`
  );
}

/* 非法游标**一律抛**（不回落第一页）：回落会把一个分页 bug 伪装成「又刷了一遍第一页」——
   用户与开发者都看不出少了东西。校验把 `decode(encode(x)) === x` 作为不变式：长度位写错、
   手改过的数值（`01`）、截断或多出字符的片段都会被拒（末尾的原样读回再兜一遍）。 */
function decodeRunHistoryCursor(cursor: string): { createdAt: number; runId: string } {
  const versionEnd = cursor.indexOf(":");
  if (!cursor.startsWith(`${RUN_HISTORY_CURSOR_VERSION}:`)) {
    const version = versionEnd === -1 ? cursor : cursor.slice(0, versionEnd);
    throw new Error(
      `squad_runs 分页游标版本不认识「${version}」（当前 ${RUN_HISTORY_CURSOR_VERSION}）：` +
        "宁可响亮拒绝，也不按旧/新格式猜着解释。",
    );
  }
  let position = versionEnd + 1;
  /* `<位数>:<原文>`：长度位是十进制位数（无前导零），原文按位数**恰好**取下 —— 原文里再出现
     多少个冒号都不影响切分（这正是 P1 的修法：切分不再依赖分隔符不出现在内容里）。 */
  const readLengthPrefixed = (field: string): string => {
    const separator = cursor.indexOf(":", position);
    if (separator === -1) {
      throw new Error(`squad_runs 分页游标非法「${cursor}」：${field}缺少「<位数>:<原文>」段。`);
    }
    const rawLength = cursor.slice(position, separator);
    const length = Number(rawLength);
    if (!/^\d+$/.test(rawLength) || !Number.isSafeInteger(length) || String(length) !== rawLength) {
      throw new Error(
        `squad_runs 分页游标非法「${cursor}」：${field}的位数「${rawLength}」应为十进制整数（无前导零）。`,
      );
    }
    const valueStart = separator + 1;
    const valueEnd = valueStart + length;
    if (valueEnd > cursor.length) {
      throw new Error(
        `squad_runs 分页游标非法「${cursor}」：${field}的位数「${rawLength}」与实际内容不符（被截断）。`,
      );
    }
    position = valueEnd;
    return cursor.slice(valueStart, valueEnd);
  };

  const rawCreatedAt = readLengthPrefixed("时间");
  if (!/^\d+$/.test(rawCreatedAt) || String(Number(rawCreatedAt)) !== rawCreatedAt) {
    throw new Error(`squad_runs 分页游标的时间非法「${rawCreatedAt}」：应为毫秒整数。`);
  }
  const createdAt = Number(rawCreatedAt);
  if (!Number.isSafeInteger(createdAt)) {
    throw new Error(`squad_runs 分页游标的时间超出安全整数范围「${rawCreatedAt}」。`);
  }
  if (cursor[position] !== ":") {
    throw new Error(`squad_runs 分页游标非法「${cursor}」：时间与 run_id 之间缺少「:」分隔。`);
  }
  position += 1;
  const runId = readLengthPrefixed("run_id");

  const decoded = { createdAt, runId };
  if (cursor !== encodeRunHistoryCursor(decoded)) {
    throw new Error(
      `squad_runs 分页游标非法「${cursor}」：不能原样读回（手改或格式漂移），` +
        "拒绝按它翻页 —— 猜着翻会把「漏了一页」变成没人知道的事。",
    );
  }
  return decoded;
}

/** 页大小闸：非整数 / <1 / >上限一律抛（`0`、负数、`NaN` 静默变成怪查询是最坏的一种）。 */
function assertRunHistoryLimit(limit: number): number {
  if (!Number.isInteger(limit) || limit < 1 || limit > RUN_HISTORY_MAX_LIMIT) {
    throw new Error(
      `squad_runs 分页 limit 非法「${String(limit)}」：必须是 1..${RUN_HISTORY_MAX_LIMIT} 的整数` +
        "（上限存在的意义是挡住「一次请求拉全量」）。",
    );
  }
  return limit;
}

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
          dispatch_cause, caused_by_run_id, opened_at, settle_reason,
          usage_total_tokens, usage_input_tokens, usage_output_tokens, usage_reasoning_tokens,
          usage_cache_creation_tokens, usage_cache_read_tokens, usage_model_request_count,
          usage_model_error_count, usage_recorded_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
        // 0014 两列：字面量缺省（老调用方）⇒ NULL（`openedAt` 的 NULL 只该出现在 queued 行上，
        // 由 open 的写点各自负责填——不变式用例在 squadWatchdog.test.ts 逐条钉住五类写点）。
        record.openedAt ?? null,
        record.settleReason ?? null,
        // 0015 九列：缺省 NULL（未记录）——用量只由 `recordUsage` 写；行字面量带值也照落（写路径全量）。
        ...usageInsertValues(record),
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
            dispatch_cause, caused_by_run_id, opened_at, settle_reason,
            usage_total_tokens, usage_input_tokens, usage_output_tokens, usage_reasoning_tokens,
            usage_cache_creation_tokens, usage_cache_read_tokens, usage_model_request_count,
            usage_model_error_count, usage_recorded_at
          )
          SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
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
          record.openedAt ?? null,
          record.settleReason ?? null,
          ...usageInsertValues(record),
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
            dispatch_cause, caused_by_run_id, opened_at, settle_reason,
            usage_total_tokens, usage_input_tokens, usage_output_tokens, usage_reasoning_tokens,
            usage_cache_creation_tokens, usage_cache_read_tokens, usage_model_request_count,
            usage_model_error_count, usage_recorded_at
          )
          SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
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
          record.openedAt ?? null,
          record.settleReason ?? null,
          ...usageInsertValues(record),
          record.workspaceKey,
          record.agentId,
          maxConcurrentRuns,
          record.workspaceKey,
          record.workItemId,
          record.agentId,
        ).changes;
      if (opened === 1) return { kind: "opened" };

      // 语句二：插排队行——branch/dir_name 一律 NULL（实体不变式，语句层强制，record 带了也不落）。
      // opened_at 同样一律 NULL：排队行还没开跑，起算点不存在（拿 created_at 冒充会把「排队久」
      // 误判成「跑得久」——TTL 判据的起算点语义见 `SQUAD_RUN_WATCHDOG_SQL`）。
      const queued = db
        .prepare(
          `INSERT INTO squad_runs (
            run_id, workspace_key, workspace_path, work_item_id, parent_work_item_id, agent_id,
            is_leader_task, branch, dir_name, status, session_id, created_at, updated_at,
            dispatch_cause, caused_by_run_id, opened_at, settle_reason,
            usage_total_tokens, usage_input_tokens, usage_output_tokens, usage_reasoning_tokens,
            usage_cache_creation_tokens, usage_cache_read_tokens, usage_model_request_count,
            usage_model_error_count, usage_recorded_at
          )
          SELECT ?, ?, ?, ?, ?, ?, ?, NULL, NULL, 'queued', ?, ?, ?, ?, ?, NULL, NULL,
                 NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL
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

    discardQueuedRun(runId, reason) {
      // 0014：reason 给了才写 settle_reason（缺省不动该列——调用方不知道「为什么丢」时不得猜）。
      const sets = ["status = 'discarded'", "branch = NULL", "dir_name = NULL", "updated_at = ?"];
      const args: Array<string | number> = [Date.now()];
      if (reason !== undefined) {
        sets.push("settle_reason = ?");
        args.push(reason);
      }
      args.push(runId);
      const result = db
        .prepare(`UPDATE squad_runs SET ${sets.join(", ")} WHERE run_id = ? AND status = 'queued'`)
        .run(...args);
      if (result.changes !== 1) {
        throw new Error(
          `squad_runs 没有 runId=「${runId}」的 queued 行，无法丢弃：行不存在、已推进为 open、或已终态。` +
            "静默 no-op 会让「这条排队派发还跑不跑」变成没人知道的事，故一律抛。",
        );
      }
    },

    hasQueuedRunForPair(workspaceKey, workItemId, agentId) {
      const row = db
        .prepare(
          "SELECT 1 FROM squad_runs WHERE workspace_key = ? AND work_item_id = ? AND agent_id = ? AND status = 'queued' LIMIT 1",
        )
        .get(workspaceKey, workItemId, agentId);
      return row !== undefined;
    },

    hasActiveRunForPair(workspaceKey, workItemId, agentId) {
      const row = db
        .prepare(
          `SELECT 1 FROM squad_runs WHERE workspace_key = ? AND work_item_id = ? AND agent_id = ?
             AND status IN (${ACTIVE_STATUS_PLACEHOLDERS}) LIMIT 1`,
        )
        .get(workspaceKey, workItemId, agentId, ...SQUAD_RUN_ACTIVE_STATUSES);
      return row !== undefined;
    },

    claimQueuedRunForPromotion(runId, maxConcurrentRuns) {
      if (!Number.isInteger(maxConcurrentRuns) || maxConcurrentRuns < 1) {
        throw new Error(
          `claimQueuedRunForPromotion 的 maxConcurrentRuns 必须是 ≥1 的整数（收到 ${String(maxConcurrentRuns)}）`,
        );
      }
      const row = db
        .prepare(
          "SELECT workspace_key AS workspaceKey, agent_id AS agentId FROM squad_runs WHERE run_id = ? AND status = 'queued'",
        )
        .get(runId) as { workspaceKey: string; agentId: string } | undefined;
      if (row === undefined) return false;
      // 认领即**进入 open**：`opened_at` 在语句内写成认领时刻（TTL 起算点 = 开跑时刻，不是排队登记
      // 时刻——排队等待不占容量也不算「跑得久」，见 `SQUAD_RUN_WATCHDOG_SQL` 的语义）。
      const now = Date.now();
      const changes = db
        .prepare(
          `UPDATE squad_runs SET status = 'open', opened_at = ?, updated_at = ?
             WHERE run_id = ? AND status = 'queued'
               AND (SELECT COUNT(*) FROM squad_runs
                     WHERE workspace_key = ? AND agent_id = ? AND status = 'open') < ?`,
        )
        .run(now, now, runId, row.workspaceKey, row.agentId, maxConcurrentRuns).changes;
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
            dispatch_cause, caused_by_run_id, opened_at, settle_reason,
            usage_total_tokens, usage_input_tokens, usage_output_tokens, usage_reasoning_tokens,
            usage_cache_creation_tokens, usage_cache_read_tokens, usage_model_request_count,
            usage_model_error_count, usage_recorded_at
          )
          SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
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
          record.openedAt ?? null,
          record.settleReason ?? null,
          ...usageInsertValues(record),
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

      // 容量满且无活跃队长行 ⇒ 尝试排队行（branch/dir_name / opened_at 一律 NULL，理由同语句二）。
      const queued = db
        .prepare(
          `INSERT INTO squad_runs (
            run_id, workspace_key, workspace_path, work_item_id, parent_work_item_id, agent_id,
            is_leader_task, branch, dir_name, status, session_id, created_at, updated_at,
            dispatch_cause, caused_by_run_id, opened_at, settle_reason,
            usage_total_tokens, usage_input_tokens, usage_output_tokens, usage_reasoning_tokens,
            usage_cache_creation_tokens, usage_cache_read_tokens, usage_model_request_count,
            usage_model_error_count, usage_recorded_at
          )
          SELECT ?, ?, ?, ?, ?, ?, ?, NULL, NULL, 'queued', ?, ?, ?, ?, ?, NULL, NULL,
                 NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL
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

    /* 呈现用分页历史（欠账 #13）：与上面的全量口径**刻意不共用 SQL 前缀** —— 本方法的排序方向
       相反（DESC）且带游标谓词，共用前缀最容易在「顺手复用」时把方向搞反（而方向错了不报错，
       只是把最老的一页当最新的一页给人看）。过滤与排序都在这一条语句里：服务面/界面不重写、不重排。 */
    listHistoryPage(workspaceKey, query) {
      const limit = assertRunHistoryLimit(query.limit);
      const cursor = query.cursor === undefined ? null : decodeRunHistoryCursor(query.cursor);
      const conditions = ["workspace_key = ?"];
      const args: Array<string | number> = [workspaceKey];
      // agentId **下推 SQL**（不是前端过滤）：见接口注释的「假空」。
      if (query.agentId !== undefined) {
        conditions.push("agent_id = ?");
        args.push(query.agentId);
      }
      // keyset 谓词：(created_at, run_id) 严格小于游标所指的行（与 DESC 同一比较方向）。
      if (cursor) {
        conditions.push("(created_at < ? OR (created_at = ? AND run_id < ?))");
        args.push(cursor.createdAt, cursor.createdAt, cursor.runId);
      }
      const rows = db
        .prepare(
          `SELECT * FROM squad_runs WHERE ${conditions.join(" AND ")}
          ORDER BY created_at DESC, run_id DESC LIMIT ?`,
        )
        .all(...args, limit + 1) as unknown as SquadRunRow[];
      const page = rows.slice(0, limit).map(rowToSquadRun);
      // 多取的一行只用来回答「还有没有下一页」；末页的游标必须是 null（给了会让界面出现一个
      // 点不出东西的「加载更多」）。有下一页时游标指向**本页最后一行**（下一段从它之后继续）。
      const last = page[page.length - 1];
      const nextCursor = rows.length > limit && last ? encodeRunHistoryCursor(last) : null;
      return { rows: page, nextCursor };
    },

    countWatchdogSettlementsByAgent(workspaceKey, sinceMs) {
      /* 零状态派生判据（设计 §3.6）：不加表、不加列、不加内存状态 —— 没有状态可漂移、没有 reset
         可忘记。`updated_at` 是结算时刻（终态迁移必过 `setStatus`，它无条件刷这一列）。
         族由常量拼占位符（见文件头的 `WATCHDOG_REASON_PLACEHOLDERS`）：用户取消不在族内，
         故「窗口内连续取消几次」不会被算成熔断。 */
      const rows = db
        .prepare(
          `SELECT agent_id, count(*) AS n FROM squad_runs
            WHERE workspace_key = ? AND settle_reason IN (${WATCHDOG_REASON_PLACEHOLDERS})
              AND updated_at > ?
            GROUP BY agent_id`,
        )
        .all(workspaceKey, ...SQUAD_RUN_WATCHDOG_SETTLE_REASONS, sinceMs) as unknown as Array<{
        agent_id: string;
        n: number;
      }>;
      return new Map(rows.map((row) => [row.agent_id, row.n]));
    },

    hasOtherWatchdogSettledRunForPair(workspaceKey, workItemId, agentId, excludeRunId, budget) {
      /* 派生计数（设计 §3.5 的预算判据）：`run_id <> ?` 排除**触发重试的那一行**（见接口注释的
         「另有」），故第 1 次结算时计数 = 0。族由常量拼占位符 —— 用户取消不在族内（取消不重试）。
         为什么是 count 而不是 EXISTS：EXISTS 把额度钉死为「恰 1 次」，`SQUAD_RETRY_BUDGET` 改大也
         静默无效；计数（>= 注入额度）让常量成为唯一决策处。budget=1 时两口径逐格一致。 */
      const row = db
        .prepare(
          `SELECT count(*) AS n FROM squad_runs
            WHERE workspace_key = ? AND work_item_id = ? AND agent_id = ?
              AND run_id <> ?
              AND settle_reason IN (${WATCHDOG_REASON_PLACEHOLDERS})`,
        )
        .get(
          workspaceKey,
          workItemId,
          agentId,
          excludeRunId,
          ...SQUAD_RUN_WATCHDOG_SETTLE_REASONS,
        ) as {
        n: number;
      };
      return row.n >= budget;
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
        ["opened_at", "openedAt"],
        ["settle_reason", "settleReason"],
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

    recordUsage(runId, usage) {
      // 数值先过写路径闸：非法值绝不落盘（与 insert / setStatus 的闸同一条纪律）。
      assertUsageValues(usage);
      /* **单条 UPDATE 同持「行存在 + 未记录」两前置**（`usage_recorded_at IS NULL` 是 write-once 的
         全部实现）：先查后写（read → if null → write）在两次补拉并发时都会读到 NULL ⇒ 两次都写，
         后写者覆盖先写者，「先到者赢」当场失效——而这条路的两次调用来自两条异步臂，
         并发是常态。写进语句本身即原子（与 insertMemberRunOrQueue 的「判定写进语句」同法）。
         只写 `usage_*` 9 列 + `updated_at`：不碰 status / 身份列（与 bindSession 同纪律）。 */
      const now = Date.now();
      const changes = db
        .prepare(
          `UPDATE squad_runs SET
             usage_total_tokens = ?, usage_input_tokens = ?, usage_output_tokens = ?,
             usage_reasoning_tokens = ?, usage_cache_creation_tokens = ?, usage_cache_read_tokens = ?,
             usage_model_request_count = ?, usage_model_error_count = ?,
             usage_recorded_at = ?, updated_at = ?
           WHERE run_id = ? AND usage_recorded_at IS NULL`,
        )
        .run(
          usage.totalTokens,
          usage.inputTokens,
          usage.outputTokens,
          usage.reasoningTokens,
          usage.cacheCreationTokens,
          usage.cacheReadTokens,
          usage.modelRequestCount,
          usage.modelErrorCount,
          now,
          now,
          runId,
        ).changes;
      if (changes === 1) return { written: true };
      /* changes === 0 底下是两件完全不同的事，必须分开（见接口注释）：
         · 行在、只是已记录 ⇒ 合法重投 ⇒ 幂等返回 {written:false}（不抛）；
         · 行不在 ⇒ 调用方传错 runId / 台账被删 ⇒ 响亮抛（混同「已记录」会让接线 bug 变成没人知道的事）。 */
      const existing = db.prepare("SELECT 1 FROM squad_runs WHERE run_id = ?").get(runId);
      if (existing === undefined) {
        throw new Error(
          `squad_runs 没有 runId=「${runId}」的行，无法记录用量：调用方传错 runId，或台账行已被删除。` +
            "静默返回 {written:false} 会把「没有这一行」混同「已记录」——前者是接线 bug，故一律抛。",
        );
      }
      return { written: false };
    },
  };
}
