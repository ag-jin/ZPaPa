import assert from "node:assert/strict";
import test from "node:test";
import { decideWake } from "../src/workitem/wakeGuard.js";

const base = {
  rule: {
    id: "w1",
    workItemId: "wi",
    kind: "event",
    mode: "continuous",
    maxFires: 20,
    fireCount: 0,
  } as never,
  manual: false,
  recentFireCount: 0,
  chainRepeatCount: 1,
  hasPendingSameEvent: false,
  allInputsFromSelf: false,
};

test("正常情况放行", () => {
  assert.deepEqual(decideWake(base), { action: "fire" });
});

test("达到 maxFires 暂停", () => {
  assert.deepEqual(decideWake({ ...base, rule: { ...base.rule, fireCount: 20 } as never }), {
    action: "pause",
    reason: "max_fires",
  });
});

test("一小时内达到 rate 上限暂停", () => {
  assert.deepEqual(decideWake({ ...base, recentFireCount: 12 }), {
    action: "pause",
    reason: "rate",
  });
});

test("run 链中同规则出现 2 次即 loop 暂停", () => {
  assert.deepEqual(decideWake({ ...base, chainRepeatCount: 2 }), {
    action: "pause",
    reason: "loop",
  });
});

test("同事件已有待处理则合并（skip）", () => {
  assert.deepEqual(decideWake({ ...base, hasPendingSameEvent: true }), {
    action: "skip",
    reason: "merged",
  });
});

test("输入全来自自身则只承认不启动", () => {
  assert.deepEqual(decideWake({ ...base, allInputsFromSelf: true }), {
    action: "skip",
    reason: "acknowledged",
  });
});

// 人手动「现在就跑」豁免三条防失控——否则人会被自己设的闸拦住。
test("manual=true 豁免 maxFires/rate/loop", () => {
  const manual = { ...base, manual: true };
  assert.deepEqual(decideWake({ ...manual, rule: { ...base.rule, fireCount: 9999 } as never }), {
    action: "fire",
  });
  assert.deepEqual(decideWake({ ...manual, recentFireCount: 999 }), { action: "fire" });
  assert.deepEqual(decideWake({ ...manual, chainRepeatCount: 9 }), { action: "fire" });
});

// 但豁免不改变「合并」与「自我承认」：那是语义去重，不是限流闸。
test("manual=true 不豁免 merged / acknowledged", () => {
  assert.deepEqual(decideWake({ ...base, manual: true, hasPendingSameEvent: true }), {
    action: "skip",
    reason: "merged",
  });
  assert.deepEqual(decideWake({ ...base, manual: true, allInputsFromSelf: true }), {
    action: "skip",
    reason: "acknowledged",
  });
});

// 优先级：pause 判定先于 skip（闸先于去重），max_fires 先于 rate 先于 loop。
test("pause 优先于 skip", () => {
  assert.deepEqual(decideWake({ ...base, recentFireCount: 12, hasPendingSameEvent: true }), {
    action: "pause",
    reason: "rate",
  });
});

/* ------------------------------------------------------------------
   以下为本任务补的**穷举矩阵**（brief Step 5② 要求逐格有结论）。
   上面 9 条是契约原文，下面按「2 路径 × 5 规则」铺满，并补边界值与优先级叠加。
   ------------------------------------------------------------------ */

// 2 路径 × 5 规则：manual 的豁免**恰好**是三条闸，不是「四条」也不是「两条」。
// 逐格铺满是为了防「单向清单」漏检：只核对「manual 豁免了哪些」会漏掉「manual 没豁免哪些」。
const ruleWith = (fireCount: number, maxFires?: number) =>
  ({ id: "w1", workItemId: "wi", kind: "event", mode: "continuous", maxFires, fireCount }) as never;

test("矩阵：manual=false × 五条规则", () => {
  const m = false;
  assert.deepEqual(
    decideWake({ ...base, manual: m, rule: ruleWith(20, 20) }),
    { action: "pause", reason: "max_fires" },
    "max_fires",
  );
  assert.deepEqual(
    decideWake({ ...base, manual: m, recentFireCount: 12 }),
    { action: "pause", reason: "rate" },
    "rate",
  );
  assert.deepEqual(
    decideWake({ ...base, manual: m, chainRepeatCount: 2 }),
    { action: "pause", reason: "loop" },
    "loop",
  );
  assert.deepEqual(
    decideWake({ ...base, manual: m, hasPendingSameEvent: true }),
    { action: "skip", reason: "merged" },
    "merged",
  );
  assert.deepEqual(
    decideWake({ ...base, manual: m, allInputsFromSelf: true }),
    { action: "skip", reason: "acknowledged" },
    "acknowledged",
  );
});

