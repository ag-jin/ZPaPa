import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { AutomationRepo, DEFERRED_RETRY_MS } from "../src/session/automationRepo.js";

/**
 * 等待型重投（deferred）的调度语义。
 *
 * 背景：绑定会话正在执行时不得投递提醒（用户要求不排队、不插队，等会话停下再执行）。
 * 关键是「等待」不能走 transient 失败通道——transient 有 DISPATCH_MAX_ATTEMPTS=5 上限，
 * 达上限后循环任务会放弃本轮，长任务（>5 次重试）的提醒会被丢掉。
 *
 * 本测试锁定 deferDispatch 的不可变式：
 *   1. 不推进 next_run_at（保证复用同一 runId）；
 *   2. 不增加 dispatch_attempts（等待无上限）；
 *   3. 不写 last_error（不是失败，设置页不应显示失败徽标）；
 *   4. retry_at 前推固定间隔，且不随次数放大。
 */

async function withRepo(run: (repo: AutomationRepo) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "automation-defer-"));
  const repo = new AutomationRepo(join(dir, "tasks-index.sqlite"));
  try {
    await run(repo);
  } finally {
    repo.close();
    await rm(dir, { recursive: true, force: true });
  }
}

const scheduledAt = Date.now() + 60_000;

async function createBoundAutomation(repo: AutomationRepo): Promise<string> {
  const automation = await repo.create(
    {
      title: "每20分钟提醒",
      cronExpr: "*/20 * * * *",
      prompt: "检查进度",
      workspacePath: "/tmp/ws",
      targetTaskId: "sess_bound_1",
      // 循环任务：一次性任务派发成功即终态，测不到「下一轮继续调度」。
      recurring: true,
    },
    { nextRunAt: scheduledAt },
  );
  return automation.automationId;
}

test("deferDispatch 保留 next_run_at 与重试预算，只前推 retry_at", async () => {
  await withRepo(async (repo) => {
    const automationId = await createBoundAutomation(repo);
    const now = Date.now();
    await repo.deferDispatch(automationId, { deferredAt: now });

    const automation = await repo.get(automationId);
    assert.ok(automation);
    // 1. next_run_at 不变：scheduler 以它作为 runId 的 scheduledAt，必须复用同一条 run。
    assert.equal(automation.nextRunAt, scheduledAt);
    // 2. 等待不消耗重试预算，因此没有次数上限。
    assert.equal(automation.dispatchAttempts, 0);
    // 3. 不是失败。
    assert.equal(automation.lastError, undefined);
    assert.equal(automation.dispatchStatus, "idle");
    // 4. 固定间隔重投，会话一空闲就能被下一轮 tick 认领。
    assert.equal(automation.retryAt, now + DEFERRED_RETRY_MS);
    // 认领状态已释放，下一轮才可能重新认领。
    assert.equal(automation.enabled, true);
  });
});

test("反复 deferDispatch 不累积 attempts，等待可以无限持续", async () => {
  await withRepo(async (repo) => {
    const automationId = await createBoundAutomation(repo);
    let now = Date.now();
    for (let attempt = 0; attempt < 12; attempt += 1) {
      await repo.deferDispatch(automationId, { deferredAt: now });
      now += DEFERRED_RETRY_MS;
    }

    const automation = await repo.get(automationId);
    assert.ok(automation);
    // 12 次等待远超 DISPATCH_MAX_ATTEMPTS(5)；若误走 transient 通道，这里早已放弃本轮。
    assert.equal(automation.dispatchAttempts, 0);
    assert.equal(automation.nextRunAt, scheduledAt);
    assert.equal(automation.lifecycleStatus, "active");
    // 间隔恒定，不指数放大：会话结束时提醒应当立刻到达，而不是越等越久。
    assert.equal(automation.retryAt, now);
  });
});

test("defer 期间可被 retry_at 重新认领，且复用同一 runId", async () => {
  await withRepo(async (repo) => {
    const automationId = await createBoundAutomation(repo);
    const now = Date.now();
    await repo.deferDispatch(automationId, { deferredAt: now });

    // retry_at 未到：不该被认领（否则会每 tick 反复探测）。
    assert.equal((await repo.claimDue(now + DEFERRED_RETRY_MS - 1)).length, 0);

    const claimed = await repo.claimDue(now + DEFERRED_RETRY_MS);
    assert.equal(claimed.length, 1);
    const automation = claimed[0]!;
    assert.equal(automation.automationId, automationId);
    // runId 由 (automationId, scheduledAt) 构成；scheduledAt 稳定 ⇒ 重投复用同一 run 台账。
    assert.equal(automation.nextRunAt, scheduledAt);
    assert.equal(automation.retryAt, now + DEFERRED_RETRY_MS);
  });
});

test("等待期间 run 台账保持 claimed，运行历史不显示为失败", async () => {
  await withRepo(async (repo) => {
    const automationId = await createBoundAutomation(repo);
    const now = Date.now();
    // scheduler 派发前会先落 run 台账（upsertRunClaimed），等待期间它必须留在 claimed。
    await repo.upsertRunClaimed({
      runId: `${automationId}:${scheduledAt}`,
      automationId,
      workspaceKey: "/tmp/ws",
      scheduledAt,
      trigger: "schedule",
    });
    await repo.deferDispatch(automationId, { deferredAt: now });

    const runs = await repo.listRuns(automationId, "/tmp/ws");
    assert.equal(runs.length, 1);
    // 运行历史把 failed_to_dispatch 渲染成「失败」；等待不是失败。
    assert.equal(runs[0]!.dispatchStatus, "claimed");
    assert.equal(runs[0]!.error, undefined);
  });
});

test("等待后成功派发会推进 next_run_at，错过的周期收敛为一次执行", async () => {
  await withRepo(async (repo) => {
    const automationId = await createBoundAutomation(repo);
    const now = Date.now();
    await repo.deferDispatch(automationId, { deferredAt: now });
    const claimed = await repo.claimDue(now + DEFERRED_RETRY_MS);
    assert.equal(claimed.length, 1);

    // 模拟会话终于空闲、派发成功：调用方传入重算后的未来触发点。
    const nextRunAt = scheduledAt + 20 * 60_000;
    await repo.markDispatched(automationId, { dispatchedAt: now + 30_000, nextRunAt });

    const automation = await repo.get(automationId);
    assert.ok(automation);
    assert.equal(automation.nextRunAt, nextRunAt);
    assert.equal(automation.retryAt, undefined);
    assert.equal(automation.dispatchAttempts, 0);
    assert.equal(automation.runCount, 1);
  });
});
