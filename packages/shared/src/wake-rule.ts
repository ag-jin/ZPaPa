import { z } from "zod";

/* 唤醒规则（WakeRule）域模型（spec §3.5）：把「什么时候该唤醒谁」写成可校验的数据。
   本文件只做两件事——**形状**（schema）与**互斥**（validateWakeRule），不含调度、不含持久化：
   调度器（Task 5）按它决定 fire/skip/pause，Repo（Task 4）按它落盘与 CAS，
   两边共用这里的常量与校验，避免「同一枚举各写一份、悄悄漂移」。 */

/** kind 固定 4 种（spec §3.5 / 计划 Global Constraints）。键必须限死：
    kind 写错的规则永远不会被调度器捞出，等于配了一条死规则，而且没有任何报错。 */
export const WAKE_RULE_KINDS = ["event", "at", "every", "cron"] as const;
export type WakeRuleKind = (typeof WAKE_RULE_KINDS)[number];

/** mode 固定 2 种：`once` 只触发一次、`continuous` 反复触发。 */
export const WAKE_RULE_MODES = ["once", "continuous"] as const;
export type WakeRuleMode = (typeof WAKE_RULE_MODES)[number];

/** condition 固定 4 种（spec §3.5）。每种条件对应一条独立的聚合判定分支，
    多出一种就等于多一条没人实现的判定，所以是固定全集而不是自由字符串。 */
export const WAKE_CONDITION_TYPES = [
  "issue_field",
  "children_done",
  "pull_request",
  "other_issue",
] as const;
export type WakeConditionType = (typeof WAKE_CONDITION_TYPES)[number];

/** onTimeout 固定 2 种：到期后是补发一次唤醒（`wake`）还是就此作罢（`end`）。 */
export const WAKE_ON_TIMEOUTS = ["end", "wake"] as const;
export type WakeOnTimeout = (typeof WAKE_ON_TIMEOUTS)[number];

/** 暂停原因固定 3 种（spec §5.5 的三条防失控规则）。与 Task 5 的
    `WakeDecision = { action: "pause"; reason: "max_fires" | "rate" | "loop" }` 同源：
    两侧若各写一份字符串字面量，改名时会只改一边。 */
export const WAKE_PAUSE_REASONS = ["max_fires", "rate", "loop"] as const;
export type WakePauseReason = (typeof WAKE_PAUSE_REASONS)[number];

/* 防失控阈值（spec §5.5，硬规则不靠 prompt）。三个数必须与设计规格**逐字一致**：
   改了这里等于改了产品语义，所以提成常量而不是把 20/12/2 就地散落在实现里。 */
export const WAKE_DEFAULT_MAX_FIRES = 20;
export const WAKE_HOURLY_RUN_LIMIT = 12;
export const WAKE_LOOP_REPEAT_LIMIT = 2;

/** `maxFires` 的硬边界（spec §5.5「1–1000」）。注意上界 1000 是**硬规则**，
    与默认值 20 是两回事：默认值只是「没设时用 20」，上界是「设了也不许超过 1000」。 */
export const WAKE_MAX_FIRES_MIN = 1;
export const WAKE_MAX_FIRES_MAX = 1000;

/** 事件条件：`type` 固定 4 种；其余参数（如 `issue_field` 的字段名与期望值、
    `other_issue` 的目标项 id）随 type 而异，spec §3.5 未枚举，故**不预设键名**——
    预设会把合法参数当未知字段拒掉。这里用 `catchall(unknown)` 放行任意可选参数；
    「condition 只能挂在 event 上」这条穷尽性由 `validateWakeRule` 保证（见互斥第 3 条）。 */
export const wakeConditionSchema = z
  .object({ type: z.enum(WAKE_CONDITION_TYPES) })
  .catchall(z.unknown());
export type WakeCondition = z.infer<typeof wakeConditionSchema>;

