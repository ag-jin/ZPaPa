import { AGENT_BUILDER_ERROR_CODES } from "@zcode/services";
import type { AgentBuilderDraft, AgentBuilderTurn } from "@zcode/shared";
import type { TeamAgentDialogInitial } from "./teamAgentDialogInitial.js";

/* 访谈面板的**纯函数层**：状态迁移、失败分流、草稿 → 表单初值。
   组件（AgentBuilderDialog）只做渲染与调用编排 —— 判定全在这里，因为这里可被 node:test 钉住，
   而 JSX 里的判定只能靠人眼看（与 squadSurfaceViewModel / teamAgentMcpViewModel 同款纪律）。 */

export interface AgentBuilderMessage {
  role: "user" | "assistant";
  content: string;
  /** 该轮草稿未更新（模型输出不合规且已重试一次）：回复照常显示，草稿卡片标注。 */
  degraded?: boolean;
}

export interface AgentBuilderFailure {
  kind: "model-unavailable" | "request-failed";
  /** 可读原因（带原始细节，不吞错）。 */
  message: string;
}

export interface AgentBuilderSession {
  messages: AgentBuilderMessage[];
  /** 当前草稿（首轮成功前为 null；降级轮保持上一轮的值）。 */
  draft: AgentBuilderDraft | null;
  status: "idle" | "pending";
  failure: AgentBuilderFailure | null;
}

export function emptyAgentBuilderSession(): AgentBuilderSession {
  return { messages: [], draft: null, status: "idle", failure: null };
}

/** 失败分流：类型化错误码 → 两档（模型不可用那一档要引导用户去手动创建）。 */
export function agentBuilderFailureOf(error: unknown): AgentBuilderFailure {
  const code = (error as { code?: unknown } | null)?.code;
  const message =
    error instanceof Error && error.message.trim().length > 0
      ? error.message
      : typeof error === "string" && error.trim().length > 0
        ? error
        : String(error);
  // 没有 code 的错误（传输层 / 未知）与 request-failed 的界面动作完全相同：重试本轮 +
  // 改为手动创建 —— 多分一档只会多一个没有行为差异的分支。
  return {
    kind:
      code === AGENT_BUILDER_ERROR_CODES.modelUnavailable ? "model-unavailable" : "request-failed",
    message,
  };
}

/** 上一条是用户消息 ⇒ 本轮还没得到回复（可重试：重发同一条答案）。 */
export function agentBuilderAwaitingReply(messages: readonly AgentBuilderMessage[]): boolean {
  return messages.at(-1)?.role === "user";
}

/** 发送一轮：用户消息进转写并进入 pending。空输入不产生一轮（不把空气发给模型）。 */
export function agentBuilderSessionOnSend(
  session: AgentBuilderSession,
  answer: string,
): AgentBuilderSession {
  const content = answer.trim();
  if (content.length === 0) return session;
  return {
    ...session,
    messages: [...session.messages, { role: "user", content }],
    status: "pending",
    failure: null,
  };
}

/** 收到一轮结果（含降级）：回复进转写、草稿取服务返回值（降级时服务已原样返回入参草稿）。 */
export function agentBuilderSessionOnResult(
  session: AgentBuilderSession,
  result: { reply: string; draft: AgentBuilderDraft | null; degraded: boolean },
): AgentBuilderSession {
  return {
    messages: [
      ...session.messages,
      {
        role: "assistant",
        content: result.reply,
        ...(result.degraded ? { degraded: true } : {}),
      },
    ],
    draft: result.draft,
    status: "idle",
    failure: null,
  };
}

/** 本轮抛错（模型不可用 / 请求失败）：回到 idle 并挂失败信息；用户消息留在转写里（重试据此重发）。 */
export function agentBuilderSessionOnFailure(
  session: AgentBuilderSession,
  failure: AgentBuilderFailure,
): AgentBuilderSession {
  return { ...session, status: "idle", failure };
}

/** 用户停止等待（abort）：只回 idle —— 刚发出的用户消息**保留**，否则「重试本轮」无话可发。 */
export function agentBuilderSessionOnStop(session: AgentBuilderSession): AgentBuilderSession {
  return { ...session, status: "idle" };
}

/** 转写给服务的形态（人类可读、按序，服务按「末条 user 是本轮」读）。 */
export function agentBuilderHistoryOf(
  messages: readonly AgentBuilderMessage[],
): AgentBuilderTurn[] {
  return messages.map((message) => ({ role: message.role, content: message.content }));
}

/** 「去确认」的闸：草稿里有可确认的内容（全空白草稿只留「改为手动创建」这条路）。 */
export function agentBuilderDraftHasContent(draft: AgentBuilderDraft | null): boolean {
  if (draft === null) return false;
  return (
    draft.name.trim().length > 0 ||
    draft.description.trim().length > 0 ||
    draft.systemPrompt.trim().length > 0 ||
    draft.skills.length > 0
  );
}

/** 预览摘要里提示词的截断长度（卡片是**紧凑**卡片，不是全文阅读器）。 */
export const AGENT_BUILDER_PROMPT_EXCERPT_LIMIT = 160;

export interface AgentBuilderDraftSummary {
  name: string;
  description: string;
  /** 原文前缀（只截断、不改写：预览与用户最终审阅的是同一段文字）。 */
  promptExcerpt: string;
  promptLength: number;
  skills: string[];
  memoryScopeMessageId: string;
  permissionModeMessageId: string;
}

export function agentBuilderDraftSummary(draft: AgentBuilderDraft): AgentBuilderDraftSummary {
  return {
    name: draft.name.trim(),
    description: draft.description.trim(),
    promptExcerpt: [...draft.systemPrompt].slice(0, AGENT_BUILDER_PROMPT_EXCERPT_LIMIT).join(""),
    promptLength: draft.systemPrompt.length,
    skills: [...draft.skills],
    memoryScopeMessageId: `squad.common.memoryScope.${draft.memoryScope}`,
    permissionModeMessageId: `squad.common.permissionMode.${draft.permissionMode ?? "unset"}`,
  };
}

/**
 * 草稿 → 既有 TeamAgentDialog 的初值（§4-D3「表单即确认步」）。
 *
 * 只映射**六个生成字段**；color / modelSelection / tools / disallowedTools /
 * maxConcurrentRuns / mcpServers 一律不出现 —— 与 §4-D4 的生成边界一致，
 * 「访谈不会替你决定工具白名单与 MCP 配置」这件事在类型与运行时都成立。
 * skills 换新数组：初值与草稿不共享可变引用（改表单不该改到草稿）。
 */
export function agentBuilderDraftToTeamAgentInitial(
  draft: AgentBuilderDraft,
): TeamAgentDialogInitial {
  return {
    name: draft.name,
    systemPrompt: draft.systemPrompt,
    memoryScope: draft.memoryScope,
    ...(draft.description.trim().length > 0 ? { description: draft.description } : {}),
    ...(draft.skills.length > 0 ? { skills: [...draft.skills] } : {}),
    ...(draft.permissionMode !== null ? { permissionMode: draft.permissionMode } : {}),
  };
}
