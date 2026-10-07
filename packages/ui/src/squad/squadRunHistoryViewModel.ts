import {
  SQUAD_RUN_SETTLE_REASON_USER_CANCEL,
  SQUAD_RUN_SETTLE_REASON_WATCHDOG_DEAD_SESSION,
  SQUAD_RUN_SETTLE_REASON_WATCHDOG_IDLE_GRACE,
  SQUAD_RUN_SETTLE_REASON_WATCHDOG_TTL,
  type SquadRunRecord,
} from "@zcode/services";

/* agent 详情页「运行历史」分页（欠账 #13，2026-10-07 裁定）的**纯逻辑**。

   为什么这几件必须留在纯函数里（ui 包没有渲染测试设施，组件里算 = 不可测）：
   ① 追加页的合并规则（去重 / 保序）—— 错了的表现是「同一个 run 出现两行」或「行序跳动」，
      两者都只有肉眼能发现，且翻页期间台账还在继续插入新行（边界行完全可能落在两页里）；
   ② 结算原因的呈现判据（哪些码值有本地化措辞、哪些原样显示）—— `settle_reason` **不是闭集**
      （失败原因原文也落这一列），把未知值当枚举处理会让真实的失败原因从界面上消失。

   本文件不 import React（照本域既定做法）。 */

/**
 * 合并「已加载的行」与「刚取回的一页」：按 `runId` 去重、保持 `(createdAt, runId)` **DESC** 序。
 *
 * 三条语义：
 * · **去重保先**：同一个 `runId` 已在屏上就不再追加（保留已显示的那一条，界面不闪 —— 两次读到的
 *   是同一行，只是可能相隔一次写入）；
 * · **顺序与服务面同源**：`createdAt` 降序、同刻 `runId` 降序（与 repo 的
 *   `ORDER BY created_at DESC, run_id DESC` 逐字一致）。追加页本就按这个序给出，重排只是把
 *   「服务面口径与界面口径不一致」当场暴露出来，而不是让它以「行序有点怪」的样子长期存在；
 * · **不就地改写**：两份入参原样保留（React 状态里它们是既有数组，就地 push 会让
 *   `useState` 的比较失效，界面不刷新）。
 */
export function mergeRunHistoryPages(
  current: readonly SquadRunRecord[],
  page: readonly SquadRunRecord[],
): SquadRunRecord[] {
  const seen = new Set<string>();
  const merged: SquadRunRecord[] = [];
  for (const record of [...current, ...page]) {
    if (seen.has(record.runId)) continue;
    seen.add(record.runId);
    merged.push(record);
  }
  // 同刻按 runId 降序：与 repo 的 tie-break 同向（比较器只对同 createdAt 的行起作用）。
  return merged.sort(
    (left, right) =>
      right.createdAt - left.createdAt || (left.runId < right.runId ? 1 : left.runId > right.runId ? -1 : 0),
  );
}

/**
 * 结算原因的文案键：已知**码值**（看门狗族三码 + 用户取消，常量单源在 services）⇒ 文案 id；
 * 其余非空值 ⇒ `null`（**原样显示**：`settle_reason` 不是闭集，失败原因原文也落这一列，
 * 当枚举隐藏它 = 把用户最需要看到的一行抹掉）；空/NULL ⇒ `null`（没有原因，不显示）。
 *
 * 为什么键用**常量**而不是字面量：抄错一个字符，一次看门狗结算会被显示成别的原因，且不报错。
 */
export const RUN_SETTLE_REASON_MESSAGE_IDS: Record<string, string> = {
  [SQUAD_RUN_SETTLE_REASON_WATCHDOG_DEAD_SESSION]: "squad.agentDetail.settleReason.watchdogDeadSession",
  [SQUAD_RUN_SETTLE_REASON_WATCHDOG_TTL]: "squad.agentDetail.settleReason.watchdogTtl",
  [SQUAD_RUN_SETTLE_REASON_WATCHDOG_IDLE_GRACE]: "squad.agentDetail.settleReason.watchdogIdleGrace",
  [SQUAD_RUN_SETTLE_REASON_USER_CANCEL]: "squad.agentDetail.settleReason.userCancel",
};

export function runSettleReasonMessageId(reason: string | null | undefined): string | null {
  if (!reason) return null;
  return RUN_SETTLE_REASON_MESSAGE_IDS[reason] ?? null;
}
