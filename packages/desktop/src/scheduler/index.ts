/* eslint-disable max-lines -- 调度器入口集中编排**共用一个 20s tick** 的四路任务
   （automations / manual run / off-peak / wake rules）。四路的 tick 归属关系本身就是契约
   （「唤醒规则复用同一个 tick」由用例钉住），拆成多个文件会让这份共用关系在文件边界上变得不可见。 */
// 常驻 cron scheduler 进程：由 desktop main 通过 electronUtilityProcess.fork 拉起。
// 职责（tasks-index 属主方案）：
//   - 轮询 tasks-index 的 automations，事务认领到期任务（AutomationRepo.claimDue：BEGIN IMMEDIATE + running 0→1）
//   - 轮询 automation_runs 里的 manual run，手动触发累计 run_count，但不推进 next_run_at / max_runs / lifecycle
//   - 维护派发状态机：misfire 跳过、single-flight 认领、成功结算、失败退避重试
//   - 把到期任务的派发请求发回 main（main 再翻译成 CronRun 转给 workspace host 执行 createTask+sendPrompt）
//   - 收到 main 回报后结算 automation + automation_runs
//   - 闲时任务（off_peak_tasks）：启动回收中断任务，认领 schedulable=1 的 queued 任务派发；
//     与 automation 表/消息/常量全部独立，⚠ 无 misfire-skip 语义（顺延不丢弃）
//   - 唤醒规则（wake_rules）：与上面三路共用一个 tick。只做「认领到点 + 判 + 推进 + 转发一条薄请求」，
//     派给谁 / 简报 / 开树一律在 host 侧规划（调度器不读小队定义）
// 本进程只读写 tasks-index，不碰 UI / agent runtime；createTask 由 host 域执行。
import {
  AutomationRepo,
  computeAutomationNextRunAt,
  createWakeRuleRepo,
  isOneShotAutomation,
  OffPeakTaskRepo,
  type WakeRuleRepo,
} from "@zcode/services/node";
import { getTasksIndexDatabasePath } from "@zcode/services/storage-startup";
import { mkdir } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname as resolveDirname } from "node:path";
import {
  resolveWorkspaceKey,
  type ZCodeAutomation,
  type ZCodeAutomationTrigger,
  type ZCodeAutomationRun,
  type ZCodeOffPeakTask,
} from "@zcode/shared";
import type { MainToSchedulerMessage, SchedulerToMainMessage } from "./schedulerProtocol.js";
import { isMissedTriggerWindow } from "./misfireDecision.js";
import { settleManualClaimForDispatchResult } from "./manualClaimRelease.js";
import { settleOffPeakDispatchResult } from "./offPeakDispatchSettlement.js";
import {
  startSchedulerResourceTelemetry,
  type SchedulerResourceTelemetry,
} from "./schedulerResourceTelemetry.js";
import { createWakeTick } from "./wakeTick.js";

/** 轮询间隔：cron 最小粒度是分钟，20s 轮询足以按时命中且开销低。 */
const POLL_INTERVAL_MS = 20_000;
/**
 * misfire 宽限：next_run_at 早于 now 超过该值，视为「关机/休眠/退出期间错过的窗口」→ 记 skipped 不补跑。
 * 取值需明显大于一次正常轮询延迟（避免把正常到点误判成 misfire），又能覆盖短暂卡顿。
 */
const MISFIRE_GRACE_MS = 5 * 60_000;

const { parentPort } = process;

type InFlight = {
  automationId: string;
  workspaceKey: string;
  trigger: ZCodeAutomationTrigger;
};

const repo = new AutomationRepo();
/** runId → 在途派发上下文；等 main 回报后结算。scheduler 重启丢失时靠 claimDue 的僵尸回收兜底。 */
const inFlight = new Map<string, InFlight>();

// ---- 闲时任务（off-peak）----
const offPeakRepo = new OffPeakTaskRepo();
/** 进程内退避表：offPeakTaskId → 下次允许派发时间/已失败次数。scheduler 重启即重置，无害。 */
const offPeakRetryAt = new Map<string, number>();
const offPeakRetryAttempts = new Map<string, number>();
/** 在途派发集合：仅用于退出时释放认领；迟到结果凭 offPeakTaskId 即可结算，不依赖它。 */
const offPeakInFlight = new Set<string>();

