// eslint-disable-next-line typescript-eslint/triple-slash-reference -- 与同目录既有用例同一处声明
/// <reference path="../src/runtime-tools/node-forge.d.ts" />
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import {
  MS_PER_MINUTE,
  SQUAD_BREAKER_THRESHOLD,
  SQUAD_BREAKER_WINDOW_MINUTES,
  type Squad,
  type WorkItem,
} from "@zcode/shared";
import { runTasksDatabaseMigrations } from "../src/session/tasksDatabase/migrations.js";
import { createInboxItemRepo } from "../src/workitem/inboxItemRepo.js";
import { buildRunStalledInboxItem } from "../src/workitem/inboxItemProducers.js";
import { planDispatch } from "../src/workitem/leaderDispatch.js";
import { createSquadRuntime } from "../src/workitem/squadRuntime.js";
import type { SquadRuntime } from "../src/workitem/squadContracts.js";
import { createSquadRuntimeService } from "../src/workitem/squadRuntimeService.js";
import {
  SQUAD_RUN_SETTLE_REASON_USER_CANCEL,
  SQUAD_RUN_SETTLE_REASON_WATCHDOG_DEAD_SESSION,
  SQUAD_RUN_SETTLE_REASON_WATCHDOG_IDLE_GRACE,
  SQUAD_RUN_SETTLE_REASON_WATCHDOG_TTL,
  type SquadRunRecord,
} from "../src/workitem/squadRunRepo.js";
import { decideSquadToolWatchdog } from "../src/workitem/squadWatchdog.js";
import { makeRepo } from "./helpers/gitFixture.js";

/* W3 复验（看门狗六件套收官 · test-verifier 独立构造）：
   本文件**逐条自建夹具**（不复用任何实现轮测试里的 setup / helper / 断言形状），只把已批准接缝
   （`planDispatch` 纯函数、服务面 `countWatchdogSettlementsByAgent` / `registerWatchdogRetry`、
   判定面 `decideSquadToolWatchdog`、Inbox 构建件 + repo）当作观察面。

   为什么值得另写一份：实现轮的用例与实现出自同一轮工作 —— 判据被抄成「实现怎么写就怎么断言」
   时（例如把「四出口」只按已有 skip 的直觉补两支）两边会一起绿。这里按**需求的穷举表**重推：
   四条出口 × 四个方向（熔断命中 / 差一次 / 别的 agent 熔断 / 无证据）+ 熔断窗口的四类排除项 +
   重试预算的四个边界（同对第二次 / 不同对 / 别的通道义务 / 用户取消）。

   W3 五项核对的落点见各 test 名前的标号。 */

/* ───────────────────────── 夹具（自建；最小行字面量） ───────────────────────── */

const WS = "w3-independent-recheck-ws";

const agentItem = (agentId: string): WorkItem =>
  ({
    id: `wi-${agentId}`,
    workspaceIdentity: WS,
    workspacePath: "/tmp/w3-recheck",
    title: `标题-${agentId}`,
    body: "",
    status: "todo",
    assignee: { type: "agent", id: agentId },
    labels: [],
    properties: {},
    position: 0,
  }) as unknown as WorkItem;

const userItem = (): WorkItem =>
  ({
    id: "wi-user",
    workspaceIdentity: WS,
    workspacePath: "/tmp/w3-recheck",
    title: "标题-user",
    body: "",
    status: "todo",
    assignee: { type: "user", id: "u-1" },
    labels: [],
    properties: {},
    position: 0,
  }) as unknown as WorkItem;

const squadItem = (): WorkItem =>
  ({
    id: "wi-squad",
    workspaceIdentity: WS,
    workspacePath: "/tmp/w3-recheck",
    title: "标题-squad",
    body: "",
    status: "todo",
    assignee: { type: "squad", id: "sq-1" },
    labels: [],
    properties: {},
    position: 0,
  }) as unknown as WorkItem;

const LEADER = "ta-leader";
const MEMBER = "ta-member";
const ASSIGNEE = "ta-assignee";
const MENTIONED = "ta-mentioned";

