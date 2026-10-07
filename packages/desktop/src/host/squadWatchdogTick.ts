/* eslint-disable max-lines -- 看门狗的两条执行臂（启动和解 / 在线 tick）必须共享**同一份**判定输入
   装配与逐条执行：拆成两三个文件就得把端口形状、探针三态语义与「为什么不是布尔探针」这些守护注释
   复制两份，而它们一旦漂移**不报错** —— 表现是「同一行在启动与在线两处结论不同」（本文件开头那段
   也是据此写的）。留在一个边界里，W3 的工具臂只需在这一个文件上追加。 */
import {
  DEFAULT_SQUAD_FALLBACK_WALL_CLOCK_HOURS,
  hasBlockingActiveSnapshotRuntime,
  MS_PER_MINUTE,
  resolveTeamAgentIdleTimeoutMinutes,
  resolveTeamAgentRunTtlMinutes,
  resolveWorkspaceKey,
} from "@zcode/shared";
import {
  ZCODE_AGENT_RUNTIME_UNAVAILABLE_CODE,
  type ISquadRuntimeService,
  type IZCodeAgentService,
  type SquadRunRecord,
} from "@zcode/services";
import {
  buildRunStalledInboxItem,
  decideSquadWatchdog,
  hasOtherRunRowForPair,
  type InboxItemInput,
  type SquadWatchdogGitFacts,
  type SquadWatchdogRun,
} from "@zcode/services/node";

/* W2（看门狗六件套）：**执行臂**——把 W1 的判定面接到真实台账上。

   两条执行臂共用本文件的一件事：**同一份判定、同一份执行**。
   · 启动**和解**的队员臂（跨重启形态，`host/index.ts` 在 database ready 后调）：会话在重启后皆死，
     探测判据在这里恒可靠；空闲档没有信号（没有活动流可读）⇒ 只剩探测 / 树事实 / TTL。
   · 在线 **tick**（本文件的 `startSquadWatchdogTick`，60s repeating）：宿主活着，会话可能挂着不动。
   两条臂的差别**只有**：「看哪些行」（启动时队长行由既有 `settleStaleLeaderRunsBestEffort` 当场收口，
   队员臂只补队员行）与「有没有静默信号」（在线才有），执行动作（结算走 `failMemberRun`、
   留痕走 `run_stalled` Inbox、逐条容错）与判定全部共用 —— 抄成两份的代价是两边的修补互不继承。

   **没有第二份判据**（三条结构守卫的落点）：
   · 结算只经注入的 `settleRun`（= 服务面 `failMemberRun`，唯一写者）；本文件零处 `setStatus`；
   · C1 领地分类与「同一对还有别的 run 行」都**引用**服务面导出件（`decideSquadWatchdog` /
     `hasOtherRunRowForPair`）——本文件不自己拼「open + 无会话 + 分支」那类三条件；
   · 阈值只从 shared 的常量与 per-agent resolve helper 取，没有任何分钟字面量。

   **不调推进臂**（`advanceSquadQueueAfterSettlement`）：结算事实经组合根的订阅闭包自动扇出
   （C4b 既有回路），tick 里再调一次是第二份推进触发；启动链的第四步是那份全量兜底。 */

export type SquadWatchdogTickTarget = { path: string; identity: string };

/**
 * 会话探测的**三态**结论（看门狗自己的形状，刻意不复用 `BoundSessionExecutingProbe` 的布尔）：
 *
 * 那个布尔探针的失败极性是给**派发忙检查**用的 —— 探测异常 ⇒ `false` = 「不忙」 = 放行；
 * 看门狗这里同样的 `false` 会被读成「会话死了 ⇒ 结算」。同一份读数、相反的失败含义，
 * 直接复用就是把「探测坏了」当成「run 可以结算了」。故这里显式要三态，并且：
 * · `not_executing`：**只有明确不在执行**（runtime 缺席也算明确：没有执行中的东西）才给；
 * · `unavailable`：探测本身失败（异常/服务缺件）⇒ 判定面按「不猜」处理（跳过 + 留痕）。
 */
export type SquadSessionExecutingState = "executing" | "not_executing" | "unavailable";

export type SquadWatchdogLogger = {
  info(message: string): void;
  warn(message: string, error?: unknown): void;
};

