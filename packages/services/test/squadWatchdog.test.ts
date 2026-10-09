/* W1（看门狗六件套）：判定面（`squadWatchdog.ts` 纯函数）+ 数据面（0014 / 五类写点）+ 结算审计
   （settle_reason）+ Inbox `run_stalled` + `cancelSquadRun` 的 L1 半边。

   期望值取契约面（决策判别联合的 kind / 台账列 / 活跃口径 / 结算 hub 形状），不读实现中间量：
   判定面全部是**注入事实**的纯函数（照 `selectStaleLeaderRuns` / `decideWake` 的既有形态），
   数据面用真库（`:memory:` + 真迁移）+ 真 runtime（照 `c1ResidualMemberRun.test.ts` 的缝合夹具）。

   与 C1 的划界（本卡的硬约束）：`sessionId === null` 的队员行 = C1 领地 —— 看门狗只产 skip 决策
   与留痕，**不结算**；判据本体（`isTreelessOpenMemberRun` / `isSettleableResidualMemberRun`）
   一字不改、由 `squadWatchdog.ts` 引用（守卫：该文件不得自写三条件）。 */
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  DEFAULT_SQUAD_FALLBACK_WALL_CLOCK_HOURS,
  DEFAULT_SQUAD_IDLE_TIMEOUT_MINUTES,
  DEFAULT_SQUAD_RUN_TTL_MINUTES,
  MS_PER_HOUR,
  MS_PER_MINUTE,
  resolveTeamAgentIdleTimeoutMinutes,
  resolveTeamAgentRunTtlMinutes,
  resolveTeamAgentToolTimeoutMinutes,
} from "@zcode/shared";
import { planBranches } from "../src/worktree/branchNaming.js";
import { runTasksDatabaseMigrations } from "../src/session/tasksDatabase/migrations.js";
import {
  createInboxItemRepo,
  INBOX_ITEM_KINDS,
  INBOX_SEVERITY_BY_KIND,
} from "../src/workitem/inboxItemRepo.js";
import { buildRunStalledInboxItem } from "../src/workitem/inboxItemProducers.js";
import { createSquadRunSettlementHub } from "../src/workitem/squadRunSettlementHub.js";
import {
  SQUAD_RUN_SETTLE_REASON_WATCHDOG_DEAD_SESSION,
  SQUAD_RUN_SETTLE_REASON_WATCHDOG_TTL,
  SQUAD_RUN_SETTLE_REASON_USER_CANCEL,
} from "../src/workitem/squadRunRepo.js";
import { createSquadRuntime } from "../src/workitem/squadRuntime.js";
import {
  createSquadRuntimeService,
  type SquadWorkspaceTarget,
} from "../src/workitem/squadRuntimeService.js";
import { slugForId } from "../src/workitem/slug.js";
import { makeRepo } from "./helpers/gitFixture.js";
import {
  decideSquadToolWatchdog,
  decideSquadWatchdog,
  type SquadWatchdogInput,
  type SquadWatchdogRun,
} from "../src/workitem/squadWatchdog.js";

const NOW = 1_000_000_000_000;
const WS = "wd-ws";

/** 缝合夹具：真 git 仓库 + 真库（跑过 0014）+ 真 runtime + 结算 hub（照 c1ResidualMemberRun.test.ts）。 */
async function setupSquad() {
  const repoRoot = await makeRepo();
  const db = new DatabaseSync(":memory:");
  runTasksDatabaseMigrations(db);
  const settlements = createSquadRunSettlementHub();
  const settled: Array<{ runId: string; status: string }> = [];
  settlements.subscribe((event) => settled.push({ runId: event.runId, status: event.status }));
  const runtime = await createSquadRuntime({
    db,
    workspacePath: repoRoot,
    workspaceIdentity: WS,
    readExperimentEnabled: () => true,
    runSettlementHub: settlements,
  });
  const openMemberRun = (runId: string, agentId: string, workItemId = "wi-1") =>
    runtime.lifecycle.openMemberRun({
      runId,
      workItemId,
      parentWorkItemId: workItemId,
      agentId,
      isLeaderTask: false,
    });
  const git = (args: string[]) => runtime.git(args, { cwd: repoRoot });
  return { repoRoot, db, runtime, settled, openMemberRun, git };
}

/** 建一个有名册定义的智能体（名册缺席 ⇒ 直开路径；有名册 ⇒ 语句一/闸路径）。 */
function createAgent(
  runtime: Awaited<ReturnType<typeof setupSquad>>["runtime"],
  maxConcurrentRuns: number,
) {
  return runtime.teamAgentService.create({
    name: `agent-${maxConcurrentRuns}`,
    systemPrompt: "s",
    memoryScope: "project",
    maxConcurrentRuns,
  });
}

/** 不变式：任何时刻都**不存在**「open 行而没有 opened_at」——写点漏一处的唯一可见证据。 */
function openRunsWithoutOpenedAt(runtime: Awaited<ReturnType<typeof setupSquad>>["runtime"]) {
  return runtime.squadRunRepo
    .listByWorkspace(WS)
    .filter((record) => record.status === "open" && (record.openedAt ?? null) === null)
    .map((record) => record.runId);
}

/** 一行开放 run 的**最小完整形状**：用例只覆写自己关心的那一档。 */
function run(over: Partial<SquadWatchdogRun> = {}): SquadWatchdogRun {
  return {
    runId: "run-1",
    agentId: "ta-a",
    isLeaderTask: false,
    status: "open",
    sessionId: "sess-1",
    branch: "squad/member/aaaaaaaaaaaaaaaa/bbbbbbbbbbbbbbbb",
    openedAt: NOW,
    liveTreeOfOtherRow: false,
    ...over,
  };
}

/** 判定输入：缺省「探测可用、无静默信号、无活树、无分支 ref」，阈值取 shared 缺省语义。 */
function input(over: Partial<SquadWatchdogInput> = {}): SquadWatchdogInput {
  return {
    rows: [],
    executingSessionIds: new Set<string>(),
    probeAvailable: true,
    now: NOW,
    facts: { liveTreeBranches: new Set<string>(), branchRefExists: () => false },
    idleMsByRunId: new Map<string, number>(),
    thresholds: {
      ttlMinutesFor: () => 30,
      idleTimeoutMinutesFor: () => 10,
      fallbackWallClockHours: 24,
    },
    ...over,
  };
}

test("档 1（C1 领地）：无会话的队员行只产 skip 决策 —— 看门狗不结算 C1 的行", () => {
  const decisions = decideSquadWatchdog(
    input({
      rows: [
        // 残行（有行无树）：C1 的重投臂会「结算 + 同 runId 重开」，看门狗不许抢先结算。
        run({ runId: "r-residual", sessionId: null }),
      ],
    }),
  );
  assert.deepEqual(decisions, [
    {
      kind: "skip_residual_owned_by_open_member_run",
      runId: "r-residual",
      agentId: "ta-a",
      branch: "squad/member/aaaaaaaaaaaaaaaa/bbbbbbbbbbbbbbbb",
      c1Case: "settleable_residual",
    },
  ]);
});

