// 常驻池的「后台工作在跑就不回收」闸门（P1-1 加固验证的第二道防线）。
//
// 为什么这组用例承重：孤儿收敛的 J4 判据（`context.sessions` 是否有 child 的 live 记录）在生产里
// 几乎恒 false——subagent child 是父 runtime 内联 `new AgentRuntime(...)`、没有 host record。
// 让「父被去激活 ∧ 后台 child 还活着」在**主路径**上不可达的，是父会话被后台任务钉住这件事：
// 后台 child 在父 runtime 的 task registry 里是 `isBackgrounded ∧ running`，于是
// `readResidencyFacts().hasResidencyBlockingWork` 为真，`isEligible` 拒绝该会话——
// 无论 idle TTL 到期还是高水位 LRU，都不能回收它（切走会话本身只是退订，不是去激活）。
//
// 单测锁的是闸门的**语义**（阻断两条回收路径）；「后台 child 确实会把这条事实置真」由
// core 的 backgroundSubagentParentLifetime.test.ts 在真实 runtime 上证明。两者合起来才是
// 「父会话不会被去激活」，缺哪一半这条论证都不成立。

import assert from "node:assert/strict";
import test from "node:test";
import {
  SessionResidentPool,
  type SessionResidencyFacts,
  type SessionResidentPoolHost,
} from "../src/zcode-protocol/session-resident-pool.js";

const PINNED_SESSION_ID = "sess_resident_pinned_by_background_child";
const IDLE_SESSION_ID = "sess_resident_idle";
const OTHER_SESSION_ID = "sess_resident_other";

/** 只有「后台 child 在跑」这一项不同的常驻事实。 */
function residencyFacts(input: {
  hasResidencyBlockingWork: boolean;
  lastActivityAt: number;
}): SessionResidencyFacts {
  return {
    hasLegacySubscriber: false,
    hasPendingInteractions: false,
    hasQueuedCommands: false,
    hasResidencyBlockingWork: input.hasResidencyBlockingWork,
    hasSubscribers: false,
    lastActivityAt: input.lastActivityAt,
    persisted: true,
  };
}

function createHost(input: {
  facts: ReadonlyMap<string, SessionResidencyFacts>;
}): { deactivated: string[]; host: SessionResidentPoolHost } {
  const deactivated: string[] = [];
  const host: SessionResidentPoolHost = {
    deactivate: async (sessionId) => {
      deactivated.push(sessionId);
    },
    listSessionIds: () => [...input.facts.keys()],
    readResidencyFacts: (sessionId) => input.facts.get(sessionId) ?? null,
  };
  return { deactivated, host };
}

test("idle TTL 到期：后台 child 钉住的父会话不回收，空闲会话照常回收", async () => {
  const facts = new Map([
    [PINNED_SESSION_ID, residencyFacts({ hasResidencyBlockingWork: true, lastActivityAt: 0 })],
    [IDLE_SESSION_ID, residencyFacts({ hasResidencyBlockingWork: false, lastActivityAt: 0 })],
  ]);
  const { deactivated, host } = createHost({ facts });
  // 资格窗口是「连续空闲」语义：第一拍只登记 eligibleSince，第二拍才到期。
  let now = 1_000_000;
  const pool = new SessionResidentPool(host, {
    highWaterCount: 16,
    idleTimeoutMs: 60_000,
    now: () => now,
  });

  pool.rebalance();
  now += 120_000;
  pool.rebalance();
  await Promise.resolve();
  assert.deepEqual(deactivated, [IDLE_SESSION_ID], "只应收走真正空闲的会话");
  assert.equal(deactivated.includes(PINNED_SESSION_ID), false);
});

test("高水位 LRU：最久未用但后台 child 在跑的父会话必须被跳过", async () => {
  // 三个会话都「新鲜」（idle TTL 不生效），钉住的这个 lastActivityAt 最旧 ⇒ 是 LRU 首选。
  const facts = new Map([
    [PINNED_SESSION_ID, residencyFacts({ hasResidencyBlockingWork: true, lastActivityAt: 1 })],
    [IDLE_SESSION_ID, residencyFacts({ hasResidencyBlockingWork: false, lastActivityAt: 2 })],
    [OTHER_SESSION_ID, residencyFacts({ hasResidencyBlockingWork: false, lastActivityAt: 3 })],
  ]);
  const { deactivated, host } = createHost({ facts });
  const pool = new SessionResidentPool(host, {
    highWaterCount: 1,
    idleTimeoutMs: Number.MAX_SAFE_INTEGER,
    now: () => 1_000_000,
    targetCount: 0,
  });

  pool.rebalance();
  await Promise.resolve();
  assert.equal(
    deactivated.includes(PINNED_SESSION_ID),
    false,
    "LRU 快照过期也不能收走仍在跑后台工作的会话",
  );
  assert.deepEqual([...deactivated].sort(), [IDLE_SESSION_ID, OTHER_SESSION_ID]);
});

test("反面对照：同一条路径上，没有后台工作时该会话会被正常回收", async () => {
  // 唯一变量：hasResidencyBlockingWork 由真变假 ⇒ 回收发生。证明上两例的「不回收」来自闸门本身。
  const facts = new Map([
    [PINNED_SESSION_ID, residencyFacts({ hasResidencyBlockingWork: false, lastActivityAt: 0 })],
  ]);
  const { deactivated, host } = createHost({ facts });
  let now = 1_000_000;
  const pool = new SessionResidentPool(host, {
    highWaterCount: 16,
    idleTimeoutMs: 60_000,
    now: () => now,
  });

  pool.rebalance();
  now += 120_000;
  pool.rebalance();
  await Promise.resolve();
  assert.deepEqual(deactivated, [PINNED_SESSION_ID]);
});
