/**
 * 后台子 agent 的孤儿收敛（subagent orphan reconcile）。
 *
 * 问题：`48f7f18` 的冷恢复规则是「已知 child ∧ 无终态记录 ⇒ running」——它保护了「切走再切回
 * 仍在跑」的 agent，却让「宿主进程被硬杀/崩溃、child 没留下任何终态落盘」的 agent 长期显示
 * running：面板出现一张无 Stop 入口的常驻卡片，而且没有任何后续事实能让它自愈（runtime task
 * registry 是进程私有内存态、随进程消失，child transcript 也不会再长出新记录）。
 *
 * 触发时机（唯一挂点）：`activateSessionForResume` 尾部。这是唯一一个可证明「本 runtime 对该
 * 会话名下零个在飞 agent」的时刻（registry 冷恢复新建即为空；跨进程 resume 在现状不存在——
 * SendMessage 只认本进程 registry），与 dynamic workflow 孤儿 run 的「构造时收敛」同构。幂等
 * 同源：已激活会话的重复订阅走 `existing` 早退，不会重复收敛。
 *
 * 判据 J1-J5（全部成立才算孤儿，逐条对应不误杀不变量 N1-N9）：
 *   J1 后台启动（N7）：前台 Agent 的 part 终态即 child 终态，不参与；
 *   J2 已知 child（N8）：权威清单 `childSessionIds` 里有它，读不到 child 记录一律不碰；
 *   J3 无终态（N6）：当前落在权威清单 `running` 集合，也就是没有任何 outcome/stop/error 证据；
 *   J4 本进程不认领（N1/N2）：`context.sessions` 里没有该 child 的 live runtime；
 *   J5 过宽容期（N4）：child 最后持久活动距今 > {@link SUBAGENT_ORPHAN_GRACE_MS}。
 *
 * J2/J3 由权威清单（`readSessionSubagentInventory`，与侧栏/hydration 同一次读）给出，本模块
 * 不自己判活/判终态——各判一次就会造出第二份结论。J1/J5 所需的事实（后台 spawn 候选、child
 * 最后活动）也由同一次读带出，避免在激活路径上再读一遍父/子 transcript。
 *
 * 三条边界（对齐 `dynamic-workflow-run-reconcile.ts` 先例）：
 *   - **只收敛真孤儿**：本进程在跑、或宽容期内还有活动的 child 一律跳过——宁可不收敛也不误杀
 *     （契约外双进程违例的防御靠宽容期，见设计 N4/R1）；
 *   - **不合成父会话事件**（不写 `SubagentStopped`）：事件日志的契约是「引擎发过什么」，收敛者
 *     只补齐 child 的持久事实；展示层终态由 hydration 按终态事实自然合成（`lost → failed` 行）；
 *   - **失败只降级 warn**（N9），绝不拖垮激活：收敛是自愈动作，不是恢复会话的前提。
 *
 * 本模块与 `server-operations.ts` 相互引用（那边在激活尾部调用本模块，本模块用同一窄面读权威
 * 清单）：两边都只在函数体内使用对方，ESM 函数声明提升下安全；仓内既有同款相互引用
 * （`dynamic-workflow-run-service` ↔ 其 launch/submit）。
 */

import type {
  MessageWithParts,
  SessionEntryInfo,
  SessionId,
  SessionStorePort,
} from "@zcode/contracts";
import {
  readSessionSubagentInventory,
  type SessionSubagentInventory,
  type SessionSubagentInventoryReadContext,
} from "./server-operations.js";
import { SESSION_ENTRY_SUBAGENT_OUTCOME } from "./subagent-session-query.js";

/**
 * 宽容期：child 最后持久活动距今超过它才认定孤儿。
 *
 * 权衡（设计 §4.2）：长工具执行期间 child 可能长时间不写 transcript，10 分钟远大于常见工具
 * 时长；代价是孤儿最长多显示 10 分钟 running（有界），换取「另一进程还在跑但暂时安静」时不误杀。
 */
export const SUBAGENT_ORPHAN_GRACE_MS = 10 * 60 * 1_000;

/**
 * 收敛终态：`lost` =「不在运行但无 outcome」，与用户取消/模型侧停止语义可分辨
 * （侧栏词表已有「已丢失」，row 层按 `48f7f18` 定案收口成 failed）。不新造终态词。
 */
export const SUBAGENT_ORPHAN_RECONCILE_STATUS = "lost" as const;

/** 收敛原因码：说明「进程死了」这一事实（对齐 dwf `stopReason=interrupted` 的思路）。 */
export const SUBAGENT_ORPHAN_RECONCILE_REASON = "runtime_exit" as const;

