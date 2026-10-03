import { computeEventKey, type WakePauseReason, type WakeRule } from "@zcode/shared";
import { decideWake, nominalInstant, nextFireAtAfter } from "@zcode/services/node";

/* 唤醒规则的**到点判定 + 派发请求构造**（spec §5.5 三道闸 / §5.7.1 eventKey / §3.9 幂等键）。

   为什么做成纯逻辑 + 依赖注入，而不是直接写在 scheduler/index.ts 里：
   `scheduler/index.ts` 是 electronUtilityProcess.fork 出来的入口（recon.md F4：路径基于
   `import.meta.dirname`，dev 与打包布局不同），一挂就再也没法在测试里跑。而这里要判的三件事
   全是**容易静默出错**的：闸该停却报 skip、eventKey 每次算出不同的值、重投被当成新事实。
   所以把它们做成可注入的纯逻辑，用 node:test 直接喂矩阵，而不是靠读调度器代码相信它。

   本层与既有 tick 的**分工**（与 cron 路径同形）：
   - 本层只做「认领到点的规则 → 判 → 推进 → 发一条薄的派发请求」。
   - 「派给谁、简报是什么、开不开工作树」全在 host 侧一处（wake_rules / work_items 的规划），
     调度器**不读小队定义**（那是文件、由服务层拥有）。 */

/** 一轮 tick 最多处理的到点规则数（repo 的 SQL LIMIT）。到点批次本该极小；
   限幅只为让「一次数据库异常」不至于拖住整个 tick。 */
export const WAKE_TICK_LIMIT = 100;

/** rate 闸的滚动窗口（spec §5.5「一小时内 run 次数 ≥ 12」）。阈值本身在 shared（`WAKE_HOURLY_RUN_LIMIT`），
   本层只提供窗口内的**计数**。 */
const WAKE_RATE_WINDOW_MS = 60 * 60_000;

/* 派发失败后的重投退避：与 off-peak 派发**逐项同形**（首重投 30s、每次翻倍、上限 15 分钟）。
   为什么不另立一套：邻居那条路已经把「瞬时失败要退避、确定性失败不空转」的取舍论证过了，
   两套参数会让同一类失败在两条路上有不同节奏，排查时先要确认差异来自实现还是参数。
   「无可用本地 host」「转发失败」「库未就绪」都是**瞬时**的：真机上它会在用户开窗口后自愈，
   所以必须重投 —— 不重投就等于这次唤醒被静默吞掉（规则已被 CAS 推进，那一格再也推不出来）。 */
const WAKE_DISPATCH_RETRY_BASE_MS = 30_000;
const WAKE_DISPATCH_RETRY_CAP_MS = 15 * 60_000;

/**
 * 未被结算的重投记录的最长存活时间（**TTL**，从首次发出的那一刻算起）。
 *
 * 为什么必须有它：重投表的键是 `(ruleId, eventKey)`，而排期族每个网格点都算出**新的** eventKey
 * ⇒ 只要「本机没有 host / 回执不来」持续，表就会**每格新增一条永不删除的记录**（无 TTL、无上限、无淘汰）。
 * 它按事件数增长，而对照的 off-peak 退避表按**任务 id**（任务集固定）⇒ 「同形」在这一点上不成立。
 * 所以要给它一个上界，并让「已发出但永不撤下」不再可能。
 *
 * 为什么取 1 小时（与退避参数的关系）：退避从 30s 起翻倍、封顶 15min，
 *   attempt 1..6 = 30s → 60 → 120 → 240 → 480 → 900(封顶)，累计约 **30.5 分钟**才爬到帽子。
 *   TTL 必须**严格大于**这段「退避爬升时间」，否则会在退避仍有增长空间时就放弃；
 *   取 1 小时 ≈ 2× 爬升时间，让退避爬到 15min 后还能在帽子上再试一两轮。
 *   1 小时也正好是 spec §5.5 速率闸窗口（`WAKE_HOURLY_RUN_LIMIT` / 一小时）的同一量级：
 *   「一小时里本机始终没有 host / 回执始终不来」已足够判定这次唤醒没有落地。
 *   反过来若 TTL=30min（≈爬升时间），会在退避刚封顶（或还没封顶）时淘汰 —— 见上面为什么不行。
 *
 * 到期后的归宿：**响亮放弃**（从表里删除、由调度器入口打 error 日志），而不是像基线那样永久占位。
 * 不选择「到期重投」：请求可能仍在途，重投会与在途的那次**双跑**（同一 traceId 在下游没有去重保证），
 * 静默双跑比响亮放弃糟得多。
 *
 * 最坏条数口径（表有多大）：稳定态下活记录数 ≈ `(TTL / 最小排期间隔) × 规则数`。
 *   它**有限**（每个网格点至多一条、每条至多活一个 TTL），但可能**偏大**：间隔取最小（如 every 1 分钟
 *   ⇒ 1h/1min=60 条/规则），规则数一多，表仍可能到几百条。这是「**有界**（不再随派发次数无界增长）
 *   与「低开销」之间的取舍：每条只是一份薄请求 + 几个数字，淘汰是一次 O(表大小) 扫描。
 *   若未来规则规模上去，再考虑把它下沉成带 TTL 的持久表（P2c）。
 */
