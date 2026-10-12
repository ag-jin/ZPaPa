/**
 * 「后台 agent 已丢失」的父会话唤醒（2026-10-12 裁决 1，spec §1.4b）。
 *
 * 为什么单独一条方法而不是复用 `enqueueBackgroundTaskNotification`：
 * 1) 该 internal 方法在关机期直接丢弃、且账本 id 由随机命令 id 决定——接管收敛需要
 *    **确定性账本键**（`subagent-orphan-wake:<childSessionId>`）做「已交付标记」，
 *    且标记必须与命令 id 同源（管道的 promotion 按 `String(command.id)` 补标记）；
 * 2) 失败语义不同：这是收敛动作的一部分，读不到恢复面 / 账本写不进去都应降级而不是抛出。
 *
 * 复用面（不改管道）：命令走既有 `task-notification` 模式 + `next` 优先级，最终由同一批
 * `dequeueNextBatch` 合并、同一 `persistBackgroundTaskNotificationBatch` 落 model-only 消息、
 * 同一 `executeTurnCommand` 起模型轮。`origin` 用新 kind `backgroundSource: "subagent_lost"`，
 * 禁止蹭 `"subagent"`（UI 白名单与遥测会把它渲染/统计成「结果到达」，spec §1.4b）。
 *
 * 幂等（红队 A1-3）：
 * - 判据 = 账本行状态 `promoted` ⇒ 已交付，跳过；缺席 / `admitted` / `discarded(session_resumed)`
 *   ⇒ 需要投递（`discarded` 行会被 store 的冲突语义重开为 `admitted`，spec §3.3）；
 * - 允许重复投递（at-least-once）：崩在「消息已写、标记未落」之间会重投，文案已标注可能重复。
 */

import type { BackgroundResultOriginMeta, SessionId } from "@zcode/contracts";
import type { TraceContext } from "../deps.js";
import type { TaskNotificationRuntimeCommand, RuntimeCommandId } from "../command-queue.js";
import type { AgentRuntimeInternal } from "../internal.js";
import {
  extractSubagentTranscriptTail,
  type SubagentTranscriptTail,
} from "../../subagent/recovery-surface.js";
import { formatSubagentLostWakeNotification } from "../../subagent/lost-wake-notification.js";

export interface SubagentLostWakeChild {
  /**
   * 确定性账本幂等键（`subagent-orphan-wake:<childSessionId>`）。
   * 同时用作 runtime 命令 id：既有管道按 `String(command.id)` 补 promotion 标记，两者必须同源。
   */
  admissionId: string;
  agentId: string;
  childSessionId: string;
  description?: string;
  subagentType?: string;
  parentToolCallId?: string;
  /** 收敛原因码（`subagent_outcome.data.reason`）。 */
  reason: string;
}

export type SubagentLostWakeSkipReason =
  | "ledger_unavailable"
  | "ledger_write_failed"
  /** 账本行已是终态（promoted 之外还有 cancelled/failed 等）：不再重投（W3 防御性收口）。 */
  | "ledger_terminal"
  /** runtime 正在关机（S-8 防御）：不投递也不落 admission，交给下次激活的收敛重判。 */
  | "runtime_shutting_down";

export interface SubagentLostWakeResult {
  /** 本次新投递（命令已入队）的账本 id。 */
  delivered: string[];
  /** 账本已是 promoted（此前已交付）的账本 id。 */
  alreadyDelivered: string[];
  /** 未能投递的账本 id 与原因（降级，不抛出）。 */
  skipped: { admissionId: string; reason: SubagentLostWakeSkipReason }[];
}