const enabledSquad = (): Squad =>
  ({
    id: "sq-1",
    name: "复验小队",
    leaderAgentId: LEADER,
    members: [{ agentId: LEADER, role: "leader" }, { agentId: MEMBER }],
    instructions: { stopCondition: "全部 done", maxRounds: "3" },
    enabled: true,
  }) as unknown as Squad;

const counts = (...entries: ReadonlyArray<readonly [string, number]>) =>
  entries.map(([agentId, count]) => ({ agentId, count }));

const runsOf = (events: ReturnType<typeof planDispatch>) =>
  events.filter((event) => event.kind === "run.enqueued");
const skipsOf = (events: ReturnType<typeof planDispatch>) =>
  events.filter((event) => event.kind === "inbox.notified");

type Fixture = {
  runtime: SquadRuntime;
  service: ReturnType<typeof createSquadRuntimeService>;
  target: { path: string; identity: string };
  insertRun(input: {
    runId: string;
    workItemId?: string;
    agentId?: string;
    status?: SquadRunRecord["status"];
    settleReason?: string | null;
    updatedAt?: number;
    sessionId?: string | null;
    dispatchCause?: SquadRunRecord["dispatchCause"];
  }): void;
  newAgentId(): string;
  newItemId(agentId: string): string;
};

async function setup(): Promise<Fixture> {
  const repoRoot = await makeRepo();
  const db = new DatabaseSync(":memory:");
  runTasksDatabaseMigrations(db);
  const createRuntime = async (): Promise<SquadRuntime> =>
    createSquadRuntime({
      db,
      workspacePath: repoRoot,
      workspaceIdentity: WS,
      readExperimentEnabled: () => true,
    });
  const service = createSquadRuntimeService({
    createRuntime,
    readExperimentEnabled: async () => true,
    archiveSquadAndTransfer: async () => {
      throw new Error("本用例不涉及归档转交");
    },
    getInboxItemRepo: () => createInboxItemRepo(db),
    logWarn: () => {},
  });
  const runtime = await createRuntime();
  const itemIds = new Set<string>();
  const agentIds = new Set<string>();
  return {
    runtime,
    service,
    target: { path: repoRoot, identity: WS },
    insertRun(input) {
      const at = input.updatedAt ?? Date.now();
      runtime.squadRunRepo.insert({
        runId: input.runId,
        workspaceKey: WS,
        workspacePath: repoRoot,
        workItemId: input.workItemId ?? "wi-user",
        parentWorkItemId: input.workItemId ?? "wi-user",
        agentId: input.agentId ?? ASSIGNEE,
        isLeaderTask: false,
        branch: null,
        dirName: null,
        status: input.status ?? "discarded",
        sessionId: input.sessionId ?? null,
        dispatchCause: input.dispatchCause ?? null,
        causedByRunId: null,
        openedAt: at,
        settleReason: input.settleReason ?? null,
        createdAt: at,
        updatedAt: at,
      });
    },
    newAgentId() {
      const agent = runtime.teamAgentService.create({
        name: `recheck-agent-${agentIds.size}`,
        systemPrompt: "s",
        memoryScope: "project",
        maxConcurrentRuns: 1,
      });
      agentIds.add(agent.id);
      return agent.id;
    },
    newItemId(agentId: string) {
      const id = `recheck-wi-${itemIds.size}`;
      itemIds.add(id);
      runtime.workItemRepo.insert({
        id,
        workspaceIdentity: WS,
        workspacePath: repoRoot,
        title: `标题-${id}`,
        body: "",
        status: "in_progress",
        assignee: { type: "agent", id: agentId },
        labels: [],
        properties: {},
        position: 0,
      });
      return id;
    },
  };
}

/* ───────────────── W3-① 熔断：四出口穷举矩阵（独立构造，每格四向） ───────────────── */

/* 四条产出 run 的出口（对着 `planDispatch` 的源码逐条读出，不是照抄实现轮用例的出口清单）：
   · ① `assignee.type === "agent"` 的 agent 腿；
   · ② `targetOverride`（评论点名）腿 —— 判据必须落在**点名者**上，不是 assignee 上；
   · ③ `leaderOverride`（评论点名队长）腿；
   · ④ `assignee.type === "squad"` 的队长腿（③④ 的目标都经 `planLeaderRunEvents` ⇒ `leaderAgentId`）。
   每格四向：命中（无 run + 恰一条 skip 留痕）/ 差一次（照常 run）/ 别的 agent 命中（不受影响）/
   无证据（`agentBreakerCounts` 缺席或空表 ⇒ 不拦）。只钉「命中 ⇒ 无 run」会被「永远 skip」
   的实现骗过；只钉四个方向中的一个则漏掉「判错 agent」这条最隐蔽的分叉（不报错）。 */
