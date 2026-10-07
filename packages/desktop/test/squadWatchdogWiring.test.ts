// eslint-disable-next-line typescript-eslint/triple-slash-reference -- 与 hostSquadDispatch.test.ts 同一处声明（不为本文件另写一份）
/// <reference path="../../services/src/runtime-tools/node-forge.d.ts" />
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { MS_PER_MINUTE } from "@zcode/shared";
import { ZCODE_AGENT_RUNTIME_UNAVAILABLE_CODE, type ISquadRuntimeService } from "@zcode/services";
import { createInboxItemRepo } from "@zcode/services/node";
import { createSquadRuntimeService } from "@zcode/services/node";
import {
  createSquadRunCanceller,
  createSquadRunSessionStopper,
} from "../src/host/squadDispatch.js";
import { runTasksDatabaseMigrations } from "../../services/src/session/tasksDatabase/migrations.js";
import { createSquadRuntime } from "../../services/src/workitem/squadRuntime.js";
import { planBranches } from "../../services/src/worktree/branchNaming.js";
import { slugForId } from "../../services/src/workitem/slug.js";
import type { SquadRuntime } from "../../services/src/workitem/squadContracts.js";
import {
  createSquadWatchdogSweepPorts,
  runSquadWatchdogSweep,
  SQUAD_WATCHDOG_IDLE_STOP_GRACE_MS,
  startSquadWatchdogTick,
  type SquadSessionStopFn,
  type SquadWatchdogLogger,
  type SquadWatchdogSweepPorts,
} from "../src/host/squadWatchdogTick.js";

/* W2（看门狗六件套）：**执行臂**的接线与行为 —— 启动和解的队员臂 + 在线 tick。

   为什么必须有这一层用例：判定（`decideSquadWatchdog`，W1）与结算（`failMemberRun`，C1/C3）都各自
   有测试，但「谁去调判定、拿到决策之后动谁」此前**一条线都没接**（六件零实现，欠账报告 :82-88）。
   漏接的表现是「功能整块空转且不报错」：组件全绿、判定正确、台账一条不动。

   本文件前半用**真实 runtime + 真实 sqlite 台账**驱动执行臂（断言实体状态），后半是 host 源码守卫
   （接线存在性与次序契约）—— 两类证据缺一不可：守卫只证明「调用了」，行为只证明「这一条路径对」。 */

const WS = "w2-host-ws";
const NOW = 1_700_000_000_000;

const silentLogger: SquadWatchdogLogger = { info: () => {}, warn: () => {} };

/** 运行期不可得（agent 进程不在）：`createBoundSessionExecutingProbe` 口径 = 没有东西在执行。 */
function runtimeUnavailable(): Error {
  const error = new Error("agent runtime unavailable");
  (error as Error & { code?: string }).code = ZCODE_AGENT_RUNTIME_UNAVAILABLE_CODE;
  return error;
}

const run = promisify(execFile);

/** 一次性临时 git 仓库：`openMemberRun` 要真的 `git worktree add`（看门狗看的是真实台账 + 真实树）。 */
async function makeRepo(): Promise<string> {
  const root = mkdtempSync(join(tmpdir(), "squad-watchdog-"));
  await run("git", ["init", "-q", "-b", "main"], { cwd: root });
  await run("git", ["config", "user.email", "t@t"], { cwd: root });
  await run("git", ["config", "user.name", "t"], { cwd: root });
  writeFileSync(join(root, "a.txt"), "1\n");
  await run("git", ["add", "-A"], { cwd: root });
  await run("git", ["commit", "-qm", "init"], { cwd: root });
  return root;
}

type Fixture = {
  repoRoot: string;
  runtime: SquadRuntime;
  service: ISquadRuntimeService;
  ports: SquadWatchdogSweepPorts;
  target: { path: string; identity: string };
};

type ProbeMode = "unavailable" | "executing" | "probe_error";

async function setup(options?: {
  probe?: ProbeMode;
  stopSession?: SquadSessionStopFn | null;
  idleMsByRunId?: readonly (readonly [string, number])[];
}): Promise<Fixture> {
  const repoRoot = await makeRepo();
  const db = new DatabaseSync(":memory:");
  runTasksDatabaseMigrations(db);
  const target = { path: repoRoot, identity: WS };
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
    // 收件箱 repo 的懒取口（组合根口径：与 node.ts 的 `getInboxItemRepo` 同形）。
    getInboxItemRepo: () => createInboxItemRepo(db),
    logWarn: () => {},
  });
  const runtime = await createRuntime();
  const mode = options?.probe ?? "unavailable";
  const ports = createSquadWatchdogSweepPorts({
    squadRuntime: service,
    agentService: {
      async readSession() {
        // runtime 不在 = 明确「没有东西在执行」（同既有探针的判据）。
        if (mode === "unavailable") throw runtimeUnavailable();
        // 探测本身失败 = 「不可得」（判定面必须不猜，不得当成死会话）。
        if (mode === "probe_error") throw new Error("readSession 探测异常");
        // 在跑一轮 turn（`hasBlockingActiveSnapshotRuntime` 只认 runtime 活动字段/权限/工具调用）。
        return { runtime: { activeTurnId: "turn-live" }, projection: {} };
      },
    } as never,
    stopSession: options?.stopSession ?? null,
    logger: silentLogger,
  });
  const idle = options?.idleMsByRunId;
  return {
    repoRoot,
    runtime,
    service,
    target,
    ports: idle ? { ...ports, readIdleMsByRunId: async () => new Map(idle) } : ports,
  };
}

/** 一条**已绑会话**的队员 run（真实工作树 + 真实台账行）：看门狗判定面要求它有会话才进探测档。 */
async function openBoundMemberRun(
  f: Fixture,
  input: { runId: string; sessionId: string; agentId?: string; itemId?: string },
): Promise<{ itemId: string; agentId: string }> {
  const opened = await openMemberRunRow(f, input);
  await f.runtime.lifecycle.bindMemberRunSession({
    runId: input.runId,
    sessionId: input.sessionId,
  });
  return opened;
}