test("档 2（探测）：仅「明确不在执行」才结算；探测不可得 ⇒ skip（不猜会话状态）", () => {
  // 探测可得 + 会话不在执行集合里 ⇒ 会话已死（重启后必真；在线时这是**明确结论**）。
  assert.deepEqual(
    decideSquadWatchdog(input({ rows: [run({ runId: "r-dead", sessionId: "s-dead" })] })),
    [
      {
        kind: "settle_dead_session",
        runId: "r-dead",
        agentId: "ta-a",
        sessionId: "s-dead",
        reason: SQUAD_RUN_SETTLE_REASON_WATCHDOG_DEAD_SESSION,
      },
    ],
  );

  // 探测**不可得** ⇒ 同一个"不在执行集合里"的会话不构成结论：跳过并留痕，不结算。
  assert.deepEqual(
    decideSquadWatchdog(
      input({
        rows: [run({ runId: "r-no-probe", sessionId: "s-x" })],
        probeAvailable: false,
      }),
    ),
    [{ kind: "skip_probe_unavailable", runId: "r-no-probe", agentId: "ta-a", sessionId: "s-x" }],
  );
});

test("档 2 退化（探测不可得 + 兜底墙钟已过）：按超长墙钟结算，reason 走 watchdog_ttl 一族", () => {
  assert.deepEqual(
    decideSquadWatchdog(
      input({
        rows: [run({ runId: "r-old", sessionId: "s-x", openedAt: NOW - 24 * MS_PER_HOUR - 1 })],
        probeAvailable: false,
      }),
    ),
    [
      {
        kind: "settle_ttl",
        runId: "r-old",
        agentId: "ta-a",
        openedAt: NOW - 24 * MS_PER_HOUR - 1,
        thresholdMs: 24 * MS_PER_HOUR,
        reason: SQUAD_RUN_SETTLE_REASON_WATCHDOG_TTL,
      },
    ],
  );
});

test("档 3（空闲）：会话活着但静默超阈值 ⇒ stop_then_wait_idle（不结算）；无信号 ⇒ 不动作", () => {
  // 静默 10 分钟 + 1 毫秒 ⇒ 先 stop（看门狗在这条路上一个字都不写台账）。
  assert.deepEqual(
    decideSquadWatchdog(
      input({
        rows: [run({ runId: "r-idle", sessionId: "s-idle" })],
        executingSessionIds: new Set(["s-idle"]),
        idleMsByRunId: new Map([["r-idle", 10 * MS_PER_MINUTE + 1]]),
      }),
    ),
    [
      {
        kind: "stop_then_wait_idle",
        runId: "r-idle",
        agentId: "ta-a",
        sessionId: "s-idle",
        idleMs: 10 * MS_PER_MINUTE + 1,
      },
    ],
  );

  // 静默 10 分钟 − 1 毫秒 ⇒ 未超阈值：健康行不产决策。
  assert.deepEqual(
    decideSquadWatchdog(
      input({
        rows: [run({ runId: "r-busy", sessionId: "s-busy" })],
        executingSessionIds: new Set(["s-busy"]),
        idleMsByRunId: new Map([["r-busy", 10 * MS_PER_MINUTE - 1]]),
      }),
    ),
    [],
  );

  // 无静默信号（活动流不可得）⇒ 空闲档不动作，**不猜**空闲。
  assert.deepEqual(
    decideSquadWatchdog(
      input({
        rows: [run({ runId: "r-nosig", sessionId: "s-nosig" })],
        executingSessionIds: new Set(["s-nosig"]),
      }),
    ),
    [],
  );
});

test("档 4（TTL）：`opened_at` 起算的硬墙钟，两侧边界结论相反；队长行同样被收", () => {
  // 30 分钟 + 1 毫秒 ⇒ 到期。
  assert.deepEqual(
    decideSquadWatchdog(
      input({
        rows: [
          run({ runId: "r-expired", sessionId: "s-live", openedAt: NOW - 30 * MS_PER_MINUTE - 1 }),
        ],
        executingSessionIds: new Set(["s-live"]),
      }),
    ),
    [
      {
        kind: "settle_ttl",
        runId: "r-expired",
        agentId: "ta-a",
        openedAt: NOW - 30 * MS_PER_MINUTE - 1,
        thresholdMs: 30 * MS_PER_MINUTE,
        reason: SQUAD_RUN_SETTLE_REASON_WATCHDOG_TTL,
      },
    ],
  );

  // 30 分钟 − 1 毫秒 ⇒ 未到期：不产决策。
  assert.deepEqual(
    decideSquadWatchdog(
      input({
        rows: [
          run({ runId: "r-fresh", sessionId: "s-live", openedAt: NOW - 30 * MS_PER_MINUTE + 1 }),
        ],
        executingSessionIds: new Set(["s-live"]),
      }),
    ),
    [],
  );

  // 队长行（无会话）只能按墙钟收：这正是 TTL 对**队长行**的覆盖面（不依赖探测）。
  assert.deepEqual(
    decideSquadWatchdog(
      input({
        rows: [
          run({
            runId: "r-leader",
            isLeaderTask: true,
            sessionId: null,
            branch: null,
            openedAt: NOW - 30 * MS_PER_MINUTE - 1,
          }),
        ],
      }),
    ),
    [
      {
        kind: "settle_ttl",
        runId: "r-leader",
        agentId: "ta-a",
        openedAt: NOW - 30 * MS_PER_MINUTE - 1,
        thresholdMs: 30 * MS_PER_MINUTE,
        reason: SQUAD_RUN_SETTLE_REASON_WATCHDOG_TTL,
      },
    ],
  );
});

test("C1 领地四格分类：等待分支空出 / 可立即自愈 / 残行被占 / 在途未绑会话（判据经 C1 导出件）", () => {
  const classify = (row: SquadWatchdogRun, over: Partial<SquadWatchdogInput> = {}) =>
    decideSquadWatchdog(input({ rows: [row], ...over }))[0];

  // ① 等待分支空出（结算过、占位已释放）：C1 的 waiting 臂。
  assert.equal(
    classify(run({ runId: "r-await", sessionId: null, branch: null }))?.kind ===
      "skip_residual_owned_by_open_member_run" &&
      classify(run({ runId: "r-await", sessionId: null, branch: null })).c1Case,
    "awaiting_branch",
  );

  // ② 残行且分支无任何占用 ⇒ C1 可立即自愈（同一条重投会结算 + 重开）。
  assert.equal(classify(run({ runId: "r-heal", sessionId: null })).c1Case, "settleable_residual");

  // ③ 残行但同名残枝还在 ⇒ C1 等待型。
  assert.equal(
    classify(run({ runId: "r-branch", sessionId: null }), {
      facts: { liveTreeBranches: new Set(), branchRefExists: () => true },
    }).c1Case,
    "residual_blocked",
  );

  // ④ 分支上挂着**别人的**活树（旁证：同对还有别的 run 行）⇒ 仍是残行（C1 等待型）。
  assert.equal(
    classify(run({ runId: "r-other", sessionId: null, liveTreeOfOtherRow: true }), {
      facts: {
        liveTreeBranches: new Set(["squad/member/aaaaaaaaaaaaaaaa/bbbbbbbbbbbbbbbb"]),
        branchRefExists: () => false,
      },
    }).c1Case,
    "residual_blocked",
  );

  // ⑤ 树可能属本行（无旁证）、只差绑会话 ⇒ 在途派发，C1 的 already_registered 幂等臂领地。
  assert.equal(
    classify(run({ runId: "r-inflight", sessionId: null }), {
      facts: {
        liveTreeBranches: new Set(["squad/member/aaaaaaaaaaaaaaaa/bbbbbbbbbbbbbbbb"]),
        branchRefExists: () => false,
      },
    }).c1Case,
    "unbound_in_flight",
  );
});

