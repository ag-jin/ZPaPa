// eslint-disable-next-line typescript-eslint/triple-slash-reference -- 与 squadWatchdogWiring.test.ts 同一处声明（不为本文件另写一份）
/// <reference path="../../services/src/runtime-tools/node-forge.d.ts" />
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import {
  ZCODE_AGENT_RUNTIME_UNAVAILABLE_CODE,
  type ISquadRuntimeService,
  type SquadRunUsageSnapshot,
} from "@zcode/services";
import { createInboxItemRepo, createSquadRuntimeService } from "@zcode/services/node";
import { runTasksDatabaseMigrations } from "../../services/src/session/tasksDatabase/migrations.js";
import { createSquadRuntime } from "../../services/src/workitem/squadRuntime.js";
import type { SquadRuntime } from "../../services/src/workitem/squadContracts.js";
import {
  createSquadWatchdogSweepPorts,
  runSquadWatchdogSweep,
  type SquadWatchdogLogger,
} from "../src/host/squadWatchdogTick.js";
import {
  captureSquadRunUsage,
  type SquadRunUsageCaptureDeps,
} from "../src/host/squadRunUsageCapture.js";

/* CT.2（#6 按 run 记账）：host 三臂捕获的**行为**与**接线结构**。

   为什么必须有这一层用例：CT.1 冻结了写入口（`recordSquadRunUsage`，write-once），但「谁去补拉
   `getTaskTokenUsage`、什么时候补拉、补拉失败怎么办」此前一条线都没接 —— 漏接的表现是
   「列都在、接口都在、台账永远 NULL」，且**不报错**（与 W2 六件套当时同一种空转形态）。

   两类证据缺一不可（照 squadWatchdogWiring.test.ts 的既有分法）：
   · 行为：用**注入 stub / 真实 runtime + 真实 sqlite 台账**驱动捕获工具与看门狗结算臂，
     断言实体状态（用量列落盘 / 失败留 NULL / 只 warn 不抛）；
   · 接线：host 源码守卫（`host/index.ts` 的调用点计数与次序、服务面零改动），因为 `index.ts`
     是进程入口（`parentPort` 顶层副作用）**不可在测试进程里 import** —— 它的接线只能靠结构断言，
     而它的行为靠下面这些**同源构件**的行为断言（捕获工具 + 看门狗端口）。 */

/** 捕获的一次调用记录（stub 的可观察证据：拉了谁、落了什么、告了几次警）。 */
type CaptureCalls = {
  pulls: Array<{ taskId: string; workspacePath: string; workspaceIdentity?: string }>;
  records: Array<{
    target: { path: string; identity: string };
    runId: string;
    usage: SquadRunUsageSnapshot;
  }>;
  warns: Array<{ message: string; error?: unknown }>;
  /** 调用**次序**（臂内契约：终态写入 → 补拉 → Inbox）；值见各用例。 */
  order: string[];
};

/** 一份 stub 依赖（默认：拉到固定 8 字段、落账成功）；个别用例按需覆盖。 */
function makeDeps(overrides?: {
  usage?: Record<string, unknown>;
  onPull?: (calls: CaptureCalls) => void;
  onRecord?: (calls: CaptureCalls) => void;
  pullError?: unknown;
  recordError?: unknown;
}): { deps: SquadRunUsageCaptureDeps; calls: CaptureCalls } {
  const calls: CaptureCalls = { pulls: [], records: [], warns: [], order: [] };
  const deps: SquadRunUsageCaptureDeps = {
    zcodeTaskService: {
      async getTaskTokenUsage(params) {
        calls.pulls.push(params);
        overrides?.onPull?.(calls);
        if (overrides?.pullError !== undefined) throw overrides.pullError;
        return {
          sessionId: params.taskId,
          totalTokens: 12345,
          inputTokens: 1000,
          outputTokens: 2000,
          reasoningTokens: 678,
          cacheCreationTokens: 300,
          cacheReadTokens: 400,
          modelRequestCount: 7,
          modelErrorCount: 1,
          inputBaselineBySource: { "user:main": 500 },
          ...overrides?.usage,
        };
      },
    },
    squadRuntime: {
      async recordSquadRunUsage(target, input) {
        calls.records.push({ target, runId: input.runId, usage: input.usage });
        overrides?.onRecord?.(calls);
        if (overrides?.recordError !== undefined) throw overrides.recordError;
      },
    },
    logger: {
      warn(message, error) {
        calls.warns.push({ message, error });
      },
    },
  };
  return { deps, calls };
}

