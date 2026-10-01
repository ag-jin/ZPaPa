import { z } from "zod";
import { modelSelectionSchema } from "./model-selection.js";
import type { AgentColor, AgentPermissionMode } from "./subagents-types.js";

/* 协作智能体（TeamAgent）的域模型：一等独立实体，与现有 subagent 完全分开
   （决策 C3 三重隔离：存储命名空间 / 设置分区 / 术语）。
   与现有 subagent 的关系只有一次「预填拷贝」，此后各自独立，无持续引用（spec §3.2）。 */

/** 色板与现有 subagent 同一套（spec §3.2 取 SUBAGENT_COLORS）；`satisfies` 让色板改名时在此处编译报错，
    但**新增**色板颜色需手动同步到这里——strict schema 会拒绝未列出的颜色。 */
export const TEAM_AGENT_COLORS = [
  "red",
  "blue",
  "green",
  "yellow",
  "purple",
  "orange",
  "pink",
  "cyan",
] as const satisfies readonly AgentColor[];

/** `auto` / `plan` 与现有 AgentPermissionMode 同一取值域。 */
const TEAM_AGENT_PERMISSION_MODES = [
  "auto",
  "plan",
] as const satisfies readonly AgentPermissionMode[];

/** 记忆作用域：复用现成 agent-memory 能力（spec §3.2 / §7）。 */
export const TEAM_AGENT_MEMORY_SCOPES = ["user", "project", "local"] as const;

/** 预填来源留痕：只记「从哪来」，不建立引用（spec §3.2「此后无持续引用」）。 */
export const teamAgentProvenanceSchema = z
  .object({
    /** manual：手工新建；prefill：一次性从现有 agent 预填而来。 */
    source: z.enum(["manual", "prefill"]),
    /** 预填来源 agent 的 id；仅作留痕，重命名/删除来源都不影响本定义。 */
    sourceAgentId: z.string().min(1).optional(),
  })
  .strict();

/**
 * 智能体定义。**strict**：未知字段直接拒绝，这是「不绑 host」的机器化证明（决策 E，单机运行
 * 不需要 hostBinding），也让「多写一个字段」无法静默落盘。
 * `id` 必须非空：记忆以它做 key，空 id 会让一个智能体的记忆串到另一个身上。
 */
export const teamAgentSchema = z
  .object({
    id: z.string().min(1),
    name: z.string(),
    description: z.string().optional(),
    color: z.enum(TEAM_AGENT_COLORS).optional(),
    systemPrompt: z.string(),
    skills: z.array(z.string()).default([]),
    /** 复用既有 ModelSelection 校验（providerId / modelId / reasoningLevel），不另立形状。 */
    modelSelection: modelSelectionSchema.optional(),
    tools: z.array(z.string()).optional(),
    disallowedTools: z.array(z.string()).optional(),
    permissionMode: z.enum(TEAM_AGENT_PERMISSION_MODES).optional(),
    memoryScope: z.enum(TEAM_AGENT_MEMORY_SCOPES),
    enabled: z.boolean(),
    /** 归档时间戳（毫秒）：归档而非硬删，定义与记忆都不丢（Task 8 的 archive 写入）。 */
    archivedAt: z.number().int().nonnegative().optional(),
    provenance: teamAgentProvenanceSchema.optional(),
  })
  .strict();

export type TeamAgent = z.infer<typeof teamAgentSchema>;

/** 写入路径接受的形状：带 default 的字段（skills）可省略，由 schema 归一化后落盘。 */
export type TeamAgentInput = z.input<typeof teamAgentSchema>;