test("阈值按 agent 解析：TTL 与空闲阈值都按行上的 agent 取（per-agent 覆盖的唯一入口）", () => {
  // 两条同形行，只差 agentId：A 是 30 分钟缺省、B 覆盖为 5 分钟 ⇒ B 到期而 A 不到期。
  const rows = [
    run({ runId: "r-a", agentId: "ta-a", sessionId: "s-a", openedAt: NOW - 10 * MS_PER_MINUTE }),
    run({ runId: "r-b", agentId: "ta-b", sessionId: "s-b", openedAt: NOW - 10 * MS_PER_MINUTE }),
  ];
  assert.deepEqual(
    decideSquadWatchdog(
      input({
        rows,
        executingSessionIds: new Set(["s-a", "s-b"]),
        thresholds: {
          ttlMinutesFor: (agentId) => (agentId === "ta-b" ? 5 : 30),
          idleTimeoutMinutesFor: () => 10,
          fallbackWallClockHours: 24,
        },
      }),
    ),
    [
      {
        kind: "settle_ttl",
        runId: "r-b",
        agentId: "ta-b",
        openedAt: NOW - 10 * MS_PER_MINUTE,
        thresholdMs: 5 * MS_PER_MINUTE,
        reason: SQUAD_RUN_SETTLE_REASON_WATCHDOG_TTL,
      },
    ],
  );
});

test("双条件同时命中取更具体的一档：死会话 > TTL；空闲 > TTL；非 open 行与健康行不产决策", () => {
  // 死会话 + TTL 都已成立 ⇒ 结算归 dead_session（更具体的原因；TTL 是末位兜底）。
  assert.deepEqual(
    decideSquadWatchdog(
      input({
        rows: [run({ runId: "r-both", sessionId: "s-gone", openedAt: NOW - 40 * MS_PER_MINUTE })],
      }),
    ),
    [
      {
        kind: "settle_dead_session",
        runId: "r-both",
        agentId: "ta-a",
        sessionId: "s-gone",
        reason: SQUAD_RUN_SETTLE_REASON_WATCHDOG_DEAD_SESSION,
      },
    ],
  );

  // 空闲 + TTL 都已成立 ⇒ 先 stop（更温和且不写台账），不直接结算。
  assert.deepEqual(
    decideSquadWatchdog(
      input({
        rows: [
          run({ runId: "r-idle-old", sessionId: "s-idle", openedAt: NOW - 40 * MS_PER_MINUTE }),
        ],
        executingSessionIds: new Set(["s-idle"]),
        idleMsByRunId: new Map([["r-idle-old", 11 * MS_PER_MINUTE]]),
      }),
    ),
    [
      {
        kind: "stop_then_wait_idle",
        runId: "r-idle-old",
        agentId: "ta-a",
        sessionId: "s-idle",
        idleMs: 11 * MS_PER_MINUTE,
      },
    ],
  );

  // 非 open 行（produced / rejected / queued / 终态）不是看门狗的候选：输入里出现也零决策。
  assert.deepEqual(
    decideSquadWatchdog(
      input({
        rows: [
          run({ runId: "r-produced", status: "produced", openedAt: NOW - 99 * MS_PER_HOUR }),
          run({ runId: "r-rejected", status: "rejected", openedAt: NOW - 99 * MS_PER_HOUR }),
          run({ runId: "r-discarded", status: "discarded", openedAt: NOW - 99 * MS_PER_HOUR }),
          run({ runId: "r-queued", status: "queued", openedAt: null, branch: null }),
        ],
      }),
    ),
    [],
  );

  // 缺 `opened_at` 的 open 行不按编造的起算点结算（探测不可得时兜底墙钟也算不出来 ⇒ 可见地 skip）。
  assert.deepEqual(
    decideSquadWatchdog(
      input({
        rows: [run({ runId: "r-noclock", sessionId: "s-x", openedAt: null })],
        probeAvailable: false,
      }),
    ),
    [
      {
        kind: "skip_unclassified",
        runId: "r-noclock",
        agentId: "ta-a",
        note: "probe_unavailable_and_no_opened_at",
      },
    ],
  );
});

// ---------------------------------------------------------------------------------------------------
// 数据面（0014）：五类 open 写点全部带 `opened_at` + queued 行恒 NULL + C1 重开臂补刷
// ---------------------------------------------------------------------------------------------------

test("写点 1（直开 · insert）：名册缺席 ⇒ 直开行带 opened_at = 登记时刻", async () => {
  const f = await setupSquad();
  const outcome = await f.openMemberRun("direct-1", "ta-no-roster");
  assert.equal(outcome.kind, "opened");
  const row = f.runtime.squadRunRepo.get("direct-1")!;
  assert.equal(row.openedAt, row.createdAt, "直开行的起算点 = 登记时刻（同一个 now）");
  assert.equal(row.settleReason, null, "新行没有结算原因");
  assert.deepEqual(openRunsWithoutOpenedAt(f.runtime), []);
});