export const WAKE_DISPATCH_PENDING_TTL_MS = 60 * 60_000;

/** 事件的 source 维度（spec §5.7.1：两个来源的不同事实永不撞键）。规则唤醒的事实源固定是「小队调度」。 */
const WAKE_EVENT_SOURCE = "squad";

/** 派发请求（**薄**）：只带「哪条规则到点了」，不带 agentId / briefing / prompt。 */
export type WakeDispatchRequest = {
  ruleId: string;
  workItemId: string;
  /** 四元组里的 revision（fencing：过期 revision 的派发自动作废，spec §5.7.1）。 */
  revision: number;
  /** 由唯一构造器 `computeEventKey` 产出（本层不得就地拼串）。 */
  eventKey: string;
  workspacePath: string;
  workspaceIdentity?: string;
};

/** `advance` 里的改动（内部按它算出「推进后的规则快照」）。 */
export type WakeAdvancePatch = {
  fireCount?: number;
  nextFireAt?: number | null;
  pausedReason?: WakePauseReason;
};

/** main → 本层的派发结果。`(ruleId, eventKey)` 是重投表的键 —— 少任何一维都会把两条规则的
    重投记录并成一条（`eventKey` 里没有 ruleId，同一工作项上两条规则可以算出同一个 key）。 */
export type WakeDispatchResult = {
  ruleId: string;
  eventKey: string;
  ok: boolean;
  failureKind?: "transient" | "permanent" | "deferred";
  error?: string;
};

/**
 * `settle` 的结论（由调度器入口翻成日志 —— 判定留在这里，措辞留在那一处）。
 *
 * - `settled`：派发成功，撤下重投记录。
 * - `abandoned`：确定性失败（门禁关闭 / 运行时未注册 / 队员开树失败）：重试不会自愈，**不**重投。
 * - `retry`：瞬时失败或等待型（绑定会话忙），已排定下一次重投。
 * - `unknown`：`(ruleId, eventKey)` 不在重投表里（重启后的迟到回执 / 从未发出）：只留痕。
 */
export type WakeSettlementOutcome =
  | { kind: "settled" }
  | { kind: "abandoned"; error?: string }
  | {
      kind: "retry";
      attempts: number;
      retryInMs: number;
      failureKind: "transient" | "deferred";
      error?: string;
    }
  | { kind: "unknown" };

/**
 * **推进后的**规则快照（交给 `advance`）。
 *
 * 与 `WakeRule` 的差别只有一处：`nextFireAt` 允许 `null` —— 「不再到点」在域模型里是**缺省**（`undefined`），
 * 而在推进这条路径上 `null` 是明确的终态（once 触发完 / 闸命中停下来），必须能与「没动过」区分开。
 * 形状（第一个参数带 `pausedReason`）由用例钉住：§5.5 要求闸命中时 pausedReason 落到规则上。
 */