/** 队员 run 的**派发形态**（真实工作树 + 真实台账行），会话由调用方按用例决定绑不绑。 */
async function openMemberRunRow(
  f: Fixture,
  input: { runId: string; agentId?: string; itemId?: string },
): Promise<{ itemId: string; agentId: string }> {
  const requestedAgentId = input.agentId ?? "w2-ta-a";
  const itemId = input.itemId ?? `w2-wi-${input.runId}`;
  /* 名册 id 由服务面生成（`randomUUID`，不按 name 派生）⇒ 夹具按 **name** 复用同一名队员：
     有名册定义才会走「容量/活跃」裁决（maxConcurrentRuns = 1 ⇒ 第二条派发落 queued）。 */
  const agentName = `agent-${requestedAgentId}`;
  const existingAgent = f.runtime.teamAgentService
    .list()
    .find((candidate) => candidate.name === agentName);
  const agent =
    existingAgent ??
    f.runtime.teamAgentService.create({
      name: agentName,
      systemPrompt: "s",
      memoryScope: "project",
      maxConcurrentRuns: 1,
    });
  if (f.runtime.workItemRepo.get(itemId) === null) {
    f.runtime.workItemRepo.insert({
      id: itemId,
      workspaceIdentity: WS,
      workspacePath: f.repoRoot,
      title: `标题-${itemId}`,
      body: "",
      status: "in_progress",
      assignee: { type: "agent", id: agent.id },
      labels: [],
      properties: {},
      position: 0,
    });
  }
  await f.runtime.lifecycle.openMemberRun({
    runId: input.runId,
    workItemId: itemId,
    parentWorkItemId: itemId,
    agentId: agent.id,
    isLeaderTask: false,
  });
  return { itemId, agentId: agent.id };
}

const sweep = (f: Fixture, overrides?: Partial<Parameters<typeof runSquadWatchdogSweep>[0]>) =>
  runSquadWatchdogSweep({
    targets: [f.target],
    ports: f.ports,
    logger: silentLogger,
    runScope: "all",
    pendingStops: new Map<string, number>(),
    now: () => NOW,
    ...overrides,
  });

test("在线 tick｜死会话的队员行：结算 discarded（settle_reason=watchdog_dead_session）+ run_stalled Inbox 一条；二次扫描零动作", async () => {
  const f = await setup();
  const runId = "w2-dead-session";
  const { itemId } = await openBoundMemberRun(f, { runId, sessionId: "sess-dead" });
  assert.equal(f.runtime.squadRunRepo.get(runId)?.status, "open", "前置：run 在 open（还没跑完）");

  const first = await sweep(f);

  assert.deepEqual(
    f.runtime.squadRunRepo.get(runId)?.status,
    "discarded",
    "会话已死（探测明确不在执行）⇒ 结算出活跃集（容量释放；否则这条行永远占着槽位）",
  );
  assert.equal(
    f.runtime.squadRunRepo.get(runId)?.settleReason,
    "watchdog_dead_session",
    "结算原因必须落盘（W3 的熔断窗口计数与重试预算都读它；码值单源在 squadRunRepo）",
  );
  assert.deepEqual(
    first,
    { settled: 1, stopped: 0, skipped: 0, failed: 0 },
    "本轮只该结算这一条（其余行不存在）",
  );

  const inbox = await f.service.listInboxItems();
  assert.deepEqual(
    inbox.filter((item) => item.kind === "run_stalled").map((item) => [item.runId, item.title]),
    [[runId, `标题-${itemId}`]],
    "看门狗结算必须留痕 run_stalled（含工作项标题，人才能认出是哪件事）",
  );

  // 二次扫描：同一行已不在 open ⇒ 判定面忽略它，Inbox 也**不得**多出一条（dedup 按 run 收敛）。
  const second = await sweep(f);
  assert.deepEqual(second, { settled: 0, stopped: 0, skipped: 0, failed: 0 }, "二次扫描零动作");
  assert.equal(
    (await f.service.listInboxItems()).filter((item) => item.kind === "run_stalled").length,
    1,
    "重复扫描不得刷屏（dedupKey 按 runId 收敛）",
  );
});

test("在线 tick｜失败重试：看门狗结算 ⇒ 登记恰一条 origin=watchdog 义务（新 runId）；再结算不再登记", async () => {
  const f = await setup();
  const runId = "w3-retry-first";
  const { itemId, agentId } = await openBoundMemberRun(f, { runId, sessionId: "sess-dead" });

  const first = await sweep(f);
  assert.deepEqual(first, { settled: 1, stopped: 0, skipped: 0, failed: 0 }, "先结算这一条");

  const obligations = f.runtime.squadDeferredDispatchRepo.list(WS);
  assert.equal(obligations.length, 1, "看门狗结算 ⇒ 自动登记一次重试（预算未用）");
  assert.equal(obligations[0]?.origin, "watchdog", "重试义务的来源分流位");
  assert.equal(obligations[0]?.workItemId, itemId, "重试仍打在同一工作项上");
  assert.equal(obligations[0]?.agentId, agentId, "重试仍打给同一个 agent（对的身份是预算的键）");
  assert.notEqual(
    obligations[0]?.runId,
    runId,
    "重试是**新**派发决策 ⇒ 新 runId（复用被结算行的 id 会撞 already_registered，重试静默丢失）",
  );
  assert.equal(
    f.runtime.squadRunRepo.get(runId)?.status,
    "discarded",
    "重试登记不得把已结算的行改回 open（它是另一条 run，不是这一条复活）",
  );

  /* 第二次看门狗结算（同 pair 的另一条 run）⇒ 预算已用 ⇒ **不再**登记。
     「第二次」用直插的 open 行（真树会与第一条撞同名分支，而本格只关心结算后的预算判据）。 */
  const secondRunId = "w3-retry-second";
  const now = Date.now();
  f.runtime.squadRunRepo.insert({
    runId: secondRunId,
    workspaceKey: WS,
    workspacePath: f.repoRoot,
    workItemId: itemId,
    parentWorkItemId: itemId,
    agentId,
    isLeaderTask: false,
    branch: null,
    dirName: null,
    status: "open",
    sessionId: "sess-dead-2",
    dispatchCause: null,
    causedByRunId: null,
    openedAt: now,
    settleReason: null,
    createdAt: now,
    updatedAt: now,
  });
  await sweep(f);
  assert.equal(f.runtime.squadRunRepo.get(secondRunId)?.status, "discarded", "第二条同样被结算");
  assert.equal(
    f.runtime.squadDeferredDispatchRepo.list(WS).length,
    1,
    "预算用尽（同对已有一次看门狗结算）⇒ 不再登记：重试恰一次，闭环有界",
  );
});

