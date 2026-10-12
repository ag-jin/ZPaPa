/**
 * 「后台 agent 已丢失」唤醒的判据与投递（spec 2026-10-08-subagent-orphan-reconcile §1.4b，
 * 2026-10-12 裁决 1；从 `subagent-orphan-reconcile.ts` 拆出以守住单文件行数上限）。
 *
 * 本模块只做两件事：
 *   1) **防误报证据**（W2）：从 agent 产物目录 `metadata.json` 读宿主进程 pid，判其不存活——
 *      模型可见的「已丢失」断言必须有进程级硬证据，宽容期只为显示层校准；
 *   2) **候选投递**：把「本次新收敛 ∪ 读面已由 entry 决定终态」的 child 交给父 runtime 的窄方法
 *      （`enqueueSubagentLostWakes`；账本幂等与 drain 在 core 侧收口）。失败只降级 warn。
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { SubagentLostWakeSkipReason as CoreLostWakeSkipReason } from "@zcode/core";
import type {
  SessionSubagentInventory,
  SessionSubagentInventoryReadContext,
} from "./server-operations.js";

const MODULE = "bootstrap.zcode_protocol";
const EVENT_ORPHAN_WAKE_SKIPPED = "zcode_protocol.subagent.orphan_wake_skipped";
const EVENT_ORPHAN_WAKE_DELIVERED = "zcode_protocol.subagent.orphan_wake_delivered";

/** 唤醒候选的事实子集（与 `subagent-orphan-reconcile` 的候选同源，避免循环依赖只留所需字段）。 */
export interface SubagentWakeCandidate {
  childSessionId: string;
  agentId?: string;
  title?: string;
  subagentType?: string;
  toolCallId?: string;
}

/**
 * 唤醒未发生的原因（spec §1.4b 的 W1-W3 与降级分支）。
 * core 侧的账本类原因（`ledger_unavailable` / `ledger_write_failed` / `ledger_terminal` /
 * `runtime_shutting_down`）**原样透传**，不压扁成单一 runtime 原因（S-6：结构化跳因要能对账）。
 */
export type SubagentLostWakeSkipReason =
  | CoreLostWakeSkipReason
  | "evidence_unavailable"
  | "host_alive"
  | "runtime_unavailable";

/** 唤醒投递标记的账本 id 前缀（确定性幂等键，父侧「已交付标记」；对账命令读同一常量）。 */
export const SUBAGENT_LOST_WAKE_ADMISSION_ID_PREFIX = "subagent-orphan-wake:";

export function subagentLostWakeAdmissionId(childSessionId: string): string {
  return `${SUBAGENT_LOST_WAKE_ADMISSION_ID_PREFIX}${childSessionId}`;
}

/**
 * 旧 runtime 实例的进程证据读面（spec §1.4b W2）。
 *
 * 语义断言（「后台 agent 已丢失」）不能只凭宽容期：宽容期是为**显示**误杀校准的。进程级硬证据 =
 * spawn 时宿主进程写进 `metadata.json` 的 `runtimeInstance.pid`；读不到证据（旧版本 spawn 的
 * agent / 文件缺失）⇒ 不合成模型可见事实，只保留显示层收敛。
 */
export interface SubagentOrphanRuntimeEvidence {
  readHostRuntimePid(input: {
    parentSessionId: string;
    agentId: string;
  }): Promise<number | undefined>;
}

/** 生产默认证据读面：`<agentsRoot>/<parentSessionId>/<agentId>/metadata.json`（与 runner 落盘同形）。 */
export function createAgentMetadataRuntimeEvidence(input: {
  rootDir: string;
}): SubagentOrphanRuntimeEvidence {
  return {
    async readHostRuntimePid({ parentSessionId, agentId }) {
      try {
        const raw = await readFile(
          join(input.rootDir, parentSessionId, agentId, "metadata.json"),
          "utf8",
        );
        const parsed = JSON.parse(raw) as { runtimeInstance?: { pid?: unknown } };
        const pid = parsed?.runtimeInstance?.pid;
        return typeof pid === "number" && Number.isInteger(pid) && pid > 0 ? pid : undefined;
      } catch {
        return undefined;
      }
    },
  };
}

