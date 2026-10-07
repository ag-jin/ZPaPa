// eslint-disable-next-line typescript-eslint/triple-slash-reference -- 与同目录既有用例同一处声明
/// <reference path="../../services/src/runtime-tools/node-forge.d.ts" />
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { promisify } from "node:util";
import { MS_PER_MINUTE } from "@zcode/shared";
import { ZCODE_AGENT_RUNTIME_UNAVAILABLE_CODE } from "@zcode/services";
import { createInboxItemRepo } from "@zcode/services/node";
import { createSquadRuntimeService } from "@zcode/services/node";
import { runTasksDatabaseMigrations } from "../../services/src/session/tasksDatabase/migrations.js";
import { createSquadRuntime } from "../../services/src/workitem/squadRuntime.js";
import type { SquadRuntime } from "../../services/src/workitem/squadContracts.js";
import {
  createSquadWatchdogSweepPorts,
  runSquadWatchdogSweep,
  type SquadWatchdogLogger,
  type SquadWatchdogSweepPorts,
} from "../src/host/squadWatchdogTick.js";

/* W3 复验（看门狗六件套收官 · test-verifier 独立构造）：**工具臂（口径 A）的执行半**。

   口径 A（用户 2026-10-07 裁定）：检出「单次工具超阈值」⇒ 只落 Inbox 提醒；**绝不调 stop、不结算、
   台账零动作**；信号不可得 ⇒ 整体降级 no-op + 首见一次日志。

   本文件不复用实现轮的任何夹具/断言，只把已批准接缝当观察面：真实 runtime + 真实 sqlite 台账 +
   `createSquadWatchdogSweepPorts`（真实适配层）+ 注入式 `agentService`/`stopSession` 探针。
   四态（超阈提醒 / 未超不动 / 无信号降级 / 端口抛错容错）逐态断言，并带**阳性对照**证明 stop 探针
   是活的（否则「没调 stop」可能只是因为探针根本没接上）。 */

const WS = "w3-tool-arm-recheck";
const NOW = 1_800_000_000_000;

const run = promisify(execFile);

/** 自建一次性 git 仓库（`getSquadWatchdogGitFacts` 走真 git；不与实现轮夹具共享代码）。 */
async function gitRepo(): Promise<string> {
  const root = mkdtempSync(join(tmpdir(), "w3-tool-recheck-"));
  await run("git", ["init", "-q", "-b", "main"], { cwd: root });
  await run("git", ["config", "user.email", "v@v"], { cwd: root });
  await run("git", ["config", "user.name", "v"], { cwd: root });
  writeFileSync(join(root, "seed.txt"), "seed\n");
  await run("git", ["add", "-A"], { cwd: root });
  await run("git", ["commit", "-qm", "seed"], { cwd: root });
  return root;
}

type Stub = {
  /** `readSession` 的行为（探测与工具读数**共用**这一个事实来源，正如生产实现）。 */
  mode: "executing" | "not_executing" | "probe_error";
  /** 逐会话的活跃工具调用投影。 */
  toolsBySession: Map<
    string,
    Array<{ toolCallId: string; toolName: string; status: string; startedAt?: number }>
  >;
};

type Fixture = {
  runtime: SquadRuntime;
  service: ReturnType<typeof createSquadRuntimeService>;
  target: { path: string; identity: string };
  stub: Stub;
  stops: string[];
  lines: string[];
  ports: SquadWatchdogSweepPorts;
  openRun(input: { runId: string; sessionId: string; itemId: string; agentId: string }): void;
};

async function setup(): Promise<Fixture> {
  const repoRoot = await gitRepo();
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

  const stub: Stub = { mode: "executing", toolsBySession: new Map() };
  const stops: string[] = [];
  const lines: string[] = [];
  const logger: SquadWatchdogLogger = {
    info: (message) => lines.push(message),
    warn: (message) => lines.push(message),
  };
  const ports = createSquadWatchdogSweepPorts({
    squadRuntime: service,
    agentService: {
      async readSession(input: { sessionId: string }) {
        if (stub.mode === "probe_error") throw new Error("readSession 探测异常（复验：通用异常）");
        if (stub.mode === "not_executing") {
          return { runtime: {}, projection: {} };
        }
        return {
          runtime: { activeTurnId: "turn-live" },
          projection: { activeToolCalls: stub.toolsBySession.get(input.sessionId) ?? [] },
        };
      },
    } as never,
    stopSession: async (input) => {
      stops.push(input.runId);
      return true;
    },
    logger,
  });

  // 一名有容量余量的队员（id 由服务面生成；用例通过 name 取回）。
  runtime.teamAgentService.create({
    name: "recheck-tool-agent",
    systemPrompt: "s",
    memoryScope: "project",
    maxConcurrentRuns: 4,
  });

  return {
    runtime,
    service,
    target,
    stub,
    stops,
    lines,
    ports,
    openRun(input) {
      if (runtime.workItemRepo.get(input.itemId) === null) {
        runtime.workItemRepo.insert({
          id: input.itemId,
          workspaceIdentity: WS,
          workspacePath: repoRoot,
          title: `标题-${input.itemId}`,
          body: "",
          status: "in_progress",
          assignee: { type: "agent", id: input.agentId },
          labels: [],
          properties: {},
          position: 0,
        });
      }
      runtime.squadRunRepo.insert({
        runId: input.runId,
        workspaceKey: WS,
        workspacePath: repoRoot,
        workItemId: input.itemId,
        parentWorkItemId: input.itemId,
        agentId: input.agentId,
        isLeaderTask: false,
        branch: null,
        dirName: null,
        status: "open",
        sessionId: input.sessionId,
        dispatchCause: null,
        causedByRunId: null,
        openedAt: NOW,
        settleReason: null,
        createdAt: NOW,
        updatedAt: NOW,
      });
    },
  };
}