export type WakeAdvancedRule = Omit<WakeRule, "nextFireAt" | "pausedReason"> & {
  nextFireAt: number | null;
  pausedReason?: WakePauseReason;
};

/** 规则所属工作项的 workspace 绑定：`wake_rules` 表**没有** workspace 列，派发目标只能由工作项给出。 */
export type WakeWorkspace = { workspacePath: string; workspaceIdentity?: string };

export type WakeTickDeps = {
  /** 到点规则（repo 按 `next_fire_at <= now` 扫，ORDER BY next_fire_at, id）。 */
  listReady: (now: number, limit: number) => WakeRule[];
  /**
   * 解析规则所属工作项的 workspace 绑定。
   *
   * **生产接线必填**：省略只用于测试替身（那时请求里的 workspacePath 为空串）。
   * 提供了却返回 null（工作项已被删/从未写入）⇒ **抛**：派发请求没有目标地址就等于
   * 「到点了但什么都没发生」，静默发一条空地址的消息更糟（它会在入口被 schema 丢掉，且没有日志）。
   */
  resolveWorkspace?: (rule: WakeRule) => WakeWorkspace | null;
  /**
   * 推进规则（调度器侧落成 `WakeRuleRepo.casAdvance`：单条条件 UPDATE + revision fencing）。
   *
   * 收到的是**推进后的规则快照**（`revision` 仍是本轮读到的那一版 —— 它就是 CAS 的 expectRevision）：
   * 形状由用例钉住，闸命中时它必须带 `pausedReason`（§5.5 要求「停下来了」这件事落到规则上，
   * 界面上才看得出来），而同一处也就能看到推进后的 `nextFireAt`/`fireCount`。
   */
  advance: (rule: WakeAdvancedRule) => void;
  postRequest: (request: WakeDispatchRequest) => void;
  /** 判定函数（默认 `decideWake`）。做成可注入只为让「skip 分支」也能被断言。 */
  decide?: (input: Parameters<typeof decideWake>[0]) => ReturnType<typeof decideWake>;
};

/**
 * 一轮 tick 里**被 TTL 淘汰**的重投记录（只有 `run` 产出；措辞由调度器入口翻成日志 ——
 * 与 `WakeSettlementOutcome` 同一条约定：判定留在这里，措辞留在那一处）。
 *
 * 为什么要有这条出口：「已发出但回执始终不来」的条目必须**有归宿**。没有它，条目只会
 * 永久挂在表里（既不重投也不清理、静默消失）；有了它，入口能打一条可见的 error 日志。
 */
export type WakePendingEviction = {
  ruleId: string;
  eventKey: string;
  /** 从首次发出到被淘汰经历的毫秒数（≥ TTL）。 */
  pendingForMs: number;
  /** 在这段期间收到的失败回执次数：0 ⇒ 从未收到任何回执（host/main 中途退出的形态）。 */
  attempts: number;
};

export type WakeTick = {
  /** 一轮 tick：先淘汰过 TTL 的那批，再重投到期的那批，最后处理本轮到点的规则。
      返回本轮**被淘汰**的记录（可能为空）—— 由调度器入口打日志留痕。 */
  run: (now: number) => Promise<WakePendingEviction[]>;
  /** 结算一条派发结果（main 侧回执）。返回结论，由调度器入口决定怎么留痕。 */
  settle: (result: WakeDispatchResult, now: number) => WakeSettlementOutcome;
};

