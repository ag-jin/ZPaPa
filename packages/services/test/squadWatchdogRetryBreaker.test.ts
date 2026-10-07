import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import {
  MS_PER_MINUTE,
  SQUAD_BREAKER_THRESHOLD,
  SQUAD_BREAKER_WINDOW_MINUTES,
} from "@zcode/shared";
import { runTasksDatabaseMigrations } from "../src/session/tasksDatabase/migrations.js";
import { createInboxItemRepo } from "../src/workitem/inboxItemRepo.js";
import { createSquadRuntime } from "../src/workitem/squadRuntime.js";
import type { SquadRuntime } from "../src/workitem/squadContracts.js";
import { createSquadRuntimeService } from "../src/workitem/squadRuntimeService.js";
import {
  SQUAD_RUN_SETTLE_REASON_USER_CANCEL,
  SQUAD_RUN_SETTLE_REASON_WATCHDOG_DEAD_SESSION,
  SQUAD_RUN_SETTLE_REASON_WATCHDOG_IDLE_GRACE,
  SQUAD_RUN_SETTLE_REASON_WATCHDOG_TTL,
  SQUAD_RUN_WATCHDOG_SETTLE_REASONS,
} from "../src/workitem/squadRunRepo.js";
import { squadAgentBreakerSkipReason } from "../src/workitem/squadWatchdog.js";
import { makeRepo } from "./helpers/gitFixture.js";

/* W3（看门狗六件套·增强三件）：**熔断窗口计数**与**失败重试预算**两条派生判据 ——
   两者都长在「看门狗结算」的副产品上（`settle_reason`），故共用这一个文件。

   为什么必须行为级（真库 + 真 runtime）：它们由**零状态派生 SQL**实现
   （`count(*) WHERE settle_reason IN (族) AND updated_at > now−W` / `EXISTS(...)`）。派生判据一旦写错
   （族漏一值、窗口边界反了、把用户取消算进来）**不会报错** —— 表现只是「熔断早/晚一轮」或
   「重试多/少一次」，两种都不在日志里留下痕迹。故断言直接读库里的行与派生读口的返回值。 */

const WS = "w3-retry-breaker-ws";

type Fixture = {
  repoRoot: string;
  runtime: SquadRuntime;
  service: ReturnType<typeof createSquadRuntimeService>;
  target: { path: string; identity: string };
  agentId: string;
  itemId: string;
  otherAgentId: string;
  otherItemId: string;
  /** 直插台账行（夹具层：判据读的是**行上的列**，不必经生命周期跑一次真 run）。 */
  insertRun(input: {
    runId: string;
    workItemId?: string;
    agentId?: string;
    settleReason?: string | null;
    updatedAt?: number;
  }): void;
};