/** 该 workspace 的判定输入事实（一次读全：全量台账 + 阈值解析 + 标题）。 */
export type SquadWatchdogWorkspaceFacts = {
  /** **全量**台账（`listByWorkspace` 口径，含终态行）—— C1 的行级旁证要它（见 `hasOtherRunRowForPair`）。 */
  rows: readonly SquadRunRecord[];
  ttlMinutesFor(agentId: string): number;
  idleTimeoutMinutesFor(agentId: string): number;
  workItemTitleFor(workItemId: string): string | null;
};

/** 一次 stop 的注入形态（唯一调用点是 `createSquadRunSessionStopper`，见 squadDispatch.ts）。 */
export type SquadSessionStopFn = (input: {
  target: SquadWatchdogTickTarget;
  runId: string;
  sessionId: string;
}) => Promise<boolean>;

export type SquadWatchdogSweepPorts = {
  readFacts(target: SquadWatchdogTickTarget): Promise<SquadWatchdogWorkspaceFacts>;
  readGitFacts(
    target: SquadWatchdogTickTarget,
    branches: readonly string[],
  ): Promise<SquadWatchdogGitFacts>;
  probeSession(input: {
    sessionId: string;
    workspacePath: string;
    workspaceIdentity?: string;
  }): Promise<SquadSessionExecutingState>;
  settleRun(
    target: SquadWatchdogTickTarget,
    input: { runId: string; reason: string },
  ): Promise<void>;
  recordInbox(target: SquadWatchdogTickTarget, item: InboxItemInput): Promise<void>;
  /** 缺席 ⇒ 空闲档只发决策不动作？（不，见 `stopSession` 的注释：缺席时该档一律不动作并留痕。） */
  stopSession: SquadSessionStopFn | null;
  /** 每个 run 的**静默毫秒数**（缺席 = 无信号 ⇒ 空闲档不动作，不猜）。 */
  readIdleMsByRunId?(target: SquadWatchdogTickTarget): Promise<ReadonlyMap<string, number>>;
};

/**
 * 把服务面装配成扫描端口（**唯一**一处读服务的适配：host 组合根只用它）。
 *
 * `agentService` 缺席 ⇒ 探测一律 `unavailable`（判定面按「不猜」走兜底墙钟，绝不把它当死会话）；
 * `stopSession` 缺席 ⇒ 空闲档不动作（只留痕）——「没有停会话的手段」不是「可以跳过 stop 直接结算」。
 */
export function createSquadWatchdogSweepPorts(params: {
  squadRuntime: ISquadRuntimeService;
  agentService: Pick<IZCodeAgentService, "readSession"> | null;
  stopSession: SquadSessionStopFn | null;
  logger: SquadWatchdogLogger;
}): SquadWatchdogSweepPorts {
  const { squadRuntime, agentService, logger } = params;
  return {
    async readFacts(target) {
      /* 两个读口各自的口径不可互替（见 `listSquadRuns` 的注释）：`listSquadRuns` = 全量台账
         （C1 旁证要终态行），`getSnapshot` = 阈值（名册）与标题（工作项）。 */
      const [rows, snapshot] = await Promise.all([
        squadRuntime.listSquadRuns({ path: target.path, identity: target.identity }),
        squadRuntime.getSnapshot({ path: target.path, identity: target.identity }),
      ]);
      const agentById = new Map(snapshot.teamAgents.map((agent) => [agent.id, agent]));
      const titleById = new Map(snapshot.workItems.map((item) => [item.id, item.title]));
      return {
        rows,
        // 名册里没有该 agent ⇒ 走 resolve helper 的缺省（**没有第二份缺省值**：这里不写 `?? 30`）。
        ttlMinutesFor: (agentId) => resolveTeamAgentRunTtlMinutes(agentById.get(agentId) ?? {}),
        idleTimeoutMinutesFor: (agentId) =>
          resolveTeamAgentIdleTimeoutMinutes(agentById.get(agentId) ?? {}),
        workItemTitleFor: (workItemId) => titleById.get(workItemId) ?? null,
      };
    },
    readGitFacts: (target, branches) =>
      squadRuntime.getSquadWatchdogGitFacts(
        { path: target.path, identity: target.identity },
        { branches },
      ),
    async probeSession({ sessionId, workspacePath, workspaceIdentity }) {
      if (!agentService) return "unavailable";
      try {
        const snapshot = await agentService.readSession({
          workspacePath,
          ...(workspaceIdentity ? { workspaceIdentity } : {}),
          sessionId,
          // existing-only：绝不为了判定拉起一个新 Agent 进程（拉起就等于「让它继续跑」）。
          runtimePolicy: "existing-only",
        });
        return hasBlockingActiveSnapshotRuntime(snapshot) ? "executing" : "not_executing";
      } catch (error) {
        if (
          typeof error === "object" &&
          error !== null &&
          (error as { code?: unknown }).code === ZCODE_AGENT_RUNTIME_UNAVAILABLE_CODE
        ) {
          /* runtime 不在 = 这个 workspace 里**没有东西在执行**（同 `createBoundSessionExecutingProbe`
             的「放行」判据、同启动队长和解所依赖的事实）。这是明确结论，不是「探测不可得」。 */
          return "not_executing";
        }
        logger.warn(
          `[squad] watchdog 会话探测失败 session=${sessionId}（不猜会话状态：本轮该行跳过，下一轮自愈）`,
          error,
        );
        return "unavailable";
      }
    },
    settleRun: (target, input) =>
      squadRuntime.failMemberRun({ path: target.path, identity: target.identity }, input),
    recordInbox: (target, item) =>
      squadRuntime.recordInboxItem({ path: target.path, identity: target.identity }, item),
    stopSession: params.stopSession,
  };
}

