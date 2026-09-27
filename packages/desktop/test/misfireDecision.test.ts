import assert from "node:assert/strict";
import test from "node:test";
import { isMissedTriggerWindow } from "../src/scheduler/misfireDecision.js";

/**
 * misfire 判定与「等待重投」的边界。
 *
 * 这条边界直接决定提醒会不会被静默丢弃：绑定会话正在执行时提醒进入等待，
 * 若因 next_run_at 早于 now 被误判成「关机期间错过的窗口」，长任务的提醒就会消失——
 * 与用户要求的「等会话停下再执行」相反。
 *
 * 实测背景（2026-09-27）：用户报告定时提醒无视会话执行状态；修复后长时间等待必须仍能到达。
 */

const GRACE_MS = 5 * 60_000;

function decide(overrides: Partial<Parameters<typeof isMissedTriggerWindow>[0]> = {}) {
  const now = 1_000_000_000;
  return isMissedTriggerWindow({
    nextRunAt: now,
    retryAt: null,
    dispatchAttempts: 0,
    now,
    graceMs: GRACE_MS,
    ...overrides,
  });
}

test("正常到点不是错过窗口", () => {
  assert.equal(decide({ nextRunAt: 1_000_000_000 - 1_000 }), false);
});

test("远超宽限且无人认领 ⇒ 判为错过窗口（关机期间错过）", () => {
  assert.equal(decide({ nextRunAt: 1_000_000_000 - GRACE_MS - 1 }), true);
});

test("等待重投期间即使早于宽限也不判错过：长任务的提醒不丢", () => {
  // 会话忙很久，next_run_at 已远在过去，但 retry_at 表示本轮正在等待。
  assert.equal(decide({ nextRunAt: 1_000_000_000 - GRACE_MS * 10, retryAt: 1_000_000_000 }), false);
});

test("已有派发尝试次数同样视为等待中（transient 退避路径不变）", () => {
  assert.equal(decide({ nextRunAt: 1_000_000_000 - GRACE_MS * 10, dispatchAttempts: 1 }), false);
});

test("未设置 next_run_at 时不判错过", () => {
  assert.equal(decide({ nextRunAt: null }), false);
  assert.equal(decide({ nextRunAt: undefined }), false);
});
