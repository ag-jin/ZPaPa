/**
 * 重启缺口的只读对账（spec 2026-10-08-subagent-orphan-reconcile，2026-10-12 裁决 4 = 4C）。
 *
 * 为什么需要它：board 台账把「协调者轮询先取到结果」记成「通知丢失」，与 durable 事实不符
 * （诊断报告 §2：366/366 送达、283/283 消费）。对账口径必须机械、可复算、只读，且**只用
 * durable 残留**——禁止在线阈值（通知滞后 p99 39s / max 80s，任何「N 秒内没到即判丢」都会假阳）。
 *
 * 三类 durable 事实：
 *   ① 投递账本（`session_input`, kind=backgroundNotification）状态分布：admitted（在途）/
 *      promoted（已交付）/ discarded / cancelled / failed；
 *   ② resume 收口残留：`discarded` + `reason=session_resumed` = 「有投递、进程亡故未消费」；
 *   ③ 有终态无通知：child 落过 `subagent_outcome{lost}`（收敛事实，唯一权威）但父侧没有
 *      promoted 的丢失唤醒行（`subagent-orphan-wake:<childSessionId>`）。
 *
 * 本模块只读 store 的公开窄面（listSessions / listSessionInputs / sessionEntries），不写任何状态；
 * 输出可直接被 board 消费（board 不直读 db schema）。
 */

import {
  SESSION_ENTRY_SUBAGENT_OUTCOME,
  subagentOutcomeEntryFact,
  type SessionStorePort,
} from "@zcode/contracts";
import { SUBAGENT_LOST_WAKE_ADMISSION_ID_PREFIX } from "./subagent-lost-wake.js";

export interface RestartGapWakeMissingEntry {
  childSessionId: string;
  /** 账本行状态；缺席 = 从未投递。 */
  wakeStatus?: string;
}

export interface RestartGapReconcileReport {
  generatedAt: string;
  sessionsScanned: number;
  ledger: {
    admitted: number;
    promoted: number;
    discarded: number;
    cancelled: number;
    failed: number;
  };
  /** `discarded` 且 reason=session_resumed（重启收口，有投递未消费）。 */
  resumeDiscarded: number;
  /** child 侧收敛事实（`subagent_outcome{lost}`）计数。 */
  lostChildren: number;
  /** 丢失唤醒已交付（账本 promoted）计数。 */
  wakeDelivered: number;
  /** lost entry 在场但没有 promoted 唤醒行的 child（durable 对账的核心分子）。 */
  wakeMissing: RestartGapWakeMissingEntry[];
}

export async function buildRestartGapReconcileReport(
  store: SessionStorePort,
): Promise<RestartGapReconcileReport> {
  const sessions = await store.listSessions();
  const ledger = { admitted: 0, promoted: 0, discarded: 0, cancelled: 0, failed: 0 };
  let resumeDiscarded = 0;
  const wakeStatusByChild = new Map<string, string>();
  const lostChildSessionIds: string[] = [];

  for (const session of sessions) {
    const sessionID = String(session.id);
    const inputs = (await store.listSessionInputs?.({ sessionID: session.id })) ?? [];
    for (const input of inputs) {
      if (input.kind !== "backgroundNotification") continue;
      if (input.status in ledger) {
        ledger[input.status as keyof typeof ledger] += 1;
      }
      if (input.status === "discarded" && input.statusReason === "session_resumed") {
        resumeDiscarded += 1;
      }
      if (input.id.startsWith(SUBAGENT_LOST_WAKE_ADMISSION_ID_PREFIX)) {
        wakeStatusByChild.set(
          input.id.slice(SUBAGENT_LOST_WAKE_ADMISSION_ID_PREFIX.length),
          input.status,
        );
      }
    }
    // 收敛事实只可能落在 child 会话上（`taskType === "subagent_child"`）。
    if (session.taskType !== "subagent_child" || !store.sessionEntries) continue;
    const entries = await store.sessionEntries({
      sessionID: session.id,
      type: SESSION_ENTRY_SUBAGENT_OUTCOME,
    });
    if (subagentOutcomeEntryFact(entries)) {
      lostChildSessionIds.push(sessionID);
    }
  }

  const wakeMissing: RestartGapWakeMissingEntry[] = [];
  let wakeDelivered = 0;
  for (const childSessionId of lostChildSessionIds) {
    const status = wakeStatusByChild.get(childSessionId);
    if (status === "promoted") {
      wakeDelivered += 1;
      continue;
    }
    wakeMissing.push({
      childSessionId,
      ...(status ? { wakeStatus: status } : {}),
    });
  }

  return {
    generatedAt: new Date().toISOString(),
    ledger,
    lostChildren: lostChildSessionIds.length,
    resumeDiscarded,
    sessionsScanned: sessions.length,
    wakeDelivered,
    wakeMissing,
  };
}
