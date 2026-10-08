import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { resolveWorkspaceKey } from "@zcode/shared";
import {
  ZCODE_AGENT_RUNTIME_UNAVAILABLE_CODE,
  type ISquadRuntimeService,
  type SquadRunRecord,
} from "@zcode/services";
import { createInboxItemRepo, createSquadRuntimeService } from "@zcode/services/node";
import { runTasksDatabaseMigrations } from "../../services/src/session/tasksDatabase/migrations.js";
import { createSquadRuntime } from "../../services/src/workitem/squadRuntime.js";
import type { SquadRuntime } from "../../services/src/workitem/squadContracts.js";
import {
  captureSquadRunUsage,
  type SquadRunUsageCaptureDeps,
} from "../src/host/squadRunUsageCapture.js";
import {
  createSquadWatchdogSweepPorts,
  runSquadWatchdogSweep,
  type SquadWatchdogLogger,
  type SquadWatchdogSweepPorts,
} from "../src/host/squadWatchdogTick.js";

/* CT.V（#6 成本记账线整线独立复验）—— **CT.2 三臂负向控制**（独立构造，不复用实现者夹具）。

   证据层级：行为用**真 sqlite 台账 + 真 runtime + 真服务面**驱动（台账列是否 NULL 由真库回答）；
   `host/index.ts` 的接线靠**我自己的源码扫描**（进程入口不可 import，这与仓内既有约定一致）。

   钉住四件事：
   · 拉取抛 / 落账抛 ⇒ **只 warn、不抛、不阻断**，且 9 个用量列保持 NULL（不是 0）；
   · `sessionId === null` ⇒ 零拉取零落账（静默跳过，不写 0）；
   · 全 0 用量 ⇒ **真落 0** 且 `usage_recorded_at` 非空（0 与未记录可区分）；
   · 看门狗结算臂：捕获时点实体状态 = 终态已写入（discarded）且 Inbox **尚未**登记
     （次序：终态写入 → 补拉 → 留痕），捕获失败不影响结算计数。 */

const run = promisify(execFile);
const WS = "ctv-nc-ws";
const NOW = 1_700_000_000_000;
const silentLogger: SquadWatchdogLogger = { info: () => {}, warn: () => {} };

const USAGE_COLUMN_KEYS = [
  "usageTotalTokens",
  "usageInputTokens",
  "usageOutputTokens",
  "usageReasoningTokens",
  "usageCacheCreationTokens",
  "usageCacheReadTokens",
  "usageModelRequestCount",
  "usageModelErrorCount",
  "usageRecordedAt",
] as const;

const usageColumns = (record: SquadRunRecord | null): Array<number | null | undefined> =>
  record === null ? [] : USAGE_COLUMN_KEYS.map((key) => record[key]);

async function makeRepo(): Promise<string> {
  const root = mkdtempSync(join(tmpdir(), "ctv-nc-"));
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
  db: DatabaseSync;
  target: { path: string; identity: string };
  service: ISquadRuntimeService;
  runtime: SquadRuntime;
};

async function fixture(): Promise<Fixture> {
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
  return { repoRoot, db, target, service, runtime };
}

function insertRow(f: Fixture, runId: string, over: Partial<SquadRunRecord> = {}): void {
  f.runtime.squadRunRepo.insert({
    runId,
    workspaceKey: WS,
    workspacePath: f.repoRoot,
    workItemId: `wi-${runId}`,
    parentWorkItemId: `wi-${runId}`,
    agentId: "ta-nc",
    isLeaderTask: false,
    branch: null,
    dirName: null,
    status: "merged",
    sessionId: "sess-nc",
    dispatchCause: null,
    causedByRunId: null,
    openedAt: 1,
    settleReason: null,
    createdAt: 1,
    updatedAt: 1,
    ...over,
  });
}

