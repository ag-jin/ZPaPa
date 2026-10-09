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

/**
 * `timeZone` 是否是**引擎认识的时区名**（G5：TODO-2 收口）。
 *
 * 用 `Intl.DateTimeFormat` 试构造：不认识的时区名会抛 `RangeError`，构造成功即认。
 * 三个理由：① **零新依赖**——本文件被 renderer 直接解析（见下方 SHA-256 段的同一条理由），
 * 引 tz 数据库（如 `luxon` / `moment-timezone`）会往浏览器包体里塞几十 KB；
 * ② **确定性纯函数**——同一输入恒同一结论，符合 `validateWakeRule` 的纯函数契约；
 * ③ 与将来接线 croner `timeZone` 选项时**同一个判据源**（同一个引擎的时区库），
 * 不会出现「域层放行、调度器却认不出」的两套口径。
 *
 * 注意它只判「这个名字引擎认不认」，**不判**该时区下某个时刻是否合法（那是调度器的事，
 * 与 TODO-3 同一条边界）：域模型不做时间判定。
 */
export function isValidTimeZoneName(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone });
    return true;
  } catch {
    return false;
  }
}

/* 域层留白登记（G5 收口，2026-10-09；原 TODO(P2) 四条在此轮各归其位）。
   留在这里的**只剩裁定不进域层的两条**——它们是「裁定」不是「漏检」，故理由随条目写清；
   已闭项留档在末尾，避免下一轮对账按旧结论排产。

   1. 【裁定不闭】`event` 允许携带 `nextFireAt`（不受 kind 约束）：事件规则的排期点是**事实侧**
      写进 `next_fire_at` 的（见 `wakeSchedule.ts` 的 event 分支：本模块对它返回 null，
      排期点由事实侧写入）。域层禁掉会堵死该写者；排班三支的排期状态改由服务/调度构造保证
      （死配置拒绝 + 两种暂停清排期），域层只补「暂停必有空排期」这一条状态约束（第 10 条）。
   2. 【裁定不闭】`fireCount >= maxFires ⇒ 必须带 pausedReason`（以及「带 `pausedReason` 但 `enabled`
      仍为真」）**不是**不变量：推进时同时写 `fireCount = maxFires` 与下一格排期，闸要到下一次到点
      才落原因——中间态合法且必要；「带原因 + 开关为真」正是闸暂停的法定形态。写成域约束会误伤
      合法态，故按裁定登记、不做校验。防失控判定属调度器 `decideWake`（T5），域模型不重复实现。

   已闭项（留档）：
   · `timezone` 的 IANA 合法性 —— 已闭于本文件 `isValidTimeZoneName` + 第 9 条；
   · `at` / `expiresAt` 已过去 —— 已闭于调度侧（G3：首格 `initialNextFireAt` 判、fire 前置守卫、
     网格收口 `nextFireAtAfter`）。域模型维持「不做时间判定」的纯函数契约（同一 rule 任何时候结论一致），
     故不在此处重复实现；
   · `fireCount > maxFires` / `once && fireCount > 1` / `pausedReason ⇒ 排期空` —— 已闭于第 10 条。
   仍开放：`event` kind 的服务面入口未开（G10 裁定，不属本文件）。 */

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

  // 9. timezone 必须是引擎认识的 IANA 名（G5：TODO-2 收口）。非空由 schema 保证，合法性只能在这里判
  //    （schema 层放不下「引擎认不认」这件事）。此前非法名会**零告警落盘**，等到将来调度器真的拿它
  //    去算触发时刻时才炸——用户看到的是「规则不生效」，而真正的成因（一个拼错的时区名）被完全隐藏。
  //    合法名（如 `Asia/Shanghai`）必须零问题：过度拦截会把能用的规则也拦在门外（见测试的补集方向）。
  if (rule.timezone !== undefined && !isValidTimeZoneName(rule.timezone)) {
    problems.push(
      `timezone「${rule.timezone}」不是合法的 IANA 时区名：引擎无法解析它，将来按它算触发时刻时会失败`,
    );
  }

  /* 10. 触发计数的三态一致性（G5：TODO-4 的三条**可闭项**）。三条都在查「库里的状态自相矛盾」，
     且都能只靠规则自身判定（不需要当前时间、不需要调度器状态），故属域层。
     边界一律取**严格大于 / 明确并存**：合法中间态必须零告警 —— `fireCount === maxFires`
     （停在上限、下一格已排、闸待下次到点才落原因）与 once 的 `fireCount === 1`（正常跑完）
     都是构造路径真的会产生的形态，写成 `>=` / `>= 1` 会误伤它们（用例已钉两个方向）。 */
  if (rule.maxFires !== undefined && rule.fireCount > rule.maxFires) {
    problems.push(
      `fireCount（${rule.fireCount}）已超过 maxFires（${rule.maxFires}）：超过上限还活着的规则说明防失控闸没有生效`,
    );
  }
  if (rule.mode === "once" && rule.fireCount > 1) {
    problems.push(
      `mode「once」的规则 fireCount 只能到 1（当前 ${rule.fireCount}）：一次性规则不该触发第二次，这是推进路径写错或 mode 写错的信号`,
    );
  }
  if (rule.pausedReason !== undefined && rule.nextFireAt !== undefined) {
    problems.push(
      `带 pausedReason「${rule.pausedReason}」的规则不得再有排期（当前 nextFireAt ${rule.nextFireAt}）：两种暂停形态都清空排期，暂停中还在排期只可能来自绕过构造路径的写入`,
    );
  }

  return problems.length === 0 ? { ok: true } : { ok: false, problems };
}