export type SquadWatchdogSweepSummary = {
  /** 结算了几条（`failMemberRun` 成功）。 */
  settled: number;
  /** 发起过几次 stop（空闲档）。 */
  stopped: number;
  /** 产了 skip 决策几条（含 C1 领地与探测不可得）。 */
  skipped: number;
  /** 逐条容错接住的失败条数（一条坏行不停整轮）。 */
  failed: number;
};

/**
 * 空闲档 stop 之后等回调的**宽限**：超期仍未收口 ⇒ 直接结算兜底（设计 §3.1「stop 失败或宽限内
 * 无回调 ⇒ 退回直接结算」）。取 5 分钟：stop 是协议命令，正常几秒内就会以
 * `completedInterrupted` 收口；5 分钟足够覆盖一次慢收口，又远小于 TTL（30min）。
 */
export const SQUAD_WATCHDOG_IDLE_STOP_GRACE_MS = 5 * MS_PER_MINUTE;

/**
 * 空闲档宽限兜底的结算原因（**自由文本列**，不是看门狗族的码值）：会话**活着**（探测说在执行），
 * 只是静默超阈值且 stop 发出后宽限内没有终态回调 —— 与「死会话」「TTL 到期」都不同因，
 * 混用码值会让 W3 的熔断窗口计数/重试预算把三种原因算成一种。
 */
export const SQUAD_RUN_SETTLE_REASON_WATCHDOG_IDLE_GRACE = "watchdog_idle_stop_grace_expired";

/** C1 领地 skip 的留痕原因（首见一次；`c1Case` 是本行此刻在哪一格的**判别值**，见 W1 决策类型）。 */
export function squadWatchdogC1SkipReason(c1Case: string): string {
  return `watchdog_c1_owned_${c1Case}`;
}

/** 一轮扫描的输入。 */
export type SquadWatchdogSweepInput = {
  targets: readonly SquadWatchdogTickTarget[];
  ports: SquadWatchdogSweepPorts;
  logger: SquadWatchdogLogger;
  /**
   * 这一轮看哪些行：`member` = 只队员行（启动和解的队员臂：队长行由既有队长臂当场收口）；
   * `all` = 全部（在线 tick：队长行同样要离开 open，宿主活着时没有别的路径收它们）。
   */
  runScope: "member" | "all";
  /** 已发出 stop 的 runId → 发出时刻（**进程内**状态；跨重启无意义，故不落盘）。 */
  pendingStops: Map<string, number>;
  now?: () => number;
  idleStopGraceMs?: number;
};