async function setup(): Promise<Fixture> {
  const repoRoot = await makeRepo();
  const db = new DatabaseSync(":memory:");
  runTasksDatabaseMigrations(db);
  const createRuntime = (): Promise<SquadRuntime> =>
    createSquadRuntime({
      db,
      workspacePath: repoRoot,
      workspaceIdentity: WS,
      readExperimentEnabled: () => true,
    });
  const runtime = await createRuntime();
  const service = createSquadRuntimeService({
    createRuntime,
    readExperimentEnabled: async () => true,
    archiveSquadAndTransfer: async () => {
      throw new Error("本用例不涉及归档转交");
    },
    getInboxItemRepo: () => createInboxItemRepo(db),
    logWarn: () => {},
  });
  const agent = runtime.teamAgentService.create({
    name: "w3-agent",
    systemPrompt: "s",
    memoryScope: "project",
    maxConcurrentRuns: 1,
  });
  const otherAgent = runtime.teamAgentService.create({
    name: "w3-agent-other",
    systemPrompt: "s",
    memoryScope: "project",
    maxConcurrentRuns: 1,
  });
  const itemId = "w3-wi";
  const otherItemId = "w3-wi-other";
  for (const [id, owner] of [
    [itemId, agent.id],
    [otherItemId, otherAgent.id],
  ] as const) {
    runtime.workItemRepo.insert({
      id,
      workspaceIdentity: WS,
      workspacePath: repoRoot,
      title: `标题-${id}`,
      body: "",
      status: "in_progress",
      assignee: { type: "agent", id: owner },
      labels: [],
      properties: {},
      position: 0,
    });
  }
  return {
    repoRoot,
    runtime,
    service,
    target: { path: repoRoot, identity: WS },
    agentId: agent.id,
    itemId,
    otherAgentId: otherAgent.id,
    otherItemId,
    insertRun(input) {
      const at = input.updatedAt ?? Date.now();
      runtime.squadRunRepo.insert({
        runId: input.runId,
        workspaceKey: WS,
        workspacePath: repoRoot,
        workItemId: input.workItemId ?? itemId,
        parentWorkItemId: input.workItemId ?? itemId,
        agentId: input.agentId ?? agent.id,
        isLeaderTask: false,
        branch: null,
        dirName: null,
        status: "discarded",
        sessionId: null,
        dispatchCause: null,
        causedByRunId: null,
        openedAt: at,
        settleReason: input.settleReason ?? null,
        createdAt: at,
        updatedAt: at,
      });
    },
  };
}

test("看门狗族码值：空闲宽限到期结算并入 watchdog 族（熔断窗口与重试预算同口径，用户 2026-10-07 裁定）", () => {
  assert.deepEqual(
    [...SQUAD_RUN_WATCHDOG_SETTLE_REASONS],
    ["watchdog_dead_session", "watchdog_ttl", "watchdog_idle_stop_grace_expired"],
    "空闲宽限摊牌（stop 发出后宽限内无回调 ⇒ 兜底结算）也是看门狗结算 ⇒ 与死会话/TTL 同族",
  );
  assert.ok(
    !(SQUAD_RUN_WATCHDOG_SETTLE_REASONS as readonly string[]).includes(
      SQUAD_RUN_SETTLE_REASON_USER_CANCEL,
    ),
    "用户取消**不在**看门狗族：窗口计数与重试预算都不得把一次取消算成一次看门狗失败",
  );
});

test("熔断窗口计数：按 agent 分组，只认窗口内的 watchdog 族结算（用户取消 / 窗口外 / 别的 agent 都不计）", async () => {
  const f = await setup();
  const windowMs = SQUAD_BREAKER_WINDOW_MINUTES * MS_PER_MINUTE;
  const now = Date.now();

  // 窗口内三条（三个族内码值各一：TTL / 死会话 / 空闲宽限摊牌）。
  f.insertRun({ runId: "w3-in-1", settleReason: SQUAD_RUN_SETTLE_REASON_WATCHDOG_TTL });
  f.insertRun({ runId: "w3-in-2", settleReason: SQUAD_RUN_SETTLE_REASON_WATCHDOG_DEAD_SESSION });
  f.insertRun({ runId: "w3-in-3", settleReason: SQUAD_RUN_SETTLE_REASON_WATCHDOG_IDLE_GRACE });
  // 窗口外一条（同一个 agent，同一码值）——它是「窗口滑出 ⇒ 放行」的判据面。
  f.insertRun({
    runId: "w3-out-1",
    settleReason: SQUAD_RUN_SETTLE_REASON_WATCHDOG_TTL,
    updatedAt: now - windowMs - MS_PER_MINUTE,
  });
  // 用户取消（窗口内、同 agent）——**不计入**（设计 §3.6：只认看门狗族）。
  f.insertRun({ runId: "w3-cancel", settleReason: SQUAD_RUN_SETTLE_REASON_USER_CANCEL });
  // 别的 agent 的看门狗结算（窗口内）——不得算到本 agent 头上。
  f.insertRun({
    runId: "w3-other",
    agentId: f.otherAgentId,
    workItemId: f.otherItemId,
    settleReason: SQUAD_RUN_SETTLE_REASON_WATCHDOG_TTL,
  });

  const counts = await f.service.countWatchdogSettlementsByAgent(f.target);
  assert.deepEqual(
    new Map(counts.map((entry) => [entry.agentId, entry.count])),
    new Map([
      [f.agentId, 3],
      [f.otherAgentId, 1],
    ]),
    "窗口内 watchdog 族逐 agent 计数：取消不计、窗口外不计、不跨 agent 串台",
  );
});

