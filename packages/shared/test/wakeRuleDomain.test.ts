import assert from "node:assert/strict";
import test from "node:test";
import {
  WAKE_CONDITION_TYPES,
  WAKE_DEFAULT_MAX_FIRES,
  WAKE_HOURLY_RUN_LIMIT,
  WAKE_LOOP_REPEAT_LIMIT,
  WAKE_RULE_KINDS,
  WAKE_RULE_MODES,
  wakeRuleSchema,
  validateWakeRule,
} from "../src/wake-rule.js";

const ok = (over = {}) =>
  wakeRuleSchema.parse({ id: "w1", workItemId: "wi_1", kind: "event", mode: "once", ...over });
const problems = (over = {}) => {
  const r = validateWakeRule(ok(over));
  return r.ok ? [] : r.problems;
};

test("阈值常量与 spec §5.5 一致", () => {
  assert.equal(WAKE_DEFAULT_MAX_FIRES, 20);
  assert.equal(WAKE_HOURLY_RUN_LIMIT, 12);
  assert.equal(WAKE_LOOP_REPEAT_LIMIT, 2);
});

// kind 自带的 mode 约束：at 只能 once；every/cron 只能 continuous。
test("at + continuous 被拒", () => {
  assert.ok(problems({ kind: "at", mode: "continuous", at: 1 }).length > 0);
});
test("every + once 被拒", () => {
  assert.ok(problems({ kind: "every", mode: "once", intervalSeconds: 60 }).length > 0);
});

// event 不得携带任何调度字段。
test("event 带 intervalSeconds 被拒", () => {
  assert.ok(problems({ kind: "event", intervalSeconds: 60 }).length > 0);
});
test("event 带 cronExpression 被拒", () => {
  assert.ok(problems({ kind: "event", cronExpression: "* * * * *" }).length > 0);
});

// condition 只允许挂在 event 上。
test("every 带 condition 被拒", () => {
  assert.ok(
    problems({
      kind: "every",
      mode: "continuous",
      intervalSeconds: 60,
      condition: { type: "children_done" },
    }).length > 0,
  );
});

// maxFires 只在 continuous 上有效，且 1..1000。
test("once 带 maxFires 被拒", () => {
  assert.ok(problems({ maxFires: 5 }).length > 0);
});
test("continuous 的 maxFires 越界被拒", () => {
  assert.ok(
    problems({ kind: "every", mode: "continuous", intervalSeconds: 60, maxFires: 0 }).length > 0,
  );
  assert.ok(
    problems({ kind: "every", mode: "continuous", intervalSeconds: 60, maxFires: 1001 }).length >
      0,
  );
});

// onTimeout=wake 仅限 event。
test("at 带 onTimeout=wake 被拒", () => {
  assert.ok(problems({ kind: "at", mode: "once", at: 1, onTimeout: "wake" }).length > 0);
});

test("合法规则零问题", () => {
  assert.deepEqual(problems(), []);
  assert.deepEqual(problems({ kind: "cron", mode: "continuous", cronExpression: "0 9 * * *" }), []);
});

/* ---------- Step 5 ② 穷举补充 ---------- */

// 枚举全集必须先钉死：kind 4 种、mode 2 种、condition 4 种是 spec §3.5 的固定全集，
// 少一种就是少一条合法规则类型。若只断言「等于某个数组」，改常量时这里会红，不会静默漂移。
test("kind/mode/condition 是固定全集", () => {
  assert.deepEqual(WAKE_RULE_KINDS, ["event", "at", "every", "cron"]);
  assert.deepEqual(WAKE_RULE_MODES, ["once", "continuous"]);
  assert.deepEqual(WAKE_CONDITION_TYPES, [
    "issue_field",
    "children_done",
    "pull_request",
    "other_issue",
  ]);
});

