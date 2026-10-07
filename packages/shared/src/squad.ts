import { z } from "zod";

/* Squad（小队）域模型（spec §3.3）：一支小队 = 一个队长 + 花名册 + 队长指令。
   与 TeamAgent 一样走 strict schema：未知字段直接拒绝，让「多写一个字段」无法静默落盘。 */

/* ------------------------------------------------------------------------------------------------
   看门狗六件套的**阈值单源**（用户 2026-10-07 裁定；全部在 shared，消费点不得写散值）。

   为什么必须单源：这些值同时被判定面（`squadWatchdog`）、执行面（host 启动和解 / tick）与派生
   SQL（熔断计数 / 重试预算）消费；任何一处就地写 30 / 10 / 5 / 24 都会立刻分叉，而分叉**不报错**
   —— 表现是「台账按 30 分钟收、Inbox 文案说 10 分钟」这类无人能复现的不一致。
   per-agent 覆盖字段在 `team-agent.ts`（`runTtlMinutes?` 等 + resolve helper），缺省值取这里的常量。
   ------------------------------------------------------------------------------------------------ */

/** `squad_runs.opened_at` 起算的单次墙钟上限（分钟）：超过即 `watchdog_ttl` 结算（根因②）。 */
export const DEFAULT_SQUAD_RUN_TTL_MINUTES = 30;
/** 会话活着但**静默**超此值（分钟）⇒ 先 stop 再等回调；宽限内无回调退回结算（根因①档 3）。 */
export const DEFAULT_SQUAD_IDLE_TIMEOUT_MINUTES = 10;
/** 工具看门狗的单次工具墙钟（分钟；W3 消费；R-1 已裁定按「降级 no-op + 留痕」交付时仅留痕）。 */
export const DEFAULT_SQUAD_TOOL_TIMEOUT_MINUTES = 5;
/**
 * **探测不可得**时的兜底墙钟（小时）：探针缺席时看门狗不猜会话状态，只按这个超长墙钟结算
 * （设计 §3.2 的退化路径）。取 24h 是为了「宁慢勿误杀」——探测不可得期间唯一可靠的事实是时间。
 */
export const DEFAULT_SQUAD_FALLBACK_WALL_CLOCK_HOURS = 24;
/** 失败重试预算（次）：每 (workItem,agent) 至多自动重试 `budget` 次——同对**另有**的看门狗族结算数
    达本值即不再登记重试（唯一消费点 `squadRuntimeService.registerWatchdogRetry` 把它注入派生计数判据）。
    本值必须**真实被读**：此前的判据是 EXISTS（隐含恒为 1），改这里一行不会改变任何行为 —— 文档与实现
    静默分叉，且分叉不报错（F1）。 */
export const SQUAD_RETRY_BUDGET = 1;
/** 熔断窗口（分钟）与阈值（次）：窗口内同 agent 的看门狗结算数达阈值 ⇒ 该 agent 熔断（W3）。 */
export const SQUAD_BREAKER_WINDOW_MINUTES = 30;
export const SQUAD_BREAKER_THRESHOLD = 3;

/** 分钟 / 小时的毫秒换算单源：消费点不得写 `* 60_000` 这类散值（阈值常量只在上方一处）。 */
export const MS_PER_MINUTE = 60_000;
export const MS_PER_HOUR = 3_600_000;

/** 队长指令的 8 个槽位：**固定全集**（spec §5.4 表）。
    写错槽位名等于指令静默丢失——队长会照旧派单，但派单规则其实是空的，所以键必须限定在这 8 个里。 */
export const SQUAD_INSTRUCTION_SLOTS = [
  "goal",
  "breakdown",
  "dispatch",
  "independence",
  "acceptance",
  "stopCondition",
  "reporting",
  "maxRounds",
] as const;
export type SquadInstructionSlot = (typeof SQUAD_INSTRUCTION_SLOTS)[number];

/** **必填**槽位：收手条件与轮次上限（spec §5.4 加粗两行）。
    队长没有终止条件时只有两种坏结局：早早停工等人催，或没完没了地派单直到撞上 `maxFires`（spec §5.4 末段）。 */
export const SQUAD_REQUIRED_INSTRUCTION_SLOTS = ["stopCondition", "maxRounds"] as const;