// ---- 唤醒规则（squad wake rules）----
/* 唤醒规则与 automations / off-peak **同库、表独立**（recon.md 缺口 #6：`WakeRuleRepo.listReady`
   此前没有任何调用方，于是「建了规则但永远不会到点」）。

   为什么这里自己开连接：`AutomationRepo` 的连接是 private，而调度器是独立进程、也拿不到 host 侧的
   `TaskIndexRepo`（它的 `openSharedDatabase()` 只在 host 进程里存在）。本进程的 AutomationRepo /
   OffPeakTaskRepo 各持一条同库连接，这里按同一方式再开一条 —— recon.md F3 的禁令针对的是
   「另开一条**跳过迁移/回填**的连接」，而迁移由先打开的 `AutomationRepo.ensureReady()` 跑完，
   本连接只在它之后打开（见 main() 的次序）。它与 repo / offPeakRepo 一样必须**各自** close。 */
const require = createRequire(import.meta.url);
const { DatabaseSync } = require("node:sqlite") as typeof import("node:sqlite");
type TasksIndexConnection = InstanceType<typeof DatabaseSync>;

/** 本进程的唤醒规则连接（main() 里打开，dispose() 里关闭）。 */
let wakeDb: TasksIndexConnection | null = null;
let wakeRuleRepo: WakeRuleRepo | null = null;

function requireWakeRuleRepo(): WakeRuleRepo {
  if (!wakeRuleRepo) {
    throw new Error("唤醒规则仓库尚未初始化：请先等 main() 里的 AutomationRepo.ensureReady() 完成");
  }
  return wakeRuleRepo;
}

/**
 * 打开唤醒规则用的 tasks-index 连接（PRAGMA 与 AutomationRepo 逐项对齐：同库多连接靠
 * `busy_timeout` 串行化写入）。
 */
