import assert from "node:assert/strict";
import test from "node:test";
import { computeEventKey } from "@zcode/shared";

/* `eventKey` 的构造规则（spec §5.7.1）。

   不定义它、由接线方就地拼串的最坏后果是「重复投递的事件静默重复触发」——不报错、看起来正常。
   所以本文件逐条钉死 §5.7.1 的每一句：唯一构造器 / 两族前缀 / 稳定 id 优先 /
   完整 payload 指纹 / 无法去重则抛 / 易变字段是同处常量 / `filters` 与 `eventTypes` 不参与 key。 */

// spec §5.7.1：事件族优先用事件自带的**稳定 id**；同一事实重投两次必须算出同一个 key，
// 否则「同一事实只处理一次」这条去重（§5.5 merged）根本不存在。
test("事件族：有稳定 id 时用 id，且重投同 id 得同 key", () => {
  const rule = {
    id: "w1",
    workItemId: "wi",
    kind: "event",
    eventTypes: ["issue.assigned"],
  } as never;
  const fact = {
    source: "github",
    externalId: "delivery-1",
    eventType: "issue.assigned",
    payload: { a: 1 },
  };
  assert.equal(computeEventKey(rule, fact), computeEventKey(rule, fact));
  assert.match(computeEventKey(rule, fact), /^e:id:github:delivery-1$/);
});

// 稳定 id 在场时**优先于**指纹：同一 payload 换个 delivery id 必须算出不同 key
// （那是两次投递，不是同一件事），反之 payload 变了但 id 没变仍算同一件。
test("事件族：稳定 id 优先于 payload 指纹", () => {
  const rule = { id: "w1", workItemId: "wi", kind: "event" } as never;
  const base = { source: "gh", eventType: "e", payload: { a: 1 } };
  assert.notEqual(
    computeEventKey(rule, { ...base, externalId: "d-1" }),
    computeEventKey(rule, { ...base, externalId: "d-2" }),
  );
  assert.equal(
    computeEventKey(rule, { ...base, externalId: "d-1" }),
    computeEventKey(rule, { ...base, externalId: "d-1", payload: { a: 999 } }),
  );
});

// §5.7.1 最关键的一句：`filters` / `eventTypes` **不参与** key。
// 拼进去会让规则作者改一下过滤器就换掉一把去重键 ⇒ 历史去重记录全部失效（同一事实被重新处理一次）。
test("改 filters / eventTypes 不改变 key", () => {
  const fact = { source: "gh", externalId: "d-9", eventType: "issue.assigned", payload: {} };
  const a = computeEventKey(
    { id: "w1", workItemId: "wi", kind: "event", eventTypes: ["x"] } as never,
    fact,
  );
  const b = computeEventKey(
    { id: "w1", workItemId: "wi2", kind: "event", eventTypes: ["y"], filters: { a: 2 } } as never,
    fact,
  );
  assert.equal(a, b);
});

// §5.7.1：`eventKey` 里**不含** `revision`（它已是幂等四元组的独立一项）。
// 含进去的话，一次无关的规则编辑会让同一个事实在两套 key 下各处理一次。
test("改 revision / workItemId 不改变 key", () => {
  const rule = { id: "w1", workItemId: "wi", kind: "event" } as never;
  const fact = { source: "gh", externalId: "d-1", eventType: "e", payload: { a: 1 } };
  assert.equal(
    computeEventKey(rule, fact),
    computeEventKey({ ...rule, revision: 7, workItemId: "wi-other" } as never, fact),
  );
});