/** 逐条执行一个决策；返回这一条是否被计数（`settled` / `stopped` / `skipped` / `failed`）。 */
async function executeDecision(params: {
  decision: ReturnType<typeof decideSquadWatchdog>[number];
  row: SquadRunRecord;
  target: SquadWatchdogTickTarget;
  ports: SquadWatchdogSweepPorts;
  facts: SquadWatchdogWorkspaceFacts;
  pendingStops: Map<string, number>;
  now: number;
  idleStopGraceMs: number;
  logger: SquadWatchdogLogger;
}): Promise<keyof Omit<SquadWatchdogSweepSummary, "failed"> | "failed"> {
  const { decision, row, target, ports, facts, pendingStops, now, idleStopGraceMs } = params;
  const inboxFor = (reason: string): InboxItemInput =>
    buildRunStalledInboxItem({
      workspaceKey: resolveWorkspaceKey({
        workspacePath: target.path,
        workspaceIdentity: target.identity,
      }),
      workspacePath: target.path,
      workItemId: row.workItemId,
      workItemTitle: facts.workItemTitleFor(row.workItemId),
      runId: row.runId,
      agentId: row.agentId,
      sessionId: row.sessionId,
      reason,
    });

  switch (decision.kind) {
    case "settle_dead_session":
    case "settle_ttl": {
      await ports.settleRun(target, { runId: decision.runId, reason: decision.reason });
      /* 留痕与结算是**两件事**：结算失败已由调用方接住（下面逐条 try/catch），登记失败只 warn ——
         台账已经收口，Inbox 是留痕，不得让它把一条已结算的行报成失败。 */
      try {
        await ports.recordInbox(target, inboxFor(decision.reason));
      } catch (error) {
        params.logger.warn(`[squad] watchdog 未能登记 Inbox：run=${decision.runId}`, error);
      }
      return "settled";
    }
    case "stop_then_wait_idle": {
      const issuedAt = pendingStops.get(decision.runId);
      if (issuedAt !== undefined) {
        if (now - issuedAt <= idleStopGraceMs) {
          // 宽限内：等终态回调（看门狗在这条路上一个字都不写台账）。
          return "skipped";
        }
        /* 宽限已过仍停在 open ⇒ 退回直接结算（stop 没生效 / 回调没来：两者都不能让这条行永远占槽）。 */
        await ports.settleRun(target, {
          runId: decision.runId,
          reason: SQUAD_RUN_SETTLE_REASON_WATCHDOG_IDLE_GRACE,
        });
        pendingStops.delete(decision.runId);
        try {
          await ports.recordInbox(target, inboxFor(SQUAD_RUN_SETTLE_REASON_WATCHDOG_IDLE_GRACE));
        } catch (error) {
          params.logger.warn(`[squad] watchdog 未能登记 Inbox：run=${decision.runId}`, error);
        }
        return "settled";
      }
      if (!ports.stopSession) {
        // 没有停会话的手段 ⇒ 不动作（**不得**当成「跳过 stop 直接结算」）。
        params.logger.warn(
          `[squad] watchdog 空闲档无法 stop（task service 未注册）：run=${decision.runId} 本轮跳过`,
        );
        return "skipped";
      }
      const stopped = await ports.stopSession({
        target,
        runId: decision.runId,
        sessionId: decision.sessionId,
      });
      /* 成功与否都记「已发起」：失败代表这次 stop 没被接受（会话可能仍在跑），宽限到期再按墙钟兜底
         —— 立即结算会在「刚被拒绝的一瞬」把一条活着的 run 判死。 */
      pendingStops.set(decision.runId, now);
      if (!stopped) {
        params.logger.warn(
          `[squad] watchdog 空闲档 stop 未成功：run=${decision.runId}（宽限 ${idleStopGraceMs}ms 后兜底结算）`,
        );
      }
      return "stopped";
    }
    case "skip_residual_owned_by_open_member_run": {
      /* C1 领地（`sessionId === null` 的队员行）：看门狗**不结算**（结算会让 receipt 的 own-run
         永不再 open ⇒ 请求悬空；那是 C1 的「结算 + 同 runId 重开」独占的处置）。用户裁定（W2 第 134 轮
         「残留裁定 A」）要求这条窄行类**首见留痕**：登记一条 run_stalled（dedup 按 runId ⇒ 同一行只一条），
         人能看到「这条请求卡在 C1 自愈回路上、且此刻在哪一格」。 */
      try {
        await ports.recordInbox(target, inboxFor(squadWatchdogC1SkipReason(decision.c1Case)));
      } catch (error) {
        params.logger.warn(`[squad] watchdog 未能登记 Inbox：run=${decision.runId}`, error);
      }
      return "skipped";
    }
    case "skip_probe_unavailable":
    case "skip_unclassified": {
      /* 探测不可得 / 缺时钟事实：**不猜**（不结算）。只记日志不登记 Inbox —— 这两条是**暂态**结论
         （下次探测成功就可能变成结算），而 Inbox 的 dedupKey 按 runId 收敛 ⇒ 一条暂态留痕会永久占住
         这条 run 的留痕位，把后来真正的结算留痕挤掉。 */
      params.logger.warn(
        `[squad] watchdog 跳过一条 open run（不猜）：run=${decision.runId} kind=${decision.kind}`,
      );
      return "skipped";
    }
  }
}