export async function enqueueSubagentLostWakes(
  this: AgentRuntimeInternal,
  input: {
    children: readonly SubagentLostWakeChild[];
    traceContext?: TraceContext;
  },
): Promise<SubagentLostWakeResult> {
  const traceContext = input.traceContext ?? this.rootTraceContext;
  const store = this.sessionStore;
  const delivered: string[] = [];
  const alreadyDelivered: string[] = [];
  const skipped: SubagentLostWakeResult["skipped"] = [];
  // 同一批一次 drain：先把全部命令入队（不逐条触发 drain），同一次收敛的多个 lost 才会被
  // `dequeueNextBatch` 合并成一条唤醒消息 + 一个模型轮（红队要求，spec §3.3）。
  const commands: TaskNotificationRuntimeCommand[] = [];
  // S-8 防御（同族 `background-notifications.ts` 的 shuttingDown 守卫）：关机期投递会与 teardown
  // 抢模型轮。跳过即可——唤醒判据是幂等可重放的（child entry 一旦在场就永远在候选里），下次激活
  // 会重判重投；这条路径是 at-least-once、不构成丢失。
  if (this.shuttingDown) {
    for (const child of input.children) {
      const admissionId = child.admissionId.trim();
      if (admissionId) skipped.push({ admissionId, reason: "runtime_shutting_down" });
    }
    return { delivered, alreadyDelivered, skipped };
  }

  for (const child of input.children) {
    const admissionId = child.admissionId.trim();
    if (!admissionId) continue;
    if (!store?.saveSessionInput) {
      // 没有账本就没有交付标记：宁可不投递，也不做「每次激活重投」的静默刷屏。
      skipped.push({ admissionId, reason: "ledger_unavailable" });
      continue;
    }
    const existing = await store.getSessionInputById?.(admissionId).catch(() => null);
    if (existing?.status === "promoted") {
      // 已交付标记（唯一判据）：恢复/重订阅不重复唤醒。
      alreadyDelivered.push(admissionId);
      continue;
    }
    // W3 白名单（spec §1.4b）：只有「缺席 / admitted / discarded」算未交付；其余终态
    // （cancelled / failed 及未来新增状态）一律视为已终态——「不在白名单内即视为终态」比
    // 「只跳过 promoted」安全，避免未来状态变更静默变成每次激活重投。
    if (
      existing &&
      existing.status !== "admitted" &&
      existing.status !== "discarded"
    ) {
      skipped.push({ admissionId, reason: "ledger_terminal" });
      continue;
    }

    // 恢复面摘要（spec §1.7）：读取失败只降级为空摘要，不拖垮投递。
    const recovered = await readSubagentRecoveryTail.call(this, child.childSessionId);
    const text = formatSubagentLostWakeNotification({
      agentId: child.agentId,
      childSessionId: child.childSessionId,
      ...(child.description ? { description: child.description } : {}),
      ...(child.subagentType ? { subagentType: child.subagentType } : {}),
      ...(child.parentToolCallId ? { parentToolCallId: child.parentToolCallId } : {}),
      reason: child.reason,
      ...(recovered.text ? { recoveredOutput: recovered.text } : {}),
    });
    const originMeta: BackgroundResultOriginMeta = {
      // 新 origin kind：不得蹭 "subagent"（spec §1.4b 的呈现红线）。
      backgroundSource: "subagent_lost",
      workId: child.childSessionId,
      title: child.description?.trim() || child.agentId,
    };
    try {
      // 账本先落（admitted）：崩在入队/消费前只会留下可被 resume 收口、可被重投的痕迹，
      // 不会出现「命令在队列里但账本无记录」（那才是真正会静默丢失的方向）。
      await store.saveSessionInput({
        id: admissionId,
        sessionID: this.sessionId,
        kind: "backgroundNotification",
        delivery: "queue",
        payload: {
          text,
          taskId: child.agentId,
          childSessionId: child.childSessionId,
          originMeta,
        },
      });
    } catch (error) {
      skipped.push({ admissionId, reason: "ledger_write_failed" });
      this.logger?.warn("Failed to admit subagent lost wake to ledger", {
        admissionId,
        childSessionId: child.childSessionId,
        errorMessage: error instanceof Error ? error.message : String(error),
        event: "subagent_lost_wake.admit_failed",
        module: "core.runtime",
      });
      continue;
    }
    commands.push({
      branchGeneration: this.branchGeneration,
      createdAt: new Date(),
      id: admissionId as RuntimeCommandId,
      mode: "task-notification",
      originMeta,
      priority: "next",
      source: "background_task",
      taskId: child.agentId,
      text,
      traceContext,
    });
    delivered.push(admissionId);
  }

  for (const command of commands) {
    this.runtimeCommandQueue.enqueue(command);
    this.logger?.info("Subagent lost wake enqueued into runtime command queue", {
      admissionId: command.id,
      agentId: command.taskId,
      event: "subagent_lost_wake.enqueued",
      module: "core.runtime",
      queueSize: this.runtimeCommandQueue.size(),
    });
  }
  if (commands.length > 0) {
    void this.drainRuntimeCommandQueue();
  }
  return { delivered, alreadyDelivered, skipped };
}

/** 读 child transcript 尾部（恢复面，spec §1.7）；读失败/无 store 降级为空摘要。 */
async function readSubagentRecoveryTail(
  this: AgentRuntimeInternal,
  childSessionId: string,
): Promise<SubagentTranscriptTail> {
  try {
    const messages = await this.sessionStore?.messages?.({
      sessionID: childSessionId as SessionId,
    });
    return extractSubagentTranscriptTail(messages ?? []);
  } catch (error) {
    this.logger?.warn("Failed to read subagent recovery surface", {
      childSessionId,
      errorMessage: error instanceof Error ? error.message : String(error),
      event: "subagent_lost_wake.recovery_read_failed",
      module: "core.runtime",
    });
    return { truncated: false };
  }
}