test("矩阵：manual=true × 五条规则（豁免三条闸，不豁免两条去重）", () => {
  const m = true;
  assert.deepEqual(
    decideWake({ ...base, manual: m, rule: ruleWith(9999, 20) }),
    { action: "fire" },
    "max_fires 被豁免",
  );
  assert.deepEqual(
    decideWake({ ...base, manual: m, recentFireCount: 9999 }),
    { action: "fire" },
    "rate 被豁免",
  );
  assert.deepEqual(
    decideWake({ ...base, manual: m, chainRepeatCount: 9999 }),
    { action: "fire" },
    "loop 被豁免",
  );
  assert.deepEqual(
    decideWake({ ...base, manual: m, hasPendingSameEvent: true }),
    { action: "skip", reason: "merged" },
    "merged 不豁免",
  );
  assert.deepEqual(
    decideWake({ ...base, manual: m, allInputsFromSelf: true }),
    { action: "skip", reason: "acknowledged" },
    "acknowledged 不豁免",
  );
});

// manual 的**补集方向**之一：三道闸同时命中时必须全部豁免、仍然放行
// （豁免是「整块三条」，不是「其中一条」；只要少豁免一条，人手动跑就会被自己设的闸拦住）。
// 注意本条**只置三道闸**、去重两条保持 false，所以期望是 fire；「五条全中」是下一条。
test("manual=true 时三道闸同时命中仍放行", () => {
  assert.deepEqual(
    decideWake({
      ...base,
      manual: true,
      rule: ruleWith(9999, 20),
      recentFireCount: 9999,
      chainRepeatCount: 9999,
    }),
    { action: "fire" },
  );
});

/* 真正的「manual=true × 五条规则全部命中」：三道闸被豁免，去重两条**不被豁免**，
   所以结论必须落到 skip。这一步是本条存在的全部意义——
   「豁免恰好三条」的补集方向不能靠「三道闸单测 + 两条去重单测」拼出来：
   两者各自绿，仍然可以是「manual 时跳过整块判定」（那时五条全中会错报 fire）。
   上一轮的教训（闭集清单有方向性盲区）这次藏在测试**名字**里，故把它连同期望一起钉死。 */
test("manual=true × 五条规则全部命中时落到 acknowledged（豁免不含去重）", () => {
  assert.deepEqual(
    decideWake({
      ...base,
      manual: true,
      rule: ruleWith(9999, 20),
      recentFireCount: 9999,
      chainRepeatCount: 9999,
      hasPendingSameEvent: true,
      allInputsFromSelf: true,
    }),
    { action: "skip", reason: "acknowledged" },
  );
});

/* 闸 × 去重 的**十字矩阵**（2 路径 × 3 闸 × 2 去重 = 12 格，逐格断言）。
   铺满的理由：清单式覆盖是分头验的——「manual 豁免了哪三条」「闸都压得住去重吗」——
   而分头验的绿**推不出**交叉格的绿。12 格里每一格都要求实现同时做对两件事
   （manual 分支放不放行 × 去重到底报哪个 reason），是发现「闸与去重串了」最直接的一张网。 */
test("闸 × 去重 十字矩阵：manual=false 报闸，manual=true 落到去重", () => {
  const gates = [
    { name: "max_fires", input: { rule: ruleWith(9999, 20) } },
    { name: "rate", input: { recentFireCount: 9999 } },
    { name: "loop", input: { chainRepeatCount: 9999 } },
  ] as const;
  const dedups = [
    { name: "merged", input: { hasPendingSameEvent: true } },
    { name: "acknowledged", input: { allInputsFromSelf: true } },
  ] as const;

  for (const gate of gates) {
    for (const dedup of dedups) {
      const cell = { ...base, ...gate.input, ...dedup.input };
      const where = `${gate.name}×${dedup.name}`;
      // 非人发起：闸先于去重 → 报闸。
      assert.deepEqual(
        decideWake({ ...cell, manual: false }),
        { action: "pause", reason: gate.name },
        `manual=false ${where} 应报闸`,
      );
      // 人发起：闸被豁免 → 落到去重（去重是语义去重，不随发起者变化）。
      assert.deepEqual(
        decideWake({ ...cell, manual: true }),
        { action: "skip", reason: dedup.name },
        `manual=true ${where} 应落到去重`,
      );
    }
  }
});