/**
 * 对给定目标各扫一轮（启动队员臂与在线 tick 的**同一个**实现）。
 *
 * 逐条容错：一条坏行（结算撞跨终态 / 探测抛错 / Inbox 冲突）不得停掉整轮 ——
 * 照启动和解的 per-run try/catch（`host/index.ts` 的既有形态），否则第一条坏行会让**后面所有**的
 * 僵尸 run 都不被收，而日志里只有一条错。
 */
export async function runSquadWatchdogSweep(
  input: SquadWatchdogSweepInput,
): Promise<SquadWatchdogSweepSummary> {
  const now = input.now?.() ?? Date.now();
  const idleStopGraceMs = input.idleStopGraceMs ?? SQUAD_WATCHDOG_IDLE_STOP_GRACE_MS;
  const summary: SquadWatchdogSweepSummary = { settled: 0, stopped: 0, skipped: 0, failed: 0 };

  for (const target of input.targets) {
    try {
      const facts = await input.ports.readFacts(target);
      const candidates = facts.rows.filter(
        (row) => row.status === "open" && (input.runScope === "all" || !row.isLeaderTask),
      );
      if (candidates.length === 0) continue;

      /* 行 → 判定输入：`liveTreeOfOtherRow` 经服务面**唯一读法**（`hasOtherRunRowForPair`）算，
         判据本体不在本层复写；行级旁证用**全量**台账（含终态行）。 */
      const rows: SquadWatchdogRun[] = candidates.map((row) => ({
        runId: row.runId,
        agentId: row.agentId,
        isLeaderTask: row.isLeaderTask,
        status: row.status,
        sessionId: row.sessionId,
        branch: row.branch,
        openedAt: row.openedAt ?? null,
        liveTreeOfOtherRow: hasOtherRunRowForPair(facts.rows, {
          runId: row.runId,
          workItemId: row.workItemId,
          agentId: row.agentId,
        }),
      }));

      /* 强探测：**每个会话一次**（同一个会话可能被多条行引用？不可能 1:1，但缓存便宜且防重复子进程）。
         一条探测返回 `unavailable` ⇒ 本轮整体 `probeAvailable = false`（W1 的输入语义：探针不可得
         时对**会话状态**一律不猜，只按兜底墙钟；宁慢勿误杀，下一轮 60s 后自愈）。 */
      const executingSessionIds = new Set<string>();
      let probeAvailable = true;
      const probed = new Map<string, SquadSessionExecutingState>();
      for (const row of rows) {
        if (row.sessionId === null) continue;
        let state = probed.get(row.sessionId);
        if (state === undefined) {
          state = await input.ports.probeSession({
            sessionId: row.sessionId,
            workspacePath: target.path,
            ...(target.identity ? { workspaceIdentity: target.identity } : {}),
          });
          probed.set(row.sessionId, state);
        }
        if (state === "executing") executingSessionIds.add(row.sessionId);
        if (state === "unavailable") probeAvailable = false;
      }

      /* git 事实只问**C1 领地行**的分支（其余判定不读它）：`branchRefExists` 每次是一个 git 子进程，
         把全部行都问一遍会让每轮 tick 起 N 个子进程。 */
      const c1Branches = rows
        .filter(
          (row) =>
            !row.isLeaderTask &&
            row.sessionId === null &&
            row.status === "open" &&
            row.branch !== null,
        )
        .map((row) => row.branch)
        .filter((branch): branch is string => branch !== null);
      const gitFacts = await input.ports.readGitFacts(target, c1Branches);
      const factsForDecision = {
        liveTreeBranches: new Set(gitFacts.liveTreeBranches),
        branchRefExists: (branch: string) => gitFacts.existingBranchRefs.includes(branch),
      };

      /* 静默信号：端口缺席 / 读失败 ⇒ 空表 = 无信号 ⇒ 空闲档不动作（**不猜**空闲）。 */
      let idleMsByRunId = new Map<string, number>();
      if (input.ports.readIdleMsByRunId) {
        try {
          idleMsByRunId = new Map(await input.ports.readIdleMsByRunId(target));
        } catch (error) {
          input.logger.warn(
            `[squad] watchdog 静默信号读取失败 workspace=${target.path}（空闲档本轮不动作）`,
            error,
          );
        }
      }

      const decisions = decideSquadWatchdog({
        rows,
        executingSessionIds,
        probeAvailable,
        now,
        facts: factsForDecision,
        idleMsByRunId,
        thresholds: {
          ttlMinutesFor: facts.ttlMinutesFor,
          idleTimeoutMinutesFor: facts.idleTimeoutMinutesFor,
          fallbackWallClockHours: DEFAULT_SQUAD_FALLBACK_WALL_CLOCK_HOURS,
        },
      });

      const rowByRunId = new Map(candidates.map((row) => [row.runId, row]));
      for (const decision of decisions) {
        const row = rowByRunId.get(decision.runId);
        if (!row) continue; // 判定只可能来自本轮的候选行（防御性：取不到就跳过，不编造事实）
        try {
          const bucket = await executeDecision({
            decision,
            row,
            target,
            ports: input.ports,
            facts,
            pendingStops: input.pendingStops,
            now,
            idleStopGraceMs,
            logger: input.logger,
          });
          summary[bucket] += 1;
        } catch (error) {
          summary.failed += 1;
          input.logger.warn(
            `[squad] watchdog 处理一条 run 失败（其余行照常）：run=${decision.runId} kind=${decision.kind}`,
            error,
          );
        }
      }

      /* 已离开 open 的行不再需要宽限兜底（自然收口的 run 由终态出口处置）：清理内存表，防无界增长。 */
      const openRunIds = new Set(candidates.map((row) => row.runId));
      for (const runId of input.pendingStops.keys()) {
        if (!openRunIds.has(runId)) input.pendingStops.delete(runId);
      }
    } catch (error) {
      summary.failed += 1;
      input.logger.warn(`[squad] watchdog 扫描失败 workspace=${target.path}`, error);
    }
  }
  return summary;
}