test("捕获｜无会话（sessionId=null）⇒ 不拉不写、不告警（数据源不可得 = 静默跳过留 NULL）", async () => {
  const { deps, calls } = makeDeps();

  await captureSquadRunUsage(deps, {
    target: { path: "/repo", identity: "ws" },
    runId: "run-no-session",
    sessionId: null,
  });

  assert.deepEqual(calls.pulls, [], "没有会话就没有用量事实可拉：不得调 getTaskTokenUsage");
  assert.deepEqual(calls.records, [], "没有会话就没有可落的值：不得写任何一列（留 NULL，不写 0）");
  assert.deepEqual(
    calls.warns,
    [],
    "数据源不可得不是失败 ⇒ 不告警（留 NULL 是诚实登记，不是异常）",
  );
});

test("捕获｜有会话 ⇒ 拉一次（按 sessionId + 目标 workspace）、落账一次（8 字段逐字、不带第二形状）", async () => {
  const { deps, calls } = makeDeps();

  await captureSquadRunUsage(deps, {
    target: { path: "/repo", identity: "ws-1" },
    runId: "run-ok",
    sessionId: "session-ok",
  });

  assert.deepEqual(
    calls.pulls,
    [{ taskId: "session-ok", workspacePath: "/repo", workspaceIdentity: "ws-1" }],
    "拉取只经既有查询面：taskId=会话、workspace 取目标（与 stop 会话同一口径）",
  );
  assert.deepEqual(
    calls.records.map((record) => [record.runId, record.target, record.usage]),
    [
      [
        "run-ok",
        { path: "/repo", identity: "ws-1" },
        {
          totalTokens: 12345,
          inputTokens: 1000,
          outputTokens: 2000,
          reasoningTokens: 678,
          cacheCreationTokens: 300,
          cacheReadTokens: 400,
          modelRequestCount: 7,
          modelErrorCount: 1,
        },
      ],
    ],
    "落账一次且参数逐字段正确：8 个数值（不含 sessionId / inputBaselineBySource 这两个第二形状）",
  );
  assert.deepEqual(calls.warns, [], "成功路径不告警");
});

test("捕获｜拉取抛错 ⇒ 不落账、只 warn 一次、不向调用方抛（记账失败不反噬事实流）", async () => {
  const { deps, calls } = makeDeps({ pullError: new Error("usage query timed out") });

  await captureSquadRunUsage(deps, {
    target: { path: "/repo", identity: "ws-1" },
    runId: "run-pull-fail",
    sessionId: "session-x",
  });

  assert.deepEqual(
    calls.records,
    [],
    "拉不到就不落账（留 NULL = 「不知道」，绝不写 0 冒充「没消耗」）",
  );
  assert.equal(calls.warns.length, 1, "必须留一行 warn（best-effort 不等于静默）");
  assert.match(
    calls.warns[0]?.message ?? "",
    /run-pull-fail/,
    "warn 要点名 runId（否则不知道哪条没记上）",
  );
});

test("捕获｜落账抛错（服务面未命中 / 库瞬时不可用）⇒ 只 warn 一次、不向调用方抛", async () => {
  const { deps, calls } = makeDeps({ recordError: new Error("squad_runs 里没有该 runId") });

  await captureSquadRunUsage(deps, {
    target: { path: "/repo", identity: "ws-1" },
    runId: "run-record-fail",
    sessionId: "session-y",
  });

  assert.equal(calls.pulls.length, 1, "拉取照常发生（失败点在落账）");
  assert.equal(calls.warns.length, 1, "落账失败必须可见且只一次（不刷屏）");
  assert.match(calls.warns[0]?.message ?? "", /run-record-fail/, "warn 要点名 runId");
});

/* ───────────────────────── 看门狗结算臂（臂②③的队员半边） ─────────────────────────

   结算发生在 `squadWatchdogTick` 的 `executeDecision` 里，故捕获口是**端口**（`captureUsage`）：
   在线 tick 与启动和解的队员臂共用同一份扫描实现 ⇒ 这一个端口同时覆盖两条臂的队员半边。
   本段用**真实 runtime + 真实 sqlite 台账**驱动，断言「谁在什么时候被补拉」。 */

const WS = "ct2-host-ws";
const NOW = 1_700_000_000_000;
const silentLogger: SquadWatchdogLogger = { info: () => {}, warn: () => {} };

/** 运行期不可得（agent 进程不在）：探测口径 = 明确「没有东西在执行」⇒ 死会话档可结算。 */
function runtimeUnavailable(): Error {
  const error = new Error("agent runtime unavailable");
  (error as Error & { code?: string }).code = ZCODE_AGENT_RUNTIME_UNAVAILABLE_CODE;
  return error;
}