test("写点 2+5（语句一直开 / 认领升级）：queued 行 NULL；认领行的起算点是**认领时刻**", async () => {
  const f = await setupSquad();
  const agent = createAgent(f.runtime, 1);

  // 语句一：容量未满 ⇒ 直接开跑（有名册定义才会走这条语句）。
  assert.equal((await f.openMemberRun("g-a", agent.id)).kind, "opened");
  const opened = f.runtime.squadRunRepo.get("g-a")!;
  assert.equal(opened.openedAt, opened.createdAt, "语句一的起算点 = 登记时刻");

  // 语句二：容量满 ⇒ 排队行（无树无会话，起算点**不存在** ⇒ NULL，不得拿 created_at 冒充）。
  // 换一个工作项：同 (workItem,agent) 已有活跃行时走的是 R2 deferred 义务面，不是排队面。
  const queuedOutcome = await f.openMemberRun("g-b", agent.id, "wi-2");
  assert.deepEqual(queuedOutcome, { kind: "queued", runId: "g-b" });
  assert.equal(f.runtime.squadRunRepo.get("g-b")!.openedAt, null, "queued 行恒 NULL");
  assert.deepEqual(openRunsWithoutOpenedAt(f.runtime), [], "排队行不是 open 行（不参与不变式）");

  // 认领升级：先腾出容量，再按同一 runId 重投（推进臂的入口）⇒ 原子 queued→open 并写起算点。
  await f.runtime.lifecycle.failMemberRun({ runId: "g-a", reason: "fixture" });
  assert.equal((await f.openMemberRun("g-b", agent.id, "wi-2")).kind, "opened");
  const promoted = f.runtime.squadRunRepo.get("g-b")!;
  assert.notEqual(promoted.openedAt, null, "认领行必须有起算点（漏写 = 永不被 TTL 收）");
  assert.ok(promoted.openedAt! >= promoted.createdAt, "起算点不早于登记时刻");
  assert.deepEqual(openRunsWithoutOpenedAt(f.runtime), []);

  /* 钉住「起算点 = 认领时刻」而不是 created_at（M3）：直接把排队行造成**很久以前**登记的，
     再走一次真认领 —— 若实现拿 created_at 当起算点，下面的判定就会命中 TTL。 */
  const stale = await setupSquad();
  const staleAgent = createAgent(stale.runtime, 1);
  stale.runtime.squadRunRepo.insert({
    runId: "q-stale",
    workspaceKey: WS,
    workspacePath: stale.repoRoot,
    workItemId: "wi-1",
    parentWorkItemId: "wi-1",
    agentId: staleAgent.id,
    isLeaderTask: false,
    branch: null,
    dirName: null,
    status: "queued",
    sessionId: null,
    dispatchCause: null,
    causedByRunId: null,
    createdAt: 1,
    updatedAt: 1,
    openedAt: null,
    settleReason: null,
  });
  assert.equal((await stale.openMemberRun("q-stale", staleAgent.id)).kind, "opened");
  const claimed = stale.runtime.squadRunRepo.get("q-stale")!;
  assert.equal(claimed.createdAt, 1, "排队行是很久以前登记的（前置）");
  assert.ok(claimed.openedAt! > 1, "认领写入的是**认领时刻**，不是 created_at");
  await stale.runtime.lifecycle.bindMemberRunSession({ runId: "q-stale", sessionId: "s-q" });
  const decisions = decideSquadWatchdog(
    input({
      rows: [
        run({
          runId: "q-stale",
          agentId: staleAgent.id,
          sessionId: "s-q",
          openedAt: claimed.openedAt ?? null,
        }),
      ],
      now: (claimed.openedAt ?? 0) + MS_PER_MINUTE,
      executingSessionIds: new Set(["s-q"]),
    }),
  );
  assert.deepEqual(
    decisions,
    [],
    "认领后 1 分钟：TTL 从认领时刻起算 ⇒ 不命中（拿 created_at 会立刻误杀）",
  );
});

test("写点 3+4（队长登记）：直登与带闸登记都带 opened_at；容量满的队长排队行 NULL", async () => {
  const f = await setupSquad();

  // 写点 3：名册缺席 ⇒ `insertLeaderRunIfNotInProgress`。
  assert.deepEqual(
    await f.runtime.lifecycle.recordLeaderRun({
      runId: "l-direct",
      workItemId: "wi-l1",
      agentId: "ta-no-roster",
    }),
    { recorded: true },
  );
  const direct = f.runtime.squadRunRepo.get("l-direct")!;
  assert.equal(direct.openedAt, direct.createdAt, "队长直登行的起算点 = 登记时刻");

  // 写点 4：有名册 ⇒ `insertLeaderRunOrQueue` 的 recorded 支。
  const agent = createAgent(f.runtime, 2);
  assert.deepEqual(
    await f.runtime.lifecycle.recordLeaderRun({
      runId: "l-gated",
      workItemId: "wi-l2",
      agentId: agent.id,
    }),
    { recorded: true },
  );
  const gated = f.runtime.squadRunRepo.get("l-gated")!;
  assert.equal(gated.openedAt, gated.createdAt, "队长带闸登记行的起算点 = 登记时刻");

  // 容量满（该 agent 已有一条 open 行）⇒ 队长排队行：无树无会话、起算点 NULL。
  assert.equal((await f.openMemberRun("m-full", agent.id, "wi-m")).kind, "opened");
  assert.deepEqual(
    await f.runtime.lifecycle.recordLeaderRun({
      runId: "l-queued",
      workItemId: "wi-l3",
      agentId: agent.id,
    }),
    { recorded: false, reason: "capacity_full_queued" },
  );
  assert.equal(f.runtime.squadRunRepo.get("l-queued")!.openedAt, null, "队长排队行同样恒 NULL");
  assert.deepEqual(openRunsWithoutOpenedAt(f.runtime), [], "两条队长行 + 一条队员行都有起算点");

  // 队长排队行的认领（同一 claim 写点）：腾容量后按同一 runId 认领 ⇒ open + 起算点。
  await f.runtime.lifecycle.failMemberRun({ runId: "m-full", reason: "fixture" });
  assert.equal(f.runtime.squadRunRepo.claimQueuedRunForPromotion("l-queued", 2), true);
  const claimedLeader = f.runtime.squadRunRepo.get("l-queued")!;
  assert.equal(claimedLeader.status, "open");
  assert.notEqual(claimedLeader.openedAt, null, "认领的队长行必须有起算点");
  assert.equal(claimedLeader.isLeaderTask, true);
  assert.deepEqual(openRunsWithoutOpenedAt(f.runtime), []);
});

test("写点 6（C1 重开臂）：结算 + 同 runId 重开后 opened_at 被**补刷**成重开时刻", async () => {
  const f = await setupSquad();
  const agent = "ta-reopen";

  // 造一条「很久以前进入 open」的残行（有行无树、分支无占用）：登记时刻 = 1。
  f.runtime.squadRunRepo.insert({
    runId: "c1-old",
    workspaceKey: WS,
    workspacePath: f.repoRoot,
    workItemId: "wi-1",
    parentWorkItemId: "wi-1",
    agentId: agent,
    isLeaderTask: false,
    branch: planBranches({ workItemSlug: slugForId("wi-1"), agentSlug: slugForId(agent) }).member,
    dirName: null,
    status: "open",
    sessionId: null,
    dispatchCause: null,
    causedByRunId: null,
    createdAt: 1,
    updatedAt: 1,
    openedAt: 1,
    settleReason: null,
  });

  const outcome = await f.openMemberRun("c1-old", agent);
  assert.equal(outcome.kind, "opened", "残行 + 分支空闲 ⇒ C1 结算 + 同 runId 重开");
  const reopened = f.runtime.squadRunRepo.get("c1-old")!;
  assert.equal(reopened.createdAt, 1, "身份列不动：仍是同一行、同一 runId");
  assert.ok(
    (reopened.openedAt ?? 0) > 1,
    "重开臂必须**补刷**起算点（不补：下一次 tick 会拿旧起算点立刻 TTL 误杀刚重开的 run）",
  );
  assert.equal(reopened.settleReason, null, "C1 的常规结算不带 watchdog reason（列保持 NULL）");
  assert.deepEqual(openRunsWithoutOpenedAt(f.runtime), []);
  assert.deepEqual(
    f.settled.map((event) => [event.runId, event.status]),
    [["c1-old", "discarded"]],
    "重开前的那次结算是真结算（容量与活跃集如实释放一次）",
  );
});