// 无可稳定 id 时退用**完整 payload 的规范化指纹**——正因如此，仅时间戳不同的两次事件算出不同 key。
test("事件族：无稳定 id 时用完整 payload 指纹（易变字段不影响）", () => {
  const rule = { id: "w1", workItemId: "wi", kind: "event" } as never;
  const base = { source: "gh", eventType: "e", payload: { a: 1, b: { c: 2, d: 3 } } };
  const reordered = { source: "gh", eventType: "e", payload: { b: { d: 3, c: 2 }, a: 1 } };
  assert.match(computeEventKey(rule, base), /^e:fp:gh:e:/);
  assert.equal(computeEventKey(rule, base), computeEventKey(rule, reordered));
  assert.notEqual(
    computeEventKey(rule, base),
    computeEventKey(rule, { ...base, payload: { a: 1, b: { c: 2, d: 4 } } }),
  );
  // 易变字段在**同处声明的常量**里被排除，不得在调用点就地过滤。
  assert.equal(
    computeEventKey(rule, { ...base, payload: { ...base.payload, deliveryAttempt: 1 } }),
    computeEventKey(rule, { ...base, payload: { ...base.payload, deliveryAttempt: 9 } }),
  );
});

// stableStringify 必须钉死（spec §5.7.1 末段）：数组**保序**（顺序变了就是另一个事实）、
// 嵌套层的易变字段同样被排除（投递元数据常嵌在子对象里）。
test("指纹：数组保序，嵌套层的易变字段同样被排除", () => {
  const rule = { id: "w1", workItemId: "wi", kind: "event" } as never;
  const fact = (payload: unknown) => ({ source: "gh", eventType: "e", payload });
  assert.notEqual(
    computeEventKey(rule, fact({ items: [1, 2] })),
    computeEventKey(rule, fact({ items: [2, 1] })),
  );
  assert.equal(
    computeEventKey(rule, fact({ meta: { deliveryAttempt: 1 }, a: 1 })),
    computeEventKey(rule, fact({ meta: { deliveryAttempt: 2 }, a: 1 })),
  );
});

// payload 的**形态全集**：每一种都要参与指纹，且形态之间不得撞键
// （撞键 = 两个不同事实被算成同一件 ⇒ 后到的那个被静默去重吞掉）。
test("指纹：字符串 / 数字 / 布尔 / null / 嵌套数组 / 对象互不撞键", () => {
  const rule = { id: "w1", workItemId: "wi", kind: "event" } as never;
  const fact = (payload: unknown) => ({ source: "gh", eventType: "e", payload });
  const keys = ["x", 1, true, false, null, [1, [2]], { a: 1 }, { a: [1] }].map((payload) =>
    computeEventKey(rule, fact(payload)),
  );
  assert.equal(new Set(keys).size, keys.length, "不同形态的 payload 不得撞键");
  assert.equal(computeEventKey(rule, fact(null)), computeEventKey(rule, fact(null)));
  // payload 缺失按空负载归一（与显式 null 同键）：无可区分信息时「同一件」是唯一自洽的结论。
  assert.equal(
    computeEventKey(rule, { source: "gh", eventType: "e" }),
    computeEventKey(rule, fact(null)),
  );
});

// stableStringify 的「数字最简形式」：JS 只有一个 number 类型，`-0` 与 `0` 是同一件事
// （JSON 的十进制最短表示都是 `"0"`）。这条钉的是「同一件事永远同一个指纹」，不是具体格式。
test("指纹：数字按最简形式（-0 与 0 同键）", () => {
  const rule = { id: "w1", workItemId: "wi", kind: "event" } as never;
  const fact = (payload: unknown) => ({ source: "gh", eventType: "e", payload });
  assert.equal(computeEventKey(rule, fact({ a: -0 })), computeEventKey(rule, fact({ a: 0 })));
  assert.notEqual(computeEventKey(rule, fact({ a: 1 })), computeEventKey(rule, fact({ a: 2 })));
  assert.notEqual(
    computeEventKey(rule, fact({ a: 1e21 })),
    computeEventKey(rule, fact({ a: 1e20 })),
  );
});

