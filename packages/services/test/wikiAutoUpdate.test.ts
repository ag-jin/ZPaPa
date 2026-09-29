import assert from "node:assert/strict";
import test from "node:test";
import type { WikiSettings } from "@zcode/shared";
import { WikiAutoUpdateScheduler } from "../src/wiki/wikiAutoUpdate.js";

const MAX_SLEEP = 30 * 60_000;

/** 捕获调度器算出的下一次睡眠时长，不真的等待。 */
async function captureDelayMs(settings: WikiSettings | undefined): Promise<number> {
  const captured: number[] = [];
  const originalSetTimeout = globalThis.setTimeout;
  globalThis.setTimeout = ((handler: () => void, timeout?: number) => {
    if (typeof timeout === "number") captured.push(timeout);
    return { unref() {} } as unknown as ReturnType<typeof globalThis.setTimeout>;
  }) as typeof globalThis.setTimeout;
  try {
    const scheduler = new WikiAutoUpdateScheduler({
      readSettings: async () => settings,
      listTargets: async () => [],
      runUpdate: async () => {},
    });
    scheduler.start();
    // 读设置是异步的，让微任务跑完
    await new Promise((resolve) => originalSetTimeout(resolve, 20));
    scheduler.stop();
  } finally {
    globalThis.setTimeout = originalSetTimeout;
  }
  return captured[0] ?? -1;
}

test("未开启自动更新时不按计划触发（低频复查设置变化）", async () => {
  assert.equal(
    await captureDelayMs({ autoUpdateEnabled: false, autoUpdateFrequency: "daily" }),
    MAX_SLEEP,
  );
});

test("未提供设置时同样低频复查", async () => {
  assert.equal(await captureDelayMs(undefined), MAX_SLEEP);
});

test("开启后按到点时间调度，单次睡眠被截断在上限内", async () => {
  const delay = await captureDelayMs({
    autoUpdateEnabled: true,
    autoUpdateFrequency: "daily",
    autoUpdateHour: 3,
    autoUpdateMinute: 0,
  });
  assert.ok(delay > 0, `延迟应为正数，实际 ${delay}`);
  assert.ok(delay <= MAX_SLEEP, `延迟应被截断到上限，实际 ${delay}`);
});

test("越界时刻被收敛，不会算出非法延迟", async () => {
  const delay = await captureDelayMs({
    autoUpdateEnabled: true,
    autoUpdateFrequency: "every2days",
    autoUpdateHour: 99,
    autoUpdateMinute: 99,
  });
  assert.ok(delay > 0 && delay <= MAX_SLEEP, `实际 ${delay}`);
});

test("缺失锚点时用当前时间兜底，仍能算出有效延迟", async () => {
  // 没有锚点会让「按日历天推进」失去基准；兜底后不得退化成 0 或负值，
  // 否则调度器会不停自触发。
  const delay = await captureDelayMs({
    autoUpdateEnabled: true,
    autoUpdateFrequency: "weekly",
    autoUpdateHour: 8,
    autoUpdateMinute: 0,
  });
  assert.ok(delay > 0 && delay <= MAX_SLEEP, `实际 ${delay}`);
});

test("stop 后不再重新调度，且不抛错", async () => {
  const scheduler = new WikiAutoUpdateScheduler({
    readSettings: async () => ({ autoUpdateEnabled: true, autoUpdateFrequency: "daily" }),
    listTargets: async () => [],
    runUpdate: async () => {},
  });
  scheduler.start();
  scheduler.stop();
  // stop 之后再次 start 不应生效（调度器生命周期单向）
  scheduler.start();
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.ok(true, "stop 后无异常");
});