/** 真服务面 + 真 repo 的落账入口（负向用例必须让**生产代码**自己抛，而不是 stub 假装抛）。 */
const realDeps = (
  f: Fixture,
  zcodeTaskService: SquadRunUsageCaptureDeps["zcodeTaskService"],
  warns: Array<{ message: string; error?: unknown }>,
): SquadRunUsageCaptureDeps => ({
  zcodeTaskService,
  squadRuntime: f.service,
  logger: {
    warn(message, error) {
      warns.push({ message, error });
    },
  },
});

/** 固定 8 字段的查询面桩（值可覆写；`inputBaselineBySource` 只为凑协议形状，绝不该进台账）。 */
const taskServiceStub = (
  usage: Partial<Record<string, number>>,
  onPull?: (taskId: string) => void,
) =>
  ({
    async getTaskTokenUsage(params: { taskId: string }) {
      onPull?.(params.taskId);
      return {
        sessionId: params.taskId,
        totalTokens: usage.totalTokens ?? 0,
        inputTokens: usage.inputTokens ?? 0,
        outputTokens: usage.outputTokens ?? 0,
        reasoningTokens: usage.reasoningTokens ?? 0,
        cacheCreationTokens: usage.cacheCreationTokens ?? 0,
        cacheReadTokens: usage.cacheReadTokens ?? 0,
        modelRequestCount: usage.modelRequestCount ?? 0,
        modelErrorCount: usage.modelErrorCount ?? 0,
        inputBaselineBySource: {},
      };
    },
  }) as unknown as SquadRunUsageCaptureDeps["zcodeTaskService"];

test("负向①｜拉取抛：只 warn 一次且不向调用方抛；真台账 9 列 NULL、status/updated_at 不动", async () => {
  const f = await fixture();
  const runId = "nc-pull-boom";
  insertRow(f, runId);
  const before = f.runtime.squadRunRepo.get(runId)!;
  const warns: Array<{ message: string }> = [];

  await captureSquadRunUsage(
    realDeps(
      f,
      {
        async getTaskTokenUsage() {
          throw new Error("usage query timed out");
        },
      },
      warns,
    ),
    { target: f.target, runId, sessionId: "sess-nc" },
  ); // 不得 reject：记账失败不反噬事实流

  assert.equal(warns.length, 1, "恰好一行 warn（best-effort 不等于静默）");
  assert.match(warns[0]!.message, new RegExp(runId), "warn 点名 runId");
  const after = f.runtime.squadRunRepo.get(runId)!;
  assert.deepEqual(usageColumns(after), [null, null, null, null, null, null, null, null, null]);
  assert.deepEqual(
    [after.status, after.updatedAt],
    [before.status, before.updatedAt],
    "拉取失败不得留下任何写入痕迹",
  );
});

test("负向②｜落账抛（真 repo 数值闸）：只 warn、9 列 NULL、不落半个值", async () => {
  const f = await fixture();
  const runId = "nc-record-boom";
  insertRow(f, runId);
  const before = f.runtime.squadRunRepo.get(runId)!;
  const warns: Array<{ message: string }> = [];

  // 「协议回传了不可能的值」⇒ 真服务面 → 真 repo 的写路径闸响亮抛；捕获必须接住。
  await captureSquadRunUsage(realDeps(f, taskServiceStub({ totalTokens: -1 }), warns), {
    target: f.target,
    runId,
    sessionId: "sess-nc",
  });

  assert.equal(warns.length, 1, "恰好一行 warn");
  assert.match(warns[0]!.message, new RegExp(runId));
  const after = f.runtime.squadRunRepo.get(runId)!;
  assert.deepEqual(usageColumns(after), [null, null, null, null, null, null, null, null, null]);
  assert.equal(after.updatedAt, before.updatedAt, "抛错发生在 SQL 之前 ⇒ 行不得有任何改动");
});