test("W3-① 熔断四出口穷举：命中⇒skip / 差一次⇒放行 / 别的 agent⇒放行 / 无证据⇒放行", () => {
  const exits: ReadonlyArray<{
    name: string;
    /** 本出口**该被熔断挡住**的目标 agent。 */
    targetAgentId: string;
    /** 与本次派发无关的另一个 agent（熔断它不得影响本出口）。 */
    unrelatedAgentId: string;
    dispatch(
      c: Array<{ agentId: string; count: number }> | null | undefined,
    ): ReturnType<typeof planDispatch>;
  }> = [
    {
      name: "① assignee=agent",
      targetAgentId: ASSIGNEE,
      unrelatedAgentId: "ta-else-1",
      dispatch: (agentBreakerCounts) =>
        planDispatch({
          workItem: agentItem(ASSIGNEE),
          squad: null,
          trigger: "user",
          runClass: "standalone",
          agentBreakerCounts,
        }),
    },
    {
      name: "② targetOverride（评论点名者）",
      targetAgentId: MENTIONED,
      // 这一格**故意**让 unrelated 就是 assignee 本人：熔断判据若写成「按 assignee 判」，
      // 本条会被拦下 ⇒ 红。这正是「判错 agent 不报错」的那条分叉。
      unrelatedAgentId: ASSIGNEE,
      dispatch: (agentBreakerCounts) =>
        planDispatch({
          workItem: agentItem(ASSIGNEE),
          squad: null,
          trigger: "user",
          runClass: "standalone",
          targetOverride: { type: "agent", id: MENTIONED },
          agentBreakerCounts,
        }),
    },
    {
      name: "③ leaderOverride（评论点名队长）",
      targetAgentId: LEADER,
      // 同上：unrelated 是队员 —— 熔断按 `leaderAgentId` 判，不是「小队里有人熔断就停」。
      unrelatedAgentId: MEMBER,
      dispatch: (agentBreakerCounts) =>
        planDispatch({
          workItem: userItem(),
          squad: null,
          trigger: "user",
          leaderOverride: { squad: enabledSquad() },
          agentBreakerCounts,
        }),
    },
    {
      name: "④ assignee=squad（指派给小队 ⇒ 队长）",
      targetAgentId: LEADER,
      unrelatedAgentId: MEMBER,
      dispatch: (agentBreakerCounts) =>
        planDispatch({
          workItem: squadItem(),
          squad: enabledSquad(),
          trigger: "user",
          agentBreakerCounts,
        }),
    },
  ];

  for (const exit of exits) {
    // 方向 1：命中（窗口内计数 = 阈值）⇒ 一条 run 都不产，且恰好一条 skip 留痕点名熔断与计数。
    const tripped = exit.dispatch(counts([exit.targetAgentId, SQUAD_BREAKER_THRESHOLD]));
    assert.equal(
      runsOf(tripped).length,
      0,
      `${exit.name}：熔断命中 ⇒ 不得产出 run.enqueued（漏这支 = 该入口绕过熔断且不报错）`,
    );
    const skip = skipsOf(tripped);
    assert.equal(skip.length, 1, `${exit.name}：skip 必须恰好留痕一条（不多不少）`);
    assert.match(
      String(skip[0]?.reason),
      /熔断/,
      `${exit.name}：留痕文案要点名熔断（人要知道为什么没派）`,
    );
    assert.ok(
      String(skip[0]?.reason).includes(String(SQUAD_BREAKER_THRESHOLD)),
      `${exit.name}：留痕应带本次计数/阈值（审计要知道烧到第几次）`,
    );

    // 方向 2：差一次（阈值 − 1）⇒ 照常派发，且目标就是该出口的目标 agent。
    const below = exit.dispatch(counts([exit.targetAgentId, SQUAD_BREAKER_THRESHOLD - 1]));
    assert.deepEqual(
      runsOf(below).map((event) => event.agentId),
      [exit.targetAgentId],
      `${exit.name}：计数 < 阈值 ⇒ 必须照常派给目标 agent（阈值两侧结论必须相反）`,
    );

    // 方向 3：熔断的是**别的** agent ⇒ 本出口不受影响（局部故障不得放大成全局停摆）。
    const unrelated = exit.dispatch(counts([exit.unrelatedAgentId, SQUAD_BREAKER_THRESHOLD]));
    assert.deepEqual(
      runsOf(unrelated).map((event) => event.agentId),
      [exit.targetAgentId],
      `${exit.name}：别的 agent 熔断不得拦下本出口（熔断按目标 agent 判）`,
    );

    // 方向 4：无证据（缺席 / 空表）⇒ 放行（缺证据当熔断会把派发整块静默停掉）。
    for (const noEvidence of [undefined, null, [] as Array<{ agentId: string; count: number }>]) {
      const released = exit.dispatch(noEvidence);
      assert.equal(
        runsOf(released).length,
        1,
        `${exit.name}：无熔断证据（${JSON.stringify(noEvidence)}）⇒ 必须放行`,
      );
    }
  }
});

