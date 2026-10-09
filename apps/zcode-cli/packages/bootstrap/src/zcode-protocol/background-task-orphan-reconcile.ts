/**
 * 后台 Bash 任务的孤儿收敛（background task orphan reconcile）。
 *
 * 问题：子 agent 有 `subagent_outcome`（child session 的持久终态事实）+ 接管时收敛；
 * dynamic workflow run 有 journal 行 + 构造时收敛。后台 Bash 两者皆无——面板的
 * `backgroundWorks` 只由进程内事件喂出（`product-projection.ts` 的
 * `onBackgroundTaskLifecycle`），而 Bash 的持久化 part 只是**launch ACK**
 * （「Command running in background with ID: …」，启动那一刻就写成 completed）。于是进程被
 * 硬杀/崩溃、终态事件没落盘时：没有任何持久事实能证明这个 work 已经不在运行，也没有任何
 * 读面能把它收口——与 48f7f18 之前后台 Agent 的处境同型，只是 bash 连 child 记录都没有。
 *
 * 触发时机（唯一挂点）：`activateSessionForResume` 尾部、子 agent 收敛之后。这是唯一一个可
 * 证明「本 runtime 对该会话名下零个在飞 work」的时刻（runtime task registry 是进程私有内存
 * 态、冷恢复新建即为空），与两个先例（dwf 构造时 / subagent 接管时）同构。幂等同源：已激活
 * 会话的重复订阅走 `existing` 早退，不会重复收敛。
 *
 * 判据 J1-J5（全部成立才算孤儿）：
 *   J1 后台启动：Bash tool part 带可寻址的 launch ACK（workId ≡ taskId）。
 *   J2 已知 work：ACK 就是启动成功的持久证据（core 只对真起了后台的任务写它）。
 *   J3 无终态：读面里既没有结果唤醒轮（真实终局），也没有 outcome entry。
 *   J4 本进程不认领：本进程 runtime 投影里该 workId 不是 running（bash 的 in-process
 *      registry 事件归约；激活尾部恒为空，跨进程违例时由它保底不误杀）。
 *   J5 过宽容期：ACK 的持久落库时间距今 > {@link BACKGROUND_TASK_ORPHAN_GRACE_MS}。
 *
 * 三条边界（对齐 `subagent-orphan-reconcile.ts` 与 `dynamic-workflow-run-reconcile.ts`）：
 *   - **只收敛真孤儿**：本进程在跑、或宽容期内仍可能启动的 work 一律跳过——宁可不收敛
 *     也不误杀（契约外双进程违例的防御靠「本进程认领 + 宽容期」）；
 *   - **不合成父会话事件**（不写 `BackgroundTaskCompleted`）：事件日志的契约是「引擎发过
 *     什么」，收敛者只落**持久事实**（`background_task_outcome` entry）；投影的收口由读面
 *     在重建时按该事实合成（见 `transcript-hydration` 的收敛合成器）；
 *   - **失败只降级 warn**（N9），绝不拖垮激活。
 *
 * J5 对 bash 的诚实边界：transcript 在启动后不再增长（输出写文件），所以宽容期只能回答
 * 「启动多久了」，不能证明进程活着；防误杀的主力是 J4（本进程认领）与挂点位置，宽容期只
 * 是给双进程违例兜底（与子 agent 的 J5 同款取舍）。
 */

import type {
  MessageWithParts,
  SessionEntryInfo,
  SessionId,
  SessionStorePort,
} from "@zcode/contracts";
import {
  SESSION_ENTRY_BACKGROUND_TASK_OUTCOME,
  readSessionBackgroundTaskInventory,
  type BackgroundTaskInventoryReadContext,
  type BackgroundTaskWorkFact,
} from "./background-task-session-query.js";

/**
 * 宽容期：launch ACK 的落库时间距今超过它才认定孤儿。
 *
 * 权衡与子 agent 同款：孤儿最长多显示 10 分钟 running（有界），换取「另一进程还在跑」时
 * 不误杀（J5 只能看到启动时刻，见文件头）。
 */
export const BACKGROUND_TASK_ORPHAN_GRACE_MS = 10 * 60 * 1_000;

/** 收敛终态：`lost` =「不在运行但无 outcome」，与用户取消/模型侧停止语义可分辨。 */
const BACKGROUND_TASK_ORPHAN_RECONCILE_STATUS = "lost" as const;

/** 收敛原因码：说明「进程死了」这一事实（对齐 dwf `stopReason=interrupted` 的思路）。 */
export const BACKGROUND_TASK_ORPHAN_RECONCILE_REASON = "runtime_exit" as const;