test("负向③｜落账抛（真服务面未命中 runId）：只 warn，既有行保持 9 列 NULL", async () => {
  const f = await fixture();
  const runId = "nc-missing-run";
  insertRow(f, runId);
  const before = f.runtime.squadRunRepo.get(runId)!;
  const warns: Array<{ message: string }> = [];

  await captureSquadRunUsage(realDeps(f, taskServiceStub({ totalTokens: 4242 }), warns), {
    target: f.target,
    runId: "not-in-ledger",
    sessionId: "sess-nc",
  });

  assert.equal(warns.length, 1, "服务面「未命中即抛」被捕获接住（只 warn）");
  assert.match(warns[0]!.message, /not-in-ledger/, "warn 点名的是失败的那条 runId");
  const after = f.runtime.squadRunRepo.get(runId)!;
  assert.deepEqual(usageColumns(after), [null, null, null, null, null, null, null, null, null]);
  assert.equal(after.updatedAt, before.updatedAt, "别的行不得被牵连");
});

test("负向④｜sessionId === null：零拉取零落账零告警；行保持 NULL（不写 0）", async () => {
  const f = await fixture();
  const runId = "nc-no-session";
  insertRow(f, runId, { sessionId: null });
  const pulls: string[] = [];
  const warns: Array<{ message: string }> = [];
  const records: string[] = [];
  const squadRuntime: SquadRunUsageCaptureDeps["squadRuntime"] = {
    async recordSquadRunUsage() {
      records.push("called");
    },
  };

  await captureSquadRunUsage(
    {
      zcodeTaskService: taskServiceStub({ totalTokens: 999 }, (taskId) => pulls.push(taskId)),
      squadRuntime,
      logger: { warn: (message) => warns.push({ message }) },
    },
    { target: f.target, runId, sessionId: null },
  );

  assert.deepEqual([pulls, records, warns], [[], [], []], "无会话 ⇒ 静默跳过（不拉不写不告警）");
  assert.deepEqual(
    usageColumns(f.runtime.squadRunRepo.get(runId)),
    [null, null, null, null, null, null, null, null, null],
    "留 NULL 是诚实登记（写 0 才是说谎）",
  );
});

test("正向控制｜全 0 用量经真服务面真 repo：9 列读回 0 且 recorded_at 非空（0 ≠ 未记录）", async () => {
  const f = await fixture();
  const runId = "nc-zero";
  insertRow(f, runId);
  const warns: Array<{ message: string }> = [];
  assert.deepEqual(usageColumns(f.runtime.squadRunRepo.get(runId)), [
    null,
    null,
    null,
    null,
    null,
    null,
    null,
    null,
    null,
  ]);

  await captureSquadRunUsage(realDeps(f, taskServiceStub({ totalTokens: 0 }), warns), {
    target: f.target,
    runId,
    sessionId: "sess-nc",
  });

  assert.deepEqual(warns, [], "成功路径不告警");
  const after = f.runtime.squadRunRepo.get(runId)!;
  assert.deepEqual(
    usageColumns(after).slice(0, 8),
    [0, 0, 0, 0, 0, 0, 0, 0],
    "8 个数值列读回恰 0（不是 NULL —— 这是「跑过但没消耗」的事实）",
  );
  assert.ok(
    typeof after.usageRecordedAt === "number" && after.usageRecordedAt > 0,
    "存在性开关非空且为正数 —— 「跑过但没消耗」与「没记账」因此可区分",
  );
});

/* ─────────────── 看门狗结算臂（行为 + 次序探针，真 runtime / 真台账 / 真 capture 模块） ─────────────── */

function runtimeUnavailable(): Error {
  const error = new Error("agent runtime unavailable");
  (error as Error & { code?: string }).code = ZCODE_AGENT_RUNTIME_UNAVAILABLE_CODE;
  return error;
}

async function sweep(f: Fixture, captureUsage: SquadWatchdogSweepPorts["captureUsage"]) {
  const ports = createSquadWatchdogSweepPorts({
    squadRuntime: f.service,
    agentService: {
      async readSession() {
        throw runtimeUnavailable();
      },
    } as never,
    stopSession: null,
    logger: silentLogger,
    ...(captureUsage ? { captureUsage } : {}),
  });
  return runSquadWatchdogSweep({
    targets: [f.target],
    ports,
    logger: silentLogger,
    runScope: "all",
    pendingStops: new Map<string, number>(),
    now: () => NOW,
  });
}