// ---------------------------------------------------------------------------------------------------
// 结算审计（settle_reason）：看门狗族 / 用户取消落码值；C1 的常规结算保持 NULL
// ---------------------------------------------------------------------------------------------------

test("结算审计：failMemberRun 的原因落 settle_reason；C1 清扫臂的常规结算保持 NULL", async () => {
  const f = await setupSquad();
  await f.openMemberRun("audit-1", "ta-audit");
  await f.runtime.lifecycle.failMemberRun({
    runId: "audit-1",
    reason: SQUAD_RUN_SETTLE_REASON_WATCHDOG_TTL,
  });
  const settledRow = f.runtime.squadRunRepo.get("audit-1")!;
  assert.equal(settledRow.status, "discarded");
  assert.equal(
    settledRow.settleReason,
    SQUAD_RUN_SETTLE_REASON_WATCHDOG_TTL,
    "失败原因必须落盘（W3 的熔断计数 / 重试预算都读这一列；丢弃 = 派生判据永远不成立）",
  );

  /* C1 清扫臂（`settlePairResidualRuns`）：结算**别人的**残行是常规处置，不带 watchdog reason
     —— 列保持 NULL（若带上，W3 会把它算进熔断窗口：一次残行清扫被误算成一次看门狗失败）。 */
  const g = await setupSquad();
  const agent = "ta-sweep";
  const branch = planBranches({
    workItemSlug: slugForId("wi-1"),
    agentSlug: slugForId(agent),
  }).member;
  await g.git(["branch", branch, "main"]); // 先占住分支名 ⇒ 下一条建树失败、留残行
  await assert.rejects(
    () => g.openMemberRun("sweep-old", agent),
    /已被另一工作树占用|already exists/,
  );
  await g.git(["branch", "-D", branch]); // 回收器清掉残枝
  assert.equal(
    (await g.openMemberRun("sweep-new", agent)).kind,
    "opened",
    "残行先被清扫，本请求照常开树",
  );
  const swept = g.runtime.squadRunRepo.get("sweep-old")!;
  assert.equal(swept.status, "discarded", "C1 清扫臂结算了残行");
  assert.equal(swept.settleReason, null, "C1 清扫是常规结算：不得写 watchdog 族的码值");
});

// ---------------------------------------------------------------------------------------------------
// Inbox `run_stalled`：kind / severity 单源 + dedup 形状 + 重投幂等
// ---------------------------------------------------------------------------------------------------

test("Inbox run_stalled：kind 与 severity 走单源映射；dedup 按 run 收敛；重投/归档都不复活", () => {
  assert.ok(INBOX_ITEM_KINDS.includes("run_stalled"), "kind 闭集必须收录 run_stalled");
  assert.equal(INBOX_SEVERITY_BY_KIND.run_stalled, "attention", "宿主活着、run 卡住 = 要人看一眼");

  const item = buildRunStalledInboxItem({
    workspaceKey: WS,
    workspacePath: "/tmp/ws",
    workItemId: "wi-1",
    workItemTitle: null,
    runId: "r-stalled",
    agentId: "ta-a",
    sessionId: "s-1",
    reason: "watchdog_dead_session",
  });
  assert.equal(item.kind, "run_stalled");
  assert.equal(
    item.dedupKey,
    "run_stalled:r-stalled",
    "dedup 按 run 收敛：一次 run 的卡住是一个事实",
  );
  assert.equal(item.title, "wi-1", "拿不到工作项标题 ⇒ 回落 id（同另两个 run 类构建件）");
  assert.deepEqual(item.detail, {
    workItemId: "wi-1",
    runId: "r-stalled",
    agentId: "ta-a",
    sessionId: "s-1",
    reason: "watchdog_dead_session",
  });

  // 存储层幂等：同事实重投不产生第二条；归档行占着 dedup 键 ⇒ 重投不复活。
  const db = new DatabaseSync(":memory:");
  runTasksDatabaseMigrations(db);
  const repo = createInboxItemRepo(db);
  assert.equal(repo.insertIfAbsent(item), true, "首次登记");
  assert.equal(repo.insertIfAbsent(item), false, "重投（下一次 tick 的同一决策）= 幂等");
  assert.equal(repo.listAll().length, 1, "同 runId 只允许一条：二次 tick 不得刷屏");
  assert.equal(
    repo.listAll()[0]!.severity,
    "attention",
    "severity 由 repo 单源补（产生点只表态 kind）",
  );
  repo.archive(repo.listAll()[0]!.id);
  assert.equal(repo.insertIfAbsent(item), false, "已归档不复活（存储层唯一索引不变式）");
  assert.equal(repo.listAll({ includeArchived: true }).length, 1);
});

// ---------------------------------------------------------------------------------------------------
// cancelSquadRun（L1 台账结算）+ git 事实只读口（W2 的输入面）
// ---------------------------------------------------------------------------------------------------

/** 服务面夹具：真 runtime + 真服务面 + 结算 hub（取消要能被 hub 事实与容量口径验证）。 */
async function setupService() {
  const repoRoot = await makeRepo();
  const db = new DatabaseSync(":memory:");
  runTasksDatabaseMigrations(db);
  const settlements = createSquadRunSettlementHub();
  const settled: Array<{ runId: string; status: string }> = [];
  settlements.subscribe((event) => settled.push({ runId: event.runId, status: event.status }));
  const createRuntime = (target: SquadWorkspaceTarget) =>
    createSquadRuntime({
      db,
      workspacePath: repoRoot,
      workspaceIdentity: target.identity,
      readExperimentEnabled: () => true,
      runSettlementHub: settlements,
    });
  const service = createSquadRuntimeService({
    createRuntime,
    readExperimentEnabled: async () => true,
    archiveSquadAndTransfer: async () => {
      throw new Error("本用例不涉及归档转交");
    },
    getInboxItemRepo: () => createInboxItemRepo(db),
  });
  const target = { path: repoRoot, identity: WS };
  const runtime = await createRuntime(target);
  const open = (runId: string, agentId: string, workItemId = "wi-1") =>
    runtime.lifecycle.openMemberRun({
      runId,
      workItemId,
      parentWorkItemId: workItemId,
      agentId,
      isLeaderTask: false,
    });
  return { repoRoot, db, service, target, runtime, settled, open };
}

