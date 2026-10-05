import type { SquadRunRecord, SquadRunStatus } from "@zcode/services";
import type { TeamAgent } from "@zcode/shared";

/* T5：presence 的**唯一判定实现**（纯函数，UI 归属——T4 裁定③「U」：判据不出 UI 层，
   零 services 导出面改动；先例 runReviewable）。
   三条口径注意（T4 §4，写死在这里防漂移）：
   ① 小队聚合（T6 用）按 squad.members[].agentId 求和 ⇒ 同一 agent 跨队会**重复计数**；
   ② 名册可变 ⇒ 历史 run 的 agentId 可能不在当前名册/成员里（聚合时按成员过滤即漏，登记不修）；
   ③ 队长 ∈ members（队长 run 计入该队的聚合）。
   两条已知失真（用户裁定④登记不修）：僵尸 open 虚高 runningCount（启动和解只收队长行）；
   standalone run 无台账行 ⇒ 虚低（结构上不可见）。 */

/** availability：归档优先于停用（归档=历史条目，连 workload 都不给）。 */
export type SquadPresenceAvailability = "enabled" | "disabled" | "archived";

/** workload：working 优先呈现（有 open 就算在跑，queued 作 +M 追加）；null = 不显示工作档。 */
export type SquadPresenceWorkload = "working" | "queued" | "idle";

export type SquadPresence = {
  availability: SquadPresenceAvailability;
  workload: SquadPresenceWorkload | null;
  runningCount: number;
  queuedCount: number;
};

/**
 * working 判据 = `status === "open"`（T4 裁定②，**不是**活跃三态：produced/rejected 是
 * 「占树/待人审」，画成「运行中」是把等待审查伪装成在干活）。
 * 穷尽映射（Record 编译强制）：`SQUAD_RUN_STATUSES` 加状态时这里先红，判据不会静默漂移。
 */
const COUNTS_AS_WORKING: Record<SquadRunStatus, boolean> = {
  open: true,
  produced: false,
  rejected: false,
  merged: false,
  discarded: false,
  queued: false,
};

export function buildAgentPresence(
  agent: TeamAgent,
  /** 活跃 run（snapshot.runs 口径；working 计数只认 open）。 */
  runs: readonly SquadRunRecord[],
  /** 排队 run（**唯一合法的 queued 数据源** = snapshot.queuedRuns，C5 契约字段；不得推测）。 */
  queuedRuns: readonly SquadRunRecord[],
): SquadPresence {
  const availability: SquadPresenceAvailability =
    agent.archivedAt !== undefined ? "archived" : agent.enabled ? "enabled" : "disabled";
  const runningCount = runs.filter(
    (record) => record.agentId === agent.id && COUNTS_AS_WORKING[record.status],
  ).length;
  const queuedCount = queuedRuns.filter((record) => record.agentId === agent.id).length;
  const workload: SquadPresenceWorkload | null =
    availability !== "enabled"
      ? null
      : runningCount > 0
        ? "working"
        : queuedCount > 0
          ? "queued"
          : "idle";
  return { availability, workload, runningCount, queuedCount };
}