test("负向⑤｜看门狗臂：结算成功但补拉失败 ⇒ 结算计数不变、9 列 NULL、只 warn；且次序=终态在先、留痕在后", async () => {
  const f = await fixture();
  const runId = "nc-watchdog";
  const itemId = `wi-${runId}`;
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
    runId,
    workItemId: itemId,
    parentWorkItemId: itemId,
    agentId: "ta-nc",
    isLeaderTask: false,
  });
  await f.runtime.lifecycle.bindMemberRunSession({ runId, sessionId: "sess-dead" });

  const workspaceKey = resolveWorkspaceKey({
    workspacePath: f.repoRoot,
    workspaceIdentity: WS,
  });
  const inboxRepo = createInboxItemRepo(f.db);
  let statusAtCapture: string | undefined;
  let inboxAtCapture = -1;
  const captureWarns: Array<{ message: string }> = [];

  const summary = await sweep(f, async (target, input) => {
    // 捕获**时点**的两个实体探针（不靠字符串比对）：终态是否已写、留痕是否还没发生。
    statusAtCapture = f.runtime.squadRunRepo.get(input.runId)?.status;
    inboxAtCapture = inboxRepo.listByWorkspace(workspaceKey).length;
    return captureSquadRunUsage(
      realDeps(
        f,
        {
          async getTaskTokenUsage() {
            throw new Error("usage query timed out");
          },
        },
        captureWarns,
      ),
      { target, runId: input.runId, sessionId: input.sessionId },
    );
  });

  assert.deepEqual(
    summary,
    { settled: 1, stopped: 0, skipped: 0, failed: 0 },
    "捕获失败绝不允许把一条已结算的行算成 failed",
  );
  assert.equal(statusAtCapture, "discarded", "次序：补拉发生在终态写入（discarded）之后");
  assert.equal(inboxAtCapture, 0, "次序：补拉发生在 Inbox 留痕之前（终态 → 补拉 → 留痕）");
  assert.equal(captureWarns.length, 1, "补拉失败留一行 warn");
  assert.match(captureWarns[0]!.message, new RegExp(runId));

  const after = f.runtime.squadRunRepo.get(runId)!;
  assert.deepEqual(usageColumns(after), [null, null, null, null, null, null, null, null, null]);
  assert.equal(after.status, "discarded", "终态照写（捕获不是结算的条件）");
  assert.equal(inboxRepo.listByWorkspace(workspaceKey).length, 1, "留痕照旧（捕获失败不阻断）");
});

/* ─────────────── H1：接线计数独立扫描（我自己的扫描法，非复用实现者守卫） ─────────────── */

const HOST_INDEX_SRC = readFileSync(
  join(resolve(dirname(fileURLToPath(import.meta.url)), "../src/host"), "index.ts"),
  "utf8",
);

