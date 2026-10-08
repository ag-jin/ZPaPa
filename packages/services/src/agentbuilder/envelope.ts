import {
  TEAM_AGENT_MEMORY_SCOPES,
  TEAM_AGENT_PERMISSION_MODES,
  type AgentBuilderDraft,
  type ZCodeWorkspaceModelMessage,
} from "@zcode/shared";

/* AgentBuilder 访谈的**上行协议**：每轮把「用户的回答 + 当前草稿 + 可选值域」重新申明一次。

   为什么重申而不是只发增量：模型是**无状态**的（服务面同样无状态，见设计报告 §5.2）——
   它每一轮都得从完整的决策上下文出发，否则「模型只能从申明过的取值里挑」这条约束就落空了
   （multica `encodeBuilderInput` 同款取舍，`builder-protocol.ts:122-174`）。

   注意与 multica 的**一处差别**：历史轮的用户消息不再重申草稿 —— 那些轮次的草稿我们并不保留
   （服务面不存历史快照），而"当时说了什么"已由 assistant 轮自带的 <agent_draft> 块如实记录。
   权威草稿只出现在**最末一条**信封里，系统提示词里明说了这一点。 */

/** 上行信封前缀（固定首行；模型与测试都按它识别机器载荷）。 */
export const AGENT_BUILDER_INPUT_PREFIX = "ZCODE_AGENT_BUILDER_INPUT\n";

/** 历史轮次上限：超过即丢弃中段最旧的轮次，但保留首条用户目标消息（§D1 的上下文长度纪律）。 */
export const AGENT_BUILDER_HISTORY_LIMIT = 30;

export interface AgentBuilderTurn {
  role: "user" | "assistant";
  /** 已完成的轮次（编码前的人类可读形态）。 */
  content: string;
}

/** 一轮用户输入编码成信封。`draft` 为 null 时省略 `current_draft`（= 这一轮不重申草稿）。 */
export function encodeAgentBuilderTurn(answer: string, draft: AgentBuilderDraft | null): string {
  return (
    AGENT_BUILDER_INPUT_PREFIX +
    JSON.stringify({
      user_request: answer,
      ...(draft === null ? {} : { current_draft: draft }),
      available_memory_scopes: [...TEAM_AGENT_MEMORY_SCOPES],
      available_permission_modes: [...TEAM_AGENT_PERMISSION_MODES],
    })
  );
}

/**
 * 上下文钳制：不超限时**原样返回同一引用**（无谓拷贝）；超限时保留首条 + 最近 (limit-1) 条。
 * 首条是「我要个什么智能体」的目标陈述 —— 丢了它模型会忘了为什么访谈（§D1）。
 */
export function clampAgentBuilderHistory<T extends AgentBuilderTurn>(
  history: readonly T[],
  limit: number = AGENT_BUILDER_HISTORY_LIMIT,
): readonly T[] {
  if (history.length <= limit) return history;
  const first = history[0];
  if (first === undefined) return history;
  return [first, ...history.slice(history.length - (limit - 1))];
}

/**
 * 组装一轮访谈的 messages：system 提示词 + 历史（用户轮信封 / assistant 轮原文）+ 本轮信封。
 *
 * `answer` 为 null 表示「不追加本轮信封」（history 已含全部轮次，最后一条是 assistant 轮）——
 * 此时历史用户轮同样不重申草稿。不发明一句用户没说过的话。
 */
export function buildAgentBuilderMessages(params: {
  systemPrompt: string;
  history: readonly AgentBuilderTurn[];
  draft: AgentBuilderDraft | null;
  answer: string | null;
}): ZCodeWorkspaceModelMessage[] {
  // 逐条构造（不靠数组字面量的上下文推断）：messages 是四种角色的判别联合，
  // 数组展开元素拿不到元素级的上下文类型，`role` 会被放宽成 string 而报类型错。
  const messages: ZCodeWorkspaceModelMessage[] = [systemMessage(params.systemPrompt)];
  for (const turn of clampAgentBuilderHistory(params.history)) {
    messages.push(
      turn.role === "user"
        ? userMessage(encodeAgentBuilderTurn(turn.content, null))
        : assistantMessage(turn.content),
    );
  }
  if (params.answer !== null) {
    messages.push(userMessage(encodeAgentBuilderTurn(params.answer, params.draft)));
  }
  return messages;
}

function systemMessage(content: string): ZCodeWorkspaceModelMessage {
  return { role: "system", content };
}

function userMessage(content: string): ZCodeWorkspaceModelMessage {
  return { role: "user", content };
}

function assistantMessage(content: string): ZCodeWorkspaceModelMessage {
  return { role: "assistant", content };
}
