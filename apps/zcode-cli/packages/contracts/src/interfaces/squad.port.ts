// ============================================================
// Squad Port - leader dispatch boundary (create child work item / assign to member)
// ============================================================
//
// **不变式（P0/P1 裁定，spec §4.3 / §5.1）**：本接口**只**暴露「建子项」与「发派发事件」两件事，
// 以及一件只读的花名册查询。**不得**出现任何写工作项生命周期状态的方法
// （`transition` / `setStatus` / `updateStatus` / …一律禁止）——工作项状态的唯一写者是
// `workItemService.transition`；用户、队长、调度器三方都只能发同一形状的派发事件。
// 一旦本接口长出写状态的方法，队长（工具调用方）就获得了绕过唯一写者的通路。

import type {
  SquadAssignWorkItemInput,
  SquadAssignWorkItemOutput,
  SquadCreateChildWorkItemInput,
  SquadCreateChildWorkItemOutput,
} from "../tools/squad.js";

/** 花名册的最小投影：够做「派给谁」的合法性校验即可，不泄漏队员的私有配置。 */
export interface SquadRoster {
  leaderAgentId: string;
  members: Array<{ agentId: string }>;
}

export interface SquadPort {
  /** 在指定父项下建子工作项，并把它指派给某个队员（队长拆解用）。 */
  createChildWorkItem(
    input: SquadCreateChildWorkItemInput,
  ): Promise<SquadCreateChildWorkItemOutput>;
  /** 把工作项 / 子项派给某个队员 —— 只发派发事件，不替任何一方写状态。 */
  assignWorkItem(input: SquadAssignWorkItemInput): Promise<SquadAssignWorkItemOutput>;
  /** 只读花名册：`assignWorkItem` 用它把「不存在的队员」变成响亮失败。 */
  listRoster(): Promise<SquadRoster>;
}