// kind × mode 全矩阵 4×2 = 8 格，逐格钉「合法 / 被拒」，被拒的还要钉是哪一条互斥命中。
// 只测「有的格子报错」不够：漏掉某条互斥后，其余格子仍可能让总断言变绿。
const MATRIX = {
  "event/once": { legal: true },
  "event/continuous": { legal: true },
  "at/once": { legal: true },
  "at/continuous": { legal: false, expect: /mode「once」/ },
  "every/continuous": { legal: true },
  "every/once": { legal: false, expect: /mode「continuous」/ },
  "cron/continuous": { legal: true },
  "cron/once": { legal: false, expect: /mode「continuous」/ },
} as const;

/** 按 kind 补上它必须带的调度字段，单独聚焦 kind × mode 这一维的互斥。 */
const scheduled = (kind: string, mode: string) => {
  const over: Record<string, unknown> = { kind, mode };
  if (kind === "at") over.at = 1;
  if (kind === "every") over.intervalSeconds = 60;
  if (kind === "cron") over.cronExpression = "0 9 * * *";
  return over;
};

test("kind × mode 八格全矩阵：合法格零问题，非法格命中对应互斥", () => {
  for (const [key, expected] of Object.entries(MATRIX)) {
    const [kind, mode] = key.split("/");
    const found = problems(scheduled(kind!, mode!));
    if (expected.legal) {
      assert.deepEqual(found, [], `${key} 应合法`);
    } else {
      assert.ok(
        found.some((p) => expected.expect.test(p)),
        `${key} 应被拒且命中 ${expected.expect}，实际：${JSON.stringify(found)}`,
      );
    }
  }
});

// condition 4 种类型 × {event, 非 event}：event 上四种都必须放行（否则合法规则被拒），
// 非 event 上四种都必须被拦（否则「条件挂在排班规则上」静默生效）。
test("condition 四种类型：event 上全部合法，非 event 上一律被拒", () => {
  for (const type of WAKE_CONDITION_TYPES) {
    assert.deepEqual(problems({ condition: { type } }), [], `event + condition(${type}) 应合法`);
    const rejected = problems({
      kind: "every",
      mode: "continuous",
      intervalSeconds: 60,
      condition: { type },
    });
    assert.ok(
      rejected.some((p) => p.includes("condition")),
      `every + condition(${type}) 应被拒`,
    );
  }
});

// eventTypes/filters × {event, 非 event}：互斥清单封顶 6 条、且 spec §3.5 未按 kind 限制它们。
// 故意**不**把「非 event 带 eventTypes/filters」列为互斥——它们在非 event 上是不被调度器读取的死配置，
// 收紧会超出本任务清单并可能拒掉合法规则。用测试钉住这个「故意放行」，免得后来者当成漏检随手补一条。
test("eventTypes/filters 两种 kind 都只受形状约束（本清单不设 kind 互斥）", () => {
  assert.deepEqual(problems({ eventTypes: ["work_item.updated"], filters: { label: "bug" } }), []);
  assert.deepEqual(
    problems({
      kind: "every",
      mode: "continuous",
      intervalSeconds: 60,
      eventTypes: ["work_item.updated"],
      filters: { label: "bug" },
    }),
    [],
  );
});

// maxFires × {未给, 0, 1, 1000, 1001, 负数}。边界是 1 与 1000：两端合法、越界必须被拒（spec §5.5「1–1000」）。
test("maxFires 取值矩阵：未给/1/1000 合法，0/1001/负数被拒", () => {
  const cont = (maxFires?: number) => {
    const over: Record<string, unknown> = {
      kind: "every",
      mode: "continuous",
      intervalSeconds: 60,
    };
    if (maxFires !== undefined) over.maxFires = maxFires;
    return problems(over);
  };
  assert.deepEqual(cont(undefined), []);
  assert.deepEqual(cont(1), []);
  assert.deepEqual(cont(1000), []);
  assert.ok(cont(0).length > 0, "0 应被拒");
  assert.ok(cont(1001).length > 0, "1001 应被拒");
  assert.ok(cont(-1).length > 0, "-1 应被拒");
});