/* ------------------------------------------------------------------ *
 * `eventKey` 构造（spec §5.7.1）
 *
 * §3.9 的幂等键是 `(workItemId, ruleId, revision, eventKey)`，而 `eventKey` 此前**没有定义**。
 * 这是最危险的一类留白：不定义，接线方会就地拼串，**重复投递的事件静默重复触发**——不报错、
 * 看起来正常。故这里是**唯一构造器**：调度器与 Repo 都调它，不得各自拼串。
 *
 * 为什么它住在 shared 而不是 services：调度器（Task 3）与 Repo（Task 4）都要算它，
 * 而「同一事实必须算出同一个 key」这条只有在**同一份实现**下才成立。放进 services 会让
 * shared 侧的消费方（域模型的读者）反过来依赖 services。
 * ------------------------------------------------------------------ */

/**
 * 参与指纹前被**排除**的易变字段（spec §5.7.1 末段）。
 *
 * 这些字段记的是「这一次投递」的属性（第几次尝试、投递/接收时刻），不是**事实本身**的属性。
 * 不排除它们，同一件事重投两次会算出两个 key ⇒ 去重形同虚设（每次都当新事件处理）。
 *
 * 清单必须**同处声明**（就在本文件里）：spec 明确禁止在调用点就地过滤——那会让「哪些字段算易变」
 * 变成每个调用方各写一份的判断，而漏掉一处的表现是**静默重复触发**。
 * 排除按**键名**在所有层级生效：投递元数据常嵌在子对象里（`{ meta: { deliveryAttempt } }`）。
 */
export const EVENT_KEY_VOLATILE_FIELDS = [
  "deliveryAttempt",
  "deliveredAt",
  "deliveryTimestamp",
  "receivedAt",
] as const;

const VOLATILE_FIELD_SET: ReadonlySet<string> = new Set(EVENT_KEY_VOLATILE_FIELDS);

/** 统一的失败出口：文案带 `eventKey`，调用方（与测试）按它分因。 */
function eventKeyError(detail: string): Error {
  return new Error(`eventKey: ${detail}`);
}