test("在线 tick｜逐条容错：一条坏行（结算抛）不停整轮 —— 同轮其余僵尸行照常收", async () => {
  const f = await setup();
  const good = "w2-good";
  const bad = "w2-bad";
  // 两条行落在**不同 agent** 上（各占各的容量槽；同一 agent 的第二条会被闸成 queued，不进本用例）。
  await openBoundMemberRun(f, {
    runId: good,
    sessionId: "sess-good",
    agentId: "w2-ta-good",
    itemId: "w2-wi-good",
  });
  await openBoundMemberRun(f, {
    runId: bad,
    sessionId: "sess-bad",
    agentId: "w2-ta-bad",
    itemId: "w2-wi-bad",
  });

  const ports: SquadWatchdogSweepPorts = {
    ...f.ports,
    settleRun: async (target, input) => {
      if (input.runId === bad) throw new Error("模拟结算撞跨终态");
      await f.ports.settleRun(target, input);
    },
  };
  const summary = await sweep(f, { ports });

  assert.deepEqual(
    summary,
    { settled: 1, stopped: 0, skipped: 0, failed: 1 },
    "坏行计入 failed，其余行照常结算 —— 一条坏行不得让整轮僵尸行都不被收",
  );
  assert.equal(f.runtime.squadRunRepo.get(good)?.status, "discarded", "好行必须被收");
  assert.equal(f.runtime.squadRunRepo.get(bad)?.status, "open", "坏行留 open（响亮留痕、等下轮）");
});

test("在线 tick｜探测不可得：不猜会话状态 —— 不结算、该行按 skip 记账（避免把活着的 run 判死）", async () => {
  const f = await setup({ probe: "probe_error" });
  const runId = "w2-probe-error";
  await openBoundMemberRun(f, { runId, sessionId: "sess-x" });

  const summary = await sweep(f);

  assert.equal(
    f.runtime.squadRunRepo.get(runId)?.status,
    "open",
    "探测抛错 ≠ 会话死了：探针不可得时结算会把一条活着的 run 判死（W1 档 2 的在线护栏）",
  );
  assert.deepEqual(
    summary,
    { settled: 0, stopped: 0, skipped: 1, failed: 0 },
    "记一条 skip（可见，不静默）",
  );
});

/* ---- 空闲档：先 stop 再等回调；宽限到期仍 open ⇒ 兜底结算（设计 §3.1 档 3）---- */

/** 可注入 timer 的 tick 夹具：手动推进时钟与手动触发各轮（不真等 60s）。 */
function startTickFor(
  f: Fixture,
  options: { clock: { now: number }; ports?: SquadWatchdogSweepPorts; tickMs?: number },
) {
  const callbacks: Array<() => void> = [];
  const handle = startSquadWatchdogTick({
    targets: [f.target],
    resolvePorts: () => options.ports ?? f.ports,
    logger: silentLogger,
    intervalMs: options.tickMs ?? 60_000,
    now: () => options.clock.now,
    timer: {
      setInterval: (callback) => {
        callbacks.push(callback);
        return {};
      },
      clearInterval: () => {},
    },
  });
  return { handle, fireTimer: () => callbacks.forEach((callback) => callback()) };
}

test("在线 tick｜空闲档：先 stop（台账一个字不写）；宽限到期仍在 open ⇒ 兜底结算（stop 只发一次）", async () => {
  const clock = { now: NOW };
  const stops: Array<{ runId: string; sessionId: string }> = [];
  const f = await setup({
    probe: "executing",
    // 静默 11 分钟 > 缺省空闲阈值 10 分钟（阈值单源在 shared；这里给的是「事实」不是阈值）。
    idleMsByRunId: [["w2-idle", 11 * 60_000]],
    stopSession: async ({ runId, sessionId }) => {
      stops.push({ runId, sessionId });
      return true;
    },
  });
  const runId = "w2-idle";
  await openBoundMemberRun(f, { runId, sessionId: "sess-idle" });
  /* 「已发起 stop 的集合」是**进程内状态**、由调用方（tick / 启动臂）持有 —— 与 tick 里那份同一形状。
     本用例显式跨轮复用同一张表：这才是「同一行不重复 stop」要成立的前提。 */
  const pendingStops = new Map<string, number>();

  const first = await sweep(f, { now: () => clock.now, pendingStops });

  assert.deepEqual(
    first,
    { settled: 0, stopped: 1, skipped: 0, failed: 0 },
    "空闲档的动作是 **stop**，不是结算（会话还活着：结算它 = 把一条可能马上回话的 run 判死）",
  );
  assert.deepEqual(stops, [{ runId, sessionId: "sess-idle" }], "stop 必须发给这个 run 绑定的会话");
  assert.equal(
    f.runtime.squadRunRepo.get(runId)?.status,
    "open",
    "stop 之后台账**一个字都不写**：等终态回调走既有失败出口（看门狗不越权写台账）",
  );

  // 宽限内（再扫一次）：不得重复 stop、也不得结算。
  clock.now += SQUAD_WATCHDOG_IDLE_STOP_GRACE_MS - 1;
  const duringGrace = await sweep(f, { now: () => clock.now, pendingStops });
  assert.deepEqual(
    duringGrace,
    { settled: 0, stopped: 0, skipped: 1, failed: 0 },
    "宽限内只等，不动作",
  );
  assert.equal(stops.length, 1, "同一行不得重复发起 stop（同一 tick 一轮也只发一次）");

  // 宽限到期仍停在 open（回调没来）⇒ 兜底结算，否则这条行永远占着容量槽。
  clock.now += 2;
  const afterGrace = await sweep(f, { now: () => clock.now, pendingStops });
  assert.deepEqual(
    afterGrace,
    { settled: 1, stopped: 0, skipped: 0, failed: 0 },
    "宽限到期 ⇒ 兜底结算",
  );
  assert.equal(f.runtime.squadRunRepo.get(runId)?.status, "discarded", "兜底结算后离开活跃集");
  assert.equal(
    f.runtime.squadRunRepo.get(runId)?.settleReason,
    "watchdog_idle_stop_grace_expired",
    "兜底结算的原因与「死会话 / TTL」区分开（W3 的熔断与重试预算按原因分流）",
  );
  assert.equal(stops.length, 1, "兜底结算不得再补一次 stop");
});