test("失败重试：看门狗结算 ⇒ 恰一条 origin=watchdog 义务（新 runId、成因继承）；同对第二次结算不再登记", async () => {
  const f = await setup();
  /* run-1：**真实**开跑（真工作树）⇒ 走真实结算路径（`failMemberRun` 把码值写进 settle_reason），
     再登记重试 —— 判据读的是这一行上的列，故必须由真结算产生。 */
  await f.runtime.lifecycle.openMemberRun({
    runId: "w3-run-1",
    workItemId: f.itemId,
    parentWorkItemId: f.itemId,
    agentId: f.agentId,
    isLeaderTask: false,
    dispatchCause: "leader_tool",
  });
  await f.runtime.lifecycle.failMemberRun({
    runId: "w3-run-1",
    reason: SQUAD_RUN_SETTLE_REASON_WATCHDOG_TTL,
  });

  const first = await f.service.registerWatchdogRetry(f.target, { settledRunId: "w3-run-1" });
  assert.equal(first.kind, "registered", "第一次看门狗结算 ⇒ 登记重试（预算未用）");
  const retryRunId = first.kind === "registered" ? first.runId : "";
  assert.notEqual(
    retryRunId,
    "w3-run-1",
    "重试是**新**派发决策 ⇒ 新 runId（同 eventKey = 同一事实 = 同一 run，复用会把重试并进已终态的行）",
  );
  const obligation = f.runtime.squadDeferredDispatchRepo.find(WS, f.itemId, f.agentId);
  assert.equal(obligation?.origin, "watchdog", "义务来源 = watchdog（重放分流靠它）");
  assert.equal(obligation?.runId, retryRunId, "义务的 runId 就是重试 run 的身份");
  assert.equal(
    obligation?.dispatchCause,
    "leader_tool",
    "成因继承被结算行（G8：不扩 DISPATCH_CAUSES 闭集，纯搬运）",
  );

  /* run-2（重试开出来的那条）再被看门狗结算 ⇒ 预算已用 ⇒ **不再**登记。
     这一格是闭环有界的判据面（设计 §3.5）：少一次预算就成重试风暴/死循环。
     夹具直插 open 行（真树会与 run-1 撞同名分支，而本格只关心结算后的预算派生）。 */
  f.insertRun({ runId: "w3-run-2", settleReason: null });
  f.runtime.squadRunRepo.setStatus("w3-run-2", "open", { sessionId: "sess-retry" });
  await f.runtime.lifecycle.failMemberRun({
    runId: "w3-run-2",
    reason: SQUAD_RUN_SETTLE_REASON_WATCHDOG_DEAD_SESSION,
  });

  const second = await f.service.registerWatchdogRetry(f.target, { settledRunId: "w3-run-2" });
  assert.deepEqual(second, { kind: "budget_exhausted" }, "同对已有另一次看门狗结算 ⇒ 不再登记重试");
  assert.equal(
    f.runtime.squadDeferredDispatchRepo.list(WS).length,
    1,
    "义务表仍只有第一次那一条（第二次不得新增、也不得覆盖）",
  );
});