/**
 * 规范化序列化（spec §5.7.1）：对象键按**码点升序**、数组**保序**、数字最简形式、字符串 JSON 转义。
 *
 * 为什么不能用 `JSON.stringify` 直接算指纹：它的输出依赖**属性插入顺序**
 * （`{a:1,b:2}` 与 `{b:2,a:1}` 是同一件事却得到两个指纹），而事件 payload 的键序随
 * 事件源、JSON 库版本而变 —— 同一件事于是被判成两件，去重静默失效。
 *
 * 不可规范化的值一律**抛**（不返回一个「看起来还行」的串）：`undefined` / 函数 / Symbol / BigInt /
 * 非有限数字 / 循环引用。其中 `undefined` 与非有限数字最阴：`JSON.stringify` 会把它们
 * **静默丢掉或写成 null**，让两个不同的事实撞成同一个指纹——那正是「重复触发且不报错」。
 */
function stableStringify(value: unknown, path: string, seen: Set<object>): string {
  if (value === null) return "null";
  switch (typeof value) {
    case "boolean":
      return value ? "true" : "false";
    case "number":
      if (!Number.isFinite(value)) {
        throw eventKeyError(`payload 含非有限数字（${path}），无法规范化`);
      }
      // 数字最简形式：JSON 的十进制最短表示（-0 → "0"，1e21 → "1e+21"）。
      return JSON.stringify(value);
    case "string":
      return JSON.stringify(value);
    case "object":
      break;
    default:
      throw eventKeyError(`payload 含不可规范化值（类型 ${typeof value}，${path}）`);
  }

  const container = value as object;
  if (seen.has(container)) {
    throw eventKeyError(`payload 含循环引用（${path}），无法规范化`);
  }
  // 同一对象在**不同分支**里出现两次是合法的（那不是环），所以进入时登记、离开时撤销。
  seen.add(container);
  try {
    if (Array.isArray(container)) {
      // 数组**保序**：`[1,2]` 与 `[2,1]` 是两个不同的事实，排序会把它俩抹成同一个 key。
      return `[${container
        .map((entry, index) => stableStringify(entry, `${path}[${index}]`, seen))
        .join(",")}]`;
    }
    const entries = Object.entries(container as Record<string, unknown>)
      .filter(([key]) => !VOLATILE_FIELD_SET.has(key))
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
    return `{${entries
      .map(
        ([key, entry]) =>
          `${JSON.stringify(key)}:${stableStringify(entry, `${path}.${key}`, seen)}`,
      )
      .join(",")}}`;
  } finally {
    seen.delete(container);
  }
}

/* SHA-256 的**纯 TypeScript 实现**（FIPS 180-4）。
 *
 * 为什么手写而不是 `import { createHash } from "node:crypto"`：本文件经
 * `packages/shared/src/index.ts` 的 `export *` 被 renderer 直接解析，而 shared 根入口
 * 迄今**零** `node:*` 可达模块（实测：从 index.ts 递归可达 173 个模块，违规 0 条）。
 * 加一条 `node:crypto` 会让整包在浏览器侧解析失败——现场表现是「页面停在启动壳、
 * 没有任何报错浮层」，极难定位。`crypto.subtle` 是异步的，而 `computeEventKey` 必须是同步纯函数
 * （去重键要在 tick 的同步判定里算出来），故不可用。
 *
 * 算法即标准 SHA-256，唯一目的是「确定、无依赖、跨进程一致」——不是给任何安全用途用的。 */
const SHA256_K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

function rotateRight(value: number, bits: number): number {
  return ((value >>> bits) | (value << (32 - bits))) >>> 0;
}