test("在线 tick｜重入护栏：上一轮未结束时 timer 再响只跳过（不叠加并发轮）", async () => {
  const clock = { now: NOW };
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let probes = 0;
  let probeEntered!: () => void;
  const entered = new Promise<void>((resolve) => {
    probeEntered = resolve;
  });
  const f = await setup({ probe: "unavailable" });
  const runId = "w2-reentrant";
  await openBoundMemberRun(f, { runId, sessionId: "sess-r" });
  const ports: SquadWatchdogSweepPorts = {
    ...f.ports,
    probeSession: async () => {
      probes += 1;
      probeEntered();
      await gate;
      return "not_executing";
    },
  };
  const { handle, fireTimer } = startTickFor(f, { clock, ports });

  const firstSweep = handle.sweepNow();
  // 第一轮真的进到探测里（gate 未放行）⇒ 这一拍必须被护栏挡掉。
  await entered;
  fireTimer();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(probes, 1, "重入的那一拍不得再进一次扫描（并发轮会把同一行判定两次、两次 stop）");

  release();
  await firstSweep;
  assert.equal(f.runtime.squadRunRepo.get(runId)?.status, "discarded", "被放行的那一轮照常完成");

  // 停止后 timer 再响：完全不动（stop 是终态）。
  handle.stop();
  const afterStop = handle.sweepNow();
  assert.equal(await afterStop, null, "stop 之后的 sweep 一律 null（timer 已摘）");
});

test("在线 tick｜候选累积：启动名单是起点，派发事件出现过的 workspace 经 track 加入（且去重）", async () => {
  const clock = { now: NOW };
  const f = await setup();
  const { handle } = startTickFor(f, { clock });

  assert.deepEqual(handle.candidates(), [{ path: f.repoRoot, identity: WS }], "启动名单是起点");
  handle.track({ path: f.repoRoot, identity: WS });
  assert.equal(handle.candidates().length, 1, "同一 workspace（含同一 key 的不同写法）只算一次");
  handle.track({ path: "/another/ws", identity: "other" });
  assert.deepEqual(
    handle.candidates().map((candidate) => candidate.identity),
    [WS, "other"],
    "运行期派发过的 target 必须被纳入（只按启动名单扫会漏掉启动后新派发的 workspace）",
  );
  handle.stop();
});

test("在线 tick｜C1 领地（无会话的队员行）：只留痕不结算（首见一条 run_stalled，二次扫描仍一条）", async () => {
  const f = await setup();
  const runId = "w2-c1-owned";
  // 建了树、还没绑会话（在途派发的形态）：`sessionId === null` 的队员行整块归 C1。
  await openMemberRunRow(f, { runId, itemId: "w2-c1-wi" });
  assert.equal(f.runtime.squadRunRepo.get(runId)?.sessionId, null, "前置：这条行没有会话");

  const summary = await sweep(f);

  assert.equal(
    f.runtime.squadRunRepo.get(runId)?.status,
    "open",
    "看门狗**不结算** C1 领地行：结算是终局 ⇒ 该请求的 receipt own-run 永不再 open（请求悬空），" +
      "「结算 + 同 runId 重开」是 C1 独占的处置",
  );
  assert.deepEqual(summary, { settled: 0, stopped: 0, skipped: 1, failed: 0 }, "产一条可见的 skip");
  const stalled = (await f.service.listInboxItems()).filter((item) => item.kind === "run_stalled");
  assert.equal(stalled.length, 1, "首见留痕必须接上（用户裁定「残留裁定 A」）");
  assert.equal(
    String(stalled[0]?.detail.reason),
    "watchdog_c1_owned_unbound_in_flight",
    "留痕要点名它此刻在哪一格（C1 自愈回路的四种形态之一）",
  );

  const second = await sweep(f);
  assert.deepEqual(second, { settled: 0, stopped: 0, skipped: 1, failed: 0 });
  assert.equal(
    (await f.service.listInboxItems()).filter((item) => item.kind === "run_stalled").length,
    1,
    "每 tick 重复决策不得重复登记（dedupKey 按 runId 收敛）",
  );
});