/**
 * 唤醒规则。**strict**：未知字段直接拒绝（与 TeamAgent/Squad 一致，
 * 让「多写一个字段」无法静默落盘）。这里只保证形状，
 * 所有 **kind/mode 互斥**都放在 `validateWakeRule`——因为互斥要产出中文可读问题，
 * 而 zod 的报错是结构化的机器语言，人读不出「哪条规则口径打架」。
 */
export const wakeRuleSchema = z
  .object({
    id: z.string().min(1),
    workItemId: z.string().min(1),
    kind: z.enum(WAKE_RULE_KINDS),
    mode: z.enum(WAKE_RULE_MODES),
    /** 一次性唤醒的绝对时间点（epoch ms）：`kind: "at"` 必带，见互斥第 6 条。 */
    at: z.number().int().optional(),
    /** 间隔秒数：必须为正。0 或负数会让调度器每个 tick 都命中，等于无节制触发，
        属于结构性错误（不是「配置需要提醒」），故在 schema 层直接拒。 */
    intervalSeconds: z.number().positive().optional(),
    /** cron 表达式：空串不是表达式，且会被调度器当成「永不触发」而静默死掉，故非空。 */
    cronExpression: z.string().min(1).optional(),
    /** 时区：空白时区无意义（无法解析成偏移），故非空；未给则由调度器取默认时区。 */
    timezone: z.string().min(1).optional(),
    condition: wakeConditionSchema.optional(),
    /** 订阅的事件类型白名单（仅对 `kind: "event"` 有调度意义；非 event 携带由互斥⑧拒绝）。 */
    eventTypes: z.array(z.string().min(1)).optional(),
    /** 事件过滤器：键值对随事件源而异，spec 未枚举，故不预设形状，只要求是 JSON 对象。 */
    filters: z.record(z.string(), z.unknown()).optional(),
    /** 下一次应触发的时刻（epoch ms）：调度器扫表依据（Task 4 的部分索引建在这一列上）。 */
    nextFireAt: z.number().int().optional(),
    /** 触发次数上限。范围（`WAKE_MAX_FIRES_MIN..WAKE_MAX_FIRES_MAX`）由 `validateWakeRule`
        报中文问题，schema 只保证整数形状——若在这里就卡 1..1000，越界值会以 zod 原始报错抛出，
        用户拿不到「当前是多少、边界是多少」的可读提示。 */
    maxFires: z.number().int().optional(),
    fireCount: z.number().int().nonnegative().default(0),
    pausedReason: z.enum(WAKE_PAUSE_REASONS).optional(),
    /** 过期时刻（epoch ms，可选）。**域模型不做时间判定**：是否已过期要跟当前时间比，
        而校验必须是确定的纯函数（同一 rule 任何时候校验结果都一致），故语义留给调度器。 */
    expiresAt: z.number().int().optional(),
    onTimeout: z.enum(WAKE_ON_TIMEOUTS).optional(),
    /** 编辑版本号（fencing）：T4 的 CAS 用 `revision = expectRevision` 命中后 +1，
        所以默认从 0 起，且必须非负。 */
    revision: z.number().int().nonnegative().default(0),
    enabled: z.boolean().default(true),
  })
  .strict();

export type WakeRule = z.infer<typeof wakeRuleSchema>;

/** 校验结论：`ok:true` 之外只给中文可读的 `problems`，让 UI 直接把「哪里不行」说给人听。 */
export type WakeRuleValidationResult = { ok: true } | { ok: false; problems: string[] };