/* **导出仅供测试**（不是给生产用的 API，也不是给任何安全用途的）：
   这 70 行密码学实现若没有一份**外部对照**，将来改坏填充或某个轮常量时，仓内没有任何用例会变红
   （`computeEventKey` 的用例只比较 key 之间的相等/不等 —— 任何确定性函数都能通过）。
   但走 `computeEventKey` 的指纹族**无法**喂进空串与任意字节长度（先过 `stableStringify`，
   其输出恒非空、且形状受限），所以「空串 / 块边界 55·56·63·64 字节」这些向量在那里不可达。
   故把实现本身导出，让测试直接与 `node:crypto` 逐例比对（见 `packages/shared/test/wakeRuleSha256.test.ts`
   与 `packages/services/test/eventKey.test.ts` 的指纹族交叉比对）。
   它已在生产路径上被 `computeEventKey` 使用（唯一调用点），导出不改变任何行为。 */
export function sha256Hex(input: string): string {
  const data = new TextEncoder().encode(input);
  const bitLength = data.length * 8;
  // 填充：`1` 位 + `0` 位到 56 (mod 64) + 64 位大端长度。
  const paddedLength = data.length + 1 + ((56 - ((data.length + 1) % 64) + 64) % 64) + 8;
  const bytes = new Uint8Array(paddedLength);
  bytes.set(data, 0);
  bytes[data.length] = 0x80;
  const view = new DataView(bytes.buffer);
  // 长度按 64 位写；JS 数字精确到 2^53，故拆成高低两个 32 位字（够用到 PB 级输入）。
  view.setUint32(paddedLength - 8, Math.floor(bitLength / 0x100000000));
  view.setUint32(paddedLength - 4, bitLength >>> 0);

  const state = new Uint32Array([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ]);
  const schedule = new Uint32Array(64);

  for (let offset = 0; offset < paddedLength; offset += 64) {
    for (let index = 0; index < 16; index += 1) {
      schedule[index] = view.getUint32(offset + index * 4);
    }
    for (let index = 16; index < 64; index += 1) {
      const w15 = schedule[index - 15]!;
      const w2 = schedule[index - 2]!;
      const s0 = (rotateRight(w15, 7) ^ rotateRight(w15, 18) ^ (w15 >>> 3)) >>> 0;
      const s1 = (rotateRight(w2, 17) ^ rotateRight(w2, 19) ^ (w2 >>> 10)) >>> 0;
      schedule[index] = (schedule[index - 16]! + s0 + schedule[index - 7]! + s1) >>> 0;
    }

    let a = state[0]!;
    let b = state[1]!;
    let c = state[2]!;
    let d = state[3]!;
    let e = state[4]!;
    let f = state[5]!;
    let g = state[6]!;
    let h = state[7]!;
    for (let index = 0; index < 64; index += 1) {
      const s1 = (rotateRight(e, 6) ^ rotateRight(e, 11) ^ rotateRight(e, 25)) >>> 0;
      const ch = ((e & f) ^ (~e & g)) >>> 0;
      const temp1 = (h + s1 + ch + SHA256_K[index]! + schedule[index]!) >>> 0;
      const s0 = (rotateRight(a, 2) ^ rotateRight(a, 13) ^ rotateRight(a, 22)) >>> 0;
      const maj = ((a & b) ^ (a & c) ^ (b & c)) >>> 0;
      const temp2 = (s0 + maj) >>> 0;
      h = g;
      g = f;
      f = e;
      e = (d + temp1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (temp1 + temp2) >>> 0;
    }

    state[0] = (state[0]! + a) >>> 0;
    state[1] = (state[1]! + b) >>> 0;
    state[2] = (state[2]! + c) >>> 0;
    state[3] = (state[3]! + d) >>> 0;
    state[4] = (state[4]! + e) >>> 0;
    state[5] = (state[5]! + f) >>> 0;
    state[6] = (state[6]! + g) >>> 0;
    state[7] = (state[7]! + h) >>> 0;
  }

  return Array.from(state, (word) => word.toString(16).padStart(8, "0")).join("");
}

/** 事件事实：调度器从事件源归一化得到的「一件事」（spec §5.7.1 (A)）。 */
export type WakeEventFact = {
  /** 事件源（如 `github`）：进 identity，故两个来源的不同事实永不撞键。 */
  source: string;
  /** 事件类型（如 `issue.assigned`）：只在**指纹**族里进 identity（有稳定 id 时它不参与）。 */
  eventType: string;
  /** 事件源自带的**稳定 id**（如 GitHub `X-GitHub-Delivery`、`event.id`）。有则**首选**。 */
  externalId?: string | null;
  /** 事件完整负载：指纹用**完整 payload**，不是 `filters` 子集。 */
  payload?: unknown;
};

/** 排期事实：本次**应当触发的名义时刻**（epoch ms 整数），不是调度器发现它的墙钟时刻。 */
export type WakeScheduleFact = { scheduledFor: number };

export type WakeFact = WakeEventFact | WakeScheduleFact;

function readNonBlank(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw eventKeyError(
      `事件族必须有非空的 ${field}（实际 ${JSON.stringify(value)}）：缺了它算不出 identity，` +
        "只能拼出一个所有事件共用的 key（除第一件外全被去重吞掉）",
    );
  }
  return value;
}

