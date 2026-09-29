import assert from "node:assert/strict";
import test from "node:test";
import {
  WIKI_FREQUENCY_INTERVAL_DAYS,
  clampClock,
  computeNextWikiRunAt,
  isWithinWikiRunWindow,
  migrateFromCron,
  normalizeFrequency,
} from "../src/wiki/wikiSchedule.js";

/** 便利构造：本地时间的 Date。 */
function local(y: number, m: number, d: number, h = 0, min = 0): number {
  return new Date(y, m - 1, d, h, min, 0, 0).getTime();
}

test("频率映射到间隔天数", () => {
  assert.equal(WIKI_FREQUENCY_INTERVAL_DAYS.daily, 1);
  assert.equal(WIKI_FREQUENCY_INTERVAL_DAYS.every2days, 2);
  assert.equal(WIKI_FREQUENCY_INTERVAL_DAYS.weekly, 7);
});

test("normalizeFrequency 只接受三档，其余回退每天", () => {
  assert.equal(normalizeFrequency("daily"), "daily");
  assert.equal(normalizeFrequency("every2days"), "every2days");
  assert.equal(normalizeFrequency("weekly"), "weekly");
  assert.equal(normalizeFrequency("hourly"), "daily");
  assert.equal(normalizeFrequency(undefined), "daily");
  assert.equal(normalizeFrequency(42), "daily");
});

test("clampClock 收敛越界与非法输入", () => {
  assert.deepEqual(clampClock(25, 70), { hour: 23, minute: 59 });
  assert.deepEqual(clampClock(-3, -1), { hour: 0, minute: 0 });
  assert.deepEqual(clampClock(Number.NaN, Number.NaN), { hour: 3, minute: 0 });
  assert.deepEqual(clampClock(9.7, 5.2), { hour: 9, minute: 5 });
});

test("每天：从锚点推出下一个同时刻", () => {
  const anchorAt = local(2026, 3, 10, 3, 0);
  // 锚点当天 03:00 之前 → 当天
  assert.equal(
    computeNextWikiRunAt({ frequency: "daily", hour: 3, minute: 0, anchorAt, from: local(2026, 3, 10, 1, 0) }),
    local(2026, 3, 10, 3, 0),
  );
  // 锚点当天 03:00 之后 → 次日
  assert.equal(
    computeNextWikiRunAt({ frequency: "daily", hour: 3, minute: 0, anchorAt, from: local(2026, 3, 10, 5, 0) }),
    local(2026, 3, 11, 3, 0),
  );
});

test("每 2 天：按日历天推进，跨月末不出现「隔 1 天」", () => {
  // 这是不用 `*/2` cron 的原因：31 号之后 cron 会命中 1 号，实际只隔 1 天。
  const anchorAt = local(2026, 3, 31, 3, 0);
  const from = local(2026, 3, 31, 4, 0);
  const next = computeNextWikiRunAt({ frequency: "every2days", hour: 3, minute: 0, anchorAt, from });
  // 3/31 + 2 天 = 4/2，而不是 4/1
  assert.equal(next, local(2026, 4, 2, 3, 0));
});

test("每周：固定星期几 + 间隔 7 天", () => {
  const anchorAt = local(2026, 3, 10, 3, 0); // 2026-03-10 是周二
  const next = computeNextWikiRunAt({
    frequency: "weekly",
    hour: 3,
    minute: 0,
    anchorAt,
    from: local(2026, 3, 10, 5, 0),
  });
  assert.equal(next, local(2026, 3, 17, 3, 0));
});

test("时刻变更立刻反映到下一次排期", () => {
  const anchorAt = local(2026, 3, 10, 3, 0);
  const from = local(2026, 3, 10, 5, 0); // 已过原定 03:00
  // 改成 09:30：今天 09:30 还没到，应当今天跑，而不是推到明天
  assert.equal(
    computeNextWikiRunAt({ frequency: "daily", hour: 9, minute: 30, anchorAt, from }),
    local(2026, 3, 10, 9, 30),
  );
  // 改成 04:00：今天 04:00 已过，推到明天
  assert.equal(
    computeNextWikiRunAt({ frequency: "daily", hour: 4, minute: 0, anchorAt, from }),
    local(2026, 3, 11, 4, 0),
  );
});