async function openWakeRuleDatabase(): Promise<void> {
  const path = getTasksIndexDatabasePath();
  await mkdir(resolveDirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec("PRAGMA busy_timeout = 5000");
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA synchronous = NORMAL");
  wakeDb = db;
  wakeRuleRepo = createWakeRuleRepo(db);
}

/**
 * 工作项 → workspace 绑定（派发目标）。`wake_rules` 表**没有** workspace 列，派发目标只能由工作项给出。
 *
 * 为什么用裸 SQL：冻结面（`@zcode/services/node`）只导出 `createWakeRuleRepo`（没有
 * `createWorkItemRepo`），而调度器进程也没有 host 侧的服务面。这里只读两列、不复制任何领域判定；
 * `workspace_key` 列存的就是工作项的 `workspaceIdentity`（与 `workItemRepo.rowToWorkItem` 同源）。
 * 归档行按 repo 的口径视同不存在（`archived_at IS NULL`），返回 null 后由 wakeTick **响亮失败**。
 *
 * ⚠️ 这是本任务最小接线的**已知粗糙处**（见 task-3-report）：更好的做法是给 node 入口补一个
 * 「按 workItemId 取派发目标」的只读 accessor，让调度器不必读 work_items 的裸列。
 */
function resolveWakeTarget(
  workItemId: string,
): { workspacePath: string; workspaceIdentity?: string } | null {
  if (!wakeDb) throw new Error("唤醒规则连接尚未初始化");
  const row = wakeDb
    .prepare(
      "SELECT workspace_path, workspace_key FROM work_items WHERE id = ? AND archived_at IS NULL",
    )
    .get(workItemId) as { workspace_path: string; workspace_key: string } | undefined;
  return row ? { workspacePath: row.workspace_path, workspaceIdentity: row.workspace_key } : null;
}

/** 唤醒规则到点的一路（判定与 eventKey 构造全在 `wakeTick.ts`，本文件只把它接到既有的 tick 上）。 */
const wakeTick = createWakeTick({
  listReady: (now, limit) => requireWakeRuleRepo().listReady(now, limit),
  resolveWorkspace: (rule) => resolveWakeTarget(rule.workItemId),
  advance: (rule) => {
    // revision fencing（spec §5.7）：只有 revision 仍等于本轮读到的那一版才推进。
    // 未命中说明规则在判定期间被人编辑过 —— 本次派发**作废**，不入库也不覆盖新状态。
    const outcome = requireWakeRuleRepo().casAdvance(
      rule.id,
      rule.revision,
      rule.nextFireAt,
      rule.fireCount,
      rule.pausedReason,
    );
    /* 未命中按**判因**分格留痕（G2）：两种成因的处置不同，合成一条会让人排查时分不出来。
       · fenced：行还在、revision 变了 ⇒ 并发编辑（本格作废）。warn 且带**两侧** revision，
         否则只知道「没推进」，定位不到是谁改的；
       · missing：行已不在 ⇒ 规则被删除 / 归档清理。正常生命周期，不是异常 ⇒ 只留 info。
       advanced 静默（热路径，每格都发生）。 */
    if (outcome.outcome === "fenced") {
      log(
        "warn",
        `wake rule advance rejected by fencing rule=${rule.id} expectedRevision=${rule.revision} currentRevision=${outcome.currentRevision}`,
      );
    } else if (outcome.outcome === "missing") {
      log(
        "info",
        `wake rule missing at advance rule=${rule.id} revision=${rule.revision}（规则已被删除，本格排期自然作废）`,
      );
    }
  },
  postRequest: (request) => {
    const msg: SchedulerToMainMessage = { type: "squad-wake-dispatch-request", ...request };
    parentPort?.postMessage(msg);
  },
});

let ticking = false;
let tickRequested = false;
let schedulerReady = false;
let disposed = false;
let pollTimer: ReturnType<typeof setInterval> | null = null;
/** 资源遥测：本进程唯一的自采定时器。 */
let resourceTelemetry: SchedulerResourceTelemetry | null = null;

function log(level: "info" | "warn" | "error", message: string): void {
  const msg: SchedulerToMainMessage = { type: "scheduler-log", level, message };
  parentPort?.postMessage(msg);
  // 兜底：parentPort 不可用（非 utilityProcess 调试运行）时仍留痕。
  if (!parentPort) {
    // eslint-disable-next-line no-console -- scheduler 调试兜底
    console[level === "error" ? "error" : "log"](`[scheduler] ${message}`);
  }
}

/** 派发时间戳：优先用 next_run_at（重试期间不变，保证 runId 稳定），退到 retry_at / now。 */
function resolveScheduledAt(automation: ZCodeAutomation, now: number): number {
  return automation.nextRunAt ?? automation.retryAt ?? now;
}

function buildRunId(automationId: string, scheduledAt: number): string {
  return `${automationId}:${scheduledAt}`;
}

async function tick(): Promise<void> {
  if (disposed || !schedulerReady || ticking) return;
  ticking = true;
  try {
    do {
      tickRequested = false;
      try {
        const now = Date.now();
        const claimed = await repo.claimDue(now);
        for (const automation of claimed) {
          await handleClaimed(automation, now);
        }
        const manualRuns = await repo.claimManualRuns(now);
        for (const manualRun of manualRuns) {
          await handleClaimedManual(manualRun.automation, manualRun.run);
        }
        const offPeakClaimed = await offPeakRepo.claimDue(now);
        for (const task of offPeakClaimed) {
          await handleOffPeakClaimed(task, now);
        }
        /* 第四条：唤醒规则（recon.md 缺口 #6）。与上面三路**共用同一个 20s tick**——
           另起一个定时器会让两路 tick 相对漂移，misfire / 退避语义也会长出第二套口径。

           ⚠ 必须**每轮都跑** run，不能像原先那样先 `listReady` 判「有没有到点」再决定跑不跑：
           一条已 fire 的规则（advance-before-post）其 `next_fire_at` 已前进到未来，安静期里
           `listReady` 恒为空 —— 若据此跳过 run，则**重投发不出去、过期记录也清理不掉**，
           这次的「TTL 淘汰 + 重投」两格在生产里根本不会执行。run 内部自带 `listReady` 扫描，
           去掉这层多余的预判同时也少一次重复的 SQL。 */
        const evicted = await wakeTick.run(now);
        /* 到 TTL 仍未结算的重投记录会被淘汰并交回这里 —— **必须留痕**：
           「已发出但回执始终不来」（host/main 中途退出）的条目若静默消失，那次唤醒就
           无从排查。attempts=0 表示从未收到任何回执，正是这一形态；
           有过回执（attempts>0）说明是在退避重投里耗尽了 TTL。两者都打 error。 */
        for (const item of evicted) {
          log(
            "error",
            `squad wake dispatch pending expired (TTL) rule=${item.ruleId} eventKey=${item.eventKey}` +
              ` pendingFor=${item.pendingForMs}ms attempts=${item.attempts}` +
              `（本次唤醒放弃，不再重投：迟到的回执只会被当成 unknown）`,
          );
        }
        // keep-awake：上报执行中计数，main 据此 + 设置决定 powerSaveBlocker。
        await reportOffPeakActiveCount();
      } catch (error) {
        log("error", `tick failed: ${error instanceof Error ? error.message : String(error)}`);
      }
      // manual run 的唤醒可能与当前 tick 重叠；因 ticking=true 直接丢弃会让
      // 用户仍需等待下一轮 20 秒轮询。记录 pending，并在本轮完成后立即补跑。
    } while (tickRequested && !disposed);
  } finally {
    ticking = false;
  }
}

function requestTick(): void {
  if (disposed) return;
  if (!schedulerReady || ticking) {
    tickRequested = true;
    return;
  }
  void tick();
}

async function handleClaimed(automation: ZCodeAutomation, now: number): Promise<void> {
  const scheduledAt = resolveScheduledAt(automation, now);
  const runId = buildRunId(automation.automationId, scheduledAt);
  const workspaceKey = resolveWorkspaceKey({
    workspacePath: automation.workspacePath,
    workspaceIdentity: automation.workspaceIdentity,
  });
  // misfire：计划触发时间已远早于 now 且本轮未被接受 → 认定错过窗口，跳过不补跑。
  // 等待重投（retry_at 非空，含等待绑定会话空闲的 deferred）不算错过，见 misfireDecision。
  const missed = isMissedTriggerWindow({
    nextRunAt: automation.nextRunAt,
    retryAt: automation.retryAt,
    dispatchAttempts: automation.dispatchAttempts,
    now,
    graceMs: MISFIRE_GRACE_MS,
  });
  if (missed) {
    // 纯一次性任务（如 delayMinutes 落成的 minute scheduleRule）错过窗口后，
    // 通用重算会给出 anchorAt + k*interval 的下一周期，让“只跑一次”的提醒在后续周期
    // 继续执行。一次性语义是确定的目标时刻，错过即终态，不得再排程新的执行承诺。
    const finalize = isOneShotAutomation(automation);
    const nextRunAt = finalize ? null : computeAutomationNextRunAt(automation, now);
    await repo.skipAndReschedule({
      automationId: automation.automationId,
      runId,
      workspaceKey,
      scheduledAt,
      reason: "computer_asleep_or_app_not_running",
      nextRunAt,
      finalize,
    });
    log(
      "info",
      `skip missed window automation=${automation.automationId} scheduledAt=${scheduledAt}${finalize ? " finalized=one-shot" : ""}`,
    );
    return;
  }

  // 正常派发：先落/更新 run 台账（claimed），再把请求发回 main。
  await repo.upsertRunClaimed({
    runId,
    automationId: automation.automationId,
    workspaceKey,
    scheduledAt,
    trigger: "schedule",
    // 原意图在 dispatch request 中传递，首次有效选择由目标 Host 固定；此处不提前冻结。
  });
  inFlight.set(runId, {
    automationId: automation.automationId,
    workspaceKey,
    trigger: "schedule",
  });
  const run = await repo.getRun(runId);
  postDispatchRequest(automation, runId, run?.modelSelection);
}

function postDispatchRequest(
  automation: ZCodeAutomation,
  runId: string,
  fixedSelection?: ZCodeAutomationRun["modelSelection"],
): void {
  const request: SchedulerToMainMessage = {
    type: "cron-dispatch-request",
    automationId: automation.automationId,
    runId,
    prompt: automation.prompt,
    ...(automation.targetTaskId ? { targetTaskId: automation.targetTaskId } : {}),
    ...((fixedSelection ?? automation.modelSelection)
      ? { modelSelection: fixedSelection ?? automation.modelSelection }
      : {}),
    ...(automation.mode ? { mode: automation.mode } : {}),
    workspacePath: automation.workspacePath,
    ...(automation.workspaceIdentity ? { workspaceIdentity: automation.workspaceIdentity } : {}),
  };
  parentPort?.postMessage(request);
}

async function handleClaimedManual(
  automation: ZCodeAutomation,
  run: ZCodeAutomationRun,
): Promise<void> {
  inFlight.set(run.runId, {
    automationId: automation.automationId,
    workspaceKey: resolveWorkspaceKey({
      workspacePath: automation.workspacePath,
      workspaceIdentity: automation.workspaceIdentity,
    }),
    trigger: "manual",
  });
  postDispatchRequest(automation, run.runId, run.modelSelection);
}

/** 执行中计数上报（keep-awake）：仅在值变化时发消息，减噪。 */
let lastOffPeakActiveCount = -1;
async function reportOffPeakActiveCount(): Promise<void> {
  try {
    const count = await offPeakRepo.countActive();
    if (count === lastOffPeakActiveCount) return;
    lastOffPeakActiveCount = count;
    const msg: SchedulerToMainMessage = { type: "offpeak-active-count", count };
    parentPort?.postMessage(msg);
  } catch (error) {
    log(
      "warn",
      `off-peak active count report failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

// ---- 闲时任务派发 ----

/**
 * 认领后派发闲时任务。退避中的任务立即释放认领等下轮（进程内退避表；每轮 claim+release
 * 两次写，任务数小、WAL 下开销可忽略——若退避任务成规模再把退避下沉进 claimDue）。
 */
async function handleOffPeakClaimed(task: ZCodeOffPeakTask, now: number): Promise<void> {
  const retryAt = offPeakRetryAt.get(task.offPeakTaskId) ?? 0;
  if (retryAt > now) {
    await offPeakRepo.releaseClaim(task.offPeakTaskId, { now });
    return;
  }
  offPeakInFlight.add(task.offPeakTaskId);
  const request: SchedulerToMainMessage = {
    type: "offpeak-dispatch-request",
    offPeakTaskId: task.offPeakTaskId,
    prompt: task.prompt,
    permissionMode: task.permissionMode,
    modelSelection: task.modelSelection,
    ...(task.conversationId ? { conversationId: task.conversationId } : {}),
    ...(task.sessionId ? { sessionId: task.sessionId } : {}),
    ...(task.serverTicketId ? { serverTicketId: task.serverTicketId } : {}),
    workspacePath: task.workspacePath,
    ...(task.workspaceIdentity ? { workspaceIdentity: task.workspaceIdentity } : {}),
  };
  parentPort?.postMessage(request);
  log("info", `off-peak dispatch requested task=${task.offPeakTaskId}`);
}

async function settleDispatchResult(
  msg: Extract<MainToSchedulerMessage, { type: "cron-dispatch-result" }>,
): Promise<void> {
  const context = inFlight.get(msg.runId);
  inFlight.delete(msg.runId);
  const now = Date.now();
  // 从 runId 还原 automationId（context 丢失时兜底，如 scheduler 重启后收到迟到回报）。
  const automationId = context?.automationId ?? msg.runId.split(":")[0]!;
  const workspaceKey = context?.workspaceKey;
  const trigger: ZCodeAutomationTrigger =
    context?.trigger ?? (msg.runId.includes(":manual:") ? "manual" : "schedule");
  const settleManualClaim = async (ok: boolean): Promise<void> => {
    await settleManualClaimForDispatchResult({
      repo,
      automationId,
      runId: msg.runId,
      workspaceKey,
      ok,
      logError: (message) => log("error", message),
    });
  };

  if (msg.ok) {
    if (trigger === "manual") {
      await repo.markManualRunDispatched({
        runId: msg.runId,
        sessionId: msg.sessionId ?? null,
        dispatchedAt: now,
      });
      await settleManualClaim(true);
      return;
    }
    await repo.markRunDispatch({
      runId: msg.runId,
      dispatchStatus: "dispatched",
      sessionId: msg.sessionId ?? null,
    });
    const automation = await repo.get(automationId);
    const nextRunAt = automation ? computeAutomationNextRunAt(automation, now) : null;
    await repo.markDispatched(automationId, { dispatchedAt: now, nextRunAt });
    return;
  }

  const kind = msg.failureKind ?? "transient";
  if (trigger !== "manual" && kind === "deferred") {
    // 等待型重投：目标绑定会话正在执行。既不投递也不判失败，保持 next_run_at 与重试预算
    // 不变，等会话空闲后由下一轮 tick 按 retry_at 重新认领同一条 run。
    //
    // 必须放在 markRunDispatch 之前：那次写入会把 run 记成 failed_to_dispatch，
    // 而运行历史把该状态显示为「失败」——等待不是失败，台账应保持 claimed（进行中）。
    // manual run 不进入等待队列（用户要的是立刻执行）：下面按失败结算。
    await repo.deferDispatch(automationId, { deferredAt: now });
    log(
      "info",
      `defer automation dispatch (bound session busy) automation=${automationId} runId=${msg.runId}`,
    );
    return;
  }

  await repo.markRunDispatch({
    runId: msg.runId,
    dispatchStatus: "failed_to_dispatch",
    error: msg.error ?? "dispatch failed",
  });
  if (trigger === "manual") {
    await settleManualClaim(false);
    return;
  }
  await repo.markDispatchFailed(automationId, {
    failedAt: now,
    error: msg.error ?? "dispatch failed",
    kind,
    // transient 达上限后循环任务跳下一个正常 next_run_at。
    nextRunAt: await repo
      .get(automationId)
      .then((automation) => (automation ? computeAutomationNextRunAt(automation, now) : null)),
  });
}

async function dispose(): Promise<void> {
  if (disposed) return;
  disposed = true;
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = null;
  resourceTelemetry?.stop();
  resourceTelemetry = null;
  // 释放本进程仍在途的认领，避免下次启动等到 CLAIM_STALE 才回收。
  for (const [, context] of inFlight) {
    try {
      if (context.trigger === "manual") {
        await repo.releaseManualClaim(context.automationId, context.workspaceKey);
      } else {
        await repo.releaseClaim(context.automationId);
      }
    } catch {
      // 忽略：退出路径尽力而为。
    }
  }
  inFlight.clear();
  for (const offPeakTaskId of offPeakInFlight) {
    try {
      await offPeakRepo.releaseClaim(offPeakTaskId);
    } catch {
      // 忽略：退出路径尽力而为。
    }
  }
  offPeakInFlight.clear();
  try {
    repo.close();
  } catch {
    // 忽略。
  }
  try {
    offPeakRepo.close();
  } catch {
    // 忽略。
  }
  try {
    // 唤醒规则是**同一个库的另一条连接**（`WakeRuleRepo` 自身没有 close，句柄由本进程持有）：
    // 不关它就会在退出时留下一枚残留句柄（无报错，只是残留）。
    wakeDb?.close();
  } catch {
    // 忽略。
  }
  wakeDb = null;
  wakeRuleRepo = null;
  process.exit(0);
}

parentPort?.on("message", (event: Electron.MessageEvent) => {
  const msg = event.data as MainToSchedulerMessage;
  if (!msg || typeof msg !== "object") return;
  if (msg.type === "scheduler-dispose") {
    void dispose();
    return;
  }
  if (msg.type === "cron-dispatch-result") {
    void settleDispatchResult(msg)
      .then(() => {
        // manual run 可能因同一 automation 已有派发在途而暂时无法认领。
        // 前一轮结算释放 single-flight 锁后主动 tick，避免再次等待 20 秒轮询。
        requestTick();
      })
      .catch((error) => {
        log(
          "error",
          `settle dispatch result failed runId=${msg.runId}: ${error instanceof Error ? error.message : String(error)}`,
        );
      });
    return;
  }
  if (msg.type === "squad-wake-dispatch-result") {
    /* 唤醒派发的回执结算：**这块必须真的重投**。规则在本轮 fire 时已被 CAS 推进
       （advance-before-post），所以「本机没有 host」「转发失败」「库未就绪」这些瞬时结果若只打一条日志，
       那一格就再也推不出来 —— 这次唤醒被静默吞掉，而邻居的 cron / off-peak 都有退避重投。
       判定（重投 / 放弃 / 迟到）在 `wakeTick.settle` 里，这里只按结论留痕：
       permanent（门禁关闭 / 运行时未注册 / 开树失败）是确定性状态，重试不会自愈，故**不**重投，
       但必须留 warn —— 静默丢弃会让「到点了但什么都没发生」无从排查。 */
    const outcome = wakeTick.settle(
      {
        ruleId: msg.ruleId,
        // 协议里这一维叫 runId（与 cron 消息同名），在唤醒这条路上它就是幂等键里的 eventKey。
        eventKey: msg.runId,
        ok: msg.ok,
        ...(msg.failureKind !== undefined ? { failureKind: msg.failureKind } : {}),
        ...(msg.error !== undefined ? { error: msg.error } : {}),
      },
      Date.now(),
    );
    const label = `eventKey=${msg.runId} rule=${msg.ruleId}`;
    switch (outcome.kind) {
      case "settled":
        log("info", `squad wake dispatch ok ${label}`);
        break;
      case "retry":
        log(
          "warn",
          `squad wake dispatch failed (${outcome.failureKind}) ${label} attempts=${outcome.attempts}` +
            ` retryIn=${outcome.retryInMs}ms: ${outcome.error ?? "-"}`,
        );
        break;
      case "abandoned":
        log("warn", `squad wake dispatch abandoned (permanent) ${label}: ${outcome.error ?? "-"}`);
        break;
      case "unknown":
        // 迟到回执（重启后 / 从未发出）：留痕即可，不能拿它去重投一条来路不明的请求。
        log("warn", `squad wake dispatch result without pending request ${label}`);
        break;
    }
    return;
  }
  if (msg.type === "offpeak-dispatch-result") {
    offPeakInFlight.delete(msg.offPeakTaskId);
    void settleOffPeakDispatchResult(
      {
        repo: offPeakRepo,
        retryAt: offPeakRetryAt,
        retryAttempts: offPeakRetryAttempts,
        now: Date.now,
        log,
      },
      msg,
    ).catch((error) => {
      log(
        "error",
        `settle off-peak dispatch result failed task=${msg.offPeakTaskId}: ${error instanceof Error ? error.message : String(error)}`,
      );
    });
    return;
  }
  if (msg.type === "scheduler-wake") {
    log("info", `manual run wake requested automation=${msg.automationId}`);
    requestTick();
  }
});

async function main(): Promise<void> {
  await repo.ensureReady();
  // 唤醒规则连接必须在 AutomationRepo.ensureReady() **之后**打开：那一步跑完 tasks-index 的迁移与回填，
  // 本连接才看得到完整 schema（recon.md F3：另开一条跳过迁移的连接会静默读写到不同库状态）。
  await openWakeRuleDatabase();
  // 闲时任务中断恢复：scheduler 是 app 单例、先于任何派发启动——此刻 DB 里的
  // running 必属上一个 app 实例残留，安全置回 queued（session 保留供 resume 续跑）。
  try {
    const recovered = await offPeakRepo.recoverInterrupted(Date.now());
    if (recovered > 0) {
      log("info", `off-peak recovered ${recovered} interrupted task(s) back to queued`);
    }
  } catch (error) {
    log(
      "error",
      `off-peak recoverInterrupted failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  schedulerReady = true;
  log("info", "cron scheduler started");
  requestTick();
  pollTimer = setInterval(requestTick, POLL_INTERVAL_MS);
  // 资源遥测：60 秒自采一次 CPU / 内存发给 main（heap 只有本进程读得到）。
  resourceTelemetry = startSchedulerResourceTelemetry({
    postMessage: (message) => parentPort?.postMessage(message),
  });
}

void main().catch((error) => {
  log(
    "error",
    `scheduler bootstrap failed: ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exit(1);
});