/**
 * pid 存活探测：`kill(pid, 0)` 失败且不是 EPERM ⇒ 确认不存活。
 * EPERM 表示「进程存在但没有信号权限」——这是**存活**（保守方向：宁可不唤醒不误报）。
 */
export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException | undefined)?.code === "EPERM";
  }
}


/** 唤醒未发生的 child 与原因（结构化日志与单测断言都读它）。 */
export interface SubagentLostWakeSession {
  childSessionId: string;
  reason: SubagentLostWakeSkipReason;
}

export interface SubagentLostWakeDeliveryResult {
  /** 本次新投递（账本 admission 已落、命令已入队）的 childSessionId。 */
  woke: string[];
  /** 已交付（账本 promoted）而跳过的 childSessionId。 */
  wakeAlreadyDelivered: string[];
  /** 未唤醒的候选与原因（W2 证据缺失 / 宿主存活 / runtime 不在场，全部只降级）。 */
  wakeSkipped: SubagentLostWakeSession[];
}

/**
 * §1.4b 的唤醒投递：候选 = 本次新收敛 ∪ 读面 `reconciled === true` 的行（两者的终态都由 entry
 * 决定 ⇒ W1 恒成立，`reconciled` 标记本身由读面按「真实 outcome > entry」判定，不另立判据）。
 * 逐条过 W2（pid 硬证据）；W3（账本已交付标记）由 runtime 的窄方法在写入侧收口。
 */
