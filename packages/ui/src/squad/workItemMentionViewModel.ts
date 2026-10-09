import { SUBAGENT_COLOR_CLASS, resolveSubagentColorFromName } from "@/lib/subagentColors.js";
import type { MentionRoster } from "./workItemCollaborationViewModel.js";

/* B5.1 轮 1：`@` 补全的**候选模型**（设计案 §4.2）。

   名册来源**只有一处**：同一 workspace 的 `SquadSnapshot.teamAgents` + `squads` 的稳定
   `id + name` 快照 —— 不得从已渲染评论文本、当前 assignee 或本地字符串猜名册；
   人类提及候选要等未来正式人类名册接口，本轮**不伪造候选**（C3）。

   客户端补全只是**输入辅助**：插入的只是显示名称文本，持久化的 mentions 才是提交后事实，
   本地**不认定**任何派发目标（本模型不 import 任何派发常量，也拿不到 receipt 状态）。 */

/** 一条 `@` 候选（`key` 是稳定 id，用于 `data-testid="work-item-mention-option-{id}"`）。 */
export type MentionOption = {
  key: string;
  type: "agent" | "squad" | "all";
  id: string;
  name: string;
  /** 插入文本（不含前导空格）：选择后写进草稿的是**显示名称**。 */
  insertText: string;
  /** 重名 ⇒ **不自动选取、不可插入**（插入一个会触发且指向不明目标的名字是坏动作）。 */
  ambiguous: boolean;
  colorClass?: string;
  /** 附加说明的文案键（`@all` 的「仅抑制自动路由」）。 */
  hintMessageId?: string;
};

export type MentionMenuModel =
  /** 名册不可用：界面**必须说出来**（`work-item-comment-mention-unavailable`），不得静默不出菜单。 */
  { kind: "rosterUnavailable" } | { kind: "ready"; options: MentionOption[] };

const ALL_OPTION: MentionOption = {
  key: "all",
  type: "all",
  id: "all",
  name: "@all",
  insertText: "@all",
  ambiguous: false,
  hintMessageId: "squad.workItemDetail.mention.allHint",
};

export function buildMentionMenu(input: {
  roster: MentionRoster | null;
  /** `@` 之后的查询串（可为空 = 只输入了一个 `@`）。 */
  query: string;
}): MentionMenuModel {
  if (input.roster === null) return { kind: "rosterUnavailable" };
  const agentNames = new Map<string, number>();
  for (const agent of input.roster.agents) {
    agentNames.set(agent.name, (agentNames.get(agent.name) ?? 0) + 1);
  }
  const needle = input.query.trim().toLowerCase();
  const matches = (name: string) => name.toLowerCase().startsWith(needle);
  const options: MentionOption[] = [];
  for (const agent of input.roster.agents) {
    if (!matches(agent.name)) continue;
    options.push({
      key: `agent:${agent.id}`,
      type: "agent",
      id: agent.id,
      name: agent.name,
      insertText: `@${agent.name}`,
      ambiguous: (agentNames.get(agent.name) ?? 0) > 1,
      colorClass: SUBAGENT_COLOR_CLASS[agent.color ?? resolveSubagentColorFromName(agent.name)],
    });
  }
  for (const squad of input.roster.squads) {
    if (!matches(squad.name)) continue;
    options.push({
      key: `squad:${squad.id}`,
      type: "squad",
      id: squad.id,
      name: squad.name,
      insertText: `@${squad.name}`,
      ambiguous: false,
    });
  }
  // `@all` 恒定置底：它是「仅抑制自动路由」，不暗示广播/通知/启动运行（设计案 §4.2）。
  options.push(ALL_OPTION);
  return { kind: "ready", options };
}

/** 重名项不可插入（`null` = 该候选不能用于补全，界面显示「名称不唯一，请使用标识」）。 */
export function mentionOptionInsertText(option: MentionOption): string | null {
  return option.ambiguous ? null : option.insertText;
}

/**
 * ↑↓ 选择在候选间环绕；空候选返回 `-1`（没有可选项，界面不选中任何项）。
 * Escape / Enter / Tab 的语义由组件承担（关闭菜单 / 插入 / 插入），索引算术留在本函数里可测。
 */
export function moveMentionSelection(current: number, delta: number, count: number): number {
  if (count <= 0) return -1;
  if (current < 0) return delta > 0 ? 0 : count - 1;
  return (current + delta + count) % count;
}

/**
 * 草稿末尾**未闭合**的 `@token`（菜单只在它存在时打开）：
 * · 必须出现在行首或空白之后 —— `mail@example.com` 里的 `@` 不是提及入口；
 * · token 内不得有空白（空格/换行即结束）；
 * · 返回 `{ query }`（`@` 后为空串 = 刚敲下 `@`，列出全部候选），没有激活的 token ⇒ `null`。
 */
export function activeMentionQuery(draft: string): { query: string } | null {
  const match = /(?:^|\s)@([^\s@]*)$/.exec(draft);
  return match ? { query: match[1] ?? "" } : null;
}