const sweep = async (
  f: Fixture,
  overrides?: Partial<Parameters<typeof runSquadWatchdogSweep>[0]>,
): Promise<{ settled: number; stopped: number; skipped: number; failed: number }> =>
  runSquadWatchdogSweep({
    targets: [f.target],
    ports: f.ports,
    logger: { info: (m) => f.lines.push(m), warn: (m) => f.lines.push(m) },
    runScope: "all",
    pendingStops: new Map<string, number>(),
    now: () => NOW,
    ...overrides,
  });

const stalled = async (f: Fixture) =>
  (await f.service.listInboxItems()).filter((item) => item.kind === "run_stalled");

const runningTool = (over: { toolCallId: string; toolName?: string; startedAt: number }) => ({
  toolCallId: over.toolCallId,
  toolName: over.toolName ?? "bash",
  status: "running",
  startedAt: over.startedAt,
});

test("W3 工具臂｜超阈值 ⇒ 恰一条 run_stalled 提醒；台账零动作；绝不调 stop（带阳性对照）", async () => {
  const f = await setup();
  const agentId = f.runtime.teamAgentService.list()[0]!.id;
  f.openRun({ runId: "tool-over", sessionId: "sess-tool", itemId: "wi-tool", agentId });
  f.openRun({ runId: "idle-run", sessionId: "sess-idle", itemId: "wi-idle", agentId });
  // 6 分钟 > 缺省 5 分钟（阈值来自 shared 单源，本用例不写死分钟数）。
  f.stub.toolsBySession.set("sess-tool", [
    runningTool({ toolCallId: "tc-over", startedAt: NOW - 6 * MS_PER_MINUTE }),
  ]);
  f.stub.toolsBySession.set("sess-idle", []);

  const summary = await sweep(f, {
    // 阳性对照：给 idle-run 一条超阈值的静默信号 —— 空闲档**应当**发 stop。
    // 有它，「工具臂那条 run 没被 stop」才排除了「stop 探针根本没接上」这个解释。
    ports: {
      ...f.ports,
      readIdleMsByRunId: async () => new Map([["idle-run", 11 * MS_PER_MINUTE]]),
    },
  });

  assert.deepEqual(
    summary,
    { settled: 0, stopped: 1, skipped: 0, failed: 0 },
    "空闲档发了一条 stop",
  );
  assert.deepEqual(f.stops, ["idle-run"], "stop 探针是活的；且**工具超时那条 run 没有被 stop**");
  assert.equal(
    f.runtime.squadRunRepo.get("tool-over")?.status,
    "open",
    "口径 A：只提醒不处置 —— 台账一个字不写（结算会把一次「慢工具」判成失败）",
  );
  const alerts = await stalled(f);
  assert.deepEqual(
    alerts.map((item) => [item.runId, item.workItemId]),
    [["tool-over", "wi-tool"]],
    "命中 ⇒ 恰一条 run_stalled 提醒（带 run 与工作项，人知道去看哪件事）",
  );
  assert.match(
    String(alerts[0]?.detail.reason),
    /watchdog_tool_timeout[\s\S]*bash[\s\S]*tc-over[\s\S]*6 分钟/,
    "提醒要点名事实：哪个工具名、哪个工具调用、超了多久（人要知道去看什么）",
  );
});