// once 上带 maxFires：无论取值是否在范围内，都该被「仅 continuous」那条拦下——
// 这才是「mode 写错」的信号，不能因为取值合法就被放过。
test("once 带合法取值 maxFires 仍被拒，原因是仅 continuous", () => {
  assert.ok(problems({ maxFires: 20 }).some((p) => p.includes("continuous")));
});

// onTimeout × {end, wake} × {event, 非 event}。
test("onTimeout 矩阵：非 event 的 wake 被拒、end 合法；event 上两者都合法", () => {
  assert.deepEqual(problems({ onTimeout: "end" }), []);
  assert.deepEqual(problems({ onTimeout: "wake" }), []);
  assert.deepEqual(
    problems({ kind: "every", mode: "continuous", intervalSeconds: 60, onTimeout: "end" }),
    [],
  );
  assert.ok(
    problems({ kind: "every", mode: "continuous", intervalSeconds: 60, onTimeout: "wake" }).some(
      (p) => p.includes("onTimeout"),
    ),
  );
});

// expiresAt × {不设, 过去, 未来}：域模型是**无时钟**的（校验必须是确定的纯函数），
// 所以过期判定不能在这里做——三种取值都只受形状约束，语义留给调度器（Task 5）。
test("expiresAt 不设/过去/未来：域模型不做时间判定", () => {
  assert.deepEqual(problems(), []);
  assert.deepEqual(problems({ expiresAt: 1 }), []);
  assert.deepEqual(problems({ expiresAt: 9_999_999_999_999 }), []);
});

// 缺字段三格：at/every/cron 各缺自己的字段都必须报出**对应字段名**，
// 否则人只看得到「有问题」却不知道缺的是哪个调度字段。
test("at/every/cron 缺各自调度字段分别被拒且点名字段", () => {
  assert.ok(problems({ kind: "at", mode: "once" }).some((p) => p.includes("at")));
  assert.ok(
    problems({ kind: "every", mode: "continuous" }).some((p) => p.includes("intervalSeconds")),
  );
  assert.ok(
    problems({ kind: "cron", mode: "continuous" }).some((p) => p.includes("cronExpression")),
  );
});

// event 带 at（互斥第 2 条的第三种字段，brief 只列了 intervalSeconds/cronExpression）。
test("event 带 at 被拒", () => {
  assert.ok(problems({ at: 1 }).length > 0);
});

// intervalSeconds 必须为正：0 会让调度器每 tick 都命中，等于无节制触发，故由 schema 直接拒。
test("intervalSeconds 必须为正：0 与负数被 schema 拒", () => {
  const rule = (intervalSeconds: number) => ({
    id: "w1",
    workItemId: "wi_1",
    kind: "every" as const,
    mode: "continuous" as const,
    intervalSeconds,
  });
  assert.equal(wakeRuleSchema.safeParse(rule(0)).success, false);
  assert.equal(wakeRuleSchema.safeParse(rule(-1)).success, false);
  assert.equal(wakeRuleSchema.safeParse(rule(1)).success, true);
});

// cronExpression 空串不是表达式，且会被调度器当成「永不触发」而静默死掉，故非空。
test("cronExpression 空串被 schema 拒", () => {
  assert.equal(
    wakeRuleSchema.safeParse({
      id: "w1",
      workItemId: "wi_1",
      kind: "cron",
      mode: "continuous",
      cronExpression: "",
    }).success,
    false,
  );
});

// strict：未知字段被拒（如 T1 已明确排除的 hostBinding），避免「多写字段静默落盘」。
test("strict：未知字段被拒", () => {
  assert.equal(
    wakeRuleSchema.safeParse({
      id: "w1",
      workItemId: "wi_1",
      kind: "event",
      mode: "once",
      hostBinding: "h1",
    }).success,
    false,
  );
});