const run = promisify(execFile);

/** 一次性临时 git 仓库：`openMemberRun` 要真的 `git worktree add`（看门狗看的是真实台账 + 真实树）。 */
async function makeRepo(): Promise<string> {
  const root = mkdtempSync(join(tmpdir(), "squad-usage-capture-"));
  await run("git", ["init", "-q", "-b", "main"], { cwd: root });
  await run("git", ["config", "user.email", "t@t"], { cwd: root });
  await run("git", ["config", "user.name", "t"], { cwd: root });
  writeFileSync(join(root, "a.txt"), "1\n");
  await run("git", ["add", "-A"], { cwd: root });
  await run("git", ["commit", "-qm", "init"], { cwd: root });
  return root;
}

type WatchdogFixture = {
  repoRoot: string;
  runtime: SquadRuntime;
  service: ISquadRuntimeService;
  target: { path: string; identity: string };
};

async function makeWatchdogFixture(): Promise<WatchdogFixture> {
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
    getInboxItemRepo: () => createInboxItemRepo(db),
    logWarn: () => {},
  });
  const runtime = await createRuntime();
  return { repoRoot, runtime, service, target };
}

/** 一条**已绑会话**的队员 run（真实工作树 + 真实台账行）：看门狗只在有会话时才进探测档。 */
async function openBoundMemberRun(
  f: WatchdogFixture,
  input: { runId: string; sessionId: string },
): Promise<{ itemId: string; agentId: string }> {
  const itemId = `ct2-wi-${input.runId}`;
  f.runtime.workItemRepo.insert({
    id: itemId,
    workspaceIdentity: WS,
    workspacePath: f.repoRoot,
    title: `标题-${itemId}`,
    body: "",
    status: "in_progress",
    assignee: { type: "user", id: "u1" },
    labels: [],
    properties: {},
    position: 0,
  });
  await f.runtime.lifecycle.openMemberRun({
    runId: input.runId,
    workItemId: itemId,
    parentWorkItemId: itemId,
    agentId: "ct2-ta-a",
    isLeaderTask: false,
  });
  await f.runtime.lifecycle.bindMemberRunSession({
    runId: input.runId,
    sessionId: input.sessionId,
  });
  return { itemId, agentId: "ct2-ta-a" };
}

/** 死会话档（探测明确不在执行）扫一轮：判定面只可能给出 settle_dead_session。 */
async function sweepDeadSessions(
  f: WatchdogFixture,
  captureUsage: (
    target: { path: string; identity: string },
    input: { runId: string; sessionId: string | null },
  ) => Promise<void>,
  options?: { runScope?: "member" | "all" },
) {
  const ports = createSquadWatchdogSweepPorts({
    squadRuntime: f.service,
    agentService: {
      async readSession() {
        throw runtimeUnavailable();
      },
    } as never,
    stopSession: null,
    logger: silentLogger,
    captureUsage,
  });
  return runSquadWatchdogSweep({
    targets: [f.target],
    ports,
    logger: silentLogger,
    runScope: options?.runScope ?? "all",
    pendingStops: new Map<string, number>(),
    now: () => NOW,
  });
}

test("看门狗结算臂｜结算之后补拉一次：终态已写入（discarded）才开始捕获，runId/sessionId 逐字段正确", async () => {
  const f = await makeWatchdogFixture();
  const runId = "ct2-watchdog-settled";
  await openBoundMemberRun(f, { runId, sessionId: "sess-dead" });

  const captures: Array<{
    runId: string;
    sessionId: string | null;
    statusAtCapture: string | undefined;
  }> = [];
  const summary = await sweepDeadSessions(f, async (_target, input) => {
    captures.push({
      ...input,
      // 捕获**当时**台账里这条行的状态：次序契约（终态在先）由此可观察，不靠字符串比对日志。
      statusAtCapture: f.runtime.squadRunRepo.get(input.runId)?.status,
    });
  });

  assert.deepEqual(
    summary,
    { settled: 1, stopped: 0, skipped: 0, failed: 0 },
    "死会话档结算一条（本用例只放一条行）",
  );
  assert.deepEqual(
    captures,
    [{ runId, sessionId: "sess-dead", statusAtCapture: "discarded" }],
    "结算后**恰好**补拉一次，且捕获发生在终态写入之后（台账已是 discarded）",
  );
});

