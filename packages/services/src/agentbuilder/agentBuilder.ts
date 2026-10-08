import { ServiceChannels } from "@zcode/shared";
import type { AgentBuilderDraft, AgentBuilderTurn, Locale, ModelSelection } from "@zcode/shared";
import { createServiceDescriptor } from "../descriptors.js";

export type { AgentBuilderTurn } from "@zcode/shared";

/**
 * AgentBuilder（AI 访谈式智能体创建）服务面。
 *
 * 无状态：**历史与草稿由调用方持有**，每轮整段传入（设计报告 §5.2 状态所有权）——
 * 服务端不存会话、不落盘，唯一副作用是模型调用本身。接口只有一个方法，实现吞掉
 * 提示词工程、信封编码、协议解析、一次纠错重试、模型解析的全部复杂度。
 */
export interface IAgentBuilderService {
  /**
   * 一轮访谈。
   *
   * `history` 是**含本轮**的完整对话（按序）：最后一条应当是 user 轮（用户刚说/刚回答的话），
   * 它就是本轮要回答的内容 —— 权威草稿会随它的信封一起重申给模型。若最后一条是 assistant 轮，
   * 就按「让模型接着说」原样送出（不发明一句用户没说过的话）。
   *
   * 错误形态（类型化，UI 据此渲染重试）：模型不可用 / 请求失败**响亮抛**；
   * 模型输出不合规**不抛** —— 重试一次后仍不合规即降级返回（`degraded: true`，草稿不动）。
   */
  interviewTurn(params: {
    workspacePath: string;
    workspaceIdentity?: string;
    /** 已完成的轮次 + 本轮用户消息（编码前的人类可读形态），按序。 */
    history: readonly AgentBuilderTurn[];
    /** 当前草稿（上一轮产物；首轮为 null）。 */
    draft: AgentBuilderDraft | null;
    /** 显式模型（v1 UI 不传，服务端回退当前 preferredSelection）。 */
    selection?: ModelSelection;
    signal?: AbortSignal;
    /** 回复语言（跟随界面 locale）；省略时按运行时 locale 判定。 */
    locale?: Locale;
  }): Promise<{
    /** 剥离草稿块后的自然语言回复（含追问）。 */
    reply: string;
    /**
     * 本轮合并后的草稿；降级轮 = 原样返回入参 draft（首轮降级仍可能是 null）。
     * 非 null 时**必然**通过 `agentBuilderDraftSchema`。
     */
    draft: AgentBuilderDraft | null;
    /** true = 本轮输出不合规（已重试一次仍未过），草稿未更新。 */
    degraded: boolean;
  }>;
}

export const IAgentBuilderService = createServiceDescriptor<IAgentBuilderService>(
  ServiceChannels.AgentBuilder,
);

/** 传给模型的归因标记。 */
export const AGENT_BUILDER_QUERY_SOURCE = "agent_builder";
