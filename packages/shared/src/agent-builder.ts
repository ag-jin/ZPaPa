import { z } from "zod";
import { TEAM_AGENT_MEMORY_SCOPES, TEAM_AGENT_PERMISSION_MODES } from "./team-agent.js";

/* AgentBuilder（AI 访谈式智能体创建）的**草稿契约**：访谈每轮由模型产出的结构化草稿。

   为什么草稿不是 TeamAgent 的子集形状而是独立一份：它只承载访谈**生成**的六个字段
   （设计报告 §4-D4 的生成边界），其余字段各有归属 —— id/enabled/provenance 由代码赋值、
   color/modelSelection 由用户在表单里手选、tools/maxConcurrentRuns 本版不生成、
   mcpServers（可能含 env/token）**永不生成**且 schema 里根本不存在这个字段。
   于是「模型不可能往草稿里塞敏感配置」是形状上的事实，不靠提示词自觉。 */

/**
 * 字段长度钳制：超出即截断（不拒整轮）——访谈是交互场景，为一个超长字段报废整轮
 * 代价远大于截断；systemPrompt 的上限取得足够宽（完整 Markdown 系统提示词）。
 */
export const AGENT_BUILDER_DRAFT_LIMITS = {
  name: 60,
  description: 200,
  systemPrompt: 20_000,
  /** 技能令牌个数上限。 */
  skills: 20,
  /** 单个技能令牌字符数上限。 */
  skill: 60,
} as const;

/** 访谈的一轮：用户说的话 / 模型回复的正文（**编码前**的人类可读形态）。 */
export interface AgentBuilderTurn {
  role: "user" | "assistant";
  content: string;
}

/**
 * 交互草稿。**strict**：多余字段直接拒绝 —— 越权字段（mcpServers / tools / id / color…）
 * 在类型层就进不来，「模型输出越权字段」不可能静默落进表单。
 *
 * `permissionMode` 用 `null` 表达「未设置」（三态），与落盘定义的 optional 语义对得上：
 * 访谈期间允许用户还没被问到权限模式。
 */
export const agentBuilderDraftSchema = z
  .object({
    name: z.string(),
    description: z.string(),
    systemPrompt: z.string(),
    skills: z.array(z.string()),
    memoryScope: z.enum(TEAM_AGENT_MEMORY_SCOPES),
    permissionMode: z.enum(TEAM_AGENT_PERMISSION_MODES).nullable(),
  })
  .strict();

export type AgentBuilderDraft = z.infer<typeof agentBuilderDraftSchema>;

/** 访谈第一轮的起点草稿（也是降级轮的「草稿不动」基线）。memoryScope 与表单默认值一致。 */
export function emptyAgentBuilderDraft(): AgentBuilderDraft {
  return {
    name: "",
    description: "",
    systemPrompt: "",
    skills: [],
    memoryScope: "project",
    permissionMode: null,
  };
}