/** 成员条目：`agentId` 必须非空（空 id 的队员无法被派单，也认不出是谁）；`role` 是自由标签，可省。 */
export const squadMemberSchema = z.object({
  agentId: z.string().min(1),
  role: z.string().optional(),
});

/** 队长指令：键限定在 8 槽位内（写错键报错而非静默丢），但**允许缺键**。
    「缺哪些键算不合格」交给 `validateSquad` 而不是 schema：这里若要求齐 8 键，
    就没法只填一部分槽位后再按需补齐（spec §5.4「可按工作项覆盖」）。
    zod v4 的 `z.record(z.enum(...))` 是**穷尽**语义（8 键全必需），故用 `z.partialRecord`。 */
export const squadInstructionsSchema = z.partialRecord(z.enum(SQUAD_INSTRUCTION_SLOTS), z.string());

/**
 * 小队定义。**strict**：未知字段直接拒绝（如 `hostBinding`，单机运行不需要，决策 E）。
 * 注意：`leaderAgentId` 是否真的在 `members` 里、必填槽位是否真的填了，
 * 都**不在此处校验**，也不静默补齐——补齐是服务层（Task 2 的 create）的行为，schema 只保证形状。
 */
export const squadSchema = z
  .object({
    id: z.string().min(1),
    name: z.string(),
    description: z.string().optional(),
    leaderAgentId: z.string().min(1),
    /** 只要求非空名册，**不设名册上限**：spec §3.10 的「单小队并行队员 ≤ 6」是**并发**约束
        （一次同时跑几个），由派发侧执行，不是名册规模。在这里凭空加一条上限会拒绝合法的大名单。 */
    members: z.array(squadMemberSchema).min(1),
    instructions: squadInstructionsSchema,
    enabled: z.boolean(),
    /** 归档时间戳（毫秒）：归档而非硬删，花名册与指令都不丢。 */
    archivedAt: z.number().int().nonnegative().optional(),
  })
  .strict();

export type Squad = z.infer<typeof squadSchema>;

/** 校验结论：`ok:true` 之外只给中文可读的 `problems`，让 UI 能直接把「哪里不行」说给人听。 */
export type SquadValidationResult = { ok: true } | { ok: false; problems: string[] };

/** 空白（含纯空白）等于没写：队长仍拿不到终止条件，所以必填槽位按「非空」判定。 */
function isBlankInstruction(value: string | undefined): boolean {
  return value === undefined || value.trim() === "";
}

/**
 * 小队的**跨字段**校验（schema 管形状，这里管关系）。
 * 一次性收集全部问题而不是首错即返：人一次看到「缺哪个槽位 + 队长不在名册」比来回改三轮快。
 */
export function validateSquad(squad: Squad): SquadValidationResult {
  const problems: string[] = [];

  // 1. 队长必须同时是成员。spec §3.3 说「leader 自动作为成员」，本任务只校验、不静默补——
  //    否则调用方传错 leaderAgentId 会被悄悄「修好」，实际却没有这个人。
  if (!squad.members.some((member) => member.agentId === squad.leaderAgentId)) {
    problems.push(
      `leaderAgentId「${squad.leaderAgentId}」不在 members 中：队长必须同时是成员，否则「队长协调」没有承载者`,
    );
  }

  // 2. 同一 agentId 不得出现两次：重复会让花名册与派单出现两份，run 记账与记忆也会串。
  const seen = new Set<string>();
  const duplicated = new Set<string>();
  for (const member of squad.members) {
    if (seen.has(member.agentId)) {
      duplicated.add(member.agentId);
    }
    seen.add(member.agentId);
  }
  for (const agentId of duplicated) {
    problems.push(
      `members 中 agentId「${agentId}」重复：同一队员只能列一次，重复会让派单与花名册出现两份`,
    );
  }

  // 3. 必填槽位必须有非空值。
  for (const slot of SQUAD_REQUIRED_INSTRUCTION_SLOTS) {
    const value = squad.instructions[slot];
    if (value === undefined) {
      problems.push(`缺少必填指令槽位「${slot}」：缺了队长就没有终止条件，会一直派单或早早停工`);
    } else if (isBlankInstruction(value)) {
      problems.push(`必填指令槽位「${slot}」为空白：空白等于没写，队长仍无终止条件`);
    }
  }

  return problems.length === 0 ? { ok: true } : { ok: false, problems };
}
