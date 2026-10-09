import type { SquadRunRecord, SquadRunStatus } from "@zcode/services";
import type { Squad, TeamAgent } from "@zcode/shared";
import { SUBAGENT_COLOR_CLASS, resolveSubagentColorFromName } from "@/lib/subagentColors.js";

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

/** 头像堆叠投影：可见至多 3 个色点（成员身份色，九色板；归档/名册外成员不入堆叠）。 */
export type SquadAvatarStackEntry = { agentId: string; colorClass: string };

export type SquadAggregatePresence = {
  availability: SquadPresenceAvailability;
  workload: SquadPresenceWorkload | null;
  runningCount: number;
  queuedCount: number;
  /** 未归档且在名册内的成员数（归档成员是历史条目，不计入「现有成员」摘要）。 */
  activeMemberCount: number;
  avatarStack: SquadAvatarStackEntry[];
  /** 超出可见 3 个的成员数（0 = 无溢出，UI 不渲染 +N）。 */
  avatarOverflow: number;
};

const AVATAR_STACK_LIMIT = 3;

export function buildSquadPresence(
  squad: Squad,
  teamAgents: readonly TeamAgent[],
  runs: readonly SquadRunRecord[],
  queuedRuns: readonly SquadRunRecord[],
): SquadAggregatePresence {
  const availability: SquadPresenceAvailability =
    squad.archivedAt !== undefined ? "archived" : squad.enabled ? "enabled" : "disabled";
  // 口径注意②：名册可变 ⇒ 成员 agentId 查不到定义（或已归档）时不计入头像与成员数（不猜）。
  const activeMembers = squad.members.flatMap((member) => {
    const agent = teamAgents.find(
      (candidate) => candidate.id === member.agentId && candidate.archivedAt === undefined,
    );
    return agent ? [agent] : [];
  });
  // 口径注意③：队长 ∈ members ⇒ 队长 run 计入本队聚合（不加特判）。
  // 口径注意①：聚合是**按卡**口径——同一 agent 跨队时两张卡各自全数（不去重，写死于测试）。
  let runningCount = 0;
  let queuedCount = 0;
  for (const member of activeMembers) {
    const presence = buildAgentPresence(member, runs, queuedRuns);
    runningCount += presence.runningCount;
    queuedCount += presence.queuedCount;
  }
  const workload: SquadPresenceWorkload | null =
    availability !== "enabled"
      ? null
      : runningCount > 0
        ? "working"
        : queuedCount > 0
          ? "queued"
          : "idle";
  return {
    availability,
    workload,
    runningCount,
    queuedCount,
    activeMemberCount: activeMembers.length,
    avatarStack: activeMembers.slice(0, AVATAR_STACK_LIMIT).map((agent) => ({
      agentId: agent.id,
      colorClass: SUBAGENT_COLOR_CLASS[agent.color ?? resolveSubagentColorFromName(agent.name)],
    })),
    avatarOverflow: Math.max(0, activeMembers.length - AVATAR_STACK_LIMIT),
  };
}
