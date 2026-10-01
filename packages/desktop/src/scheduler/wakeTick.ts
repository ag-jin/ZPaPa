import { computeEventKey, type WakePauseReason, type WakeRule } from "@zcode/shared";
import { computeNextRunAt, decideWake } from "@zcode/services/node";

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

export type WakeTick = { run: (now: number) => Promise<void> };

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

/**
 * 排期族的**锚点**（spec §5.7.1 (B) 末段：锚点归调度器，`computeEventKey` 只做格式化）。
 *
 * 定义并写死在这里：`eventKey = t:<名义时刻>`，而名义时刻取
 *   - `at`      ：`rule.at`（绝对时刻，规则自带，与「什么时候被发现」无关）；
 *   - `every`/`cron`：`rule.nextFireAt`（**持久化的**排期点，也就是 listReady 命中的那一格）。
 *
 * 为什么不取「调度器发现它的墙钟时刻 `now`」：同一格在重启后重算会落在不同的 `now` 上
 * （也可能是在休眠后补跑），算出**两个** eventKey，而去重是按 `(ruleId, revision, eventKey)`
 * 做的 —— 于是一次唤醒被当成两件事派发两次，**且不报错**。锚点必须是规则自己的排期字段。
 *
 * 缺名义时刻（排期 kind 却没有 at/nextFireAt）时**抛**：这时拼不出 key，静默换一个「随便什么值」
 * 只会把同一格拆成无数个新事实。
 */
export function nominalInstant(rule: WakeRule): number {
  if (rule.kind === "at") {
    if (rule.at === undefined) {
      throw new Error(
        `唤醒规则 ${rule.id} 是 kind=at 但没有 at：排期族的名时刻取自规则自带的排期字段，缺了就拼不出 eventKey`,
      );
    }
    return rule.at;
  }
  if (rule.nextFireAt === undefined) {
    throw new Error(
      `唤醒规则 ${rule.id}（kind=${rule.kind}）没有名义时刻（next_fire_at 为空）：` +
        "排期族的 eventKey 是 t:<名义时刻>，缺了它同一格每次都会算出不同的 key（去重静默失效）",
    );
  }
  return rule.nextFireAt;
}

/**
 * fire 之后的下一次到点时刻。
 *
 * `once` ⇒ null（不再到点：`listReady` 只取 `next_fire_at IS NOT NULL`，置空即终态）。
 * `continuous` ⇒ 推进到网格上的下一格，**网格锚点不动**：
 *   - `every`：`nominal + k*interval`（k ≥ 1 且严格晚于 now）。用整数倍步进而不是「按 now 对齐」，
 *     两件事同时成立：① 网格不漂移（重算永远落在同一串时刻上，eventKey 可复现）；
 *     ② 休眠/关机错过的窗口**不补跑**（顺延到下一格，与 automations 的 misfire-skip 同义）。
 *   - `cron`：表达式在 `now` 之后的下一次命中。cron 的**网格就是它命中的那些时刻**，
 *     所以「从 now 起算下一格」不会让网格漂移（重算永远落在同一串时刻上），同时还跳过
 *     已错过的窗口（不补跑）。`computeNextRunAt` 返回 null（无未来命中）时按终态处理，与 once 同义。
 *   - `event`：返回 null。事件由事实驱动，排期点是**事实侧**写进 next_fire_at 的；
 *     本层 fire 之后必须置空——否则下一轮 tick 会把同一条事实按新的 fireCount 再派一遍
 *     （一路派到撞上 `max_fires` 闸才停），下一条事实到来时再由事实侧重新写入。
 */
export function nextFireAtAfter(rule: WakeRule, now: number): number | null {
  if (rule.mode === "once") return null;
  switch (rule.kind) {
    case "every": {
      const intervalSeconds = rule.intervalSeconds;
      if (intervalSeconds === undefined) {
        throw new Error(
          `唤醒规则 ${rule.id} 是 kind=every 但没有 intervalSeconds：没有周期就没有下一格（validateWakeRule 本应拦住）`,
        );
      }
      const stepMs = intervalSeconds * 1_000;
      const nominal = nominalInstant(rule);
      const steps = Math.max(1, Math.ceil((now - nominal) / stepMs));
      return nominal + steps * stepMs;
    }
    case "cron": {
      const expression = rule.cronExpression;
      if (expression === undefined) {
        throw new Error(
          `唤醒规则 ${rule.id} 是 kind=cron 但没有 cronExpression：没有表达式就没有下一格（validateWakeRule 本应拦住）`,
        );
      }
      // 无未来命中（如表达式只覆盖过去的日历）⇒ null，按终态处理，与 once 同义。
      return computeNextRunAt(expression, now);
    }
    case "at":
      // `at` 只允许配 `once`（validateWakeRule 互斥第 1 条），连续语义在契约上不存在。
      throw new Error(
        `唤醒规则 ${rule.id} 是 kind=at 却要求推进（mode=${rule.mode}）：at 只允许 once（数据绕过了 validateWakeRule）`,
      );
    case "event":
      // 见函数头：事件规则的排期点归事实侧，这里必须置空（否则同一条事实会被反复派发到撞上闸）。
      return null;
  }
}

export function createWakeTick(deps: WakeTickDeps): WakeTick {
  const decide = deps.decide ?? decideWake;
  /** 已处理过的事实：`(ruleId, revision, eventKey)`（spec §3.9 的幂等键）。
      进程内内存集合，等价于「同一事实重投只 fire 一次」；持久去重表属 P2c。 */
  const handledFacts = new Set<string>();
  /** 各规则的**触发时刻**列表（rate 闸的最小实现：内存里的滚动一小时窗口）。
      为什么不落一张窗口表：本阶段只为让闸**真的会停**，而窗口的语义（滑过即自解）必须保住——
      单调递增的进程内计数会在人重新启用规则后立刻再暂停一次，与 §5.5「rate 等窗口滑过去就自解」矛盾。 */
  const firesByRule = new Map<string, number[]>();

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
    deps.advance(advanced(rule, { fireCount: rule.fireCount + 1, nextFireAt: nextFireAtAfter(rule, now) }));
    const workspace = deps.resolveWorkspace?.(rule) ?? null;
    // 提供了 resolver 却解析不到工作项 ⇒ **抛**（没有目标地址的派发比不派发更糟）：
    // 消息会在入口被 schema 丢掉，用户看到的是「到点了但什么都没发生」。
    if (workspace === null && deps.resolveWorkspace !== undefined) {
      throw new Error(
        `唤醒规则 ${rule.id} 的到点派发找不到所属工作项 ${rule.workItemId}：` +
          "派发目标由工作项给出（wake_rules 没有 workspace 列），解析不到就不能派发",
      );
    }
    deps.postRequest({
      ruleId: rule.id,
      workItemId: rule.workItemId,
      revision: rule.revision,
      eventKey,
      // 省略 resolver 时（测试替身）为空串：只验证「谁到点了、key 是什么」这一半。
      workspacePath: workspace?.workspacePath ?? "",
      ...(workspace?.workspaceIdentity !== undefined
        ? { workspaceIdentity: workspace.workspaceIdentity }
        : {}),
    });
  };

  return {
    async run(now) {
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
    },
  };
}