test("computeNextWikiRunAt 结果总是严格晚于 from", () => {
  const anchorAt = local(2026, 3, 10, 3, 0);
  for (const frequency of ["daily", "every2days", "weekly"] as const) {
    for (const from of [
      local(2026, 3, 10, 2, 59),
      local(2026, 3, 10, 3, 0),
      local(2026, 3, 10, 3, 1),
      local(2026, 3, 11, 12, 0),
    ]) {
      const next = computeNextWikiRunAt({ frequency, hour: 3, minute: 0, anchorAt, from });
      assert.ok(next > from, `${frequency} from=${new Date(from).toISOString()} → ${new Date(next).toISOString()}`);
    }
  }
});

test("触发窗口：到点算命中，未到点/刚过窗口都不算", () => {
  const anchorAt = local(2026, 3, 10, 3, 0);
  const base = { frequency: "daily" as const, hour: 3, minute: 0, anchorAt };
  // 正好到点
  assert.equal(isWithinWikiRunWindow({ ...base, now: local(2026, 3, 10, 3, 0) }), true);
  // 窗口内（5 分钟）
  assert.equal(isWithinWikiRunWindow({ ...base, now: local(2026, 3, 10, 3, 4) }), true);
  // 还没到
  assert.equal(isWithinWikiRunWindow({ ...base, now: local(2026, 3, 10, 2, 59) }), false);
  // 超出窗口
  assert.equal(isWithinWikiRunWindow({ ...base, now: local(2026, 3, 10, 3, 30) }), false);
});

test("触发窗口：每 2 天频率下，非间隔日不命中", () => {
  const anchorAt = local(2026, 3, 10, 3, 0);
  const base = { frequency: "every2days" as const, hour: 3, minute: 0, anchorAt };
  // 锚点日命中
  assert.equal(isWithinWikiRunWindow({ ...base, now: local(2026, 3, 10, 3, 0) }), true);
  // 次日（非间隔日）不命中 —— 否则「每 2 天」会退化成每天
  assert.equal(isWithinWikiRunWindow({ ...base, now: local(2026, 3, 11, 3, 0) }), false);
  // 第三天命中
  assert.equal(isWithinWikiRunWindow({ ...base, now: local(2026, 3, 12, 3, 0) }), true);
});

test("触发窗口：锚点之前不命中", () => {
  const anchorAt = local(2026, 3, 10, 3, 0);
  assert.equal(
    isWithinWikiRunWindow({
      frequency: "daily",
      hour: 3,
      minute: 0,
      anchorAt,
      now: local(2026, 3, 9, 3, 0),
    }),
    false,
  );
});

test("旧 cron 迁移：日/每2天/每周都能识别，保留时刻", () => {
  assert.deepEqual(migrateFromCron("0 3 * * *"), { frequency: "daily", hour: 3, minute: 0 });
  assert.deepEqual(migrateFromCron("30 21 * * 1"), { frequency: "weekly", hour: 21, minute: 30 });
  assert.deepEqual(migrateFromCron("0 3 */1 * *"), { frequency: "daily", hour: 3, minute: 0 });
  assert.deepEqual(migrateFromCron("0 3 */2 * *"), { frequency: "every2days", hour: 3, minute: 0 });
});

test("旧 cron 迁移：无法识别的输入返回 null 而不是猜", () => {
  assert.equal(migrateFromCron(undefined), null);
  assert.equal(migrateFromCron(""), null);
  assert.equal(migrateFromCron("* * * * *"), null, "没有具体时刻");
  assert.equal(migrateFromCron("0 3 * *"), null, "段数不足");
  assert.equal(migrateFromCron("0 3 1 * *"), null, "按月触发不属于三档");
});