test("cancelSquadRun：open 取消落 user_cancel + hub 事实；二次取消幂等；produced / 未命中响亮抛", async () => {
  const f = await setupService();

  await f.open("c-open", "ta-cancel");
  await f.service.cancelSquadRun(f.target, { runId: "c-open" });
  const cancelled = f.runtime.squadRunRepo.get("c-open")!;
  assert.equal(cancelled.status, "discarded", "L1：台账立刻出活跃集");
  assert.equal(cancelled.settleReason, SQUAD_RUN_SETTLE_REASON_USER_CANCEL);
  assert.deepEqual(
    f.settled.filter((event) => event.runId === "c-open"),
    [{ runId: "c-open", status: "discarded" }],
    "结算事实扇出一次（容量释放 → 队列推进靠它）",
  );

  // 幂等：同 runId 重复取消第二次是 no-op 成功（不抛、不重复扇出、不改写终态）。
  await f.service.cancelSquadRun(f.target, { runId: "c-open" });
  assert.equal(f.runtime.squadRunRepo.get("c-open")!.status, "discarded");
  assert.equal(
    f.settled.filter((event) => event.runId === "c-open").length,
    1,
    "重复取消不得重复扇出（重复扇出会让推进回路空转）",
  );

  // 已产出 ⇒ 响亮抛（保护已产出的活；文案分流到审查 / 整批放弃）。
  assert.equal((await f.open("c-produced", "ta-cancel", "wi-2")).kind, "opened");
  await f.runtime.lifecycle.completeMemberRun({ runId: "c-produced" });
  assert.equal(f.runtime.squadRunRepo.get("c-produced")!.status, "produced");
  await assert.rejects(
    () => f.service.cancelSquadRun(f.target, { runId: "c-produced" }),
    /produced|审查|放弃/,
    "取消已产出的 run = 跨终态改写，必须响亮拒绝",
  );

  // runId 不存在 ⇒ 响亮抛（静默 no-op 会让界面以为取消了）。
  await assert.rejects(() => f.service.cancelSquadRun(f.target, { runId: "nope" }), /nope/);
});

test("cancelSquadRun：queued 行走丢弃出口（同样落 user_cancel）；取消后容量释放由 false 变 true", async () => {
  const f = await setupService();
  const agent = await f.runtime.teamAgentService.create({
    name: "cap-agent",
    systemPrompt: "s",
    memoryScope: "project",
    maxConcurrentRuns: 1,
  });

  assert.equal((await f.open("cap-a", agent.id, "wi-a")).kind, "opened");
  assert.deepEqual(await f.open("cap-b", agent.id, "wi-b"), { kind: "queued", runId: "cap-b" });
  assert.equal(
    f.runtime.squadRunRepo.claimQueuedRunForPromotion("cap-b", 1),
    false,
    "前置：容量被 cap-a 占着（排队行认领不动）",
  );

  // 取消 queued 行：走 `discardQueuedRun`（无会话无树，不是 failMemberRun）。
  await f.service.cancelSquadRun(f.target, { runId: "cap-b" });
  const dropped = f.runtime.squadRunRepo.get("cap-b")!;
  assert.equal(dropped.status, "discarded");
  assert.equal(dropped.settleReason, SQUAD_RUN_SETTLE_REASON_USER_CANCEL, "排队取消同样落码值");

  // 取消 open 行 ⇒ 容量释放：同一个排队行现在可被认领（`false` → `true` 是容量的直接证据）。
  assert.deepEqual(await f.open("cap-d", agent.id, "wi-d"), { kind: "queued", runId: "cap-d" });
  assert.equal(
    f.runtime.squadRunRepo.claimQueuedRunForPromotion("cap-d", 1),
    false,
    "前置：cap-a 仍占着唯一容量位",
  );
  await f.service.cancelSquadRun(f.target, { runId: "cap-a" });
  assert.equal(
    f.runtime.squadRunRepo.claimQueuedRunForPromotion("cap-d", 1),
    true,
    "取消 ⇒ 出活跃集 ⇒ 容量释放（这条链不新写一行代码，靠既有 hub 回路）",
  );
});

test("git 事实只读口：活树分支集合 + 按分支的 ref 存在性（与 lifecycle 同一注入面）", async () => {
  const f = await setupService();
  const agent = "ta-facts";
  const branch = planBranches({
    workItemSlug: slugForId("wi-1"),
    agentSlug: slugForId(agent),
  }).member;

  // 前置：一条只有 ref 的残枝（没有工作树）+ 一条真正的活树分支。
  const pre = await f.runtime.git(["branch", "squad/member/residual-only", "main"], {
    cwd: f.repoRoot,
  });
  assert.equal(pre.code, 0, `前置：残枝应能建出来（stderr=${pre.stderr}）`);
  assert.equal((await f.open("facts-tree", agent)).kind, "opened", "活树分支一条");

  const facts = await f.service.getSquadWatchdogGitFacts(f.target, {
    branches: [branch, "squad/member/residual-only", "squad/member/does-not-exist"],
  });
  assert.deepEqual(
    facts.liveTreeBranches,
    [branch],
    "活树分支集合取自 WorktreeManager.list 的投影",
  );
  assert.deepEqual(
    facts.existingBranchRefs,
    [branch, "squad/member/residual-only"],
    "ref 存在性按分支逐一问 git（残枝 = 有 ref 没树）",
  );
});

// ---------------------------------------------------------------------------------------------------
// 端到端演示（不开 host）：僵尸 open 队员行 ⇒ 判定 ⇒ 结算 ⇒ 容量释放 ⇒ Inbox 一条 ⇒ 二次零动作
// ---------------------------------------------------------------------------------------------------