/* ───────────────── W3-② 熔断窗口：只认窗口内的看门狗族（四类排除项逐条） ───────────────── */

test("W3-② 熔断计数窗口口径：族外（取消/自由文本/NULL）与窗口外都不计，且不跨 agent 串台", async () => {
  const f = await setup();
  const windowMs = SQUAD_BREAKER_WINDOW_MINUTES * MS_PER_MINUTE;
  const now = Date.now();

  // 族内三码值各一条（一个都不能漏：漏一个码值 = 熔断晚一轮生效，且不报错）。
  f.insertRun({
    runId: "in-dead",
    agentId: ASSIGNEE,
    settleReason: SQUAD_RUN_SETTLE_REASON_WATCHDOG_DEAD_SESSION,
  });
  f.insertRun({
    runId: "in-ttl",
    agentId: ASSIGNEE,
    settleReason: SQUAD_RUN_SETTLE_REASON_WATCHDOG_TTL,
  });
  f.insertRun({
    runId: "in-grace",
    agentId: ASSIGNEE,
    settleReason: SQUAD_RUN_SETTLE_REASON_WATCHDOG_IDLE_GRACE,
  });
  // 窗口**内边**（贴近窗口起点、仍在窗内）：必须计入（窗边界的方向不能反）。
  f.insertRun({
    runId: "in-edge",
    agentId: "ta-edge",
    settleReason: SQUAD_RUN_SETTLE_REASON_WATCHDOG_TTL,
    updatedAt: now - windowMs + 60_000,
  });
  // 四类排除项（同 agent、窗口内）：用户取消 / 自由文本（failMemberRun 的失败原文也落这一列）/
  // NULL（常规结算与遗留行）。它们都不是「看门狗结算」。
  f.insertRun({
    runId: "x-cancel",
    agentId: ASSIGNEE,
    settleReason: SQUAD_RUN_SETTLE_REASON_USER_CANCEL,
  });
  f.insertRun({ runId: "x-free", agentId: ASSIGNEE, settleReason: "replay failed: 沙箱不可用" });
  f.insertRun({ runId: "x-null", agentId: ASSIGNEE, settleReason: null });
  // 窗口外（同一 agent、族内码值）：是「窗口滑出 ⇒ 自动愈合」的判据面。
  f.insertRun({
    runId: "x-out",
    agentId: ASSIGNEE,
    settleReason: SQUAD_RUN_SETTLE_REASON_WATCHDOG_TTL,
    updatedAt: now - windowMs - 60_000,
  });
  // 别的 agent 的族内结算：不得算到本 agent 头上。
  f.insertRun({
    runId: "other-agent",
    agentId: "ta-other",
    settleReason: SQUAD_RUN_SETTLE_REASON_WATCHDOG_TTL,
  });

  const read = await f.service.countWatchdogSettlementsByAgent(f.target);
  assert.deepEqual(
    new Map(read.map((entry) => [entry.agentId, entry.count])),
    new Map([
      [ASSIGNEE, 3],
      ["ta-edge", 1],
      ["ta-other", 1],
    ]),
    "窗口内 watchdog 族逐 agent 计数：取消 / 自由文本 / NULL / 窗口外都不计，也不跨 agent 串台",
  );
});

