import type { SquadSnapshot } from "@zcode/services";
import { dispatchableTeamAgents } from "./squadEntryViewModel.js";

/* 「小队」一级页面（SquadsPage）的**纯逻辑**补充。

   状态机与行动作判据是**面无关**的，已抽到 `squadSurfaceViewModel`（与智能体页共用**同一份**
   实现）；这里只放小队面**独有**的判据，让「新建按钮置灰」与「空态提示」这两处问的是
   同一个函数（两处各写一遍 `length === 0` 迟早分叉，而分叉不报错）。 */

/**
 * 能不能新建小队：候选（可派发的协作智能体）为空 ⇒ false。
 *
 * 为什么这是判据而不是样式细节：小队的队长是**必填**（`CreateSquadInput.leaderAgentId`），
 * 而队长只能从可派发的协作智能体里选 —— 没有候选时，点开新建对话框连队长都选不出来，
 * 提交按钮永远不会亮。**不给自己一个必然失败的入口**：入口摆着但通往死路，
 * 用户只会把它读成"功能坏了"。停用 / 已归档的智能体不算候选（与建小队的队员候选同一条规则：
 * `dispatchableTeamAgents`）。
 */
export function canCreateSquad(snapshot: SquadSnapshot): boolean {
  return dispatchableTeamAgents(snapshot).length > 0;
}

/**
 * 小队表单（`SquadDialog`）**编辑模式的初值形状**。
 *
 * 为什么形状定义在这里而不是表单文件里：初值由页面构造（`SquadsPage` 从 `squad.members`
 * 去掉队长投影出来）、由对话框消费 —— 两处各写一遍形状迟早分叉（多塞一个字段是静默的）。
 * `memberIds` **不含队长**（队长由 leaderAgentId 自动并入名册，spec §3.3）。
 */
export type SquadDialogInitial = {
  name: string;
  leaderAgentId: string;
  memberIds: string[];
  stopCondition: string;
  maxRounds: string;
};