test("端到端（脚本化夹具）：僵尸行被判定 ⇒ 结算 ⇒ 容量释放 ⇒ Inbox run_stalled 一条 ⇒ 二次零动作", async () => {
  const f = await setupService();
  const agent = await f.runtime.teamAgentService.create({
    name: "zombie-agent",
    systemPrompt: "s",
    memoryScope: "project",
    maxConcurrentRuns: 1,
  });

  // 僵尸行：open + 会话已消失（`s-gone` 不在任何执行集合里 ⇒ 探测结论 = 不在执行）。
  assert.equal((await f.open("zombie-1", agent.id, "wi-z")).kind, "opened");
  await f.runtime.lifecycle.bindMemberRunSession({ runId: "zombie-1", sessionId: "s-gone" });
  // 一条排队行正等容量（结算僵尸行 ⇒ 它应当可被认领）。
  assert.deepEqual(await f.open("zombie-q", agent.id, "wi-z2"), {
    kind: "queued",
    runId: "zombie-q",
  });

  /** 判定臂的脚本化形态（W2 的 tick/启动臂按同一形状组装输入）。 */
  const decide = async () => {
    const runs = f.runtime.squadRunRepo.listActive(WS);
    const branches = runs
      .map((record) => record.branch)
      .filter((branch): branch is string => branch !== null);
    const facts = await f.service.getSquadWatchdogGitFacts(f.target, { branches });
    const refs = new Set(facts.existingBranchRefs);
    const agents = f.runtime.teamAgentService.list();
    return decideSquadWatchdog({
      rows: runs.map((record) => ({
        runId: record.runId,
        agentId: record.agentId,
        isLeaderTask: record.isLeaderTask,
        status: record.status,
        sessionId: record.sessionId,
        branch: record.branch,
        openedAt: record.openedAt ?? null,
        liveTreeOfOtherRow: false,
      })),
      // 强探测：此刻没有任何会话在执行（重启后恒真）。
      executingSessionIds: new Set<string>(),
      probeAvailable: true,
      now: Date.now(),
      facts: {
        liveTreeBranches: new Set(facts.liveTreeBranches),
        branchRefExists: (branch) => refs.has(branch),
      },
      idleMsByRunId: new Map<string, number>(),
      // 阈值经 shared 单源 + per-agent resolve helper 读（消费点不写散值）。
      thresholds: {
        ttlMinutesFor: (agentId) => {
          const definition = agents.find((candidate) => candidate.id === agentId);
          return definition === undefined
            ? DEFAULT_SQUAD_RUN_TTL_MINUTES
            : resolveTeamAgentRunTtlMinutes(definition);
        },
        idleTimeoutMinutesFor: (agentId) => {
          const definition = agents.find((candidate) => candidate.id === agentId);
          return definition === undefined
            ? DEFAULT_SQUAD_IDLE_TIMEOUT_MINUTES
            : resolveTeamAgentIdleTimeoutMinutes(definition);
        },
        fallbackWallClockHours: DEFAULT_SQUAD_FALLBACK_WALL_CLOCK_HOURS,
      },
    });
  };

  assert.equal(
    f.runtime.squadRunRepo.claimQueuedRunForPromotion("zombie-q", 1),
    false,
    "前置：容量被僵尸行占着（排队行认领不动）",
  );

  // 判定命中：僵尸行是**明确探测不到执行**的会话 ⇒ settle_dead_session（不是 TTL、不是 skip）。
  const decisions = await decide();
  assert.deepEqual(decisions, [
    {
      kind: "settle_dead_session",
      runId: "zombie-1",
      agentId: agent.id,
      sessionId: "s-gone",
      reason: SQUAD_RUN_SETTLE_REASON_WATCHDOG_DEAD_SESSION,
    },
  ]);

  // 执行臂（W2 的形状）：逐条 failMemberRun（唯一写者）+ 首见一次 Inbox 留痕。
  for (const decision of decisions) {
    if (decision.kind !== "settle_dead_session") continue;
    await f.runtime.lifecycle.failMemberRun({
      runId: decision.runId,
      reason: SQUAD_RUN_SETTLE_REASON_WATCHDOG_DEAD_SESSION,
    });
    f.runtime.inboxItemRepo.insertIfAbsent(
      buildRunStalledInboxItem({
        workspaceKey: WS,
        workspacePath: f.repoRoot,
        workItemId: "wi-z",
        workItemTitle: null,
        runId: decision.runId,
        agentId: decision.agentId,
        sessionId: decision.sessionId,
        reason: SQUAD_RUN_SETTLE_REASON_WATCHDOG_DEAD_SESSION,
      }),
    );
  }

  const zombie = f.runtime.squadRunRepo.get("zombie-1")!;
  assert.equal(zombie.status, "discarded", "结算：出活跃集");
  assert.equal(
    zombie.settleReason,
    SQUAD_RUN_SETTLE_REASON_WATCHDOG_DEAD_SESSION,
    "原因落盘可复盘",
  );
  const inbox = f.runtime.inboxItemRepo.listAll();
  assert.equal(inbox.length, 1, "首见一次留痕（不是每 tick 一条）");
  assert.equal(inbox[0]!.kind, "run_stalled");
  // 二次执行零动作：僵尸行已出活跃集 ⇒ 零决策；Inbox 仍是一条（幂等）。这一步在认领之前做：
  // 认领会把排队行变成一条新的 open 行（它上面出现的是 C1 领地的 skip，不是"零决策"）。
  assert.deepEqual(await decide(), [], "二次扫描对同一条僵尸行零动作");
  assert.equal(f.runtime.inboxItemRepo.listAll().length, 1, "重投不刷屏");

  // 容量释放：排队行从「认领不动」变成「可认领」（结算事实经 hub 扇出的下游效果）。
  assert.equal(
    f.runtime.squadRunRepo.claimQueuedRunForPromotion("zombie-q", 1),
    true,
    "容量释放：排队行从「认领不动」变成「可认领」",
  );
});

// ---------------------------------------------------------------------------------------------------
// 结构守卫（W1 卡「结构守卫」逐条；机械可查，不靠人眼）
// ---------------------------------------------------------------------------------------------------

const SERVICES_SRC = join(import.meta.dirname, "..", "src");
const WORKITEM_SRC = join(SERVICES_SRC, "workitem");

function sourceOf(relative: string): string {
  return readFileSync(join(SERVICES_SRC, relative), "utf8");
}

test("守卫｜C1 判据唯一：squadWatchdog 不自写三条件，且引用了 C1 的导出判据", () => {
  const source = sourceOf("workitem/squadWatchdog.ts");
  /* 卡片原话：「该文件不得自写 `sessionId === null` 判定，必须经 C1 判据」。三条件的另一种写法
     （`sessionId !== null` 之外的行级 null 判定）同样不许 —— 只允许「已绑会话」这一条行级事实，
     由 `hasBoundSession` 承接，而 C1 的两格分类必须走导出判据。 */
  assert.ok(
    !source.includes("sessionId === null"),
    "squadWatchdog 不得自写 `sessionId === null`（三条件判据只有 C1 一处实现）",
  );
  for (const predicate of [
    "isTreelessOpenMemberRun(",
    "isSettleableResidualMemberRun(",
    "isAwaitingBranchMemberRun(",
  ])
    assert.ok(
      source.includes(predicate),
      `squadWatchdog 必须引用 C1 导出判据 ${predicate}（不复制三条件）`,
    );
});

test("守卫｜squad_runs 写入点唯一：services 内只有 squadRunRepo 出现 INSERT/UPDATE squad_runs", () => {
  const offenders = readdirSync(WORKITEM_SRC)
    .filter((name) => name.endsWith(".ts") && name !== "squadRunRepo.ts")
    .filter((name) => {
      const source = readFileSync(join(WORKITEM_SRC, name), "utf8");
      return source.includes("INSERT INTO squad_runs") || source.includes("UPDATE squad_runs");
    });
  assert.deepEqual(
    offenders,
    [],
    "台账的裸 SQL 只准出现在 squadRunRepo（第二处写入 = 两套状态机）",
  );
});