test("W3-② 熔断计数与真实结算路径同源：openMemberRun ⇒ failMemberRun(watchdog) ⇒ 窗口计数 +1", async () => {
  const f = await setup();
  const agentId = f.newAgentId();
  const itemId = f.newItemId(agentId);
  const before = new Map(
    (await f.service.countWatchdogSettlementsByAgent(f.target)).map((e) => [e.agentId, e.count]),
  );
  assert.equal(before.get(agentId) ?? 0, 0, "前置：该 agent 窗口内零结算");

  await f.runtime.lifecycle.openMemberRun({
    runId: "real-settle-run",
    workItemId: itemId,
    parentWorkItemId: itemId,
    agentId,
    isLeaderTask: false,
    dispatchCause: "leader_tool",
  });
  await f.runtime.lifecycle.failMemberRun({
    runId: "real-settle-run",
    reason: SQUAD_RUN_SETTLE_REASON_WATCHDOG_TTL,
  });

  const after = new Map(
    (await f.service.countWatchdogSettlementsByAgent(f.target)).map((e) => [e.agentId, e.count]),
  );
  assert.equal(
    after.get(agentId) ?? 0,
    1,
    "结算事实（settle_reason）必须被派生计数读到：真实结算路径写下的码值与 SQL 的族判据是同源",
  );
});

/* ───────────────── W3-③ 重试预算：四条边界 + 身份/成因（独立夹具） ───────────────── */

test("W3-③ 重试登记：新 runId、origin=watchdog 可读回、成因继承（null 与具体值两格）", async () => {
  const f = await setup();
  const agentId = f.newAgentId();
  const itemId = f.newItemId(agentId);

  f.insertRun({
    runId: "retry-src-1",
    workItemId: itemId,
    agentId,
    settleReason: SQUAD_RUN_SETTLE_REASON_WATCHDOG_DEAD_SESSION,
    dispatchCause: "leader_tool",
  });
  const first = await f.service.registerWatchdogRetry(f.target, { settledRunId: "retry-src-1" });
  assert.equal(first.kind, "registered");
  const retryRunId = first.kind === "registered" ? first.runId : "";
  assert.notEqual(retryRunId, "retry-src-1", "重试是新派发决策 ⇒ 铸新 runId");

  const viaList = f.runtime.squadDeferredDispatchRepo.list(WS);
  assert.equal(viaList.length, 1, "同对只登记一条");
  assert.equal(viaList[0]?.origin, "watchdog", "来源第三值落盘（读回经 readOrigin 闭集校验）");
  assert.equal(viaList[0]?.runId, retryRunId);
  assert.equal(viaList[0]?.dispatchCause, "leader_tool", "成因继承被结算行（不推断、不写死）");

  // 成因 NULL 的一格：继承 NULL（不得凭空造一个成因档位）。
  const agentId2 = f.newAgentId();
  const itemId2 = f.newItemId(agentId2);
  f.insertRun({
    runId: "retry-src-null",
    workItemId: itemId2,
    agentId: agentId2,
    settleReason: SQUAD_RUN_SETTLE_REASON_WATCHDOG_TTL,
    dispatchCause: null,
  });
  await f.service.registerWatchdogRetry(f.target, { settledRunId: "retry-src-null" });
  const nullCause = f.runtime.squadDeferredDispatchRepo.find(WS, itemId2, agentId2);
  assert.equal(nullCause?.dispatchCause, null, "被结算行没有成因 ⇒ 重试义务同样没有（纯搬运）");
});