test("启动队员臂：僵尸 run（死会话 + 真实树）⇒ 和解结算 ⇒ 回收取树（分支消失）⇒ 容量释放（排队行可升级）", async () => {
  const f = await setup();
  const runId = "w2-startup-zombie";
  const { itemId, agentId } = await openBoundMemberRun(f, {
    runId,
    sessionId: "sess-gone",
    agentId: "w2-ta-zombie",
    itemId: "wi-zombie",
  });
  const branch = planBranches({
    workItemSlug: slugForId(itemId),
    agentSlug: slugForId(agentId),
  }).member;
  const git = (args: string[]) => f.runtime.git(args, { cwd: f.repoRoot });
  assert.equal(
    (await git(["rev-parse", "-q", "--verify", `refs/heads/${branch}`])).code,
    0,
    "前置：树与分支都在",
  );

  // 另一条工作项的派发在容量满（maxConcurrentRuns = 1）时排队 —— 它要靠这次结算才能被推进。
  const queuedId = "w2-startup-queued";
  f.runtime.workItemRepo.insert({
    id: "wi-queued",
    workspaceIdentity: WS,
    workspacePath: f.repoRoot,
    title: "排队的活",
    body: "",
    status: "in_progress",
    assignee: { type: "agent", id: agentId },
    labels: [],
    properties: {},
    position: 0,
  });
  const queuedOutcome = await f.runtime.lifecycle.openMemberRun({
    runId: queuedId,
    workItemId: "wi-queued",
    parentWorkItemId: "wi-queued",
    agentId,
    isLeaderTask: false,
  });
  assert.equal(queuedOutcome.kind, "queued", "前置：容量满 ⇒ 第二条派发落排队行");
  // 认领需给该 agent 的并发上限（与名册一致：夹具建的就是 maxConcurrentRuns = 1）。
  const maxConcurrentRuns = 1;
  assert.equal(
    f.runtime.squadRunRepo.claimQueuedRunForPromotion(queuedId, maxConcurrentRuns),
    false,
    "前置：僵尸行还占着容量槽（排队行认领不了）",
  );

  // 启动链的两步（次序契约由 squadWiring.test.ts 的源码守卫钉住；这里断言两步的**效果**）：
  // ① 队员和解臂（runScope=member：队长行由既有队长臂当场收口，不归它管）；
  const summary = await sweep(f, { runScope: "member" });
  // ② 回收：僵尸 run 已离开活跃集 ⇒ 它的树与分支这一次启动就该被收掉（这就是和解前移到回收之前的意义）。
  await f.service.reapStartupOrphans(f.target);

  assert.deepEqual(summary, { settled: 1, stopped: 0, skipped: 0, failed: 0 }, "队员臂收掉僵尸行");
  assert.equal(f.runtime.squadRunRepo.get(runId)?.status, "discarded", "结算");
  assert.equal(
    (await git(["rev-parse", "-q", "--verify", `refs/heads/${branch}`])).code === 0,
    false,
    "同一次启动内分支被回收（和解在回收之前 ⇒ 不必等下一次启动）",
  );
  assert.deepEqual(await f.runtime.worktreeManager.list(), [], "工作树也已收净");
  assert.equal(
    f.runtime.squadRunRepo.claimQueuedRunForPromotion(queuedId, maxConcurrentRuns),
    true,
    "容量释放（结算 ⇒ 出活跃集）⇒ 排队行可被推进臂认领（队列推进零新代码）",
  );
});

/* ---- 取消的 L2 半边（host 侧函数；Q2 裁定：本轮只交付函数 + 接缝测试，UI 入口留 UI 轮）----

   L1（台账结算）在服务面（W1 已落地）。本层是「对绑定会话发协议 stop」的**唯一**调用点：
   看门狗空闲档与用户取消共用它，故 host 里只允许一处 `stopGeneration(`（守卫见文件末）。 */

test("取消 L2｜open 行：L1 先结算（必达）⇒ 对绑定会话 stop 恰一次；重复取消不重复 stop", async () => {
  const f = await setup();
  const runId = "w2-cancel-open";
  await openBoundMemberRun(f, { runId, sessionId: "sess-cancel", itemId: "wi-cancel" });
  const stops: Array<{ runId: string; sessionId: string }> = [];
  const cancel = createSquadRunCanceller({
    readRun: async (target, id) =>
      (await f.service.listSquadRuns(target)).find((row) => row.runId === id) ?? null,
    cancelRun: (target, input) => f.service.cancelSquadRun(target, input),
    stopSession: async (input) => {
      stops.push({ runId: input.runId, sessionId: input.sessionId });
      return true;
    },
    logInfo: () => {},
    logWarn: () => {},
  });

  const outcome = await cancel(f.target, { runId });

  assert.deepEqual(outcome, { status: "settled", stop: "stopped" }, "L1 结算 + L2 stop 都成立");
  assert.equal(f.runtime.squadRunRepo.get(runId)?.status, "discarded", "L1：台账立刻出活跃集");
  assert.equal(
    f.runtime.squadRunRepo.get(runId)?.settleReason,
    "user_cancel",
    "取消的原因落 settle_reason（W3 据此把用户取消排除在熔断/重试之外）",
  );
  assert.deepEqual(stops, [{ runId, sessionId: "sess-cancel" }], "stop 必须发给该 run 绑定的会话");

  // 重复取消：L1 幂等（不再结算），L2 也**不得**再 stop（第二刀打在同一条已收口的会话上）。
  const again = await cancel(f.target, { runId });
  assert.deepEqual(again, { status: "settled", stop: "skipped" }, "已 discarded 的行不再 stop");
  assert.equal(stops.length, 1, "重复取消不重复 stop");
});

test("取消 L2｜stop 失败：L1 已经生效（取消的必达半边不受 L2 影响）", async () => {
  const f = await setup();
  const runId = "w2-cancel-stop-failed";
  await openBoundMemberRun(f, { runId, sessionId: "sess-fail", itemId: "wi-cancel-fail" });
  const cancel = createSquadRunCanceller({
    readRun: async (target, id) =>
      (await f.service.listSquadRuns(target)).find((row) => row.runId === id) ?? null,
    cancelRun: (target, input) => f.service.cancelSquadRun(target, input),
    stopSession: async () => false,
    logInfo: () => {},
    logWarn: () => {},
  });

  const outcome = await cancel(f.target, { runId });

  assert.deepEqual(outcome, { status: "settled", stop: "failed" }, "L2 失败如实上报，不冒充成功");
  assert.equal(
    f.runtime.squadRunRepo.get(runId)?.status,
    "discarded",
    "L1 是必达半边：L2 抛/失败都不得把它回滚（会话可能跑到自然终态，迟到成功由跨终态守卫拦住）",
  );
});