/** 幂等键前缀：同一 work 只会有一条 outcome entry，重复收敛同 key 覆盖、无累积。 */
const BACKGROUND_TASK_OUTCOME_ENTRY_ID_PREFIX = "background-task-outcome:";

const MODULE = "bootstrap.zcode_protocol";
const EVENT_ORPHAN_RECONCILED = "zcode_protocol.background_task.orphan_reconciled";
const EVENT_ORPHAN_SKIPPED = "zcode_protocol.background_task.orphan_skipped";
const EVENT_ORPHAN_RECONCILE_FAILED = "zcode_protocol.background_task.orphan_reconcile_failed";

/** 候选被跳过的原因（结构化日志与单测断言都读它）。 */
export type BackgroundTaskOrphanSkipReason =
  | "claimed_in_process"
  | "terminal_evidence"
  | "activity_unknown"
  | "within_grace"
  | "write_failed";

export interface BackgroundTaskOrphanSkipEntry {
  workId: string;
  reason: BackgroundTaskOrphanSkipReason;
}

export interface BackgroundTaskOrphanSelection {
  orphans: BackgroundTaskWorkFact[];
  skipped: BackgroundTaskOrphanSkipEntry[];
}

/**
 * 判据纯函数：从候选事实里挑出孤儿。J1/J2 已由候选枚举决定（候选就是带 ACK 的 work），
 * 这里只判 J3/J4/J5，且**失败一律跳过**（无法证明是孤儿就不收敛）。
 */
export function selectBackgroundTaskOrphans(input: {
  candidates: readonly BackgroundTaskWorkFact[];
  now: number;
  /** 测试注入宽容期；缺省 {@link BACKGROUND_TASK_ORPHAN_GRACE_MS}。 */
  graceMs?: number;
}): BackgroundTaskOrphanSelection {
  const graceMs = input.graceMs ?? BACKGROUND_TASK_ORPHAN_GRACE_MS;
  const orphans: BackgroundTaskWorkFact[] = [];
  const skipped: BackgroundTaskOrphanSkipEntry[] = [];
  for (const candidate of input.candidates) {
    const reason = skipReason(candidate, input.now, graceMs);
    if (reason) {
      skipped.push({ workId: candidate.workId, reason });
      continue;
    }
    orphans.push(candidate);
  }
  return { orphans, skipped };
}

function skipReason(
  candidate: BackgroundTaskWorkFact,
  now: number,
  graceMs: number,
): BackgroundTaskOrphanSkipReason | undefined {
  // J3：有任何持久终态证据（结果唤醒轮 / 收敛 entry）就不参与——终态已经存在，
  // 再写一条 lost 会让真实终局被补洞事实盖住。
  if (candidate.terminal) return "terminal_evidence";
  // J4：本进程 runtime 认领（registry 归约到投影的 running）⇒ 还在跑，不碰。
  if (candidate.liveStatus === "running") return "claimed_in_process";
  // J5：读不到启动时间就不判（放弃，不误杀）。
  if (candidate.launchedAtMs === undefined) return "activity_unknown";
  // 恰好等于宽容期也算「还在窗口内」：边界偏向不收敛。
  if (now - candidate.launchedAtMs <= graceMs) return "within_grace";
  return undefined;
}

/** 收敛 entry 的幂等键：确定性、只含 workId，重复收敛同 key 覆盖。 */
export function backgroundTaskOutcomeEntryId(workId: string): string {
  return `${BACKGROUND_TASK_OUTCOME_ENTRY_ID_PREFIX}${workId}`;
}

/**
 * 收敛事实的落盘形状：写**父会话自己**的 session entry（bash work 没有自己的 child 会话，
 * 工作身份由父 transcript 的 launch ACK 承载）。`runtimeInstance` 只带 pid：审计够用，
 * 且不得写入用户目录等敏感信息。
 */
function buildBackgroundTaskOutcomeEntry(input: {
  workId: string;
  parentSessionId: string;
  reconciledAt: number;
  pid?: number;
}): SessionEntryInfo {
  return {
    id: backgroundTaskOutcomeEntryId(input.workId),
    sessionID: input.parentSessionId as SessionId,
    type: SESSION_ENTRY_BACKGROUND_TASK_OUTCOME,
    // 收敛不是会话的任务活动：不能把「刚被收敛」伪装成「刚刚还在跑」——否则宽容期判据
    // 自污染，父会话的活动时间也被改写（见 SessionEntryInfo.touchSession 的约定）。
    touchSession: false,
    time: { created: input.reconciledAt, updated: input.reconciledAt },
    data: {
      status: BACKGROUND_TASK_ORPHAN_RECONCILE_STATUS,
      reason: BACKGROUND_TASK_ORPHAN_RECONCILE_REASON,
      workId: input.workId,
      parentSessionId: input.parentSessionId,
      reconciledAt: new Date(input.reconciledAt).toISOString(),
      runtimeInstance: { pid: input.pid ?? process.pid },
    },
  };
}

