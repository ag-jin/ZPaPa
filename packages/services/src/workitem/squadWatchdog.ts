/* W1（看门狗六件套）：run 看门狗的**判定面**——纯函数、依赖全注入，不做任何 IO。

   为什么判定必须与执行分离（本项目的既有形态：`isSquadBatchRoot` / `selectStaleLeaderRuns` /
   `decideWake`）：判定要被**两条执行臂**（启动和解 + 在线 tick，W2）共用；判定里一旦掺进 IO，
   「同一行在启动与在线两处结论不同」就会成为无法复现的现场，而看门狗的动作是**结算**（终局、
   会扇出队列推进）——判错不报错，只留下一条不该消失的 run。

   与 C1 的**硬边界**（W1 卡 §1-c，用户 2026-10-07 裁定）：**未绑会话**（`sessionId` 为 NULL）的
   队员行整块是 C1 领地（残行 / 等待分支空出 / 树已建、会话未绑的在途派发）——看门狗只产 skip 与留痕，
   **不结算**。理由（三条既有事实）：结算是终局 ⇒ 评论 receipt 的 own-run 永不再 open
   （`own_run_not_open` 永久跳过）而请求悬空；C1 的「结算 + 同 runId 重开」是唯一保留请求身份的
   处置；看门狗既没有重开能力、也没有替某条请求继续跑的授权。
   **判据本体不在这里复写**：本文件只**引用** `squadRunLifecycle` 导出的 C1 行级判据
   （`isTreelessOpenMemberRun` / `isSettleableResidualMemberRun` / `isAwaitingBranchMemberRun`），
   不自己拼「open + 无会话 + 分支」那组三条件（守卫见 squadWatchdog.test.ts 的结构守卫用例）。

   TTL 的覆盖范围是上面那条划界的**推论**：无会话的队员行先被 C1 档吃掉，末位的 TTL 兜底于是
   只可能命中「有会话的队员行」与「队长行」（不再需要在本文件里写第二份会话判据）。 */

import {
  SQUAD_RUN_SETTLE_REASON_WATCHDOG_DEAD_SESSION,
  SQUAD_RUN_SETTLE_REASON_WATCHDOG_TTL,
  type SquadRunStatus,
} from "./squadRunRepo.js";
import {
  isAwaitingBranchMemberRun,
  isSettleableResidualMemberRun,
  isTreelessOpenMemberRun,
} from "./squadRunLifecycle.js";
import { MS_PER_HOUR, MS_PER_MINUTE } from "@zcode/shared";

/**
 * 判定输入的一行（**看门狗自己的形状**，不直接吃 `SquadRunRecord`）：调用方（W2 的启动臂 / tick）
 * 从 `getSnapshot().runs` / `listSquadRuns` 映射，并补齐两个它才知道的事实。
 *
 * `openedAt`：进入 open 的时刻（0014）。`null` = 没有这个事实（queued 行 / 加列前的遗留行）。
 * **不猜**：读回 NULL 时 TTL 判据**不成立**（宁可让这行继续可见地停在 open，也不按一个编造的
 * 起算点结算它）——迁移会回填非 queued 行，故它只该出现在「写点漏了」或 queued 行上。
 *
 * `liveTreeOfOtherRow`：P2-1 判据的**行级旁证**（「同一对还有别的 run 行 ⇒ 分支上的活树另有来路」，
 * 唯一读法是 `hasOtherRunRowForPair`）。刻意由调用方声明而不是本层自己查：判据本体是
 * `squadRunLifecycle` 的既有实现，这里只做搬运（**不复制**那条投影）。
 */
export type SquadWatchdogRun = {
  runId: string;
  agentId: string;
  isLeaderTask: boolean;
  status: SquadRunStatus;
  sessionId: string | null;
  branch: string | null;
  openedAt: number | null;
  liveTreeOfOtherRow: boolean;
};

/** C1 领地里这一行**此刻处在哪一格**（留痕用；四格互斥，按 C1 判据的顺序判定）。 */
export type SquadWatchdogC1Case =
  /** C1 等待臂：结算过、分支占位已释放（`isAwaitingBranchMemberRun`），等回收器收净后同一条重投自愈。 */
  | "awaiting_branch"
  /** C1 可立即自愈（`isSettleableResidualMemberRun`）：残行且分支无任何占用，重投会结算+重开。 */
  | "settleable_residual"
  /** C1 等待型（`isTreelessOpenMemberRun` 但分支仍被活树/残枝占着）：重投得 `residual_blocked`。 */
  | "residual_blocked"
  /** 树可能已建好、会话还没绑（在途派发）：C1 的 `already_registered` 幂等臂在管它。 */
  | "unbound_in_flight";