test("取消 L2｜stop 的唯一调用点：`stopGeneration` 收到的是该 run 的会话与 workspace（失败只 warn）", async () => {
  const calls: Array<Record<string, unknown>> = [];
  const warns: string[] = [];
  const stopper = createSquadRunSessionStopper({
    taskService: {
      async stopGeneration(input: Record<string, unknown>) {
        calls.push(input);
      },
    } as never,
    logWarn: (message) => warns.push(message),
  });

  assert.equal(
    await stopper({ target: { path: "/ws", identity: "ws-1" }, runId: "r-1", sessionId: "s-1" }),
    true,
    "成功 stop ⇒ true",
  );
  assert.deepEqual(
    calls,
    [{ taskId: "s-1", workspacePath: "/ws", workspaceIdentity: "ws-1" }],
    "复用既有 `IZCodeTaskService.stopGeneration`（无栅栏版；R-2：host 只缺这一个调用点）",
  );

  // 任务服务缺件 / 调用抛错 ⇒ false + 一条 warn（best-effort，不把取消变成失败）。
  const noService = createSquadRunSessionStopper({
    taskService: null,
    logWarn: (m) => warns.push(m),
  });
  assert.equal(
    await noService({ target: { path: "/ws", identity: "ws-1" }, runId: "r-2", sessionId: "s-2" }),
    false,
  );
  const throwing = createSquadRunSessionStopper({
    taskService: {
      async stopGeneration() {
        throw new Error("ACK rejected");
      },
    } as never,
    logWarn: (m) => warns.push(m),
  });
  assert.equal(
    await throwing({ target: { path: "/ws", identity: "ws-1" }, runId: "r-3", sessionId: "s-3" }),
    false,
  );
  assert.equal(warns.length, 2, "两条失败路径各留一条 warn（不静默）");
});

/* ---- host 源码守卫（接线存在性）：本文件前半证明「这一条路径对」，这里证明「它真的接上了」----

   没有这些断言，漏接的表现是「功能整块空转且不报错」（组件全绿、判定正确、台账一条不动）。 */

const HOST_SOURCE = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "../src/host/index.ts"),
  "utf8",
);
const TICK_SOURCE = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "../src/host/squadWatchdogTick.ts"),
  "utf8",
);
const DISPATCH_SOURCE = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "../src/host/squadDispatch.ts"),
  "utf8",
);