test("W3 工具臂｜未超阈值 ⇒ 零提醒、零提醒日志（健康行不刷屏）", async () => {
  const f = await setup();
  const agentId = f.runtime.teamAgentService.list()[0]!.id;
  f.openRun({ runId: "tool-under", sessionId: "sess-under", itemId: "wi-under", agentId });
  f.stub.toolsBySession.set("sess-under", [
    runningTool({ toolCallId: "tc-under", startedAt: NOW - 4 * MS_PER_MINUTE }),
  ]);

  const summary = await sweep(f);

  assert.deepEqual(
    summary,
    { settled: 0, stopped: 0, skipped: 0, failed: 0 },
    "未超阈值 ⇒ 无任何动作",
  );
  assert.equal((await stalled(f)).length, 0, "未超阈值不得落 Inbox");
  assert.equal(
    f.lines.filter((line) => line.includes("工具超时提醒")).length,
    0,
    "未超阈值不得打工具提醒日志",
  );
  assert.equal(f.runtime.squadRunRepo.get("tool-under")?.status, "open");
});

test("W3 工具臂｜信号不可得 ⇒ 降级 no-op + 首见一次日志（两轮只一条）+ 不落 Inbox + 不结算", async () => {
  const f = await setup();
  const agentId = f.runtime.teamAgentService.list()[0]!.id;
  f.openRun({ runId: "tool-nosignal", sessionId: "sess-nosignal", itemId: "wi-nosignal", agentId });
  f.stub.mode = "probe_error"; // 探测/读数都不可得（同一次 readSession 的两个消费面）

  const toolSignalLogged = new Set<string>();
  await sweep(f, { toolSignalLogged });
  await sweep(f, { toolSignalLogged });

  assert.equal(
    f.runtime.squadRunRepo.get("tool-nosignal")?.status,
    "open",
    "信号不可得 ⇒ 不猜（不结算）；探测不可得时判定面走 skip_probe_unavailable",
  );
  assert.equal(
    (await stalled(f)).length,
    0,
    "降级路径不落 Inbox（暂态结论会永久占住该 run 的 dedup 位）",
  );
  assert.equal(
    f.lines.filter((line) => line.includes("工具看门狗无信号")).length,
    1,
    "「工具臂此刻不工作」必须可见，且**首见一次**（每轮 60s 各打一遍就是刷屏）",
  );
});

test("W3 工具臂｜读数端口自身抛错 ⇒ 逐条容错（整轮不计 failed）+ 响亮留痕 + 台账零动作", async () => {
  const f = await setup();
  const agentId = f.runtime.teamAgentService.list()[0]!.id;
  f.openRun({ runId: "tool-port-throws", sessionId: "sess-port", itemId: "wi-port", agentId });
  f.stub.toolsBySession.set("sess-port", [
    runningTool({ toolCallId: "tc-x", startedAt: NOW - 60 * MS_PER_MINUTE }),
  ]);
  const ports: SquadWatchdogSweepPorts = {
    ...f.ports,
    readSessionTools: async () => {
      throw new Error("工具信号端口异常（复验）");
    },
  };

  const summary = await sweep(f, { ports });

  assert.deepEqual(
    summary,
    { settled: 0, stopped: 0, skipped: 0, failed: 0 },
    "一条读数失败不得把整轮计成 failed（逐条容错）",
  );
  assert.equal(f.runtime.squadRunRepo.get("tool-port-throws")?.status, "open", "台账零动作");
  assert.equal((await stalled(f)).length, 0, "读数失败没有结论 ⇒ 不落 Inbox");
  assert.ok(
    f.lines.some((line) => line.includes("工具信号读取失败") && line.includes("sess-port")),
    "读数失败必须响亮留痕并带 session（否则「工具臂不工作」与「工具都很健康」长得一样）",
  );
});

test("W3 工具臂接线｜readSessionTools 适配：startedAt 缺省 ⇒ null；runtime 不可得 ⇒ 空表；其余异常 ⇒ unavailable；agentService 缺席 ⇒ unavailable", async () => {
  const f = await setup();
  const makePorts = (
    readSession: ((input: { sessionId: string }) => Promise<unknown>) | null,
  ): SquadWatchdogSweepPorts =>
    createSquadWatchdogSweepPorts({
      squadRuntime: f.service,
      agentService: readSession === null ? null : ({ readSession } as never),
      stopSession: null,
      logger: { info: () => {}, warn: () => {} },
    });

  // 1) 正常：`startedAt?` 缺席 = 没有这个时钟事实 ⇒ 显式 null（NaN 会把「超时」静默变成「不超时」）。
  const mapped = await makePorts(async () => ({
    projection: {
      activeToolCalls: [
        { toolCallId: "t1", toolName: "bash", status: "running" },
        { toolCallId: "t2", toolName: "grep", status: "completed", startedAt: 42 },
      ],
    },
  })).readSessionTools({ sessionId: "s", workspacePath: f.target.path });
  assert.deepEqual(mapped, {
    kind: "tools",
    activeToolCalls: [
      { toolCallId: "t1", toolName: "bash", status: "running", startedAt: null },
      { toolCallId: "t2", toolName: "grep", status: "completed", startedAt: 42 },
    ],
  });

  // 2) runtime 不在 = 明确「没有东西在执行」⇒ 空工具表（不是「不可得」）。
  const unavailableRuntime = await makePorts(async () => {
    const error = new Error("agent runtime unavailable");
    (error as Error & { code?: string }).code = ZCODE_AGENT_RUNTIME_UNAVAILABLE_CODE;
    throw error;
  }).readSessionTools({ sessionId: "s", workspacePath: f.target.path });
  assert.deepEqual(unavailableRuntime, { kind: "tools", activeToolCalls: [] });

  // 3) 其余异常 ⇒ 不可得（降级 no-op，绝不按「没有在跑的工具」处理）。
  const broken = await makePorts(async () => {
    throw new Error("未知读数异常");
  }).readSessionTools({ sessionId: "s", workspacePath: f.target.path });
  assert.deepEqual(broken, { kind: "unavailable" });

  // 4) 读口缺席 ⇒ 不可得。
  const absent = await makePorts(null).readSessionTools({
    sessionId: "s",
    workspacePath: f.target.path,
  });
  assert.deepEqual(absent, { kind: "unavailable" });
});