/** 判定输入：全部事实注入（含 git 事实与阈值解析），本函数不读库、不问 git、不取时钟。 */
export type SquadWatchdogInput = {
  /** 候选行（行序即决策序；非 `open` 行由本函数忽略）。 */
  rows: readonly SquadWatchdogRun[];
  /**
   * **强探测**结论（`createBoundSessionExecutingProbe` 口径）：此刻确实在执行中的会话集合。
   * 行上会话**不在**集合里 = 明确「不在执行」；集合是否可信由 `probeAvailable` 表态。
   */
  executingSessionIds: ReadonlySet<string>;
  /**
   * 探针**是否可得**（agentService 未注册 / 探测抛错 ⇒ false）。不可得时本函数**不猜**会话状态：
   * 只按兜底墙钟（`fallbackWallClockHours`）结算，否则一律 `skip_probe_unavailable` 留痕。
   */
  probeAvailable: boolean;
  now: number;
  /** git 事实（工作树与分支 ref 的唯一所有者投影，见 `squadRunLifecycle` 的注入面注释）。 */
  facts: {
    liveTreeBranches: ReadonlySet<string>;
    branchRefExists: (branch: string) => boolean;
  };
  /**
   * 每个 run 的**静默毫秒数**（会话活着但最近无活动 + 队列空；由 W2 从会话活动信号算出）。
   * 缺席 = 无信号 ⇒ 空闲档不动作（**不猜**空闲）。
   */
  idleMsByRunId: ReadonlyMap<string, number>;
  /** 阈值：TTL / 空闲按 agent 解析（经 shared 的 per-agent resolve helper），兜底墙钟为全局常量。 */
  thresholds: {
    ttlMinutesFor: (agentId: string) => number;
    idleTimeoutMinutesFor: (agentId: string) => number;
    fallbackWallClockHours: number;
  };
};

/** 判定结论（判别联合）：三种动作 + 三种 skip（skip 也要**可见**，静默跳过是本项目反复消灭的形态）。
 *
 * 结算类决策**自带 `reason`**（`settle_reason` 的码值，单源在 `squadRunRepo.ts`）：执行臂把它
 * 原样交给 `failMemberRun`，不必在 host 侧再写一张 kind→码值 的映射表（那张表一旦分叉，
 * 熔断窗口的『看门狗族』口径就静默变了，而没有任何用例会红）。 */
export type SquadWatchdogDecision =
  /** 会话已死（探测明确不在执行）⇒ `failMemberRun`（reason = `watchdog_dead_session`）。 */
  | {
      kind: "settle_dead_session";
      runId: string;
      agentId: string;
      sessionId: string;
      reason: string;
    }
  /** TTL（或探测缺席的兜底墙钟）到期 ⇒ `failMemberRun`（reason = `watchdog_ttl`）。 */
  | {
      kind: "settle_ttl";
      runId: string;
      agentId: string;
      openedAt: number;
      thresholdMs: number;
      reason: string;
    }
  /** 会话活着但静默超阈值 ⇒ **先 stop** 再等终态回调；宽限内无回调由执行臂退回结算。 */
  | {
      kind: "stop_then_wait_idle";
      runId: string;
      agentId: string;
      sessionId: string;
      idleMs: number;
    }
  /** 探针不可得且兜底墙钟未到 ⇒ 跳过并留痕（不猜会话状态，设计 §3.1 档 2 的在线护栏）。 */
  | { kind: "skip_probe_unavailable"; runId: string; agentId: string; sessionId: string }
  /** C1 领地（无会话队员行）⇒ 只留痕不结算；`c1Case` 说明它此刻在哪一格。 */
  | {
      kind: "skip_residual_owned_by_open_member_run";
      runId: string;
      agentId: string;
      branch: string | null;
      c1Case: SquadWatchdogC1Case;
    }
  /** 匹配不上任何一档（例如 open 行缺 `opened_at` 这一时钟事实）⇒ 跳过并留痕，绝不猜着结算。 */
  | { kind: "skip_unclassified"; runId: string; agentId: string; note: string };

/** C1 领地的行级分类：四问都落到 C1 的**既有判据**上（本文件不写第二份三条件）。 */
function classifyC1Case(
  row: SquadWatchdogRun,
  facts: SquadWatchdogInput["facts"],
): SquadWatchdogC1Case {
  if (isAwaitingBranchMemberRun(row)) return "awaiting_branch";
  const c1Facts = {
    liveTreeBranches: facts.liveTreeBranches,
    liveTreeOfOtherRow: row.liveTreeOfOtherRow,
    branchRefExists: row.branch !== null && facts.branchRefExists(row.branch),
  };
  if (isSettleableResidualMemberRun(row, c1Facts)) return "settleable_residual";
  if (isTreelessOpenMemberRun(row, c1Facts)) return "residual_blocked";
  return "unbound_in_flight";
}