export async function deliverLostWakes(input: {
  context: SessionSubagentInventoryReadContext;
  sessionId: string;
  inventory: SessionSubagentInventory;
  newlyReconciled: readonly SubagentWakeCandidate[];
  /**
   * 收敛原因码：由调用方（`subagent-orphan-reconcile` 的 `SUBAGENT_ORPHAN_RECONCILE_REASON`）
   * 提供——它就是写 entry 的那个事实，本模块不再自带第二份常量（S-1）。
   */
  reason: string;
  evidence?: SubagentOrphanRuntimeEvidence;
}): Promise<SubagentLostWakeDeliveryResult> {
  const { context, sessionId } = input;
  const logger = context.logger;
  const woke: string[] = [];
  const wakeAlreadyDelivered: string[] = [];
  const wakeSkipped: SubagentLostWakeSession[] = [];

  const candidateByChild = new Map<string, SubagentWakeCandidate>();
  for (const orphan of input.newlyReconciled) {
    candidateByChild.set(orphan.childSessionId, orphan);
  }
  for (const ended of input.inventory.ended) {
    // `reconciled === true` = 终态由 entry 决定（W1）；真实 outcome 到场后读面会摘掉标记。
    if (ended.reconciled !== true || candidateByChild.has(ended.childSessionId)) continue;
    candidateByChild.set(ended.childSessionId, {
      childSessionId: ended.childSessionId,
      ...(ended.agentId ? { agentId: ended.agentId } : {}),
      title: ended.title,
      subagentType: ended.subagentType,
      ...(ended.toolCallId ? { toolCallId: ended.toolCallId } : {}),
    });
  }
  if (candidateByChild.size === 0) {
    return { woke, wakeAlreadyDelivered, wakeSkipped };
  }

  const runtime = context.sessions.get(sessionId)?.app?.runtime;
  const enqueueWakes = runtime?.enqueueSubagentLostWakes?.bind(runtime);
  if (!enqueueWakes) {
    for (const childSessionId of candidateByChild.keys()) {
      wakeSkipped.push({ childSessionId, reason: "runtime_unavailable" });
    }
    logger?.warn("Subagent lost wake skipped: live runtime unavailable", {
      event: EVENT_ORPHAN_WAKE_SKIPPED,
      module: MODULE,
      sessionId,
      childSessionCount: candidateByChild.size,
    });
    return { woke, wakeAlreadyDelivered, wakeSkipped };
  }

  // W2：逐条 pid 硬证据。拿不到证据/宿主仍存活都跳过（保守方向），只保留显示层收敛。
  const children: {
    admissionId: string;
    agentId: string;
    childSessionId: string;
    description?: string;
    subagentType?: string;
    parentToolCallId?: string;
    reason: string;
  }[] = [];
  for (const candidate of candidateByChild.values()) {
    const agentId = candidate.agentId ?? agentIdFromSubagentChildSessionId(candidate.childSessionId);
    if (!agentId) {
      wakeSkipped.push({ childSessionId: candidate.childSessionId, reason: "evidence_unavailable" });
      continue;
    }
    const hostPid = await input.evidence
      ?.readHostRuntimePid({ parentSessionId: sessionId, agentId })
      .catch(() => undefined);
    if (hostPid === undefined) {
      wakeSkipped.push({ childSessionId: candidate.childSessionId, reason: "evidence_unavailable" });
      logger?.info("Subagent lost wake skipped: host pid evidence unavailable", {
        childSessionId: candidate.childSessionId,
        event: EVENT_ORPHAN_WAKE_SKIPPED,
        module: MODULE,
        reason: "evidence_unavailable",
        sessionId,
      });
      continue;
    }
    if (isProcessAlive(hostPid)) {
      wakeSkipped.push({ childSessionId: candidate.childSessionId, reason: "host_alive" });
      logger?.info("Subagent lost wake skipped: host process still alive", {
        childSessionId: candidate.childSessionId,
        event: EVENT_ORPHAN_WAKE_SKIPPED,
        hostPid,
        module: MODULE,
        reason: "host_alive",
        sessionId,
      });
      continue;
    }
    children.push({
      admissionId: subagentLostWakeAdmissionId(candidate.childSessionId),
      agentId,
      childSessionId: candidate.childSessionId,
      ...(candidate.title ? { description: candidate.title } : {}),
      ...(candidate.subagentType ? { subagentType: candidate.subagentType } : {}),
      ...(candidate.toolCallId ? { parentToolCallId: candidate.toolCallId } : {}),
      reason: input.reason,
    });
  }
  if (children.length === 0) {
    return { woke, wakeAlreadyDelivered, wakeSkipped };
  }

  try {
    // 一次调用投递整批：core 侧按确定性账本 id 去重后合并成一个模型轮（§3.3 批量化）。
    const result = await enqueueWakes({ children });
    for (const admissionId of result.delivered) {
      woke.push(admissionId.slice(SUBAGENT_LOST_WAKE_ADMISSION_ID_PREFIX.length));
    }
    for (const admissionId of result.alreadyDelivered) {
      wakeAlreadyDelivered.push(
        admissionId.slice(SUBAGENT_LOST_WAKE_ADMISSION_ID_PREFIX.length),
      );
    }
    for (const item of result.skipped) {
      wakeSkipped.push({
        childSessionId: item.admissionId.slice(SUBAGENT_LOST_WAKE_ADMISSION_ID_PREFIX.length),
        reason: item.reason,
      });
    }
    if (woke.length > 0) {
      logger?.warn("Subagent lost wake delivered to parent session", {
        childSessionIds: woke,
        event: EVENT_ORPHAN_WAKE_DELIVERED,
        module: MODULE,
        parentSessionId: sessionId,
      });
    }
  } catch (error) {
    // 投递失败只降级（a 层收敛已完成，事实不丢）。
    for (const child of children) {
      wakeSkipped.push({ childSessionId: child.childSessionId, reason: "runtime_unavailable" });
    }
    logger?.warn("Subagent lost wake delivery failed", {
      errorMessage: errorMessageOf(error),
      event: EVENT_ORPHAN_WAKE_SKIPPED,
      module: MODULE,
      reason: "delivery_failed",
      sessionId,
    });
  }
  return { woke, wakeAlreadyDelivered, wakeSkipped };
}

/**
 * childSessionId → agentId 的确定性反推（`createSessionId(\`subagent_${agentId}\`)` 的逆）。
 * 只认完整前缀（`sess_subagent_`），推不出来就返回 undefined（不给唤醒，不猜）。
 */
function agentIdFromSubagentChildSessionId(childSessionId: string): string | undefined {
  const prefix = "sess_subagent_";
  if (!childSessionId.startsWith(prefix)) return undefined;
  const agentId = childSessionId.slice(prefix.length);
  return agentId.length > 0 ? agentId : undefined;
}

function errorMessageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