test("失败重试：只由看门狗族结算触发 —— 用户取消 / 普通失败不登记（响亮拒绝，不静默吞）", async () => {
  const f = await setup();
  f.insertRun({ runId: "w3-cancel-run", settleReason: null });
  f.runtime.squadRunRepo.setStatus("w3-cancel-run", "open", { sessionId: "sess-cancel" });
  await f.runtime.lifecycle.failMemberRun({
    runId: "w3-cancel-run",
    reason: SQUAD_RUN_SETTLE_REASON_USER_CANCEL,
  });

  await assert.rejects(
    () => f.service.registerWatchdogRetry(f.target, { settledRunId: "w3-cancel-run" }),
    /看门狗/,
    "用户取消不自动重试（用户已表态）：调用方拿它是 bug，故响亮抛而不是静默 no-op",
  );
  assert.equal(
    f.runtime.squadDeferredDispatchRepo.list(WS).length,
    0,
    "拒绝的路径不得留下任何义务行",
  );
});

test("熔断判据（纯函数）：计数 < 阈值 ⇒ 放行；= 阈值 ⇒ skip 文案含计数/阈值/窗口", () => {
  assert.equal(
    squadAgentBreakerSkipReason({
      agentId: "w3-ta",
      watchdogSettlementsInWindow: SQUAD_BREAKER_THRESHOLD - 1,
    }),
    null,
    "差一次不算熔断（阈值是「达到即熔断」，两侧必须结论相反）",
  );
  const tripped = squadAgentBreakerSkipReason({
    agentId: "w3-ta",
    watchdogSettlementsInWindow: SQUAD_BREAKER_THRESHOLD,
  });
  assert.ok(tripped !== null, "计数 = 阈值 ⇒ 熔断");
  for (const fragment of [
    "w3-ta",
    String(SQUAD_BREAKER_THRESHOLD),
    String(SQUAD_BREAKER_WINDOW_MINUTES),
  ])
    assert.ok(
      tripped.includes(fragment),
      `skip 文案必须点名事实（agent / 阈值 / 窗口）：人要知道为什么没派、多久后自愈（缺 ${fragment}）`,
    );
  assert.match(tripped, /熔断/, "文案必须能被 Inbox 的 kind/reason 一眼读出是熔断");
});

test("失败重试：同对已有别的通道的义务 ⇒ 并入它（义务表「每对至多一行」的不变式，不新增第二行）", async () => {
  const f = await setup();
  // 前置：该 (workItem, agent) 已有一条 R2（改派）义务 —— 义务表的唯一约束在这一对上。
  const inserted = f.runtime.squadDeferredDispatchRepo.insertIfAbsent({
    runId: "w3-existing-obligation",
    workspaceKey: WS,
    workItemId: f.itemId,
    agentId: f.agentId,
    dispatchCause: null,
    origin: "reassign",
    createdAt: Date.now(),
    updatedAt: Date.now(),
  });
  assert.equal(inserted, true, "前置：既有义务已登记");

  f.insertRun({ runId: "w3-coalesce-run", settleReason: null });
  f.runtime.squadRunRepo.setStatus("w3-coalesce-run", "open", { sessionId: "sess-c" });
  await f.runtime.lifecycle.failMemberRun({
    runId: "w3-coalesce-run",
    reason: SQUAD_RUN_SETTLE_REASON_WATCHDOG_IDLE_GRACE,
  });

  const outcome = await f.service.registerWatchdogRetry(f.target, {
    settledRunId: "w3-coalesce-run",
  });
  assert.deepEqual(
    outcome,
    { kind: "coalesced", targetRunId: "w3-existing-obligation" },
    "同对已有义务 ⇒ 并入它（重放机制不分来源都能把这一对再派一次；另起一行会破坏「每对至多一行」）",
  );
  assert.equal(f.runtime.squadDeferredDispatchRepo.list(WS).length, 1, "不得新增第二行");
});

test("失败重试：被结算行不存在 ⇒ 响亮抛（调用方拿错 runId 是 bug，不得静默登记）", async () => {
  const f = await setup();
  await assert.rejects(
    () => f.service.registerWatchdogRetry(f.target, { settledRunId: "w3-not-a-run" }),
    /w3-not-a-run/,
    "runId 不存在时静默 no-op 会让「这条 run 被结算过、但没人重试」变成没人知道的事",
  );
  assert.equal(f.runtime.squadDeferredDispatchRepo.list(WS).length, 0);
});