/** `eventKey` 的**唯一**构造入口（spec §5.7.1）：任何地方都不得就地拼串。 */
export function buildWakeEventKey(rule: WakeRule): string {
  if (rule.kind === "event") {
    // 事件族：事实 = 「同一条规则的第 N 次」。(workItemId, revision, fireCount) 是这件事的规范表示：
    // 同一格重算必得同一个 externalId ⇒ 同一个 `e:id:...`。
    // eventType / payload 在给出 externalId 时不参与指纹（computeEventKey 在此提前返回），
    // 但 `WakeEventFact` 的类型要求它们在场——「有稳定 id 的事件」本来就该同时有类型与负载。
    return computeEventKey(rule, {
      source: WAKE_EVENT_SOURCE,
      externalId: `${rule.workItemId}:${rule.revision}:${rule.fireCount}`,
      eventType: rule.kind,
      payload: {},
    });
  }
  // 排期族：名义时刻**只能**取自规则自带的持久化排期字段（锚点定义见 nominalInstant）。
  return computeEventKey(rule, { scheduledFor: nominalInstant(rule) });
}

/* `nominalInstant`（排期族锚点）与 `nextFireAtAfter`（fire 后的下一格）已**整体搬入**
   `@zcode/services/node`（`workitem/wakeSchedule.ts`，逐字未改）：服务面
   （`createWakeRule` / `resumeWakeRule`）也要用同一份排期计算，而依赖方向只允许 desktop → services。
   **不得在本文件里再定义一份** —— 两份实现会让「建出来的规则」与「调度器推进的网格」静默漂移
   （同一格算出两个名义时刻，eventKey 去重静默失效）。源码守卫见
   `packages/desktop/test/schedulerWiring.test.ts`（`wakeTick 不得再定义排期计算`）。
   这里**原样再导出**（新增消费方仍可从本模块取，导出面与搬运前一致），实现不在此处。 */
export { nominalInstant, nextFireAtAfter };