/* TODO(P2)：本阶段（P1）**故意留白**、只在域模型层无法判定的几处，集中登记在此，避免被当成漏检：
   1. `nextFireAt` 的 kind 约束：event 规则当前也允许带 `nextFireAt`（互斥清单未列，且 T4 的
      部分索引建在 `next_fire_at` 上，不排除「event 也参与排期扫描」的合法用法）。
   2. `timezone` 的 IANA 合法性：只校验非空（域模型不引入 tz 数据库依赖），非法时区名会留到调度器运行时才炸。
   3. `at` / `expiresAt` 已过去：需要与「当前时间」比较，而校验必须是确定的纯函数（同一 rule 任何时候结果一致），
      故域模型不做时间判定，由调度器（T5）按入参 `now` 判。
   4. `pausedReason` / `enabled` / `fireCount` **三者相互的一致性**（如 `fireCount >= maxFires` 就该带
      `pausedReason`、`fireCount > maxFires`、`once` 却 `fireCount > 0`、已带 `pausedReason` 但 `enabled` 仍为真）：
      属于防失控判定与状态机语义（T5 `decideWake`），域模型不重复实现。 */

/**
 * 唤醒规则的**互斥校验**（schema 管形状，这里管关系）。
 * 一次性收集全部问题而不是首错即返：人一次看到所有口径打架的地方，比来回改三轮快
 * （与 `validateSquad` 同风格）。
 */
