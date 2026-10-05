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

/** 每 agent 最大并发 run 数的缺省（C1，⑤刀 Concurrency 半边）：对齐 multica `MaxConcurrentTasks` 默认 6（migration 023）。 */
export const DEFAULT_TEAM_AGENT_MAX_CONCURRENT_RUNS = 6;
/** 并发上限的**校验界**（不是存储界）：单机 CLI 场景每个并发 run = 一条 CLI 会话 + 一棵工作树，16 已覆盖批量在途并留余量；将来放宽只改此常量、无需迁移。 */
export const TEAM_AGENT_MAX_CONCURRENT_RUNS_LIMIT = 16;

/**
 * 读「该 agent 允许的最大并发 run 数」的唯一入口：缺省（字段未设置）与显式值都经这里解析。
 * 闸（C3）、UI 与详情页必须读同一处，不得各写一份 `?? 6`——否则缺省语义会分叉。
 * 注意（C3 闸行为，评审 A5）：名册里**找不到 agent 定义**时不适用本函数、更不得凭空套缺省 6——
 * 那是「闸不排队、照旧派发 + 日志」的独立分支，与本字段无关。
 */
export function resolveTeamAgentMaxConcurrentRuns(
  agent: Pick<TeamAgent, "maxConcurrentRuns">,
): number {
  return agent.maxConcurrentRuns ?? DEFAULT_TEAM_AGENT_MAX_CONCURRENT_RUNS;
}

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
    /** 每 agent 最大并发 run 数（C1）：可选——缺省不落盘（存量文件零改写），读数经 resolveTeamAgentMaxConcurrentRuns。 */
    maxConcurrentRuns: z
      .number()
      .int()
      .min(1)
      .max(TEAM_AGENT_MAX_CONCURRENT_RUNS_LIMIT)
      .optional(),
    enabled: z.boolean(),
    /** 归档时间戳（毫秒）：归档而非硬删，定义与记忆都不丢（Task 8 的 archive 写入）。 */
    archivedAt: z.number().int().nonnegative().optional(),
    provenance: teamAgentProvenanceSchema.optional(),
  })
  .strict();

export type TeamAgent = z.infer<typeof teamAgentSchema>;

/** 写入路径接受的形状：带 default 的字段（skills）可省略，由 schema 归一化后落盘。 */
export type TeamAgentInput = z.input<typeof teamAgentSchema>;
