import type { SquadSnapshot } from "@zcode/services";
import type { Squad, TeamAgent } from "@zcode/shared";
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

/**
 * 「编辑小队」的**队长候选**：可派发的智能体 ∪ **当前队长**（若它已停用/归档而掉出候选）。
 *
 * 为什么必须并上当前队长：`SquadDialog` 用 `candidates.find(leaderAgentId).name` 显示当前队长。
 * 队长若已停用/归档（例如先在「智能体」面停用了它），它就**不在** `dispatchableTeamAgents` 里 ⇒
 * 触发器的名字解析成 `undefined` ⇒ 表单显示空白占位符，看上去像"这支小队没有队长"，
 * 而提交时其实带着旧队长 —— **显示与提交不一致**，且不报错。并上它之后：名字显示得出来、
 * 也仍可被重新选中（它本来就是当前值，不算"给了个必然失败的选项"）。
 *
 * 新增候选仍**只**来自可派发集合：本函数不会把一个停用/归档的智能体**变成可新增的队长候选**
 * （它只在已是当前队长时出现）。当前队长在前（默认值可见、易找），其余按既有顺序，去重。
 */
export function squadEditLeaderCandidates(snapshot: SquadSnapshot, squad: Squad): TeamAgent[] {
  const dispatchable = dispatchableTeamAgents(snapshot);
  const current = snapshot.teamAgents.find((agent) => agent.id === squad.leaderAgentId);
  if (!current || dispatchable.some((agent) => agent.id === current.id)) return dispatchable;
  return [current, ...dispatchable];
}

/**
 * 「编辑小队」的**队员勾选源**：可派发的智能体 ∪ **本队当前成员**（含已停用/归档的）。
 *
 * 为什么必须并上当前成员：勾选框只对列出来的智能体有效 ⇒ 一个"先在「智能体」面停用/归档、
 * 后来才编辑小队"的成员**不在**候选列表里 ⇒ 用户**没法把它从名册里去掉**（归档还没有"取消归档"，
 * 对被归档的成员这条路是真死路）。并上当前成员之后，它们至少能被取消勾选（移除）；
 * 而**新增**仍只限于可派发的智能体 —— 非成员且不可派发的智能体不会因为本函数变得可选。
 *
 * 当前选中状态由 `initial.memberIds` 决定（页面投影：名册去掉队长）；队长由对话框按当前
 * 选择过滤（spec §3.3 自动并入），本函数不做那层过滤。
 */
export function squadEditMemberCandidates(snapshot: SquadSnapshot, squad: Squad): TeamAgent[] {
  const byId = new Map(snapshot.teamAgents.map((agent) => [agent.id, agent]));
  const candidates = dispatchableTeamAgents(snapshot);
  const seen = new Set(candidates.map((agent) => agent.id));
  for (const member of squad.members) {
    if (seen.has(member.agentId)) continue;
    const agent = byId.get(member.agentId);
    // 定义已不存在的成员无法做成勾选框（没有名字可显示）；它在 `memberIds` 初值里，提交时保留。
    if (!agent) continue;
    candidates.push(agent);
    seen.add(agent.id);
  }
  return candidates;
}
