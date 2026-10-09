import type { WakeRule } from "@zcode/shared";
import { computeNextRunAt } from "../session/automationCron.js";

/* 唤醒规则的**排期计算核心**（`nominalInstant` / `nextFireAtAfter`，spec §5.7.1 (B) / §6.6 第 3 项）。

   为什么住在 services 而不是调度器（desktop）：本文件是「调度网格」的**唯一一份**实现，
   而它现在有两个消费面 ——
   ① 调度器（desktop `scheduler/wakeTick.ts`）：fire 后推进到下一格；
   ② 服务面（`squadWakeRules.ts`）：`createWakeRule` / `resumeWakeRule` 建出的**第一条**排期点。
   依赖方向只允许 `desktop → services`（反向会让 services 触达 Electron / 调度进程入口），
   而「同一份实现」这条只有在**源代码只有一处**时才成立：两边各写一份的计算迟早漂移，
   而漂移的表现是「建出来的规则与调度器推算的网格对不上」—— 不报错，只是同一格算出两个名义时刻
   （eventKey 去重静默失效，见 §5.7.1）。故本文件由 `wakeTick.ts` **整体搬入**（逐字未改），
   调度器改为从 `@zcode/services/node` 导入；`computeNextRunAt` 本就在 services（automationCron）。

   本文件是**浏览器安全**的（只 import `@zcode/shared` 的类型与本地 `croner` 封装，不触达 `node:*`）：
   服务面（`squadRuntimeService.ts`，经根入口被 renderer 解析）要值导入它。 */

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
 * **到期点收口**（G3）：算出的下一格若不早于 `expiresAt`，就没有下一格（返回 null = 终态）。
 *
 * 边界语义钉死在这里、只用一份实现：**触发时刻必须严格早于 `expiresAt`** ⇒ `next >= expiresAt`
 * 即终态。写成 `>` 会让「到点时刻恰等于到期点」的那一格仍然触发，与「过期时刻之后不再唤醒」
 * 直接矛盾；写成每次调用点各判一次，三个消费方（create 首格 / resume 首格 / fire 推进）迟早漂移。
 *
 * 为什么是**终态**而不是「跳过这一格继续往后排」：后者会让规则永远留在表里、每格判一次、
 * 永远不派发 —— 正是域模型要消灭的静默死配置形态。置空排期后 `listReady`
 * （`next_fire_at IS NOT NULL`）不再命中它，规则干净地停在到期点上。
 *
 * 注意这**不是闸**：到期不写 `pausedReason`（那是防失控闸的专列）、不动 `enabled`（用户启停）——
 * 「到点了」与「被停下来了」是两件可分辨的事。
 */
function cutAtExpiry(rule: WakeRule, next: number | null): number | null {
  if (next === null) return null;
  if (rule.expiresAt !== undefined && next >= rule.expiresAt) return null;
  return next;
}

/**
 * fire 之后的下一次到点时刻。
 *
 * `once` ⇒ null（不再到点：`listReady` 只取 `next_fire_at IS NOT NULL`，置空即终态）。
 * `continuous` ⇒ 推进到网格上的下一格，**网格锚点不动**：
 *   - `every`：`nominal + k*interval`（k ≥ 1 且**严格晚于 now**；now 恰好落在网格点上时取下一格，
 *     不返回 now 自己 —— 见下面步长计算的注释）。用整数倍步进而不是「按 now 对齐」，
 *     两件事同时成立：① 网格不漂移（重算永远落在同一串时刻上，eventKey 可复现）；
 *     ② 休眠/关机错过的窗口**不补跑**（顺延到下一格，与 automations 的 misfire-skip 同义）。
 *   - `cron`：表达式在 `now` 之后的下一次命中。cron 的**网格就是它命中的那些时刻**，
 *     所以「从 now 起算下一格」不会让网格漂移（重算永远落在同一串时刻上），同时还跳过
 *     已错过的窗口（不补跑）。`computeNextRunAt` 返回 null（无未来命中）时按终态处理，与 once 同义。
 *   - `event`：返回 null。事件由事实驱动，排期点是**事实侧**写进 next_fire_at 的；
 *     本层 fire 之后必须置空——否则下一轮 tick 会把同一条事实按新的 fireCount 再派一遍
 *     （一路派到撞上 `max_fires` 闸才停），下一条事实到来时再由事实侧重新写入。
 *
 * **到期点**（`expiresAt`，G3）：`every` / `cron` 算出的下一格都要过 `cutAtExpiry` ——
 * 不早于到期点即终态（null）。`once` / `event` 本就返回 null，判定不改变它们的语义。
 *
 * 调用注意（服务面 `createWakeRule` / `resumeWakeRule`）：本函数按 `mode === "once"` 提前返回 null，
 * 那是**触发之后**的终态语义 —— 对「尚未触发」的一次性规则同样返回 null，故首格排期不能直接取本函数
 * 的返回值（`at` 的名义时刻就是 `at` 本身，见 `squadWakeRules.initialNextFireAt`）。
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
      /* 严格晚于 now 的**同一网格点**：`floor(...) + 1` 而不是 `ceil(...)`。
         用 `ceil` 时 now 恰好落在网格点上（now = nominal + k*step）会算出 `now` 自己，
         与「推进到下一格」矛盾：那一格要多留一拍才发现到点，而且下一格的 eventKey 会指向
         刚刚 fire 过的名义时刻。`Math.max(1, …)` 只兜 now < nominal 这种不该出现的输入
         （生产路径上 listReady 只取 `next_fire_at <= now`），保证步数恒 ≥ 1。 */
      const steps = Math.max(1, Math.floor((now - nominal) / stepMs) + 1);
      // 网格算完再过到期点收口（G3）：越过到期点的下一格不存在。
      return cutAtExpiry(rule, nominal + steps * stepMs);
    }
    case "cron": {
      const expression = rule.cronExpression;
      if (expression === undefined) {
        throw new Error(
          `唤醒规则 ${rule.id} 是 kind=cron 但没有 cronExpression：没有表达式就没有下一格（validateWakeRule 本应拦住）`,
        );
      }
      // 无未来命中（如表达式只覆盖过去的日历）⇒ null，按终态处理，与 once 同义。
      // 命中点同样过到期点收口（G3）—— cron 的网格是表达式命中的那些时刻，到期点截断它。
      return cutAtExpiry(rule, computeNextRunAt(expression, now));
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