test("W3 六件③ TTL｜会话活着但墙钟超阈值 ⇒ 结算 watchdog_ttl（共用执行分支；留痕与重试义务落定）", async () => {
  const f = await setup();
  const agentId = f.runtime.teamAgentService.list()[0]!.id;
  f.openRun({ runId: "ttl-run", sessionId: "sess-ttl", itemId: "wi-ttl", agentId });
  f.stub.toolsBySession.set("sess-ttl", []); // 有工具信号且无在跑工具 ⇒ 工具臂不产任何决策

  // 判据是纯墙钟事实（`opened_at` + per-agent TTL，缺省 30 分钟单源在 shared）：把当前时刻推进
  // 31 分钟 ⇒ 末位 TTL 档必须命中（会话活着，既不是死会话也没有静默信号）。
  const summary = await sweep(f, { now: () => NOW + 31 * MS_PER_MINUTE });

  assert.deepEqual(summary, { settled: 1, stopped: 0, skipped: 0, failed: 0 }, "TTL 档命中并结算");
  assert.equal(
    f.runtime.squadRunRepo.get("ttl-run")?.settleReason,
    "watchdog_ttl",
    "结算原因必须落族内码值（熔断窗口计数与重试预算读它）",
  );
  const alerts = await stalled(f);
  assert.deepEqual(
    alerts.map((item) => [item.runId, item.detail.reason]),
    [["ttl-run", "watchdog_ttl"]],
    "TTL 结算同样留痕 run_stalled（原因用码值，人复看时能分辨是超时不是死会话）",
  );
  assert.deepEqual(
    f.runtime.squadDeferredDispatchRepo.list(WS).map((obligation) => obligation.origin),
    ["watchdog"],
    "TTL 结算后自动登记重试义务（与死会话同一路径）",
  );
});

test("W3 跨轮｜工具提醒占位后同 run 被结算：收件箱仍一格（先写者占位）；台账与重试义务照常落定", async () => {
  const f = await setup();
  const agentId = f.runtime.teamAgentService.list()[0]!.id;
  f.openRun({ runId: "tool-then-settle", sessionId: "sess-mixed", itemId: "wi-mixed", agentId });
  f.stub.toolsBySession.set("sess-mixed", [
    runningTool({ toolCallId: "tc-mixed", startedAt: NOW - 30 * MS_PER_MINUTE }),
  ]);

  await sweep(f);
  assert.equal((await stalled(f)).length, 1, "第一轮：工具提醒占位");

  // 第二轮：会话已死（探测明确不在执行）⇒ 看门狗结算同一条 run。
  f.stub.mode = "not_executing";
  const second = await sweep(f);

  assert.deepEqual(second, { settled: 1, stopped: 0, skipped: 0, failed: 0 }, "第二轮结算这一条");
  assert.equal(
    f.runtime.squadRunRepo.get("tool-then-settle")?.settleReason,
    "watchdog_dead_session",
    "结算事实照常落盘（熔断计数/重试预算读的是它）",
  );
  const items = await stalled(f);
  assert.equal(
    items.length,
    1,
    "W1/W2 与 W3 的 run_stalled 共用 dedupKey（按 runId）⇒ 同一条 run 只有一格",
  );
  assert.match(
    String(items[0]?.detail.reason),
    /watchdog_tool_timeout/,
    "先写者（工具提醒）占位：结算留痕在收件箱里不单独可见（结算事实在台账与日志可见）",
  );
  const obligations = f.runtime.squadDeferredDispatchRepo.list(WS);
  assert.deepEqual(
    obligations.map((obligation) => [obligation.origin, obligation.agentId]),
    [["watchdog", agentId]],
    "结算后自动登记重试义务（tick 的重试接线在真结算路径上生效）",
  );
});