test("接线独立扫描｜捕获工具单点定义 + index.ts 恰 5 处调用，且不侵入派发桥 MCP 段", () => {
  const captureModuleSrc = readFileSync(
    join(
      resolve(dirname(fileURLToPath(import.meta.url)), "../src/host"),
      "squadRunUsageCapture.ts",
    ),
    "utf8",
  );
  const definitionsInModule =
    captureModuleSrc.split("export async function captureSquadRunUsage(").length - 1;
  assert.equal(definitionsInModule, 1, "捕获工具定义单点（行为模块）");
  assert.equal(
    HOST_INDEX_SRC.split("function captureSquadRunUsage(").length - 1,
    0,
    "index.ts 不得再定义一份捕获工具（只接线）",
  );

  const callSites = HOST_INDEX_SRC.split("captureSquadRunUsage(").length - 1;
  assert.equal(callSites, 5, "index.ts 恰 5 处调用（防漏接 / 防顺手第六处）");

  // 三处臂①（终态三出口）必须落在「有台账行」的闸内；一处看门狗端口；一处启动和解队长臂。
  const gateStart = HOST_INDEX_SRC.lastIndexOf(
    'if (ledgerAction !== "none") {',
    HOST_INDEX_SRC.indexOf("const subscriptionKey = cronRunSubscriptionKey("),
  );
  const sendPromptAt = HOST_INDEX_SRC.indexOf("await zcodeTaskService.sendPrompt(", gateStart);
  assert.ok(gateStart > 0 && sendPromptAt > gateStart, "台账闸区间可定位");
  const gateRegion = HOST_INDEX_SRC.slice(gateStart, sendPromptAt);
  assert.equal(
    gateRegion.split("captureSquadRunUsage(").length - 1,
    3,
    "臂①三出口全在台账闸内（独立安排 ⇒ 零捕获）",
  );
  const memberArm = gateRegion.slice(
    gateRegion.indexOf("completeMemberRun: async (runId)"),
    gateRegion.indexOf("completeLeaderRun: async (runId)"),
  );
  assert.ok(
    memberArm.indexOf("completeMemberRun(") < memberArm.indexOf("captureSquadRunUsage("),
    "队员成功出口：终态写入在前、补拉在后",
  );
  const leaderArm = gateRegion.slice(gateRegion.indexOf("completeLeaderRun: async (runId)"));
  assert.ok(
    leaderArm.indexOf("completeLeaderRun(") < leaderArm.indexOf("captureSquadRunUsage("),
    "队长成功出口：终态写入在前、补拉在后",
  );
  const failureArm = gateRegion.slice(
    gateRegion.indexOf('outcome.outcome !== "succeeded"'),
    gateRegion.indexOf("listener(outcome);"),
  );
  const failAt = failureArm.indexOf("failMemberRun(");
  const captureAt = failureArm.indexOf("captureSquadRunUsage(");
  const inboxAt = failureArm.indexOf("recordInboxItem(");
  assert.ok(
    failAt >= 0 && captureAt > failAt && inboxAt > captureAt,
    "失败出口次序：failMemberRun → 补拉 → recordInboxItem（终态 → 补拉 → 留痕）",
  );

  const watchdogRegion = HOST_INDEX_SRC.slice(
    HOST_INDEX_SRC.indexOf("function resolveSquadWatchdogSweepPorts("),
    HOST_INDEX_SRC.indexOf("function stopSquadWatchdogTick("),
  );
  assert.equal(
    watchdogRegion.split("captureSquadRunUsage(").length - 1,
    1,
    "臂②（看门狗结算端口）恰一处",
  );
  assert.ok(
    watchdogRegion.includes("captureUsage = zcodeTaskService"),
    "数据源缺席 ⇒ 端口缺席（静默跳过留 NULL）",
  );

  const startupRegion = HOST_INDEX_SRC.slice(
    HOST_INDEX_SRC.indexOf("async function settleStaleLeaderRunsBestEffort("),
    HOST_INDEX_SRC.indexOf("async function forEachSquadWorkspaceTarget("),
  );
  assert.equal(
    startupRegion.split("captureSquadRunUsage(").length - 1,
    1,
    "臂⑤（启动和解队长臂）恰一处",
  );
  assert.ok(
    startupRegion.indexOf("squadRuntime.failMemberRun(") <
      startupRegion.indexOf("captureSquadRunUsage(") &&
      startupRegion.indexOf("captureSquadRunUsage(") <
        startupRegion.indexOf("squadRuntime.recordInboxItem("),
    "启动和解次序：结算成功 → 补拉 → 留痕",
  );

  const mcpStart = HOST_INDEX_SRC.indexOf(
    "const mcpSyncService = targetServices.getOptional(IMcpSyncService);",
  );
  const mcpEnd = HOST_INDEX_SRC.indexOf("const traceId = eventKey as TraceId;");
  assert.ok(mcpStart > 0 && mcpEnd > mcpStart, "派发桥 MCP 段边界可定位");
  assert.equal(
    HOST_INDEX_SRC.slice(mcpStart, mcpEnd).includes("captureSquadRunUsage"),
    false,
    "H3：用量捕获不得侵入派发桥的 MCP 挂载段",
  );
});