/** 幂等键前缀：同一 child 只会有一条 outcome entry，重复收敛同 key 覆盖、无累积。 */
const SUBAGENT_OUTCOME_ENTRY_ID_PREFIX = "subagent-outcome:";

const MODULE = "bootstrap.zcode_protocol";
const EVENT_ORPHAN_RECONCILED = "zcode_protocol.subagent.orphan_reconciled";
const EVENT_ORPHAN_SKIPPED = "zcode_protocol.subagent.orphan_skipped";
const EVENT_ORPHAN_RECONCILE_FAILED = "zcode_protocol.subagent.orphan_reconcile_failed";

/** 候选被跳过的原因（结构化日志与单测断言都读它）。 */
export type SubagentOrphanSkipReason =
  | "not_background"
  | "live_child"
  | "activity_unknown"
  | "within_grace"
  | "write_failed";

export interface SubagentOrphanSkipEntry {
  childSessionId: string;
  reason: SubagentOrphanSkipReason;
}

/** 收敛判据的全部输入事实（全部来自权威清单的同一次读，见文件头 J1-J5）。 */
export interface SubagentOrphanCandidateFacts {
  childSessionId: string;
  /** J1：后台 spawn（持久化 spawn input 的 `run_in_background`）。 */
  backgroundLaunch: boolean;
  /** J4：本进程有该 child 的 live runtime。 */
  liveInProcess: boolean;
  /** J5：child 最后持久活动时刻；读面没给出时不给值（放弃判定，不误杀）。 */
  lastActivityAt?: number;
}

export interface SubagentOrphanSelection {
  orphans: SubagentOrphanCandidateFacts[];
  skipped: SubagentOrphanSkipEntry[];
}

/**
 * 判据纯函数：从候选事实里挑出孤儿。J2/J3 已由权威清单决定（候选就是 running 集合），
 * 这里只判 J1/J4/J5，且**失败一律跳过**（无法证明是孤儿就不收敛）。
 */
export function selectSubagentOrphans(input: {
  candidates: readonly SubagentOrphanCandidateFacts[];
  now: number;
  /** 测试注入宽容期；缺省 {@link SUBAGENT_ORPHAN_GRACE_MS}。 */
  graceMs?: number;
}): SubagentOrphanSelection {
  const graceMs = input.graceMs ?? SUBAGENT_ORPHAN_GRACE_MS;
  const orphans: SubagentOrphanCandidateFacts[] = [];
  const skipped: SubagentOrphanSkipEntry[] = [];
  for (const candidate of input.candidates) {
    const reason = skipReason(candidate, input.now, graceMs);
    if (reason) {
      skipped.push({ childSessionId: candidate.childSessionId, reason });
      continue;
    }
    orphans.push(candidate);
  }
  return { orphans, skipped };
}

function skipReason(
  candidate: SubagentOrphanCandidateFacts,
  now: number,
  graceMs: number,
): SubagentOrphanSkipReason | undefined {
  if (!candidate.backgroundLaunch) return "not_background";
  if (candidate.liveInProcess) return "live_child";
  if (candidate.lastActivityAt === undefined) return "activity_unknown";
  // 恰好等于宽容期也算「还在窗口内」：边界偏向不收敛。
  if (now - candidate.lastActivityAt <= graceMs) return "within_grace";
  return undefined;
}

/** 收敛 entry 的幂等键：确定性、只含 child session id，重复收敛同 key 覆盖。 */
export function subagentOutcomeEntryId(childSessionId: string): string {
  return `${SUBAGENT_OUTCOME_ENTRY_ID_PREFIX}${childSessionId}`;
}

/**
 * 收敛事实的落盘形状（设计 §4.3）：写 child session 的 session entry，不合成父会话事件。
 * `runtimeInstance` 只带 pid（设计 §9-3）：审计够用，且不得写入用户目录等敏感信息。
 */
export function buildSubagentOutcomeEntry(input: {
  childSessionId: string;
  parentSessionId: string;
  reconciledAt: number;
  pid?: number;
}): SessionEntryInfo {
  return {
    id: subagentOutcomeEntryId(input.childSessionId),
    sessionID: input.childSessionId as SessionId,
    type: SESSION_ENTRY_SUBAGENT_OUTCOME,
    // 收敛不是 child 的任务活动：不能把「刚被收敛」伪装成「刚刚还在跑」——否则宽容期判据
    // 自污染，child 的会话活动时间也被改写（见 SessionEntryInfo.touchSession 的约定）。
    touchSession: false,
    time: { created: input.reconciledAt, updated: input.reconciledAt },
    data: {
      status: SUBAGENT_ORPHAN_RECONCILE_STATUS,
      reason: SUBAGENT_ORPHAN_RECONCILE_REASON,
      parentSessionId: input.parentSessionId,
      reconciledAt: new Date(input.reconciledAt).toISOString(),
      runtimeInstance: { pid: input.pid ?? process.pid },
    },
  };
}

