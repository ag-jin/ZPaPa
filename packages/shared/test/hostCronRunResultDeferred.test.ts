import assert from "node:assert/strict";
import test from "node:test";
import { hostResponseMessageSchema } from "../src/validation.js";

/**
 * `deferred` 派发结果的 wire 契约。
 *
 * main 侧用 hostResponseMessageSchema 校验 host 消息，校验失败会**静默丢弃**整条消息
 * （desktopHostProcess 的 on("message") 直接 return）。因此 deferred 若不进 schema，
 * 「会话忙 → 等待重投」会在半路消失：scheduler 收不到结算，automation 一直停在 claimed，
 * 直到 10 分钟 stale 回收才发现——用户看到的是提醒既不投递也不重试。
 */
test("cron-run-result 接受 deferred，保证等待重投能穿过 main 的校验", () => {
  const parsed = hostResponseMessageSchema.safeParse({
    type: "cron-run-result",
    runId: "automation-1:1700000000000",
    ok: false,
    error: "automation bound session is executing",
    failureKind: "deferred",
  });
  assert.equal(parsed.success, true);
});

test("cron-run-result 既有的 transient/permanent 语义不变", () => {
  for (const failureKind of ["transient", "permanent"]) {
    const parsed = hostResponseMessageSchema.safeParse({
      type: "cron-run-result",
      runId: "automation-1:1700000000000",
      ok: false,
      failureKind,
    });
    assert.equal(parsed.success, true, `failureKind=${failureKind} 应保持可解析`);
  }
});

test("未知 failureKind 仍被拒绝，不放宽既有校验强度", () => {
  const parsed = hostResponseMessageSchema.safeParse({
    type: "cron-run-result",
    runId: "automation-1:1700000000000",
    ok: false,
    failureKind: "not_a_real_kind",
  });
  assert.equal(parsed.success, false);
});