test("看门狗结算臂｜端口缺席（数据源不可得）⇒ 静默跳过：结算照旧、零告警（不写 0 也不报错）", async () => {
  const f = await makeWatchdogFixture();
  const runId = "ct2-watchdog-no-port";
  await openBoundMemberRun(f, { runId, sessionId: "sess-dead" });

  const warns: string[] = [];
  const ports = createSquadWatchdogSweepPorts({
    squadRuntime: f.service,
    agentService: {
      async readSession() {
        throw runtimeUnavailable();
      },
    } as never,
    stopSession: null,
    logger: silentLogger,
  });
  const summary = await runSquadWatchdogSweep({
    targets: [f.target],
    ports,
    logger: { info: () => {}, warn: (message) => warns.push(message) },
    runScope: "all",
    pendingStops: new Map<string, number>(),
    now: () => NOW,
  });

  assert.deepEqual(
    summary,
    { settled: 1, stopped: 0, skipped: 0, failed: 0 },
    "捕获缺席不影响结算",
  );
  assert.equal(f.runtime.squadRunRepo.get(runId)?.status, "discarded", "终态照写");
  assert.equal(
    f.runtime.squadRunRepo.get(runId)?.usageRecordedAt ?? null,
    null,
    "没有数据源就没有用量：9 列保持 NULL（**不得**写 0）",
  );
  assert.deepEqual(warns, [], "「数据源不可得」不是失败 ⇒ 不告警（与 sessionId=null 同款）");
});

test("看门狗结算臂｜捕获抛错 ⇒ 结算计数不受影响、只 warn：记账失败不反噬事实流", async () => {
  const f = await makeWatchdogFixture();
  const runId = "ct2-watchdog-capture-boom";
  await openBoundMemberRun(f, { runId, sessionId: "sess-dead" });

  const warns: string[] = [];
  const ports = createSquadWatchdogSweepPorts({
    squadRuntime: f.service,
    agentService: {
      async readSession() {
        throw runtimeUnavailable();
      },
    } as never,
    stopSession: null,
    logger: silentLogger,
    captureUsage: async () => {
      throw new Error("capture port exploded");
    },
  });
  const summary = await runSquadWatchdogSweep({
    targets: [f.target],
    ports,
    logger: { info: () => {}, warn: (message) => warns.push(message) },
    runScope: "all",
    pendingStops: new Map<string, number>(),
    now: () => NOW,
  });

  assert.deepEqual(
    summary,
    { settled: 1, stopped: 0, skipped: 0, failed: 0 },
    "捕获异常**不得**把一条已结算的行算成 failed（结算与捕获是两件事）",
  );
  assert.equal(f.runtime.squadRunRepo.get(runId)?.status, "discarded", "终态照写");
  assert.equal(warns.length, 1, "必须留一行 warn（best-effort 不等于静默）");
  assert.match(warns[0] ?? "", new RegExp(runId), "warn 要点名 runId");
});

test("启动和解臂（队员半边）｜真台账 + 真服务：结算后 9 列落盘、每 run 恰拉一次、终态与身份列逐字不变", async () => {
  const f = await makeWatchdogFixture();
  const runId = "ct2-startup-member";
  await openBoundMemberRun(f, { runId, sessionId: "sess-startup" });
  const before = f.runtime.squadRunRepo.get(runId);
  assert.ok(before, "前置：台账行已落");

  const pulls: string[] = [];
  const summary = await sweepDeadSessions(
    f,
    (target, input) =>
      captureSquadRunUsage(
        {
          zcodeTaskService: {
            async getTaskTokenUsage(params) {
              pulls.push(params.taskId);
              return {
                sessionId: params.taskId,
                totalTokens: 4242,
                inputTokens: 1000,
                outputTokens: 2000,
                reasoningTokens: 21,
                cacheCreationTokens: 0,
                cacheReadTokens: 1000,
                modelRequestCount: 3,
                modelErrorCount: 0,
                inputBaselineBySource: {},
              };
            },
          },
          squadRuntime: f.service,
          logger: silentLogger,
        },
        { target, runId: input.runId, sessionId: input.sessionId },
      ),
    // 启动和解的**队员臂**：与在线 tick 共用同一份扫描（runScope 只收队员行）。
    { runScope: "member" },
  );

  const after = f.runtime.squadRunRepo.get(runId);
  assert.ok(after, "结算后行仍在（结算不是删除）");
  assert.deepEqual(summary, { settled: 1, stopped: 0, skipped: 0, failed: 0 }, "结算一条");
  assert.deepEqual(pulls, ["sess-startup"], "每 run **恰好**拉一次（同一会话不会被重复补拉）");
  assert.deepEqual(
    [
      after.usageTotalTokens,
      after.usageInputTokens,
      after.usageOutputTokens,
      after.usageReasoningTokens,
      after.usageCacheCreationTokens,
      after.usageCacheReadTokens,
      after.usageModelRequestCount,
      after.usageModelErrorCount,
      typeof after.usageRecordedAt,
    ],
    [4242, 1000, 2000, 21, 0, 1000, 3, 0, "number"],
    "8 个数值逐字落盘 + usage_recorded_at 非空（**0 也是合法值**：cacheCreation=0 照落，不是「未记录」）",
  );
  assert.deepEqual(
    [
      after.status,
      after.settleReason,
      after.sessionId,
      after.agentId,
      after.branch,
      after.dirName,
      after.workItemId,
    ],
    [
      "discarded",
      "watchdog_dead_session",
      before.sessionId,
      before.agentId,
      before.branch,
      before.dirName,
      before.workItemId,
    ],
    "用量列是**唯一**差异：终态、结算原因与身份列逐字不变（记账不改判据、不碰 git）",
  );
});