export interface SubagentOrphanReconcileInput {
  /** 权威清单读取的依赖窄面（store / 本进程 live 记录 / logger）。 */
  context: SessionSubagentInventoryReadContext;
  sessionId: string;
  /**
   * 调用方（激活路径）已经读出的父 transcript。传进来可以省掉清单读取里的一次重复查询
   * （激活路径的时延预算）；缺席时清单自己读。
   */
  persistedMessages?: MessageWithParts[];
  /** 测试注入时钟；缺省 `Date.now()`。 */
  now?: number;
  /** 测试注入宽容期；缺省 {@link SUBAGENT_ORPHAN_GRACE_MS}。 */
  graceMs?: number;
}

export interface SubagentOrphanReconcileResult {
  reconciled: number;
  skipped: SubagentOrphanSkipEntry[];
}

/**
 * 接管会话时收敛孤儿（本机制的对外接口）。见文件头：判据 J1-J5、三条边界、幂等来源。
 * 读/写失败都只记 warn 并跳过（N9），返回结果供调用方与单测断言。
 */
export async function reconcileSubagentOrphansOnActivation(
  input: SubagentOrphanReconcileInput,
): Promise<SubagentOrphanReconcileResult> {
  const { context, sessionId } = input;
  const logger = context.logger;
  const now = input.now ?? Date.now();
  const skipped: SubagentOrphanSkipEntry[] = [];
  const store: SessionStorePort | undefined = context.deps.sessionStore;
  if (!store?.saveSessionEntry) {
    // 没有持久落点（旧宿主 / 只读回放）就没有幂等闭环：不收敛，也不算失败。
    return { reconciled: 0, skipped };
  }

  let inventory: SessionSubagentInventory;
  try {
    inventory = await readSessionSubagentInventory(
      context,
      sessionId,
      input.persistedMessages,
      "subagent_orphan_reconcile",
    );
  } catch (error) {
    logger?.warn("Subagent orphan reconciliation skipped: inventory read failed", {
      errorMessage: errorMessageOf(error),
      event: EVENT_ORPHAN_RECONCILE_FAILED,
      module: MODULE,
      reason: "inventory_read_failed",
      sessionId,
    });
    return { reconciled: 0, skipped };
  }

  const backgroundChildSessionIds = new Set(inventory.backgroundChildSessionIds);
  const candidates = inventory.running.map((running) => ({
    childSessionId: running.childSessionId,
    backgroundLaunch: backgroundChildSessionIds.has(running.childSessionId),
    liveInProcess: context.sessions.has(running.childSessionId),
    lastActivityAt: inventory.childLastActivityAtMs.get(running.childSessionId),
  }));
  const selection = selectSubagentOrphans({
    candidates,
    now,
    ...(input.graceMs === undefined ? {} : { graceMs: input.graceMs }),
  });
  for (const entry of selection.skipped) {
    skipped.push(entry);
    logger?.info("Subagent orphan reconciliation skipped a candidate", {
      childSessionId: entry.childSessionId,
      event: EVENT_ORPHAN_SKIPPED,
      module: MODULE,
      reason: entry.reason,
      sessionId,
    });
  }

  let reconciled = 0;
  for (const orphan of selection.orphans) {
    const entry = buildSubagentOutcomeEntry({
      childSessionId: orphan.childSessionId,
      parentSessionId: sessionId,
      reconciledAt: now,
    });
    try {
      await store.saveSessionEntry?.(entry);
      reconciled += 1;
      logger?.warn("Subagent orphan reconciled as lost", {
        childSessionId: orphan.childSessionId,
        event: EVENT_ORPHAN_RECONCILED,
        module: MODULE,
        parentSessionId: sessionId,
        reason: SUBAGENT_ORPHAN_RECONCILE_REASON,
      });
    } catch (error) {
      skipped.push({ childSessionId: orphan.childSessionId, reason: "write_failed" });
      logger?.warn("Subagent orphan reconciliation write failed", {
        childSessionId: orphan.childSessionId,
        errorMessage: errorMessageOf(error),
        event: EVENT_ORPHAN_RECONCILE_FAILED,
        module: MODULE,
        parentSessionId: sessionId,
      });
    }
  }
  return { reconciled, skipped };
}

function errorMessageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