// 默认值三件：fireCount/revision 从 0 起（否则第一次 CAS 的 expectRevision 无锚点）、enabled 默认开。
test("默认值：fireCount=0、revision=0、enabled=true", () => {
  const rule = wakeRuleSchema.parse({ id: "w1", workItemId: "wi_1", kind: "event", mode: "once" });
  assert.equal(rule.fireCount, 0);
  assert.equal(rule.revision, 0);
  assert.equal(rule.enabled, true);
});

// 逆推 spec §3.5：整张字段表都要能被 schema 认识（含 filters/expiresAt/onTimeout/revision/pausedReason）。
test("§3.5 字段齐：全字段 event 规则通过 schema 与校验", () => {
  const rule = wakeRuleSchema.parse({
    id: "w_full",
    workItemId: "wi_1",
    kind: "event",
    mode: "continuous",
    condition: { type: "issue_field", field: "status", equals: "done" },
    filters: { label: "bug" },
    eventTypes: ["work_item.updated"],
    nextFireAt: 1_700_000_000_000,
    timezone: "Asia/Shanghai",
    maxFires: 20,
    fireCount: 3,
    pausedReason: "rate",
    expiresAt: 1_800_000_000_000,
    onTimeout: "wake",
    revision: 2,
    enabled: false,
  });
  assert.deepEqual(validateWakeRule(rule), { ok: true });
  for (const key of [
    "id",
    "workItemId",
    "kind",
    "mode",
    "condition",
    "filters",
    "eventTypes",
    "nextFireAt",
    "timezone",
    "maxFires",
    "fireCount",
    "pausedReason",
    "expiresAt",
    "onTimeout",
    "revision",
    "enabled",
  ]) {
    assert.ok(key in rule, `§3.5 字段「${key}」未被 schema 认识`);
  }
});

// 三个调度字段都要被 schema 认识（缺一即整类规则无法落盘）：三种 kind 各解析一次。
test("调度字段 at/intervalSeconds/cronExpression 都被 schema 认识", () => {
  assert.equal(
    wakeRuleSchema.parse({ id: "w1", workItemId: "wi_1", kind: "at", mode: "once", at: 1_700_000_000_000 })
      .at,
    1_700_000_000_000,
  );
  assert.equal(
    wakeRuleSchema.parse({
      id: "w1",
      workItemId: "wi_1",
      kind: "every",
      mode: "continuous",
      intervalSeconds: 60,
    }).intervalSeconds,
    60,
  );
  assert.equal(
    wakeRuleSchema.parse({
      id: "w1",
      workItemId: "wi_1",
      kind: "cron",
      mode: "continuous",
      cronExpression: "0 9 * * *",
    }).cronExpression,
    "0 9 * * *",
  );
});

// 全字段 every 规则（含防失控三件套与过期/超时）：排班类合法规则不能被互斥误伤。
test("全字段 every 规则通过校验", () => {
  const rule = wakeRuleSchema.parse({
    id: "w2",
    workItemId: "wi_1",
    kind: "every",
    mode: "continuous",
    intervalSeconds: 300,
    timezone: "Asia/Shanghai",
    nextFireAt: 1,
    maxFires: 20,
    fireCount: 0,
    expiresAt: 1_800_000_000_000,
    onTimeout: "end",
    revision: 0,
    enabled: true,
  });
  assert.deepEqual(validateWakeRule(rule), { ok: true });
});

// pausedReason 只认 spec §5.5 的三条防失控原因（与 Task 5 的 pause reason 同源），写错要报错而不是静默落盘。
test("pausedReason 只认三条防失控原因", () => {
  const base = { id: "w1", workItemId: "wi_1", kind: "event" as const, mode: "once" as const };
  for (const reason of ["max_fires", "rate", "loop"]) {
    assert.equal(wakeRuleSchema.safeParse({ ...base, pausedReason: reason }).success, true);
  }
  assert.equal(wakeRuleSchema.safeParse({ ...base, pausedReason: "whatever" }).success, false);
});