test("W3-③ 重试预算：同对第二次看门狗结算 ⇒ budget_exhausted（终身口径，禁重试风暴）", async () => {
  const f = await setup();
  const agentId = f.newAgentId();
  const itemId = f.newItemId(agentId);

  f.insertRun({
    runId: "budget-1",
    workItemId: itemId,
    agentId,
    settleReason: SQUAD_RUN_SETTLE_REASON_WATCHDOG_TTL,
  });
  const first = await f.service.registerWatchdogRetry(f.target, { settledRunId: "budget-1" });
  assert.equal(first.kind, "registered", "第一次看门狗结算 ⇒ 登记");

  // 同对再有一条看门狗结算行（`run_id <> ?` 只排除**本次**这一行 ⇒ 另一次必须计入预算）。
  f.insertRun({
    runId: "budget-2",
    workItemId: itemId,
    agentId,
    settleReason: SQUAD_RUN_SETTLE_REASON_WATCHDOG_DEAD_SESSION,
  });
  const second = await f.service.registerWatchdogRetry(f.target, { settledRunId: "budget-2" });
  assert.deepEqual(second, { kind: "budget_exhausted" }, "同对第二次 ⇒ 不再重试");
  assert.equal(
    f.runtime.squadDeferredDispatchRepo.list(WS).length,
    1,
    "预算用尽时不得新增/覆盖义务行",
  );

  // 反向：**不同的对**不共享预算（同 agent 换个工作项 ⇒ 仍可登记）。
  const itemIdB = f.newItemId(agentId);
  f.insertRun({
    runId: "budget-other-pair",
    workItemId: itemIdB,
    agentId,
    settleReason: SQUAD_RUN_SETTLE_REASON_WATCHDOG_TTL,
  });
  const otherPair = await f.service.registerWatchdogRetry(f.target, {
    settledRunId: "budget-other-pair",
  });
  assert.equal(otherPair.kind, "registered", "预算按 (workItem, agent) 对 —— 换对不共享已用额度");
});

test("W3-③ 重试拒绝面：用户取消 / 不存在 runId ⇒ 响亮抛且不留义务行", async () => {
  const f = await setup();
  const agentId = f.newAgentId();
  const itemId = f.newItemId(agentId);

  f.insertRun({
    runId: "cancel-run",
    workItemId: itemId,
    agentId,
    settleReason: SQUAD_RUN_SETTLE_REASON_USER_CANCEL,
  });
  await assert.rejects(
    () => f.service.registerWatchdogRetry(f.target, { settledRunId: "cancel-run" }),
    (error: unknown) =>
      error instanceof Error && error.message.includes(SQUAD_RUN_SETTLE_REASON_USER_CANCEL),
    "用户取消不自动重试（用户已表态）：拒绝文案要点名拿到的是哪个码值",
  );
  await assert.rejects(
    () => f.service.registerWatchdogRetry(f.target, { settledRunId: "no-such-run" }),
    (error: unknown) => error instanceof Error && error.message.includes("no-such-run"),
    "runId 不存在 ⇒ 抛（静默 no-op 会让「结算过但没人重试」无从回答）",
  );
  assert.equal(f.runtime.squadDeferredDispatchRepo.list(WS).length, 0, "两条拒绝路径都不留行");
});

test("W3-③ 重试并入别的通道：既有 comment 义务 ⇒ coalesced（不新增第二行，不丢重试语义）", async () => {
  const f = await setup();
  const agentId = f.newAgentId();
  const itemId = f.newItemId(agentId);

  const inserted = f.runtime.squadDeferredDispatchRepo.insertIfAbsent({
    runId: "comment-obligation",
    workspaceKey: WS,
    workItemId: itemId,
    agentId,
    dispatchCause: "comment",
    origin: "comment",
    createdAt: Date.now(),
    updatedAt: Date.now(),
  });
  assert.equal(inserted, true, "前置：评论义务已登记");

  f.insertRun({
    runId: "coalesce-src",
    workItemId: itemId,
    agentId,
    settleReason: SQUAD_RUN_SETTLE_REASON_WATCHDOG_IDLE_GRACE,
  });
  const outcome = await f.service.registerWatchdogRetry(f.target, { settledRunId: "coalesce-src" });
  assert.deepEqual(
    outcome,
    { kind: "coalesced", targetRunId: "comment-obligation" },
    "并入既有义务并回报**并到了哪一条**（义务表不变式：每对至多一行）",
  );
  const rows = f.runtime.squadDeferredDispatchRepo.list(WS);
  assert.deepEqual(
    rows.map((row) => row.origin),
    ["comment"],
    "既有行的来源不得被改写成 watchdog",
  );
});