// maxFires 边界：未设 → 默认 20（brief 要求用 WAKE_DEFAULT_MAX_FIRES 兜底，不得就地写 20）。
test("maxFires 未设时用默认值 20 兜底", () => {
  assert.deepEqual(decideWake({ ...base, rule: ruleWith(19, undefined) }), { action: "fire" });
  assert.deepEqual(decideWake({ ...base, rule: ruleWith(20, undefined) }), {
    action: "pause",
    reason: "max_fires",
  });
});

test("maxFires 边界 0/19/20/21（fireCount=20）", () => {
  assert.deepEqual(
    decideWake({ ...base, rule: ruleWith(20, 0) }),
    { action: "pause", reason: "max_fires" },
    "0 = 无预算：非法输入下宁可停（fail-closed），不放过",
  );
  assert.deepEqual(decideWake({ ...base, rule: ruleWith(20, 19) }), {
    action: "pause",
    reason: "max_fires",
  });
  assert.deepEqual(
    decideWake({ ...base, rule: ruleWith(20, 20) }),
    { action: "pause", reason: "max_fires" },
    "达上限（>=）即停；上限那次本身仍是合法 run（spec §5.5）",
  );
  assert.deepEqual(decideWake({ ...base, rule: ruleWith(20, 21) }), { action: "fire" });
});

// 「达上限那次仍是合法 run」：fireCount=19、maxFires=20 时第 20 次必须放行（不能提前停）。
test("fireCount 比 maxFires 少 1 时仍放行", () => {
  assert.deepEqual(decideWake({ ...base, rule: ruleWith(19, 20) }), { action: "fire" });
});

test("rate 阈值边界 11 / 12", () => {
  assert.deepEqual(decideWake({ ...base, recentFireCount: 11 }), { action: "fire" });
  assert.deepEqual(decideWake({ ...base, recentFireCount: 12 }), {
    action: "pause",
    reason: "rate",
  });
});

test("loop 阈值边界 0 / 1 / 2", () => {
  assert.deepEqual(decideWake({ ...base, chainRepeatCount: 0 }), { action: "fire" });
  assert.deepEqual(decideWake({ ...base, chainRepeatCount: 1 }), { action: "fire" });
  assert.deepEqual(decideWake({ ...base, chainRepeatCount: 2 }), {
    action: "pause",
    reason: "loop",
  });
});

// 闸内优先级：三闸同时命中必须报 max_fires（最持久、最需要人看见的那条）。
test("优先级 max_fires > rate > loop", () => {
  const all = { ...base, rule: ruleWith(20, 20), recentFireCount: 12, chainRepeatCount: 2 };
  assert.deepEqual(decideWake(all), { action: "pause", reason: "max_fires" });
  assert.deepEqual(decideWake({ ...all, rule: ruleWith(0, 999) }), {
    action: "pause",
    reason: "rate",
  });
  assert.deepEqual(decideWake({ ...all, rule: ruleWith(0, 999), recentFireCount: 0 }), {
    action: "pause",
    reason: "loop",
  });
});

test("优先级 pause > skip（三闸各自都压得住两条去重）", () => {
  const dedup = { hasPendingSameEvent: true, allInputsFromSelf: true };
  assert.deepEqual(decideWake({ ...base, ...dedup, rule: ruleWith(20, 20) }), {
    action: "pause",
    reason: "max_fires",
  });
  assert.deepEqual(decideWake({ ...base, ...dedup, recentFireCount: 12 }), {
    action: "pause",
    reason: "rate",
  });
  assert.deepEqual(decideWake({ ...base, ...dedup, chainRepeatCount: 2 }), {
    action: "pause",
    reason: "loop",
  });
});

// 两条去重同时命中时的次序被钉死：先 self（自我回声）后 merged（同事件待处理）。
// 两者都是 skip，只有 reason 不同；钉死是为了让接线方拿到稳定字符串，不让它随实现漂移。
test("两条去重同时命中时报 acknowledged（self 优先于 merged）", () => {
  assert.deepEqual(decideWake({ ...base, allInputsFromSelf: true, hasPendingSameEvent: true }), {
    action: "skip",
    reason: "acknowledged",
  });
});