export function createWakeTick(deps: WakeTickDeps): WakeTick {
  const decide = deps.decide ?? decideWake;
  /** 已处理过的事实：`(ruleId, revision, eventKey)`（spec §3.9 的幂等键）。
      进程内内存集合，等价于「同一事实重投只 fire 一次」；持久去重表属 P2c。 */
  const handledFacts = new Set<string>();
  /** 各规则的**触发时刻**列表（rate 闸的最小实现：内存里的滚动一小时窗口）。
      为什么不落一张窗口表：本阶段只为让闸**真的会停**，而窗口的语义（滑过即自解）必须保住——
      单调递增的进程内计数会在人重新启用规则后立刻再暂停一次，与 §5.5「rate 等窗口滑过去就自解」矛盾。 */
  const firesByRule = new Map<string, number[]>();
  /* **已请求但未结算**的唤醒：`(ruleId, eventKey)` → 重投上下文。
     为什么必须有这张表：`fire()` 是 advance-before-post（先 CAS 推进、再发请求，顺序有理由），
     所以**一旦发出请求，那一格就再也推不出来了**（next_fire_at 已经前进，listReady 不会再给）。
     若瞬时结果（本机没有 host / 转发失败 / 库未就绪）就此丢弃，这次唤醒就永远消失 ——
     而邻居两条路（cron / off-peak）都有退避重投。本表把「已请求未结算」记下来，按退避重投**同一条**
     请求（同一个 `(ruleId, eventKey)`，正是 §3.9 幂等键要的「同一格重投算同一件事」）。
     进程内（与 off-peak 的退避表同形）：调度器重启即丢，那一格由重启后的规则排期接管，不假装能补。
     `postedAt` 是 TTL 的起点（首次发出的时刻）：**不因重投而刷新** —— 刷新会让重投循环永不淘汰，
     又回到无界；不刷新则「一条记录最多活 `WAKE_DISPATCH_PENDING_TTL_MS`」。 */
  const pending = new Map<
    string,
    { request: WakeDispatchRequest; attempts: number; retryAt: number | null; postedAt: number }
  >();
  const pendingKey = (ruleId: string, eventKey: string): string => `${ruleId}\u0000${eventKey}`;

  const recentFireCount = (ruleId: string, now: number): number => {
    const fires = firesByRule.get(ruleId) ?? [];
    const windowStart = now - WAKE_RATE_WINDOW_MS;
    const recent = fires.filter((at) => at > windowStart);
    if (recent.length !== fires.length) firesByRule.set(ruleId, recent);
    return recent.length;
  };

  /** 把 patch 并进规则，得到「推进后的快照」。`pausedReason` 显式随 patch 走：
      不带 patch 的那次推进要把上一条陈旧原因清掉（casAdvance 落库时也是 `?? null`）。 */
  const advanced = (rule: WakeRule, patch: WakeAdvancePatch): WakeAdvancedRule => ({
    ...rule,
    fireCount: patch.fireCount ?? rule.fireCount,
    nextFireAt: patch.nextFireAt ?? null,
    pausedReason: patch.pausedReason,
  });

  /** fire 的三步：记事实 → 推进（CAS 落盘）→ 发薄请求。 */
  const fire = (rule: WakeRule, eventKey: string, factKey: string, now: number): void => {
    // 顺序有理由：先推进（落盘）再发请求，反过来会在「已发出、未推进」之间留下重复窗口
    // （崩溃/重启后同一格会被再判一次 fire）。
    handledFacts.add(factKey);
    firesByRule.set(rule.id, [...(firesByRule.get(rule.id) ?? []), now]);
    deps.advance(
      advanced(rule, { fireCount: rule.fireCount + 1, nextFireAt: nextFireAtAfter(rule, now) }),
    );
    const workspace = deps.resolveWorkspace?.(rule) ?? null;
    // 提供了 resolver 却解析不到工作项 ⇒ **抛**（没有目标地址的派发比不派发更糟）：
    // 消息会在入口被 schema 丢掉，用户看到的是「到点了但什么都没发生」。
    if (workspace === null && deps.resolveWorkspace !== undefined) {
      throw new Error(
        `唤醒规则 ${rule.id} 的到点派发找不到所属工作项 ${rule.workItemId}：` +
          "派发目标由工作项给出（wake_rules 没有 workspace 列），解析不到就不能派发",
      );
    }
    const request: WakeDispatchRequest = {
      ruleId: rule.id,
      workItemId: rule.workItemId,
      revision: rule.revision,
      eventKey,
      // 省略 resolver 时（测试替身）为空串：只验证「谁到点了、key 是什么」这一半。
      workspacePath: workspace?.workspacePath ?? "",
      ...(workspace?.workspaceIdentity !== undefined
        ? { workspaceIdentity: workspace.workspaceIdentity }
        : {}),
    };
    deps.postRequest(request);
    // 请求已经发出 ⇒ 记进重投表（还没有到期重投：retryAt=null，等回执说失败才排期）。
    // postedAt 是 TTL 起点（这次就是「首次发出」）。
    pending.set(pendingKey(rule.id, eventKey), {
      request,
      attempts: 0,
      retryAt: null,
      postedAt: now,
    });
  };

  /**
   * TTL 淘汰：**任何**状态（在等回执 / 已排定重投）的记录，只要从首次发出起已过 TTL，
   * 一律撤下并作为「被淘汰」交回入口留痕。
   *
   * 这一格同时关掉两个洞：
   * ① 「本机无 host」持续 ⇒ 每个网格点新增的记录都会在 TTL 后被淘汰，表不再无界增长；
   * ② 「已发出但回执始终不来」（`retryAt` 恒 null ⇒ 既不被重投也不被清理）⇒ 到 TTL 被**响亮放弃**，
   *    不再静默占位、也不再需要「永不撤下」。
   */
  const evictExpired = (now: number): WakePendingEviction[] => {
    const evicted: WakePendingEviction[] = [];
    for (const [key, entry] of pending) {
      const pendingForMs = now - entry.postedAt;
      if (pendingForMs < WAKE_DISPATCH_PENDING_TTL_MS) continue;
      pending.delete(key);
      evicted.push({
        ruleId: entry.request.ruleId,
        eventKey: entry.request.eventKey,
        pendingForMs,
        attempts: entry.attempts,
      });
    }
    return evicted;
  };

  /** 重投到期的那些（退避已过）：它们的规则早被 CAS 推进过，所以**不会**出现在本轮 listReady 里。 */
  const repostDue = (now: number): void => {
    for (const [key, entry] of pending) {
      if (entry.retryAt === null || entry.retryAt > now) continue;
      // 先清 retryAt 再发：发出去到收到回执之间若又跑一轮 tick，不该把同一条重复发第二遍。
      // postedAt 保持不变：TTL 仍从**首次**发出算起，重投不延长寿命。
      pending.set(key, { ...entry, retryAt: null });
      deps.postRequest(entry.request);
    }
  };

  return {
    async run(now) {
      // 先淘汰过 TTL 的那批（无条件：无论它在等回执还是已排定重投）。
      const evicted = evictExpired(now);
      // 再重投到期的那批（它们不在 listReady 结果里：规则已被 CAS 推进）。
      repostDue(now);
      // 规则之间的处理顺序由 repo 的 ORDER BY 保证（next_fire_at, id），本层不再排序。
      for (const rule of deps.listReady(now, WAKE_TICK_LIMIT)) {
        const eventKey = buildWakeEventKey(rule);
        const factKey = `${rule.id}\u0000${rule.revision}\u0000${eventKey}`;
        const decision = decide({
          rule,
          // 规则 tick 起 run 是自动派发（不是用户点「现在就跑」），故三道闸一律要判（spec §5.2）。
          manual: false,
          recentFireCount: recentFireCount(rule.id, now),
          // run 链的重复计数需要事件源侧的链上下文；本层恒为 1（< 阈值 2 ⇒ 不会误报 loop）。
          chainRepeatCount: 1,
          hasPendingSameEvent: handledFacts.has(factKey),
          // 「全部输入都出自被唤醒者自己」要事件源提供来源信息（P2c）；本层恒 false。
          allInputsFromSelf: false,
        });

        if (decision.action === "skip") {
          // skip 是**瞬时结论**（spec §5.5）：不推进、不发请求。下一轮同一事实仍在，还是 skip。
          continue;
        }

        if (decision.action === "pause") {
          // 闸命中：只把「停下来了」落到规则上（§5.5 硬规则不靠 prompt），**不发**派发请求。
          deps.advance(advanced(rule, { pausedReason: decision.reason, nextFireAt: null }));
          continue;
        }

        fire(rule, eventKey, factKey, now);
      }
      return evicted;
    },

    settle(result, now) {
      const key = pendingKey(result.ruleId, result.eventKey);
      const entry = pending.get(key);
      if (!entry) {
        // 迟到的回执（重启后 / 从未发出）：只留痕，不当成失败，更不重投一条来路不明的请求。
        return { kind: "unknown" };
      }
      if (result.ok) {
        pending.delete(key);
        return { kind: "settled" };
      }
      if (result.failureKind !== "permanent") {
        // 瞬时失败与等待型（绑定会话忙）都重投：两者都会自愈（用户开窗口 / 会话跑完）。
        // 未标 failureKind 的失败按 transient 处理（与 cron 的 `msg.failureKind ?? "transient"` 同口径）。
        // 重投的是**同一条**请求 ⇒ 同一个 `(ruleId, eventKey)`（§3.9：同一格重投算同一件事）。
        const attempts = entry.attempts + 1;
        const backoff = Math.min(
          WAKE_DISPATCH_RETRY_BASE_MS * 2 ** Math.max(0, attempts - 1),
          WAKE_DISPATCH_RETRY_CAP_MS,
        );
        pending.set(key, { ...entry, attempts, retryAt: now + backoff });
        return {
          kind: "retry",
          attempts,
          retryInMs: backoff,
          failureKind: result.failureKind === "deferred" ? "deferred" : "transient",
          ...(result.error !== undefined ? { error: result.error } : {}),
        };
      }
      // permanent：门禁关闭 / 运行时未注册 / 队员开树失败 —— 重试不会自愈，撤下记录不再空转。
      pending.delete(key);
      return { kind: "abandoned", ...(result.error !== undefined ? { error: result.error } : {}) };
    },
  };
}
