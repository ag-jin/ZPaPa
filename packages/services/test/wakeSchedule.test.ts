import assert from "node:assert/strict";
import test from "node:test";
import type { WakeRule } from "@zcode/shared";
import { nextFireAtAfter } from "../src/workitem/wakeSchedule.js";

/* `nextFireAtAfter` 的**到期点（`expiresAt`）矩阵**（G3）。
   排期网格本身（every 的整数倍步进 / cron 的下一命中）已由既有用例与调度器用例覆盖，
   这里只钉**新增的那一条判定**：下一格若**不早于** `expiresAt` 就不再有下一格（返回 null = 终态）。

   口径（架构轮 G3 第 1 条，边界必须被用例钉死）：
   · 触发时刻必须**严格早于** `expiresAt` ⇒ `next >= expiresAt` 即 null；
   · `expiresAt` 未设 ⇒ 恒定沿用网格（对照组：没有它，「恒返回 null」也能让边界用例全绿）。

   期望值取自**独立真源**：every 的网格是纯算术（nominal + k*interval），cron 的下一格是
   「本地时区下一个整分钟」——都不是把实现再算一遍。 */

const T0 = 1_700_000_000_000;
const MINUTE = 60_000;

const every = (over: Partial<WakeRule> = {}): WakeRule =>
  ({
    id: "w1",
    workItemId: "wi_1",
    kind: "every",
    mode: "continuous",
    intervalSeconds: 60,
    fireCount: 0,
    revision: 0,
    enabled: true,
    nextFireAt: T0,
    ...over,
  }) as WakeRule;

/** 本地时区下一个整分钟（cron `* * * * *` 的命中点，与 TZ 无关：从整分钟边界起算恰好 +1 分钟）。 */
const localMinuteBoundary = new Date(2026, 0, 15, 10, 30, 0, 0).getTime();

test("未设 expiresAt ⇒ 照旧推进到网格下一格（对照组）", () => {
  assert.equal(nextFireAtAfter(every(), T0), T0 + MINUTE);
});

test("expiresAt 恰等于下一格 ⇒ null（触发时刻必须严格早于到期点）", () => {
  assert.equal(nextFireAtAfter(every({ expiresAt: T0 + MINUTE }), T0), null);
});

test("expiresAt 比下一格晚 1ms ⇒ 下一格照常（边界另一侧）", () => {
  assert.equal(nextFireAtAfter(every({ expiresAt: T0 + MINUTE + 1 }), T0), T0 + MINUTE);
});

test("expiresAt 早于下一格 ⇒ null", () => {
  assert.equal(nextFireAtAfter(every({ expiresAt: T0 + MINUTE - 1 }), T0), null);
});

test("expiresAt 已在过去 ⇒ null", () => {
  assert.equal(nextFireAtAfter(every({ expiresAt: T0 - 1 }), T0), null);
});

/* 连续推进（调度器 fire 的形状）：网格一格格走，走到第一格「不早于 expiresAt」就停。
   这钉的是「到期即终态」而不是「到期即跳过那一格、继续往后排」—— 后者会让一条规则
   永远停在表里、每格判一次、永远不派发。 */
test("到期即终态：连续推进在第一个越界格停下来（不是跳过它继续往后排）", () => {
  const expiresAt = T0 + 150_000;
  const first = nextFireAtAfter(every({ expiresAt }), T0);
  assert.equal(first, T0 + MINUTE, "第 1 格：早于到期点，照常");
  const second = nextFireAtAfter(every({ expiresAt, nextFireAt: first! }), first!);
  assert.equal(second, T0 + 2 * MINUTE, "第 2 格：仍早于到期点（120s < 150s）");
  const third = nextFireAtAfter(every({ expiresAt, nextFireAt: second! }), second!);
  assert.equal(third, null, "第 3 格 180s 已越界（>= 150s）⇒ 终态，不再有下一格");
});

test("cron 分支同样受到期点约束（下一整分钟 vs 到期点）", () => {
  const cron = (over: Partial<WakeRule> = {}): WakeRule =>
    ({
      id: "w2",
      workItemId: "wi_1",
      kind: "cron",
      mode: "continuous",
      cronExpression: "* * * * *",
      fireCount: 0,
      revision: 0,
      enabled: true,
      nextFireAt: localMinuteBoundary,
      ...over,
    }) as WakeRule;
  const nextMinute = localMinuteBoundary + MINUTE;
  assert.equal(nextFireAtAfter(cron(), localMinuteBoundary), nextMinute, "对照组：下一整分钟");
  assert.equal(
    nextFireAtAfter(cron({ expiresAt: nextMinute }), localMinuteBoundary),
    null,
    "恰等于下一格 ⇒ 终态",
  );
  assert.equal(
    nextFireAtAfter(cron({ expiresAt: nextMinute + 1 }), localMinuteBoundary),
    nextMinute,
    "晚 1ms ⇒ 保留",
  );
});

// 一次性规则（`once`）在任何 kind 下都提前返回 null（终态语义），到期判定不改变它 ——
// 首格排期（create/resume）不走本函数，故 `at` 的到期判定在 initialNextFireAt 那一侧（服务面用例）。
test("once ⇒ 恒为 null（到期判定不改变一次性规则的终态语义）", () => {
  assert.equal(nextFireAtAfter(every({ mode: "once" }), T0), null);
  assert.equal(nextFireAtAfter(every({ mode: "once", expiresAt: T0 + MINUTE }), T0), null);
});

// 事件规则的排期点归事实侧：本层恒返回 null（与到期点无关）。
test("event ⇒ 恒为 null（排期点由事实侧写入，不受到期点影响）", () => {
  const event = every({ kind: "event", mode: "once", expiresAt: T0 + MINUTE }) as WakeRule;
  assert.equal(nextFireAtAfter(event, T0), null);
});