// 既无稳定 id、payload 又不可规范化 ⇒ **抛**（不 fire）：不可去重的事件每次重投都会重复触发且不报错。
test("不可去重的事件抛错", () => {
  const rule = { id: "w1", workItemId: "wi", kind: "event" } as never;
  const cyclic: Record<string, unknown> = {};
  cyclic.self = cyclic;
  assert.throws(
    () => computeEventKey(rule, { source: "gh", eventType: "e", payload: cyclic }),
    /eventKey/,
  );
  // 函数 / Symbol / undefined / BigInt 同样不可规范化：静默丢字段会让两个不同事实撞成同一个指纹。
  for (const bad of [
    () => 1,
    Symbol("s"),
    undefined,
    BigInt(1),
    Number.NaN,
    Number.POSITIVE_INFINITY,
  ]) {
    assert.throws(
      () => computeEventKey(rule, { source: "gh", eventType: "e", payload: { a: bad } }),
      /eventKey/,
      `payload 含不可规范化值（${String(bad)}）应抛`,
    );
  }
});

// 事件族**必须**能指名来源：缺了就无法构造 identity，静默拼出一个所有人共用的 key
// （所有事件都变成「同一件」⇒ 除第一个之外全被去重吞掉）。
// `eventType` 只在**指纹族**里参与（spec §5.7.1 (A)2）：有稳定 id 时它不参与 identity，
// 所以那时缺它不是错误——这是 spec 写死的形状，不是实现的疏漏。
test("事件族缺 source ⇒ 抛；缺 eventType 仅在无稳定 id 时抛", () => {
  const rule = { id: "w1", workItemId: "wi", kind: "event" } as never;
  assert.throws(() => computeEventKey(rule, { eventType: "e", payload: {} }), /eventKey/);
  assert.throws(
    () => computeEventKey(rule, { source: "  ", eventType: "e", payload: {} }),
    /eventKey/,
  );
  // 无稳定 id + 无 eventType ⇒ 指纹拼不出来，抛。
  assert.throws(() => computeEventKey(rule, { source: "gh", payload: {} }), /eventKey/);
  // 有稳定 id ⇒ identity 只需 source + externalId。
  assert.equal(computeEventKey(rule, { source: "gh", externalId: "d", payload: {} }), "e:id:gh:d");
});

// 排期族：名义时刻（**不是**发现它的墙钟时刻）进 key，故重启重算 / misfire 补发 / tick 反复捞到
// 三种情形都算出同一个 key。两族前缀不同 ⇒ 事件的第 N 次与排期的第 N 次永不撞键。
test("排期族用名义时刻，前缀与事件族不同", () => {
  const rule = { id: "w1", workItemId: "wi", kind: "every", intervalSeconds: 60 } as never;
  assert.equal(computeEventKey(rule, { scheduledFor: 1000 }), "t:1000");
  assert.notEqual(
    computeEventKey(rule, { scheduledFor: 1000 }),
    computeEventKey(rule, { scheduledFor: 1060 }),
  );
});

// 三种排期 kind 都走同一族（spec §5.7.1 (B) 列的是 `at | every | cron`）：
// 只实现 every 会让 at / cron 落到事件族分支，那两类事件于是永远算不出 key（或算出 nonsense）。
for (const kind of ["at", "every", "cron"] as const) {
  test(`排期族覆盖 kind=${kind}`, () => {
    assert.equal(
      computeEventKey({ id: "w1", workItemId: "wi", kind } as never, { scheduledFor: 42 }),
      "t:42",
    );
  });
}

// 名义时刻必须是**整数毫秒**：小数/非数会让「同一格」每次算出不同的字符串，
// 去重静默失效（每次都像新的一次）。
test("排期族：scheduledFor 非整数毫秒 ⇒ 抛", () => {
  const rule = { id: "w1", workItemId: "wi", kind: "every", intervalSeconds: 60 } as never;
  assert.throws(() => computeEventKey(rule, { scheduledFor: 1000.5 }), /eventKey/);
  assert.throws(() => computeEventKey(rule, {}), /eventKey/);
});