/* ───────────────── W3-④ 工具臂判定：四态 + 阈值边界（口径 A 的判定半） ───────────────── */

const toolCall = (
  over: Partial<{
    toolCallId: string;
    toolName: string;
    status: "pending" | "running" | "completed" | "failed" | "denied";
    startedAt: number | null;
  }> = {},
) => ({
  toolCallId: "tc-x",
  toolName: "bash",
  status: "running" as const,
  startedAt: null as number | null,
  ...over,
});

test("W3-④ 工具臂判定：恰好等于阈值不提醒（严格大于）、超 1ms 提醒 —— 边界两侧结论相反", () => {
  const now = 1_800_000_000_000;
  const thresholdMinutes = 5;
  const thresholdMs = thresholdMinutes * MS_PER_MINUTE;
  const decisions = decideSquadToolWatchdog({
    observations: [
      {
        runId: "exact",
        agentId: "ta-1",
        sessionId: "s-exact",
        activeToolCalls: [toolCall({ toolCallId: "tc-exact", startedAt: now - thresholdMs })],
      },
      {
        runId: "over-by-1ms",
        agentId: "ta-1",
        sessionId: "s-over",
        activeToolCalls: [toolCall({ toolCallId: "tc-over", startedAt: now - thresholdMs - 1 })],
      },
      {
        runId: "under-by-1ms",
        agentId: "ta-1",
        sessionId: "s-under",
        activeToolCalls: [toolCall({ toolCallId: "tc-under", startedAt: now - thresholdMs + 1 })],
      },
    ],
    now,
    toolTimeoutMinutesFor: () => thresholdMinutes,
  });
  assert.deepEqual(
    decisions.map((decision) => [decision.kind, decision.runId]),
    [["alert_tool_timeout", "over-by-1ms"]],
    "阈值是「严格超过」：= 阈值不提醒、+1ms 提醒、−1ms 不提醒（边界写反会早/晚一轮，不报错）",
  );
});

test("W3-④ 工具臂判定：状态与时钟事实逐格 —— 只有 running 且有 startedAt 才计时", () => {
  const now = 1_800_000_000_000;
  const long = now - 60 * MS_PER_MINUTE;
  const decisions = decideSquadToolWatchdog({
    observations: [
      {
        runId: "statuses",
        agentId: "ta-1",
        sessionId: "s-statuses",
        activeToolCalls: [
          toolCall({ toolCallId: "pending", status: "pending", startedAt: long }),
          toolCall({ toolCallId: "completed", status: "completed", startedAt: long }),
          toolCall({ toolCallId: "failed", status: "failed", startedAt: long }),
          toolCall({ toolCallId: "denied", status: "denied", startedAt: long }),
          toolCall({ toolCallId: "no-clock", status: "running", startedAt: null }),
        ],
      },
      { runId: "empty", agentId: "ta-1", sessionId: "s-empty", activeToolCalls: [] },
      { runId: "no-signal", agentId: "ta-1", sessionId: "s-none", activeToolCalls: null },
    ],
    now,
    toolTimeoutMinutesFor: () => 5,
  });
  assert.deepEqual(
    decisions,
    [{ kind: "skip_tool_no_signal", runId: "no-signal", agentId: "ta-1", sessionId: "s-none" }],
    "已结束/还没跑/没有开始时刻的调用都不是「超时的在跑工具」；空数组 = 确实没有；(null = 无信号)",
  );
});