/**
 * **唯一**的 `eventKey` 构造器（spec §5.7.1）。两族前缀不同 ⇒ 事件的第 N 次与排期的第 N 次永不撞键：
 *
 * - 事件族：`e:id:<source>:<externalId>`（有稳定 id 时优先）
 *   → `e:fp:<source>:<eventType>:<sha256(stableStringify(payload))>`（无稳定 id 时退用指纹）
 * - 排期族（`at` / `every` / `cron`）：`t:<scheduledFor>`
 *
 * `filters` / `eventTypes` / `revision` / `workItemId` **不参与**：前者判「是否匹配」，
 * 后两者已是幂等四元组的独立项（拼进来会让一次无关的规则编辑作废全部历史去重记录）。
 *
 * 排期族的「钉死锚点」不在本函数：名义时刻由调用方按网格算出后传入，本函数**只做格式化**
 * （锚点归调度器，见 spec §5.7.1 (B) 末段）。
 */
export function computeEventKey(rule: WakeRule, fact: WakeFact): string {
  if (rule.kind === "event") {
    const event = fact as WakeEventFact;
    const source = readNonBlank(event.source, "source");
    const stableId =
      typeof event.externalId === "string" && event.externalId.trim() !== ""
        ? event.externalId
        : undefined;
    if (stableId !== undefined) {
      return `e:id:${source}:${stableId}`;
    }
    const eventType = readNonBlank(event.eventType, "eventType");
    /* payload **缺失**按空负载归一（`?? null`，与显式 `null` 同键）。这是有意的：既没有稳定 id、
       又没有负载时，两件事之间**不存在任何可区分的信息**，「算作同一件」是唯一自洽的结论
       （换个 key 只会把同一批无法区分的事件重新当成新事实处理一遍）。
       它与「payload 里含不可规范化值」是两回事：后者**抛**（见 stableStringify），
       因为那说明负载本该有内容却写成了规范化不了的形式，静默丢字段会让两个不同事实撞键。 */
    // 无稳定 id 且 payload 不可规范化 ⇒ **抛**（不 fire）：不可去重的事件每次重投都会重复触发。
    return `e:fp:${source}:${eventType}:${sha256Hex(stableStringify(event.payload ?? null, "$", new Set()))}`;
  }

  const scheduledFor = (fact as WakeScheduleFact).scheduledFor;
  if (typeof scheduledFor !== "number" || !Number.isInteger(scheduledFor)) {
    throw eventKeyError(
      `排期族的 scheduledFor 必须是整数毫秒（实际 ${JSON.stringify(scheduledFor)}）：` +
        "非整数会让「同一格」每次算出不同的字符串，去重静默失效",
    );
  }
  return `t:${scheduledFor}`;
}