/**
 * 判定入口：逐行给出决策（顺序 = 输入行序，确定性；健康行不产决策）。
 *
 * 档次序（设计 §3.1 原样；判定优先级自上而下）：
 * 1. **C1 领地**：无会话的队员行 ⇒ skip（判据经 C1 导出件，见文件头）；
 * 2. **探测**：有会话的行 —— 探针可得且明确不在执行 ⇒ 结算死会话；不可得 ⇒ 兜底墙钟或 skip；
 * 3. **空闲**：会话在执行但静默超阈值 ⇒ 先 stop；
 * 4. **TTL**：末位兜底（`opened_at` 起算的硬墙钟）—— C1 档已把无会话队员行吃掉，故它实际只命中
 *    「有会话的队员行」与「队长行」。
 */
export function decideSquadWatchdog(input: SquadWatchdogInput): SquadWatchdogDecision[] {
  const decisions: SquadWatchdogDecision[] = [];
  for (const row of input.rows) {
    if (row.status !== "open") continue;
    const sessionId = row.sessionId;
    /* 「本行已绑会话」是一条**行级事实**（不是 C1 判据）：无会话的**队员行**整块归 C1 —— 残行与
       等待行两格由 C1 判据分类，第三格（树已建、会话未绑的在途派发）只能由这条事实分辨。
       判据本体不在这里复写：本文件零处自写「open + 无会话 + 分支」三条件。 */
    const hasBoundSession = sessionId !== null;
    /* 档 1：C1 领地 —— 只产 skip 决策（结算与重开是 C1 的 `openMemberRun` 臂的事）。 */
    if (!row.isLeaderTask && !hasBoundSession) {
      decisions.push({
        kind: "skip_residual_owned_by_open_member_run",
        runId: row.runId,
        agentId: row.agentId,
        branch: row.branch,
        c1Case: classifyC1Case(row, input.facts),
      });
      continue;
    }

    const openedAt = row.openedAt ?? null;
    const ttlMs = input.thresholds.ttlMinutesFor(row.agentId) * MS_PER_MINUTE;

    if (hasBoundSession) {
      /* 档 2：强探测。**仅明确「不在执行」才结算**；探针不可得时只按兜底墙钟，不猜会话状态
         （在线形态的活性护栏：探测抛错 / agentService 未注册时把它当死会话，会把活着的 run 结算掉）。 */
      if (!input.probeAvailable) {
        const fallbackMs = input.thresholds.fallbackWallClockHours * MS_PER_HOUR;
        if (openedAt === null) {
          // 兜底墙钟的时钟事实缺席（正常不可达：迁移回填非 queued 行）⇒ 不猜，留痕。
          decisions.push({
            kind: "skip_unclassified",
            runId: row.runId,
            agentId: row.agentId,
            note: "probe_unavailable_and_no_opened_at",
          });
        } else if (input.now - openedAt > fallbackMs) {
          decisions.push({
            kind: "settle_ttl",
            runId: row.runId,
            agentId: row.agentId,
            openedAt,
            thresholdMs: fallbackMs,
            reason: SQUAD_RUN_SETTLE_REASON_WATCHDOG_TTL,
          });
        } else {
          decisions.push({
            kind: "skip_probe_unavailable",
            runId: row.runId,
            agentId: row.agentId,
            sessionId,
          });
        }
        continue;
      }
      if (!input.executingSessionIds.has(sessionId)) {
        decisions.push({
          kind: "settle_dead_session",
          runId: row.runId,
          agentId: row.agentId,
          sessionId,
          reason: SQUAD_RUN_SETTLE_REASON_WATCHDOG_DEAD_SESSION,
        });
        continue;
      }
      /* 档 3：会话在执行但**静默**超阈值 ⇒ 先 stop 再等终态回调（看门狗在这条路上一个字都不写台账）。
         无静默信号 ⇒ 不动作（不猜空闲）。 */
      const idleMs = input.idleMsByRunId.get(row.runId);
      if (
        idleMs !== undefined &&
        idleMs > input.thresholds.idleTimeoutMinutesFor(row.agentId) * MS_PER_MINUTE
      ) {
        decisions.push({
          kind: "stop_then_wait_idle",
          runId: row.runId,
          agentId: row.agentId,
          sessionId,
          idleMs,
        });
        continue;
      }
    }
    /* 档 4：TTL（末位兜底，`opened_at` 起算的硬墙钟）。走到这里的只有**有会话的队员行**（C1 档
       已把无会话队员行吃掉）与**队长行**（含尚未绑会话的：没有会话可探测，只剩墙钟事实）。
       `opened_at` 缺席 ⇒ TTL 不成立（不按编造的起算点结算；迁移回填后正常不可达）。 */
    if (openedAt !== null && input.now - openedAt > ttlMs) {
      decisions.push({
        kind: "settle_ttl",
        runId: row.runId,
        agentId: row.agentId,
        openedAt,
        thresholdMs: ttlMs,
        reason: SQUAD_RUN_SETTLE_REASON_WATCHDOG_TTL,
      });
    }
  }
  return decisions;
}
