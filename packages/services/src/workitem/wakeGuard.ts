import {
  WAKE_DEFAULT_MAX_FIRES,
  WAKE_HOURLY_RUN_LIMIT,
  WAKE_LOOP_REPEAT_LIMIT,
  type WakePauseReason,
  type WakeRule,
} from "@zcode/shared";

/* 派发决策（spec §5.1/§5.5）：把「这次触发该不该起一个 run」判成一个可断言的值。
   刻意做成**纯函数**——无 IO、无持久化、不读时钟：同一份入参任何时候都得到同一个决策。
   于是「防失控」这条硬规则可以被穷举矩阵测干净，而不是靠读一遍调度器代码相信它。

   三个 part 的分工：`fire` 起 run；`skip` 是一次性的**语义去重**（同一事实只处理一次，
   不改规则状态，下一轮还是同样的 skip）；`pause` 是**闸**（该停下来等人处理，
   调用方要把 `reason` 落到 `rule.pausedReason` 上，spec §5.5）。 */

/* reason 取自 shared 的 `WAKE_PAUSE_REASONS`（Task 3），不在这里重写一遍字面量：
   两侧各写一份的话，改名时只会改一边，闸名与落盘值就会悄悄对不上。 */
export type WakeDecision =
  | { action: "fire" }
  | { action: "skip"; reason: "merged" | "acknowledged" }
  | { action: "pause"; reason: WakePauseReason };

/**
 * 判定顺序**本身是契约**，两条次序都不能调换：
 *
 * 1. **先判闸、再判去重**（`pause` 优先于 `skip`）。两者可能同时命中，此时候选返回值不同，
 *    必须选一个。选 `pause` 的理由：`pause` 要落盘成 `rule.pausedReason`、要让人在界面上看见
 *    「规则已经停下等你」，而 `skip` 是瞬时结论、不改变任何状态——下一轮同一事实仍在，
 *    `skip` 还会再被算出来一次。所以先报**不可逆、需要人介入**的那条：报 `skip` 会让人
 *    把「闸该停但没停」理解成「只是被合并了」，闸就白设了（spec §5.5 是硬规则，不靠 prompt）。
 *
 * 2. **闸内顺序 `max_fires` → `rate` → `loop`**（与 §5.5 表格自上而下一致），按「自解速度」从慢到快排：
 *    `max_fires` 是规则自身的终身上限，一旦撞上就再也不会自解（除非人改规则）；
 *    `rate` 是滚动一小时窗口的限流，等窗口滑过去就自解；
 *    `loop` 只在当前 run 链内成立，链一结束就自解。
 *    先报最持久的那条，用户看到的原因才最接近「为什么它停在那儿不动了」。
 *
 * 豁免范围**恰好是三条闸**：`manual === true`（用户手动「现在就跑」）跳过上面整块，
 * 因为闸拦的是「自动派发太频繁」，而人一次点击不构成频率（spec §5.2「防失控只约束非人发起」）。
 * 但豁免**不含**下面两条去重：`merged` / `acknowledged` 不是限流闸，而是「同一事实只处理一次」
 * 的语义去重（唯一键 `(ruleId, revision, eventKey)` 与自我回声短路）——同一事实重复处理
 * 对人对规则都一样危险，跟谁发起无关，所以 manual 也必须服从。
 */
export function decideWake(input: {
  rule: WakeRule;
  manual: boolean;
  recentFireCount: number;
  chainRepeatCount: number;
  hasPendingSameEvent: boolean;
  allInputsFromSelf: boolean;
}): WakeDecision {
  const { rule, manual, recentFireCount, chainRepeatCount, hasPendingSameEvent, allInputsFromSelf } = input;

  if (!manual) {
    /* `?? WAKE_DEFAULT_MAX_FIRES` 而不是就地写 20：默认值是产品语义（spec §5.5），
       只能有一处出处；用 `??` 而非 `||` 是为了让显式的 `0` 也是「0」——
       非法/无预算时 `fireCount >= 0` 恒真 → 一律 pause（fail-closed）。
       判定用 `>=`：spec §5.5 明确「达上限那次仍是合法 run」，即 fireCount=19/maxFires=20 时
       第 20 次仍要放行，跑完 fireCount 变成 20 才停。 */
    const maxFires = rule.maxFires ?? WAKE_DEFAULT_MAX_FIRES;
    if (rule.fireCount >= maxFires) return { action: "pause", reason: "max_fires" };

    // §5.5：「一小时内 run 次数 ≥ 12 → 暂停」。窗口与计数由调用方（调度器）提供，本函数只比阈值。
    if (recentFireCount >= WAKE_HOURLY_RUN_LIMIT) return { action: "pause", reason: "rate" };

    // §5.5：「run 链中同一规则出现 ≥ 2 次 → 暂停」，防自我放大的派发环。
    if (chainRepeatCount >= WAKE_LOOP_REPEAT_LIMIT) return { action: "pause", reason: "loop" };
  }

  /* 语义去重（manual 也适用）。次序先 self（自我承认短路）后 merged：
     两条同时命中时都是 skip，差别只在 reason。选 self 在前是因为它是更强的结论——
     「这次唤醒的全部输入都出自被唤醒者自己」，此时任何启动都只会放大自己的回声；
     而 `merged` 只是「已经有一次在队列里了」。钉死这次序是为了让 reason 字符串稳定，
     不让接线方的展示随实现顺序漂移。 */
  if (allInputsFromSelf) return { action: "skip", reason: "acknowledged" };
  if (hasPendingSameEvent) return { action: "skip", reason: "merged" };

  return { action: "fire" };
}