export interface BackgroundTaskOrphanReconcileInput {
  /** 读面依赖窄面（store / 本进程 live 记录 / logger）。 */
  context: BackgroundTaskInventoryReadContext;
  sessionId: string;
  /**
   * 调用方（激活路径）已经读出的父 transcript。传进来可以省掉清单读取里的一次重复查询；
   * 缺席时清单自己读。
   */
  persistedMessages?: MessageWithParts[];
  /** 测试注入时钟；缺省 `Date.now()`。 */
  now?: number;
  /** 测试注入宽容期；缺省 {@link BACKGROUND_TASK_ORPHAN_GRACE_MS}。 */
  graceMs?: number;
}

export interface BackgroundTaskOrphanReconcileResult {
  reconciled: number;
  skipped: BackgroundTaskOrphanSkipEntry[];
}

/**
 * 接管会话时收敛孤儿 work（本机制的对外接口）。见文件头：判据 J1-J5、三条边界、幂等来源。
 * 读/写失败都只记 warn 并跳过（N9），返回结果供调用方与单测断言。
 */
export async function reconcileBackgroundTaskOrphansOnActivation(
  input: BackgroundTaskOrphanReconcileInput,
): Promise<BackgroundTaskOrphanReconcileResult> {
  const { context, sessionId } = input;
  const logger = context.logger;
  const now = input.now ?? Date.now();
  const skipped: BackgroundTaskOrphanSkipEntry[] = [];
  const store: SessionStorePort | undefined = context.deps.sessionStore;
  // 绑到 store 上再调（adapter 的实现依赖 this）；取不到写入口就直接退场——没有持久落点
  // （旧宿主 / 只读回放）就没有幂等闭环，不收敛也不算失败。
  const persistOutcomeEntry = store?.saveSessionEntry?.bind(store);
  if (!persistOutcomeEntry) {
    return { reconciled: 0, skipped };
  }

  let inventory: Awaited<ReturnType<typeof readSessionBackgroundTaskInventory>>;
  try {
    inventory = await readSessionBackgroundTaskInventory(
      context,
      sessionId,
      input.persistedMessages,
      "background_task_orphan_reconcile",
    );
  } catch (error) {
    logger?.warn("Background task orphan reconciliation skipped: inventory read failed", {
      errorMessage: errorMessageOf(error),
      event: EVENT_ORPHAN_RECONCILE_FAILED,
      module: MODULE,
      reason: "inventory_read_failed",
      sessionId,
    });
    return { reconciled: 0, skipped };
  }

  const selection = selectBackgroundTaskOrphans({
    candidates: inventory.works,
    now,
    ...(input.graceMs === undefined ? {} : { graceMs: input.graceMs }),
  });
  for (const entry of selection.skipped) {
    skipped.push(entry);
    logger?.info("Background task orphan reconciliation skipped a candidate", {
      event: EVENT_ORPHAN_SKIPPED,
      module: MODULE,
      reason: entry.reason,
      sessionId,
      workId: entry.workId,
    });
  }

  let reconciled = 0;
  for (const orphan of selection.orphans) {
    const entry = buildBackgroundTaskOutcomeEntry({
      workId: orphan.workId,
      parentSessionId: sessionId,
      reconciledAt: now,
    });
    try {
      await persistOutcomeEntry(entry);
      reconciled += 1;
      logger?.warn("Background task orphan reconciled as lost", {
        event: EVENT_ORPHAN_RECONCILED,
        module: MODULE,
        parentSessionId: sessionId,
        reason: BACKGROUND_TASK_ORPHAN_RECONCILE_REASON,
        workId: orphan.workId,
      });
    } catch (error) {
      skipped.push({ workId: orphan.workId, reason: "write_failed" });
      logger?.warn("Background task orphan reconciliation write failed", {
        errorMessage: errorMessageOf(error),
        event: EVENT_ORPHAN_RECONCILE_FAILED,
        module: MODULE,
        parentSessionId: sessionId,
        workId: orphan.workId,
      });
    }
  }
  return { reconciled, skipped };
}

function errorMessageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