/* ------------------------------------------------------------------------------------------------
   在线 tick：repeating timer + 候选 workspace 累积 + 重入护栏。
   ------------------------------------------------------------------------------------------------ */

/** timer 的注入形态（照 `hostMemoryDiagnosticsLog` 的可注入 timer：测试不用真等 60s）。 */
type SquadWatchdogTimerHandle = { unref?(): void };

export type SquadWatchdogTickHandle = {
  /** 立刻跑一轮（测试与手动触发）；重入时返回 null（见 `startSquadWatchdogTick` 的护栏）。 */
  sweepNow(): Promise<SquadWatchdogSweepSummary | null>;
  /** 运行期累积候选 workspace（派发事件出现过的 target）。 */
  track(target: SquadWatchdogTickTarget): void;
  /** 当前候选集合（启动 warm 名单 + 运行期累积；去重按 `resolveWorkspaceKey` 口径）。 */
  candidates(): SquadWatchdogTickTarget[];
  /** 停止 timer（**必须**与启动配对：否则 host 退出前一直有个 60s 定时器在跑）。 */
  stop(): void;
};

/** 在线 tick 的默认周期（与 host 内存诊断同一节奏：60s，够快又不会成为日志/子进程负担）。 */
export const SQUAD_WATCHDOG_TICK_INTERVAL_MS = 60_000;