export function validateWakeRule(rule: WakeRule): WakeRuleValidationResult {
  const problems: string[] = [];

  // 1. kind × mode 互斥：4×2 八格里被拒的三格（at/continuous、every/once、cron/once）在这里拦下
  //    `at` 是「到点唤醒一次」，配 continuous 要么被调度器忽略、要么在重复触发里失控；
  //    `every`/`cron` 是周期性排班，配 once 只触发一次就停，与排班语义直接矛盾。
  if (rule.kind === "at" && rule.mode !== "once") {
    problems.push(
      `kind「at」只能配 mode「once」（当前 mode「${rule.mode}」）：一次性到点唤醒没有「持续」的含义`,
    );
  }
  if ((rule.kind === "every" || rule.kind === "cron") && rule.mode !== "continuous") {
    problems.push(
      `kind「${rule.kind}」只能配 mode「continuous」（当前 mode「${rule.mode}」）：周期性排班触发一次就停，与排班语义矛盾`,
    );
  }

  // 2. event 不得携带任何调度字段：event 由事实驱动，排班字段永远不会被读取，
  //    配了等于静默死配置（还会让人以为「这个 event 规则会定时跑」）。
  //    字段集合必须与 spec §3.5 的「调度字段」一行**逐字对齐**：那里把 `timezone` 与
  //    `nextFireAt` 并列，**`timezone` 也是调度字段**，只查 at/intervalSeconds/cronExpression
  //    三项会让 `{kind:"event", timezone:"Asia/Shanghai"}` 零告警落盘——正是本类缺口要拦的死配置。
  //    注意 `timezone` **只对 event 禁**：三种排班 kind（at/every/cron）都要它来确定触发时刻的时区，
  //    故它不进互斥⑦（互斥⑦管的是 at/intervalSeconds/cronExpression 三者在 kind 间的互斥）。
  if (rule.kind === "event") {
    const schedulingFields: Array<[keyof WakeRule, unknown]> = [
      ["at", rule.at],
      ["intervalSeconds", rule.intervalSeconds],
      ["cronExpression", rule.cronExpression],
      ["timezone", rule.timezone],
    ];
    for (const [field, value] of schedulingFields) {
      if (value !== undefined) {
        problems.push(
          `kind「event」不得携带调度字段「${field}」：event 由事实驱动，该字段不会被读取`,
        );
      }
    }
  }

  // 3. condition 只能挂在 event 上：排班类规则没有可判定的事件事实，
  //    挂上去会让人以为「条件满足才跑」，实际是按时间跑，语义被悄悄改变。
  if (rule.kind !== "event" && rule.condition !== undefined) {
    problems.push(
      `condition 只能挂在 kind「event」上（当前 kind「${rule.kind}」）：排班类规则没有可判定的事件条件`,
    );
  }

  // 4. maxFires 只对 continuous 有意义（spec §5.5「连续规则默认上限 20」），且必须在 1..1000。
  if (rule.maxFires !== undefined) {
    if (rule.mode !== "continuous") {
      problems.push(
        `maxFires 只在 mode「continuous」时有效（当前 mode「${rule.mode}」）：一次性规则本就只触发一次，设上限说明 mode 写错了`,
      );
    }
    if (rule.maxFires < WAKE_MAX_FIRES_MIN || rule.maxFires > WAKE_MAX_FIRES_MAX) {
      problems.push(
        `maxFires 必须在 ${WAKE_MAX_FIRES_MIN}..${WAKE_MAX_FIRES_MAX} 之间（当前 ${rule.maxFires}）：低于下限等于永不触发，高于上限则防失控形同虚设（未设时默认 ${WAKE_DEFAULT_MAX_FIRES}）`,
      );
    }
  }

  // 5. onTimeout「wake」只在 event 上可用：其余 kind 到点本身就产生一次唤醒，
  //    「超时再唤醒」没有对象，写上去只会让人误以为还有一层兜底。
  if (rule.onTimeout === "wake" && rule.kind !== "event") {
    problems.push(
      `onTimeout「wake」只在 kind「event」时可用（当前 kind「${rule.kind}」）：其余 kind 到点本身就是一次唤醒`,
    );
  }

  // 6. 三种调度 kind 各自必须带上自己的字段。缺字段的规则会被调度器一直跳过，
  //    但「一直跳过」在界面上表现为「规则不生效」，不说清缺哪个字段就无从排查。
  if (rule.kind === "at" && rule.at === undefined) {
    problems.push(
      `kind「at」必须带「at」（绝对时间点）：缺了就不知道何时触发，规则会被调度器一直跳过`,
    );
  }
  if (rule.kind === "every" && rule.intervalSeconds === undefined) {
    problems.push(`kind「every」必须带「intervalSeconds」（间隔秒数）：缺了就没有周期`);
  }
  if (rule.kind === "cron" && rule.cronExpression === undefined) {
    problems.push(`kind「cron」必须带「cronExpression」（cron 表达式）：缺了就没有排班表达式`);
  }

  // 7. 调度字段不得跨 kind 混装：每种 kind 只认自己那一个调度字段。
  //    ② 只禁止 event 带调度字段、⑥ 只要求「本 kind 的字段必须带」，两条合起来仍留下盲区：
  //    `every` 同时带 intervalSeconds 与 cronExpression、`at` 带 intervalSeconds、`cron` 带 at
  //    这类**混装**会被无条件放行。两条调度口径同时存在时调度器只能任选其一，
  //    另一条就成了永不生效的死配置，且零告警——这正是本域模型要拦的「静默自相矛盾」。
  const ownSchedulingField: Partial<Record<WakeRuleKind, keyof WakeRule>> = {
    at: "at",
    every: "intervalSeconds",
    cron: "cronExpression",
  };
  const ownField = ownSchedulingField[rule.kind];
  if (ownField !== undefined) {
    for (const field of ["at", "intervalSeconds", "cronExpression"] as const) {
      if (field !== ownField && rule[field] !== undefined) {
        problems.push(
          `kind「${rule.kind}」不得携带调度字段「${field}」：本 kind 只认「${ownField}」，两种调度口径并存时「${field}」永不生效`,
        );
      }
    }
  }

  // 8. `eventTypes`/`filters` 与 `condition` 同构，只对 event 有调度意义（互斥③针对 condition，
  //    此条针对这两个订阅字段）：非 event 上它们不被任何调度路径读取，留着会让人以为
  //    「这条排班规则还会筛事件」，把实际行为理解错。
  if (rule.kind !== "event") {
    const eventOnlyFields: Array<[keyof WakeRule, unknown]> = [
      ["eventTypes", rule.eventTypes],
      ["filters", rule.filters],
    ];
    for (const [field, value] of eventOnlyFields) {
      if (value !== undefined) {
        problems.push(
          `kind「${rule.kind}」不得携带「${field}」：只有 kind「event」才消费事件订阅字段`,
        );
      }
    }
  }

  return problems.length === 0 ? { ok: true } : { ok: false, problems };
}