test("接线｜在线 tick 在 database ready 之后启动，且两条释放路径都停（timer 不得泄漏）", () => {
  const readyAt = HOST_SOURCE.indexOf('if (state.phase === "ready")');
  assert.ok(readyAt >= 0, "host 里没有 database ready 分支");
  const startAt = HOST_SOURCE.indexOf("squadWatchdogTick = startSquadWatchdogTick({");
  assert.ok(
    startAt > readyAt,
    "tick 必须在 database ready 之后启动（库没就绪时扫描只会空转/报错）",
  );
  assert.ok(startAt - readyAt < 6_000, "tick 启动点必须就在 ready 分支里，而不是文件另一处");
  assert.equal(
    (HOST_SOURCE.match(/startSquadWatchdogTick\(/g) ?? []).length,
    1,
    "tick 只该启动一次（第二处启动 = 两个定时器扫同一批行）",
  );

  // 两条释放路径（正常 dispose 与 bestEffort dispose）都要摘掉定时器。
  assert.equal(
    (HOST_SOURCE.match(/stopSquadWatchdogTick\(/g) ?? []).length,
    3,
    "stopSquadWatchdogTick 应是「两处调用 + 一处定义」（少一处 = 那条释放路径上定时器泄漏）",
  );
  assert.match(
    HOST_SOURCE,
    /async function disposeHostResources\([\s\S]*?stopSquadWatchdogTick\(`dispose:\$\{reason\}`\)/,
    "正常释放路径必须停 tick",
  );
  assert.match(
    HOST_SOURCE,
    /function disposeHostResourcesBestEffort\([\s\S]*?stopSquadWatchdogTick\(`disposeBestEffort:\$\{reason\}`\)/,
    "best-effort 释放路径同样必须停 tick",
  );
});

test("接线｜派发桥把出现过的 workspace 交给 tick 累积（启动后新派发的 workspace 不得漏扫）", () => {
  const implAt = HOST_SOURCE.indexOf("async function runSquadDispatch(");
  assert.ok(implAt >= 0, "host 里没有 runSquadDispatch");
  const handlerAt = HOST_SOURCE.indexOf('parentPort.on("message",', implAt);
  const bridge = HOST_SOURCE.slice(implAt, handlerAt);
  assert.match(
    bridge,
    /squadWatchdogTick\?\.track\(target\);/,
    "派发桥必须把 target 交给 tick（只按启动 warm 名单扫会整块漏掉启动后新派发的 workspace）",
  );
});

test("接线｜host 里 `stopGeneration` 调用点唯一（防第二套停会话路径）", () => {
  const occurrences = (DISPATCH_SOURCE.match(/\.stopGeneration\(/g) ?? []).length;
  assert.equal(
    occurrences,
    1,
    `squadDispatch.ts 里 .stopGeneration( 应恰 1 处（实际 ${occurrences}）`,
  );
  assert.equal(
    (HOST_SOURCE.match(/\.stopGeneration\(/g) ?? []).length,
    0,
    "host/index.ts 不得直接停会话（唯一调用点在 createSquadRunSessionStopper）",
  );
  assert.equal(
    (TICK_SOURCE.match(/\.stopGeneration\(/g) ?? []).length,
    0,
    "tick 只经注入的 stopSession 端口停会话（停谁只有一处判据）",
  );
});

test("接线｜队员和解臂只收队员行，且与在线 tick 共用同一份扫描实现", () => {
  assert.match(
    HOST_SOURCE,
    /async function settleStaleMemberRunsBestEffort\([\s\S]*?runScope: "member"[\s\S]*?pendingStops: new Map/,
    "启动队员臂必须显式限定 runScope=member（队长行由既有队长臂当场收口）",
  );
  assert.match(
    HOST_SOURCE,
    /async function settleStaleMemberRunsBestEffort\([\s\S]*?runSquadWatchdogSweep\(\{/,
    "启动队员臂必须与在线 tick 共用 runSquadWatchdogSweep（第二份执行实现会分叉）",
  );
});

test("接线｜阈值单源：tick 文件里没有分钟/小时的散值换算", () => {
  assert.doesNotMatch(
    TICK_SOURCE,
    /\d+\s*\*\s*(60_000|3_600_000|60 \* 1000)/,
    "换算必须经 shared 的 MS_PER_MINUTE / MS_PER_HOUR（散值会让阈值在实现轮里静默分叉）",
  );
  assert.doesNotMatch(
    TICK_SOURCE,
    /ttlMinutesFor:\s*\(.*\)\s*=>\s*\d+|idleTimeoutMinutesFor:\s*\(.*\)\s*=>\s*\d+/,
    "per-agent 阈值必须走 shared 的 resolve helper（缺省语义只有一处）",
  );
  assert.match(
    TICK_SOURCE,
    /DEFAULT_SQUAD_FALLBACK_WALL_CLOCK_HOURS/,
    "探测缺席的兜底墙钟取 shared 常量",
  );
});

test("接线｜看门狗的两个执行臂在自动路径上不碰 discardBatch（沿用既有禁令）", () => {
  /* `discardBatch` 是**用户显式**的整批放弃（git 破坏性、三道前置闸）。自动路径（启动和解 / tick）
     一旦调它，就变成「宿主自己删掉用户还没看过的一批成果」—— 看门狗只许**结算台账**（failMemberRun），
     树与分支一律交给回收器按活跃集口径收（spec §6.2/S5）。 */
  for (const [name, source] of [
    ["host/index.ts", HOST_SOURCE],
    ["host/squadWatchdogTick.ts", TICK_SOURCE],
    ["host/squadDispatch.ts", DISPATCH_SOURCE],
  ] as const) {
    assert.doesNotMatch(
      source,
      /discardBatch/,
      `${name} 不得调用/引入 discardBatch（自动路径禁令）`,
    );
  }
});

test("接线｜验收条款「stop 发起后 run 不得走成功入账」：只有 succeeded 才进成功臂，stopped/failed 一律 failMemberRun", () => {
  /* 这条链的每一段都各有一处判据（本轮只管中间一段：会话被 stop 打断 ⇒ outcome=stopped）：
     · syncer：completedInterrupted ⇒ `turn.interrupted`（服务面测试钉）；
     · adapter：`turn.interrupted` ⇒ `"stopped"`（服务面测试钉）；
     · 骨架 `watchRunSettlement`：**非 succeeded ⇒ 不调 settleOnSuccess**（下面第一条断言）；
     · host 闭包：`outcome !== "succeeded"` ⇒ `failMemberRun`（下面第二条断言）。
     合起来 = 「看门狗/取消自己发出的 stop」不会把 run 入账成 `produced`（工作项也不会回 in_review）。 */
  assert.match(
    DISPATCH_SOURCE,
    /if \(outcome\.outcome !== "succeeded"\) \{[\s\S]{0,160}?return;\s*\}\s*void params\.settleOnSuccess\(params\.runId\)/,
    "非 succeeded 的终态必须在成功入账**之前**返回（否则 stopped 也会走 completeMemberRun）",
  );
  assert.match(
    HOST_SOURCE,
    /if \(outcome\.inputId === traceId && outcome\.outcome !== "succeeded"\) \{/,
    "host 的失败出口必须由「不是 succeeded」触发（stopped 与 failed 同路 ⇒ failMemberRun）",
  );
});

/* ───────────────── W3 工具臂（口径 A：检测 + 提醒；不结算、不 stop） ─────────────────

   用户 2026-10-07 裁定：信号源 = `readSession` 的 `projection.activeToolCalls`（R-1 替代读口），
   命中 ⇒ **只落 Inbox 提醒**；run 台账一个字不写、**绝不调 stop**（协议 stop 只能 abort 整个前台执行，
   会把 run 的活杀掉 —— R-1 三条证据）。信号不可得 ⇒ 整体降级 no-op + 首见一次日志。 */

/** 捕获日志的 logger（工具臂的可观测面就是「提醒 + 留痕 + 首见一次日志」）。 */
function capturingLogger(): { logger: SquadWatchdogLogger; lines: string[] } {
  const lines: string[] = [];
  return {
    lines,
    logger: {
      info: (message) => lines.push(message),
      warn: (message) => lines.push(message),
    },
  };
}

test("在线 tick｜工具臂：单工具超阈值 ⇒ 恰一条 Inbox 提醒；run 台账零动作、不调 stop", async () => {
  const f = await setup({ probe: "executing" });
  const runId = "w3-tool-stall";
  const { itemId } = await openBoundMemberRun(f, { runId, sessionId: "sess-tool" });
  const stops: string[] = [];
  const { logger, lines } = capturingLogger();
  const ports = createSquadWatchdogSweepPorts({
    squadRuntime: f.service,
    agentService: {
      async readSession() {
        // 会话在跑一轮 turn（探测 = executing），且有一条已经跑了 6 分钟的工具调用。
        return {
          runtime: { activeTurnId: "turn-live" },
          projection: {
            activeToolCalls: [
              {
                toolCallId: "tc-stalled",
                toolName: "bash",
                status: "running",
                startedAt: NOW - 6 * MS_PER_MINUTE,
              },
            ],
          },
        };
      },
    } as never,
    stopSession: async (input) => {
      stops.push(input.runId);
      return true;
    },
    logger,
  });

  await sweep(f, { ports, logger });

  assert.equal(
    f.runtime.squadRunRepo.get(runId)?.status,
    "open",
    "工具臂**不动 run**（口径 A：只提醒）——结算会把一次「慢工具」判成失败，那是没证据的结论",
  );
  const stalled = (await f.service.listInboxItems()).filter((item) => item.kind === "run_stalled");
  assert.equal(stalled.length, 1, "命中 ⇒ 恰一条 run_stalled 提醒");
  assert.equal(stalled[0]?.runId, runId);
  assert.equal(stalled[0]?.workItemId, itemId);
  assert.match(
    String(stalled[0]?.detail.reason),
    /tc-stalled|bash/,
    "提醒要点名是哪一次工具调用（人要知道去看什么）",
  );
  assert.deepEqual(stops, [], "绝不调 stop：协议 stop 会 abort 整个前台执行（R-1 实证）");

  // 二次扫描：同一条 run 不再多出 Inbox（dedupKey 按 runId 收敛），也不重复刷日志。
  const before = lines.length;
  await sweep(f, { ports, logger });
  assert.equal(
    (await f.service.listInboxItems()).filter((item) => item.kind === "run_stalled").length,
    1,
    "重复扫描不得刷屏（Inbox dedup 按 runId）",
  );
  assert.ok(
    lines.slice(before).every((line) => !line.includes("工具看门狗")),
    "同一工具的首见留痕只一条：第二轮的同一观察不再重复打印",
  );
});

test("在线 tick｜工具臂：信号不可得 ⇒ 整体降级 no-op（日志恰一条，不刷屏；台账零动作）", async () => {
  const f = await setup();
  const runId = "w3-tool-nosignal";
  await openBoundMemberRun(f, { runId, sessionId: "sess-nosignal" });
  const { logger, lines } = capturingLogger();
  const ports = createSquadWatchdogSweepPorts({
    squadRuntime: f.service,
    agentService: {
      async readSession() {
        // 探测本身失败（既不是「不在执行」，也不是「在执行」）⇒ 工具信号同样不可得。
        throw new Error("readSession 探测异常");
      },
    } as never,
    stopSession: null,
    logger,
  });

  /* 首见记忆由**调用方**持有（在线 tick 的句柄一份、进程内有效；启动和解只扫一轮）——
     这里照 tick 的持有形态给一份，跨两轮验证「只打一次」。 */
  const toolSignalLogged = new Set<string>();
  await sweep(f, { ports, logger, toolSignalLogged });
  await sweep(f, { ports, logger, toolSignalLogged });

  assert.equal(
    f.runtime.squadRunRepo.get(runId)?.status,
    "open",
    "信号不可得 ⇒ 不猜（不结算、不提醒）",
  );
  assert.equal(
    (await f.service.listInboxItems()).filter((item) => item.kind === "run_stalled").length,
    0,
    "降级路径不落 Inbox（暂态结论：下次读成功就可能有结论，Inbox 的 dedup 会被它永久占位）",
  );
  assert.equal(
    lines.filter((line) => line.includes("工具看门狗无信号")).length,
    1,
    "「工具看门狗此刻不工作」必须可见，且**首见一次**（每轮 60s 各打一遍就是刷屏）",
  );
});

test("接线｜工具臂（口径 A）：提醒是唯一动作 —— 不结算、不 stop（R-1：stop 会 abort 整个前台执行）", () => {
  const start = TICK_SOURCE.indexOf("async function runToolWatchdogArm(");
  const end = TICK_SOURCE.indexOf("export function startSquadWatchdogTick(");
  assert.ok(start >= 0 && end > start, "找不到工具臂的执行体");
  const arm = TICK_SOURCE.slice(start, end);
  for (const forbidden of [
    "ports.settleRun(",
    "settleRun(",
    "stopSession(",
    "setStatus(",
    "failMemberRun(",
  ])
    assert.ok(
      !arm.includes(forbidden),
      `工具臂不得出现「${forbidden}」（口径 A：单次工具慢不是失败 —— 结算会杀掉活着的 run）`,
    );
  assert.ok(arm.includes("decideSquadToolWatchdog("), "工具臂必须读判定面（判据不在 host 复写）");
  assert.ok(arm.includes("recordInbox("), "命中必须落 Inbox 提醒（提醒是它的唯一动作）");
  assert.match(
    TICK_SOURCE,
    /readSessionTools/,
    "工具信号端口必须接上（漏接 = 整轮读到 undefined ⇒ 功能整块空转）",
  );
  assert.doesNotMatch(
    TICK_SOURCE,
    /stopTargetKind|expectedForegroundExecutionId/,
    "工具臂不得引入协议级定向 stop（R-1：本仓库没有 tool 级取消域，写它只会得到「停整个前台执行」）",
  );
});

test("在线 tick｜工具臂：端口本身抛错 ⇒ 逐条容错（该行降级、其余行照常、台账零动作）", async () => {
  // 探测说会话在执行（否则 run 会被死会话档结算掉，本用例就测不到工具臂的读数失败）。
  const f = await setup({ probe: "executing" });
  const runId = "w3-tool-port-throws";
  await openBoundMemberRun(f, { runId, sessionId: "sess-port-throws" });
  const { logger, lines } = capturingLogger();
  const ports = {
    ...f.ports,
    readSessionTools: async () => {
      throw new Error("工具信号端口异常");
    },
  };

  const summary = await sweep(f, { ports, logger });

  assert.deepEqual(
    summary,
    { settled: 0, stopped: 0, skipped: 0, failed: 0 },
    "端口抛错不得把整轮计成 failed（逐条容错：一条读数失败不停整轮）",
  );
  assert.equal(
    f.runtime.squadRunRepo.get(runId)?.status,
    "open",
    "台账零动作（工具臂只提醒；读数失败更没有可做的事）",
  );
  assert.ok(
    lines.some((line) => line.includes("工具信号读取失败")),
    "读数失败必须响亮留痕（带 session），否则「工具臂不工作」与「工具都很健康」长得一模一样",
  );
});