/**
 * 启动**在线看门狗 tick**（设计 §6.2）。
 *
 * 三条纪律：
 * · **候选运行时累积**：启动 warm 名单是起点，派发事件出现过的 workspace 经 `track` 加进来 ——
 *   只按启动名单扫，会让「启动后新派发过的其他 workspace」整块漏看（那些正是最可能有僵尸 run 的地方）。
 * · **重入护栏**：一轮没跑完时下一拍直接跳过（照 `scheduler/index.ts` 的 `ticking` 形态）。
 *   没有它，一轮扫描（含 git 子进程）变慢时会**叠加**并发轮：同一行被两轮同时判定、两条 stop、
 *   两条结算（结算幂等在服务面，但重复的探测/子进程与日志风暴是实打实的）。
 * · **懒取端口**：`resolvePorts` 每轮现取（服务面在 host 生命周期内可达/可缺件；闭包捕获旧服务会让
 *   「服务重建了而 tick 还在打旧库」）。
 */
export function startSquadWatchdogTick(params: {
  /** 启动 warm 名单（`agentWarmupTargets` 投影）。 */
  targets: readonly SquadWatchdogTickTarget[];
  resolvePorts: () => SquadWatchdogSweepPorts | null;
  logger: SquadWatchdogLogger;
  intervalMs?: number;
  now?: () => number;
  idleStopGraceMs?: number;
  timer?: {
    setInterval(callback: () => void, intervalMs: number): SquadWatchdogTimerHandle;
    clearInterval(handle: SquadWatchdogTimerHandle): void;
  };
}): SquadWatchdogTickHandle {
  const timer = params.timer ?? {
    setInterval: (callback: () => void, intervalMs: number) => setInterval(callback, intervalMs),
    clearInterval: (handle: SquadWatchdogTimerHandle) =>
      clearInterval(handle as ReturnType<typeof setInterval>),
  };
  /** 候选 workspace 表：key = `resolveWorkspaceKey` 口径（与服务面/台账同一处口径，不另拼一份）。 */
  const candidatesByKey = new Map<string, SquadWatchdogTickTarget>();
  const track = (target: SquadWatchdogTickTarget): void => {
    candidatesByKey.set(
      resolveWorkspaceKey({ workspacePath: target.path, workspaceIdentity: target.identity }),
      target,
    );
  };
  for (const target of params.targets) track(target);

  /** 已发出 stop 的 runId → 时刻（**进程内**：跨重启无意义，重启后会话皆死，走探测档）。 */
  const pendingStops = new Map<string, number>();
  let ticking = false;
  let stopped = false;

  const sweepNow = async (): Promise<SquadWatchdogSweepSummary | null> => {
    if (stopped) return null;
    if (ticking) {
      // 重入：本轮跳过（不排队 —— 排队会让「慢」变成「越积越多」）。
      params.logger.info("[squad] watchdog tick 重入被跳过（上一轮尚未结束）");
      return null;
    }
    ticking = true;
    try {
      const ports = params.resolvePorts();
      if (!ports) {
        // 服务面还没装配好 / 已释放：本轮不扫（**不静默**：这是「看门狗此刻不工作」的事实）。
        params.logger.warn("[squad] watchdog tick 跳过：squad runtime service 不可达");
        return null;
      }
      return await runSquadWatchdogSweep({
        targets: [...candidatesByKey.values()],
        ports,
        logger: params.logger,
        runScope: "all",
        pendingStops,
        ...(params.now ? { now: params.now } : {}),
        ...(params.idleStopGraceMs !== undefined
          ? { idleStopGraceMs: params.idleStopGraceMs }
          : {}),
      });
    } finally {
      ticking = false;
    }
  };

  const handle = timer.setInterval(
    () => void sweepNow(),
    params.intervalMs ?? SQUAD_WATCHDOG_TICK_INTERVAL_MS,
  );
  try {
    // 与内存诊断同款：unref 让这个定时器**不**单独把 host 进程吊住。
    handle.unref?.();
  } catch {
    // unref 不可用时仍保留 handle 供 stop 回收。
  }

  return {
    sweepNow,
    track,
    candidates: () => [...candidatesByKey.values()],
    stop() {
      if (stopped) return;
      stopped = true;
      timer.clearInterval(handle);
      pendingStops.clear();
    },
  };
}
