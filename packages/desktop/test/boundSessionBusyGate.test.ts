import assert from "node:assert/strict";
import test from "node:test";
import {
  BoundSessionBusyError,
  createBoundSessionExecutingProbe,
} from "../src/host/boundSessionBusyGate.js";
import { AUTOMATION_BOUND_SESSION_BUSY_ERROR_CODE } from "@zcode/shared";

/**
 * 定时任务派发的空闲门控契约。
 *
 * 背景（2026-09-27 用户报告）：绑定到会话的定时提醒到点就无条件投递，会话正在执行时
 * 也会插进去，用户要求「不排队、不插队，检测会话停下才执行」。
 *
 * 本测试锁定门控的判定与失败语义：
 *   1. 会话有真实阻塞运行态 → 判为执行中；
 *   2. 无 runtime（ZCODE_AGENT_RUNTIME_UNAVAILABLE）→ 放行，不判忙；
 *   3. 探测异常 → 放行（fail-open），避免一次读取故障永久卡住提醒。
 */

const target = {
  sessionId: "sess_bound_1",
  workspacePath: "/tmp/ws",
};

function probeWith(readSession: (params: unknown) => Promise<unknown>) {
  const warnings: string[] = [];
  return {
    probe: createBoundSessionExecutingProbe({
      agentService: { readSession } as never,
      logWarn: (message) => warnings.push(message),
    }),
    warnings,
  };
}

test("会话有活跃 turn 时判为正在执行", async () => {
  const { probe } = probeWith(async () => ({
    runtime: { activeTurnId: "turn_1" },
    projection: {},
    messages: [],
  }));
  assert.equal(await probe(target), true);
});

test("会话等待权限时同样判为正在执行（阻塞态不只是 active turn）", async () => {
  const { probe } = probeWith(async () => ({
    runtime: {},
    projection: { pendingPermissions: [{ id: "perm_1" }] },
    messages: [],
  }));
  assert.equal(await probe(target), true);
});

test("会话空闲（无活跃 turn / 无阻塞工具）时判为可派发", async () => {
  const { probe } = probeWith(async () => ({
    runtime: {},
    projection: { pendingPermissions: [], activeToolCalls: [] },
    messages: [],
  }));
  assert.equal(await probe(target), false);
});

test("无 runtime 时放行，不把未激活误判成忙", async () => {
  const { probe, warnings } = probeWith(async () => {
    throw Object.assign(new Error("no runtime"), {
      code: "ZCODE_AGENT_RUNTIME_UNAVAILABLE",
    });
  });
  assert.equal(await probe(target), false);
  // 正常路径（会话未激活）不应产生告警噪音。
  assert.equal(warnings.length, 0);
});

test("探测异常时放行并留痕，避免读取故障永久推迟提醒", async () => {
  const { probe, warnings } = probeWith(async () => {
    throw new Error("snapshot exploded");
  });
  assert.equal(await probe(target), false);
  assert.equal(warnings.length, 1);
});

test("忙碌错误带稳定错误码，供 manual 立即运行跨层识别", () => {
  const error = new BoundSessionBusyError("sess_bound_1");
  assert.equal(error.code, AUTOMATION_BOUND_SESSION_BUSY_ERROR_CODE);
  assert.ok(error.message.includes(AUTOMATION_BOUND_SESSION_BUSY_ERROR_CODE));
});