test("守卫｜cancelSquadRun 只有两条状态写路径：failMemberRun / discardQueuedRun", () => {
  const source = sourceOf("workitem/squadRuntimeService.ts");
  const start = source.indexOf("async cancelSquadRun(");
  assert.ok(start > 0, "cancelSquadRun 不见了");
  const body = source.slice(start, source.indexOf("\n    },", start));
  assert.ok(body.includes("lifecycle.failMemberRun("), "open 分支必须经 failMemberRun（唯一写者）");
  assert.ok(body.includes("squadRunRepo.discardQueuedRun("), "queued 分支必须经 discardQueuedRun");
  for (const forbidden of ["setStatus(", "UPDATE squad_runs", "INSERT INTO"])
    assert.ok(
      !body.includes(forbidden),
      `cancelSquadRun 内不得出现第二写路径的痕迹「${forbidden}」`,
    );
});

test("守卫｜阈值单源：workitem 域内不得出现手写的分钟换算（30 * 60_000 这类散值）", () => {
  const forbidden = ["* 60_000", "60_000 *", "* 60000", "60000 *", "* 60 * 1000"];
  const offenders: string[] = [];
  for (const name of readdirSync(WORKITEM_SRC).filter((entry) => entry.endsWith(".ts"))) {
    const source = readFileSync(join(WORKITEM_SRC, name), "utf8");
    for (const pattern of forbidden)
      if (source.includes(pattern)) offenders.push(`${name}: ${pattern}`);
  }
  assert.deepEqual(
    offenders,
    [],
    "阈值与单位换算必须取 shared 的单源常量（`MS_PER_MINUTE` / `MS_PER_HOUR`），不得写散值",
  );
  // 正向：判定面确实用单源换算常量（不自己写 60_000）。
  const watchdog = sourceOf("workitem/squadWatchdog.ts");
  assert.ok(watchdog.includes("MS_PER_MINUTE") && watchdog.includes("MS_PER_HOUR"));
});

/* ───────────────── W3 工具臂（口径 A：检测 + 提醒；不结算、不 stop） ─────────────────

   用户 2026-10-07 裁定：信号源 = 轮询 `readSession` 的 `projection.activeToolCalls`（R-1 的替代读口，
   `boundSessionBusyGate` 同款先例）；命中 ⇒ **只落 Inbox 提醒**，run 台账一个字不写。
   R-1 实证「只停该工具、run 继续」不可交付（协议 stop 只能 abort 整个前台执行），故本件**绝不调 stop**：
   判定面连 stop 这个动作类型都不产出，执行臂也就无从调它。 */
test("工具臂（口径 A）：单工具 > 阈值 ⇒ alert；未超 ⇒ 不动作；信号不可得 ⇒ no_signal", () => {
  const running = (
    startedAt: number | null,
    over: Partial<{
      toolCallId: string;
      toolName: string;
      status: "pending" | "running" | "completed" | "failed" | "denied";
    }> = {},
  ) => ({
    toolCallId: "tc-1",
    toolName: "bash",
    status: "running" as const,
    startedAt,
    ...over,
  });
  const decisions = decideSquadToolWatchdog({
    observations: [
      // 6 分钟 > 5 分钟（缺省 toolTimeoutMinutes）：命中。
      {
        runId: "run-over",
        agentId: "ta-a",
        sessionId: "s-over",
        activeToolCalls: [running(NOW - 6 * MS_PER_MINUTE)],
      },
      // 4 分钟 < 5 分钟：不动作（阈值两侧结论相反）。
      {
        runId: "run-under",
        agentId: "ta-a",
        sessionId: "s-under",
        activeToolCalls: [running(NOW - 4 * MS_PER_MINUTE)],
      },
      // 信号不可得：不猜、不动作，但要产一条 no_signal（执行臂据此首见留痕）。
      { runId: "run-nosignal", agentId: "ta-a", sessionId: "s-none", activeToolCalls: null },
      // 已结束的工具 / 没有开始时刻的调用都不是「超时的在跑工具」。
      {
        runId: "run-stale",
        agentId: "ta-a",
        sessionId: "s-stale",
        activeToolCalls: [
          running(NOW - 60 * MS_PER_MINUTE, { status: "completed" }),
          running(null, { toolCallId: "tc-2" }),
          running(NOW - 60 * MS_PER_MINUTE, { toolCallId: "tc-3", status: "pending" }),
        ],
      },
    ],
    now: NOW,
    toolTimeoutMinutesFor: () => 5,
  });

  assert.deepEqual(
    decisions.map((decision) => [decision.kind, decision.runId]),
    [
      ["alert_tool_timeout", "run-over"],
      ["skip_tool_no_signal", "run-nosignal"],
    ],
    "只有「在跑且超阈值」的调用命中；不可得 ⇒ no_signal；其余一律不产决策（健康行不刷屏）",
  );
  const alert = decisions[0];
  assert.ok(alert.kind === "alert_tool_timeout");
  assert.equal(alert.toolCallId, "tc-1", "提醒要能指出是哪一次工具调用");
  assert.equal(alert.toolName, "bash");
  assert.equal(alert.sessionId, "s-over", "提醒要带会话（人要去会话里看/收）");
  assert.equal(
    alert.thresholdMs,
    5 * MS_PER_MINUTE,
    "阈值进入决策（文案与审计要能说出「超了多少」）",
  );
});

test("工具臂：阈值按 agent 解析（per-agent 覆盖），同一时长在两个 agent 上结论相反", () => {
  const observations = [
    {
      runId: "run-a",
      agentId: "ta-fast",
      sessionId: "s-a",
      activeToolCalls: [
        {
          toolCallId: "tc-a",
          toolName: "bash",
          status: "running" as const,
          startedAt: NOW - 2 * MS_PER_MINUTE,
        },
      ],
    },
    {
      runId: "run-b",
      agentId: "ta-slow",
      sessionId: "s-b",
      activeToolCalls: [
        {
          toolCallId: "tc-b",
          toolName: "bash",
          status: "running" as const,
          startedAt: NOW - 2 * MS_PER_MINUTE,
        },
      ],
    },
  ];
  const thresholds: Record<string, number> = { "ta-fast": 1, "ta-slow": 5 };
  const decisions = decideSquadToolWatchdog({
    observations,
    now: NOW,
    // 解析入口是 shared 的 resolve helper（消费点不得各写一份 `?? 5`）——这里直接给已解析值。
    toolTimeoutMinutesFor: (agentId) =>
      resolveTeamAgentToolTimeoutMinutes({ toolTimeoutMinutes: thresholds[agentId] }),
  });
  assert.deepEqual(
    decisions.map((decision) => decision.runId),
    ["run-a"],
    "2 分钟的工具：阈值 1 分钟的 agent 命中、阈值 5 分钟的不命中（阈值必须按行上的 agent 取）",
  );
});
