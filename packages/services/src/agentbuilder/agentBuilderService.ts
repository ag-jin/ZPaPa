import {
  agentBuilderDraftSchema,
  emptyAgentBuilderDraft,
  type AgentBuilderDraft,
  type Locale,
  type ModelSelection,
} from "@zcode/shared";
import type { ZCodeWorkspaceModelMessage } from "@zcode/shared";
import type { ServiceLogger } from "../logger/serviceLogger.js";
import { createServiceLogger } from "../logger/serviceLogger.js";
import { AGENT_BUILDER_QUERY_SOURCE, type IAgentBuilderService } from "./agentBuilder.js";
import { AgentBuilderError } from "./agentBuilderErrors.js";
import { buildAgentBuilderMessages } from "./envelope.js";
import { mergeAgentBuilderDraft, readAgentDraftBlock } from "./draftProtocol.js";
import { resolveAgentBuilderModelSelection } from "./modelResolver.js";
import {
  buildAgentBuilderCorrectionPrompt,
  buildAgentBuilderSystemPrompt,
} from "./systemPrompt.js";

/* AgentBuilder 服务实现（设计报告 §5.1）：唯一的外部副作用是模型调用本身。

   一轮的顺序（§5.3 数据流）：
     解析模型（显式 > preferred > 响亮抛）→ 组装 messages（系统提示词 + 历史 + 本轮信封）
     → 模型调用 → 解析 <agent_draft> → 不合规则纠错重试一次 → 合并进草稿 → { reply, draft, degraded }

   两条刻意的取舍：
   1. **给用户看的正文始终取第一次响应**：纠错重试是机器修复步骤（"你没给草稿块，再给一次"），
      它的正文是对指令的响应，不是对用户的回答 —— 把它回放给用户等于让机器话术挤掉模型的追问。
   2. **降级不抛**：输出不合规重试一次后仍然不合规 ⇒ 返回 degraded（回复可见、草稿不动）。
      抛错会让整轮报废、用户丢掉模型这一轮已经说出口的追问。 */

/** 模型请求形状（由 node.ts 注入 zcodeAgentService.generateWorkspaceText）。 */
export interface AgentBuilderTextRequest {
  workspacePath: string;
  workspaceIdentity?: string;
  selection: ModelSelection;
  messages: ZCodeWorkspaceModelMessage[];
  querySource: string;
  signal?: AbortSignal;
}

export interface CreateAgentBuilderServiceOptions {
  /** 一次性多轮文本生成能力；由 node.ts 注入 zcodeAgentService.generateWorkspaceText。 */
  textGenerator: {
    generateText(params: AgentBuilderTextRequest): Promise<{ text: string }>;
  };
  /** 读取当前 preferred 模型；由 node.ts 注入 providerRuntime.modelSelection.getView()。 */
  currentModelProvider: {
    readCurrentModel(params: {
      workspacePath: string;
      workspaceIdentity?: string;
    }): Promise<ModelSelection | null>;
  };
  logger?: ServiceLogger;
}

export function createAgentBuilderService(
  options: CreateAgentBuilderServiceOptions,
): IAgentBuilderService {
  const logger = options.logger ?? createServiceLogger("agent-builder");

  async function complete(params: AgentBuilderTextRequest): Promise<string> {
    try {
      const result = await options.textGenerator.generateText(params);
      if (typeof result.text !== "string") {
        throw new Error("模型响应缺少文本内容。");
      }
      return result.text;
    } catch (error) {
      throw new AgentBuilderError(
        "模型请求失败。",
        "request-failed",
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  return {
    async interviewTurn(params) {
      const locale = params.locale ?? readRuntimeLocale();
      const preferred = await options.currentModelProvider.readCurrentModel({
        workspacePath: params.workspacePath,
        ...(params.workspaceIdentity ? { workspaceIdentity: params.workspaceIdentity } : {}),
      });
      const selection = resolveAgentBuilderModelSelection({
        requested: params.selection,
        preferred: preferred ?? undefined,
      });
      if (!selection) {
        // 不静默挑一个模型：用户没配模型就该说"没有可用的模型"（wiki 同款纪律）。
        throw new AgentBuilderError(
          "没有可用的模型，无法进行访谈。",
          "model-unavailable",
          "currentModelProvider 没有返回 providerId/modelId。",
        );
      }

      const currentTurn = params.history.at(-1);
      const isCurrentUserTurn = currentTurn?.role === "user";
      const messages = buildAgentBuilderMessages({
        systemPrompt: buildAgentBuilderSystemPrompt({ locale }),
        history: isCurrentUserTurn ? params.history.slice(0, -1) : params.history,
        draft: params.draft,
        answer: isCurrentUserTurn ? currentTurn.content : null,
      });

      logger.info(undefined, "开始一轮 AgentBuilder 访谈", {
        workspacePath: params.workspacePath,
        workspaceIdentity: params.workspaceIdentity,
        providerId: selection.providerId,
        model: selection.modelId,
        historyTurns: params.history.length,
        hasDraft: params.draft !== null,
      });

      const request: AgentBuilderTextRequest = {
        workspacePath: params.workspacePath,
        ...(params.workspaceIdentity ? { workspaceIdentity: params.workspaceIdentity } : {}),
        selection,
        messages,
        querySource: AGENT_BUILDER_QUERY_SOURCE,
        ...(params.signal ? { signal: params.signal } : {}),
      };

      const first = await complete(request);
      const firstRead = readAgentDraftBlock(first);
      if (firstRead.payload !== null) {
        return {
          reply: firstRead.reply,
          draft: mergeDraft(params.draft, firstRead.payload),
          degraded: false,
        };
      }

      // 输出不合规：追加纠错消息重试一次（交互场景整轮报废代价高，重试成本低）。
      logger.warn(undefined, "AgentBuilder 输出缺少可解析的草稿块，触发一次纠错重试", {
        workspacePath: params.workspacePath,
        replyPreview: firstRead.reply.slice(0, 120),
      });
      const retry = await complete({
        ...request,
        messages: [
          ...messages,
          { role: "assistant", content: first },
          { role: "user", content: buildAgentBuilderCorrectionPrompt({ locale }) },
        ],
      });
      const retryRead = readAgentDraftBlock(retry);
      if (retryRead.payload !== null) {
        return {
          reply: firstRead.reply,
          draft: mergeDraft(params.draft, retryRead.payload),
          degraded: false,
        };
      }

      logger.warn(undefined, "AgentBuilder 纠错重试后仍无可用草稿，降级本轮", {
        workspacePath: params.workspacePath,
        replyPreview: firstRead.reply.slice(0, 120),
      });
      return { reply: firstRead.reply, draft: params.draft, degraded: true };
    },
  };
}

/** 合并 + 不变量断言：交出去的草稿必须通过 schema（内部违背是编程错误，要响亮）。 */
function mergeDraft(
  current: AgentBuilderDraft | null,
  payload: Record<string, unknown>,
): AgentBuilderDraft {
  const merged = mergeAgentBuilderDraft(current ?? emptyAgentBuilderDraft(), payload);
  return agentBuilderDraftSchema.parse(merged);
}

/** 界面未显式传 locale 时的兜底：按运行时 locale 判定（Git 提交消息生成器同款纪律）。 */
function readRuntimeLocale(): Locale {
  try {
    return Intl.DateTimeFormat().resolvedOptions().locale.toLowerCase().startsWith("zh")
      ? "zh-CN"
      : "en-US";
  } catch {
    return "en-US";
  }
}