/* ───────────────────────── 接线（host/index.ts 源码守卫） ─────────────────────────

   `index.ts` 是进程入口（顶层 `parentPort.on` 副作用）⇒ 测试进程不能 import 它，故它的接线只能
   靠结构断言（本仓既有形态：squadWiring / squadInboxWiring / hostSquadDispatch 的「接线」用例）。
   钉两件事：**调用点计数**（防「顺手加第六处」/漏接）与**次序**（终态 → 用量 → 留痕）。 */

const hostIndexSrc = readFileSync(
  join(resolve(dirname(fileURLToPath(import.meta.url)), "../src/host"), "index.ts"),
  "utf8",
);
const captureModuleSrc = readFileSync(
  join(resolve(dirname(fileURLToPath(import.meta.url)), "../src/host"), "squadRunUsageCapture.ts"),
  "utf8",
);
const countMatches = (source: string, pattern: RegExp): number =>
  (source.match(pattern) ?? []).length;

test("接线｜捕获工具单源：行为模块里恰 1 处定义；index.ts 恰 5 处调用（三臂 + 看门狗端口 + 启动和解队长臂）", () => {
  assert.equal(
    countMatches(captureModuleSrc, /export async function captureSquadRunUsage\(/g),
    1,
    "捕获工具的定义只有一处（host 行为模块）——index.ts 不得再写一份",
  );
  assert.doesNotMatch(
    hostIndexSrc,
    /function captureSquadRunUsage\(/,
    "index.ts 不定义捕获工具（只接线）",
  );
  assert.equal(
    countMatches(hostIndexSrc, /captureSquadRunUsage\(/g),
    5,
    "index.ts 恰 5 处调用：①队员成功 ②队长成功 ③失败出口 ④看门狗结算端口 ⑤启动和解队长臂",
  );
});

test("接线｜臂①三出口全在「有台账行」的闸内（独立安排 ⇒ 零捕获），且终态写入排在捕获之前", () => {
  const subscriptionAt = hostIndexSrc.indexOf("const subscriptionKey = cronRunSubscriptionKey(");
  assert.ok(subscriptionAt > 0, "找不到终态收口的订阅键（订阅那一块的位置锚点）");
  // 订阅块（含三出口）在同一条「有台账行」的闸内 ⇒ 取它**之前最近**的那道闸。
  const gateStart = hostIndexSrc.lastIndexOf('if (ledgerAction !== "none") {', subscriptionAt);
  assert.ok(gateStart >= 0, "找不到订阅（终态收口）的台账闸");
  const sendPromptAt = hostIndexSrc.indexOf("await zcodeTaskService.sendPrompt(", gateStart);
  assert.ok(sendPromptAt > gateStart, "找不到发 prompt 的边界");
  const gated = hostIndexSrc.slice(gateStart, sendPromptAt);

  assert.equal(
    countMatches(gated, /captureSquadRunUsage\(/g),
    3,
    '臂①的三条出口都在这个闸内 ⇒ 独立安排（ledgerAction==="none"）不订阅、也就零捕获',
  );
  assert.match(
    gated,
    /completeMemberRun: async \(runId\)/,
    "队员成功出口的形态（入账动作内联捕获）",
  );
  assert.match(gated, /completeLeaderRun: async \(runId\)/, "队长成功出口的形态");

  /* 次序：入账动作先写终态、再捕获（同一 async 块里相邻两条 await），不是「先捕获后入账」。 */
  const memberArm = gated.slice(
    gated.indexOf("watchMemberRunSettlement({"),
    gated.indexOf('} else if (kind === "leader") {'),
  );
  assert.ok(
    memberArm.indexOf("completeMemberRun(") < memberArm.indexOf("captureSquadRunUsage("),
    "队员成功出口：completeMemberRun 在前、捕获在后",
  );
  const leaderArm = gated.slice(gated.indexOf('} else if (kind === "leader") {'));
  assert.ok(
    leaderArm.indexOf("completeLeaderRun(") < leaderArm.indexOf("captureSquadRunUsage("),
    "队长成功出口：completeLeaderRun 在前、捕获在后",
  );

  /* 失败出口的次序：failMemberRun → 捕获 → Inbox 登记（三段一条链）。 */
  const failureArm = gated.slice(
    gated.indexOf('outcome.outcome !== "succeeded"'),
    gated.indexOf("listener(outcome);"),
  );
  const failAt = failureArm.indexOf("failMemberRun(");
  const captureAt = failureArm.indexOf("captureSquadRunUsage(");
  const inboxAt = failureArm.indexOf("recordInboxItem(");
  assert.ok(failAt >= 0 && captureAt >= 0 && inboxAt >= 0, "失败出口三段必须齐全");
  assert.ok(failAt < captureAt, "失败出口：终态写入（failMemberRun）必须在捕获之前");
  assert.ok(captureAt < inboxAt, "失败出口：捕获必须在 Inbox 登记之前（次序契约）");
});

test("接线｜臂②看门狗结算端口：task service 缺席 ⇒ 端口缺席（静默跳过留 NULL），结算不受影响", () => {
  const region = hostIndexSrc.slice(
    hostIndexSrc.indexOf("function resolveSquadWatchdogSweepPorts("),
    hostIndexSrc.indexOf("function stopSquadWatchdogTick("),
  );
  assert.ok(region.length > 0, "找不到看门狗端口装配点");
  assert.match(region, /captureUsage/, "端口必须接上（否则看门狗结算臂零捕获）");
  assert.match(
    region,
    /const zcodeTaskService = services\.getOptional\(IZCodeTaskService\)/,
    "数据源从服务面现取（不缓存、不另建通道）",
  );
  assert.match(
    region,
    /captureUsage = zcodeTaskService/,
    "数据源缺席 ⇒ 端口缺席（数据源不可得不是失败：静默跳过留 NULL）",
  );
});

test("接线｜臂③启动和解队长臂：failMemberRun 成功之后才捕获，且排在 Inbox 登记之前", () => {
  const region = hostIndexSrc.slice(
    hostIndexSrc.indexOf("async function settleStaleLeaderRunsBestEffort("),
    hostIndexSrc.indexOf("async function forEachSquadWorkspaceTarget("),
  );
  assert.ok(region.length > 0, "找不到启动和解队长臂");
  const failAt = region.indexOf("squadRuntime.failMemberRun(");
  const captureAt = region.indexOf("captureSquadRunUsage(");
  const inboxAt = region.indexOf("squadRuntime.recordInboxItem(");
  assert.ok(failAt >= 0 && captureAt >= 0 && inboxAt >= 0, "三段必须齐全");
  assert.ok(failAt < captureAt, "终态写入在前、捕获在后（且只在 settled 时捕获）");
  assert.ok(captureAt < inboxAt, "捕获在 Inbox 登记之前");
  assert.match(region, /if \(settled && zcodeTaskService\)/, "结算未生效 / 数据源缺失 ⇒ 不捕获");
});

test("接线｜捕获路径无空 catch、无 ?? 0 / || 0（禁把未知折成 0），且不碰派发桥的 MCP 挂载段", () => {
  assert.doesNotMatch(
    captureModuleSrc,
    /catch\s*(\([^)]*\))?\s*\{\s*\}/,
    "捕获路径不得空 catch（必须 warn）",
  );
  assert.doesNotMatch(
    captureModuleSrc,
    /\?\?\s*0|(?<!\|)\|\|\s*0/,
    "捕获路径不得把未知折成 0（NULL ≠ 0）",
  );
  const callSiteIndexes = [...hostIndexSrc.matchAll(/captureSquadRunUsage\(/g)].map(
    (match) => match.index ?? 0,
  );
  for (const at of callSiteIndexes) {
    assert.doesNotMatch(
      hostIndexSrc.slice(Math.max(0, at - 200), at + 400),
      /\?\?\s*0|\|\|\s*0/,
      "调用点附近不得出现「未知折成 0」的写法",
    );
  }
  const mcpSection = hostIndexSrc.slice(
    hostIndexSrc.indexOf("const mcpSyncService = targetServices.getOptional(IMcpSyncService);"),
    hostIndexSrc.indexOf("const traceId = eventKey as TraceId;"),
  );
  assert.ok(mcpSection.length > 0, "派发桥的挂载段边界必须找得到（per-agent MCP 的既有接线）");
  assert.doesNotMatch(mcpSection, /captureSquadRunUsage/, "用量捕获不得侵入派发桥的挂载段（H3）");
});

/* ───────────────────────── 台账语义（真 runtime + 真 sqlite） ─────────────────────────

   下面四条用**真实落账路径**（服务面 → repo → sqlite）钉住三件事：
   · 「每 run 恰好一次」的兜底是 CT.1 的 write-once（重复终态 / 重复补拉 = 合法重投，不改行）；
   · `0` 与「未记录」是两件必须可区分的事（NULL ≠ 0）；
   · 重开臂（Q5「只记最后一次会话」）在**今天可达的形态**下能落，且 write-once 与重开的联动缺口
     如实登记（不硬改 CT.1）。 */

/** 一次性 stub 用量查询面（固定 8 字段，`totalTokens` 可按用例给）。 */
function stubTaskService(input: {
  totalTokens: number;
  pulls?: string[];
}): SquadRunUsageCaptureDeps["zcodeTaskService"] {
  return {
    async getTaskTokenUsage(params) {
      input.pulls?.push(params.taskId);
      return {
        sessionId: params.taskId,
        totalTokens: input.totalTokens,
        inputTokens: 0,
        outputTokens: 0,
        reasoningTokens: 0,
        cacheCreationTokens: 0,
        cacheReadTokens: 0,
        modelRequestCount: 0,
        modelErrorCount: 0,
        inputBaselineBySource: {},
      };
    },
  };
}

test("台账｜重复补拉（迟到终态 / 重投）⇒ write-once 兜底：行内容逐列不变、不抛、不告警", async () => {
  const f = await makeWatchdogFixture();
  const runId = "ct2-duplicate-capture";
  await openBoundMemberRun(f, { runId, sessionId: "sess-dup" });
  const capture = (totalTokens: number) =>
    captureSquadRunUsage(
      {
        zcodeTaskService: stubTaskService({ totalTokens }),
        squadRuntime: f.service,
        logger: silentLogger,
      },
      { target: f.target, runId, sessionId: "sess-dup" },
    );

  await capture(4242);
  const first = f.runtime.squadRunRepo.get(runId);
  assert.ok(
    first?.usageRecordedAt !== null && first?.usageRecordedAt !== undefined,
    "第一次落账成功",
  );

  // 第二次用**另一组值**补拉（模拟看门狗结算 + 迟到终态两条出口都走到）：合法重投，不得改写。
  await capture(99999);
  const second = f.runtime.squadRunRepo.get(runId);
  assert.deepEqual(
    [second?.usageTotalTokens, second?.usageRecordedAt, second?.updatedAt],
    [4242, first?.usageRecordedAt, first?.updatedAt],
    "write-once：第二次只得到 {written:false}，行内容与 updated_at 逐列不变（「没写」的可观察证据）",
  );
});

test("台账｜记录全 0 的用量 ⇒ 读回 0 且 usage_recorded_at 非空（0 是事实，与「未记录」可区分）", async () => {
  const f = await makeWatchdogFixture();
  const runId = "ct2-zero-usage";
  await openBoundMemberRun(f, { runId, sessionId: "sess-zero" });
  const before = f.runtime.squadRunRepo.get(runId);
  assert.equal(before?.usageRecordedAt ?? null, null, "前置：还没记过（9 列全 NULL）");

  await captureSquadRunUsage(
    {
      zcodeTaskService: stubTaskService({ totalTokens: 0 }),
      squadRuntime: f.service,
      logger: silentLogger,
    },
    { target: f.target, runId, sessionId: "sess-zero" },
  );

  const after = f.runtime.squadRunRepo.get(runId);
  assert.deepEqual(
    [after?.usageTotalTokens, after?.usageInputTokens, typeof after?.usageRecordedAt],
    [0, 0, "number"],
    "「跑过但没消耗」必须与「没记账」可区分（渲染 0 才不是把未知伪装成零消耗）",
  );
});

test("重开臂｜结算 + 同 runId 重开（真实 openMemberRun 残行臂）后，新终态的补拉**能落**（Q5：只记最后一次会话）", async () => {
  const f = await makeWatchdogFixture();
  const runId = "ct2-reopen";
  const itemId = `ct2-wi-${runId}`;
  f.runtime.workItemRepo.insert({
    id: itemId,
    workspaceIdentity: WS,
    workspacePath: f.repoRoot,
    title: `标题-${itemId}`,
    body: "",
    status: "in_progress",
    assignee: { type: "user", id: "u1" },
    labels: [],
    properties: {},
    position: 0,
  });
  const firstOpen = await f.runtime.lifecycle.openMemberRun({
    runId,
    workItemId: itemId,
    parentWorkItemId: itemId,
    agentId: "ct2-ta-b",
    isLeaderTask: false,
  });
  assert.equal(firstOpen.kind, "opened", "前置：第一次开跑建出树");
  const firstRow = f.runtime.squadRunRepo.get(runId);
  // 造出 C1 的残行形态（有行无树、分支无占用）：把刚建好的树与残枝收掉，再重投同一 runId。
  if (firstOpen.kind === "opened") {
    await run("git", ["worktree", "remove", "--force", firstOpen.worktreePath], {
      cwd: f.repoRoot,
    });
    await run("git", ["branch", "-D", firstOpen.branch], { cwd: f.repoRoot });
  }

  const reopened = await f.runtime.lifecycle.openMemberRun({
    runId,
    workItemId: itemId,
    parentWorkItemId: itemId,
    agentId: "ct2-ta-b",
    isLeaderTask: false,
  });
  assert.equal(reopened.kind, "opened", "C1 的「结算 + 同 runId 重开」：台账翻回 open 并另建新树");
  assert.equal(
    f.runtime.squadRunRepo.get(runId)?.sessionId ?? null,
    null,
    "重开臂把 sessionId 置回 null（另建会话）",
  );
  assert.equal(
    f.runtime.squadRunRepo.get(runId)?.usageRecordedAt ?? null,
    null,
    "重开前这条 run 从未有过会话终态 ⇒ 用量仍 NULL（第一次尝试没有用量事实可记）",
  );
  assert.equal(
    firstRow?.branch === f.runtime.squadRunRepo.get(runId)?.branch,
    true,
    "重开用的是同一个分支计划",
  );

  const pulls: string[] = [];
  await captureSquadRunUsage(
    {
      zcodeTaskService: stubTaskService({ totalTokens: 777, pulls }),
      squadRuntime: f.service,
      logger: silentLogger,
    },
    { target: f.target, runId, sessionId: "sess-second" },
  );

  assert.deepEqual(pulls, ["sess-second"], "补拉的是**最后一次会话**");
  assert.deepEqual(
    [
      f.runtime.squadRunRepo.get(runId)?.usageTotalTokens,
      typeof f.runtime.squadRunRepo.get(runId)?.usageRecordedAt,
    ],
    [777, "number"],
    "重开后终态的补拉**落得了**（Q5「只记最后一次会话」在可达形态下成立）——write-once 没有挡路",
  );
});

test("重开联动（**冲突登记**，不硬改 CT.1）｜已记录的 run 若再回 open 另建会话，write-once 会挡住覆盖", async () => {
  const f = await makeWatchdogFixture();
  const runId = "ct2-reopen-after-recorded";
  await openBoundMemberRun(f, { runId, sessionId: "sess-first" });
  await captureSquadRunUsage(
    {
      zcodeTaskService: stubTaskService({ totalTokens: 111 }),
      squadRuntime: f.service,
      logger: silentLogger,
    },
    { target: f.target, runId, sessionId: "sess-first" },
  );
  const recorded = f.runtime.squadRunRepo.get(runId);
  assert.equal(recorded?.usageTotalTokens, 111, "前置：第一条会话的用量已落账");

  /* 模拟「已记录的 run 又被重开」的台账形态（今天**没有**这条生产臂：C1 的重开只从「从未有过会话终态」
     的残行进入 —— 见用例名与 CT.2 报告的登记）。这一格里 write-once 会挡住覆盖：用量停在第一条会话。 */
  f.runtime.squadRunRepo.setStatus(runId, "open", {
    sessionId: null,
    openedAt: Date.now(),
  });
  await captureSquadRunUsage(
    {
      zcodeTaskService: stubTaskService({ totalTokens: 222 }),
      squadRuntime: f.service,
      logger: silentLogger,
    },
    { target: f.target, runId, sessionId: "sess-second" },
  );

  const after = f.runtime.squadRunRepo.get(runId);
  assert.deepEqual(
    [after?.usageTotalTokens, after?.usageRecordedAt],
    [111, recorded?.usageRecordedAt],
    "冲突登记：write-once 挡住覆盖（新会话的 222 落不进去）—— 若将来出现该重开臂，需 CT.1 让重开清 usage_recorded_at（本卡不改服务面）",
  );
});