test("W3-④ 工具臂判定：阈值按 agent 解析（同一时长两个 agent 结论相反）；同 run 两个工具各自成条", () => {
  const now = 1_800_000_000_000;
  const elapsed = 2 * MS_PER_MINUTE;
  const decisions = decideSquadToolWatchdog({
    observations: [
      {
        // 同一个时长（2 分钟）：阈值 1 分钟的 agent 命中、阈值 10 分钟的不命中。
        runId: "strict-agent",
        agentId: "ta-strict",
        sessionId: "s-1",
        activeToolCalls: [toolCall({ toolCallId: "a", startedAt: now - elapsed })],
      },
      {
        runId: "loose-agent",
        agentId: "ta-loose",
        sessionId: "s-2",
        activeToolCalls: [toolCall({ toolCallId: "b", startedAt: now - elapsed })],
      },
      {
        // 同一 run 上两条超时工具：两条事实（执行臂按 (run, toolCallId) 首见留痕）。
        runId: "two-calls",
        agentId: "ta-strict",
        sessionId: "s-3",
        activeToolCalls: [
          toolCall({ toolCallId: "c1", startedAt: now - elapsed }),
          toolCall({ toolCallId: "c2", startedAt: now - elapsed }),
        ],
      },
    ],
    now,
    toolTimeoutMinutesFor: (agentId) => (agentId === "ta-strict" ? 1 : 10),
  });
  assert.deepEqual(
    decisions.map((decision) => [
      decision.runId,
      decision.kind === "alert_tool_timeout" ? decision.toolCallId : decision.kind,
    ]),
    [
      ["strict-agent", "a"],
      ["two-calls", "c1"],
      ["two-calls", "c2"],
    ],
    "阈值按行上的 agent 解析（同 2 分钟：1 分钟阈值命中、10 分钟阈值不命中）；两条超时工具各成一条",
  );
  const first = decisions[0];
  assert.ok(first.kind === "alert_tool_timeout");
  assert.equal(first.elapsedMs, elapsed);
  assert.equal(first.thresholdMs, MS_PER_MINUTE);
  assert.equal(first.toolName, "bash");
});

/* ───────────────── W3-⑤ 跨轮：run_stalled 的 dedup 口径（W2 结算留痕 vs W3 工具提醒） ───────────────── */

/* 两处产生点（W2 的结算留痕 / W3 的工具超时提醒）共用 `buildRunStalledInboxItem`，其 dedupKey 形状
   由 `computeInboxDedupKey` 单源给出：`run_stalled:<runId>` —— **按 run 收敛，不含原因**。
   后果（本次复验的观察项，非本用例的判据）：同一 run 上先到的留痕占住那一格，后到的事实
   （例如「这条 run 已被看门狗结算」）在收件箱里**看不出来**（`insertIfAbsent` 不改行）。
   本用例钉住的是「两处确实是同一格」这条机制，防止将来一处分叉成两个 kind / 两种键。 */
test("W3-⑤ run_stalled dedup：同 run 的两条事实共用一格（按 runId 收敛，先写者占位）", async () => {
  const repoRoot = await makeRepo();
  const db = new DatabaseSync(":memory:");
  runTasksDatabaseMigrations(db);
  const repo = createInboxItemRepo(db);
  const base = {
    workspaceKey: "ws-dedup",
    workspacePath: repoRoot,
    workItemId: "wi-1",
    workItemTitle: "标题",
    runId: "run-shared",
    agentId: "ta-1",
    sessionId: "sess-1",
  };
  const toolAlert = buildRunStalledInboxItem({
    ...base,
    reason: "watchdog_tool_timeout：工具「bash」(tc-1) 已运行 6 分钟，超过阈值 5 分钟",
  });
  const settlement = buildRunStalledInboxItem({
    ...base,
    reason: SQUAD_RUN_SETTLE_REASON_WATCHDOG_DEAD_SESSION,
  });
  assert.equal(toolAlert.dedupKey, settlement.dedupKey, "两处产生点必须落在同一个 dedupKey 上");

  assert.equal(repo.insertIfAbsent(toolAlert), true, "先到的工具提醒占位");
  assert.equal(repo.insertIfAbsent(settlement), false, "后到的结算留痕被同一格吸收（不改行）");
  const rows = repo.listByWorkspace("ws-dedup");
  assert.deepEqual(
    rows.map((row) => [row.runId, row.detail.reason]),
    [["run-shared", toolAlert.detail.reason]],
    "收件箱仍只有一格，detail.reason 停在先写者（结算事实在台账/日志可见，收件箱里不可见）",
  );

  // 不同 run 不互相吸收（反向格：dedup 收敛在 run 维度，不是全局一格）。
  assert.equal(
    repo.insertIfAbsent(buildRunStalledInboxItem({ ...base, runId: "run-other", reason: "x" })),
    true,
    "另一条 run 是另一件事 ⇒ 另一格",
  );
  assert.equal(repo.listByWorkspace("ws-dedup").length, 2);
});
