// `zcode reconcile-report`（spec 2026-10-08-subagent-orphan-reconcile 裁决 4 = 4C）的命令面。
//
// 断言对象是「board / 人只消费 CLI 输出」这条 seam：命令只读、只打印 durable 事实与机械结论
// （账本分布 / resume 收口残留 / 有终态无通知清单），不做在线阈值判断、不产生任何写。

import assert from "node:assert/strict";
import test from "node:test";
import { runReconcileReportCommand } from "../src/reconcile-report-command.js";

function createRunContext() {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    ctx: {
      stdout: { write: (chunk: string) => stdout.push(chunk) },
      stderr: { write: (chunk: string) => stderr.push(chunk) },
    },
    stdout,
    stderr,
  };
}

const REPORT = {
  generatedAt: "2026-10-12T00:00:00.000Z",
  sessionsScanned: 12,
  ledger: { admitted: 1, promoted: 5, discarded: 2, cancelled: 0, failed: 0 },
  resumeDiscarded: 1,
  lostChildren: 2,
  wakeDelivered: 1,
  wakeMissing: [{ childSessionId: "sess_subagent_agent_x", wakeStatus: "admitted" }],
};

test("reconcile-report：文本输出逐条陈述 durable 事实并点名未交付唤醒", async () => {
  const { ctx, stdout } = createRunContext();

  const code = await runReconcileReportCommand(
    ctx as never,
    { json: false } as never,
    { readReport: async () => REPORT as never },
  );

  assert.equal(code, 0);
  const text = stdout.join("");
  assert.match(text, /promoted \(delivered\): 5/);
  assert.match(text, /resume-swept: 1/);
  assert.match(text, /lost_children: 2/);
  assert.match(text, /wake_missing: 1/);
  assert.match(text, /sess_subagent_agent_x \(wake ledger status: admitted\)/);
  assert.match(text, /no causal attribution/, "不许做「通知丢失」类因果归因/阈值判断");
});

test("reconcile-report：--json 输出可机读结果（board 消费面）", async () => {
  const { ctx, stdout } = createRunContext();

  const code = await runReconcileReportCommand(
    ctx as never,
    { json: true } as never,
    { readReport: async () => REPORT as never },
  );

  assert.equal(code, 0);
  assert.deepEqual(JSON.parse(stdout.join("")), REPORT);
});

test("reconcile-report：读失败 ⇒ 非零退出并把错误写到 stderr", async () => {
  const { ctx, stderr } = createRunContext();

  const code = await runReconcileReportCommand(
    ctx as never,
    { json: false } as never,
    {
      readReport: async () => {
        throw new Error("store unavailable");
      },
    },
  );

  assert.equal(code, 1);
  assert.match(stderr.join(""), /reconcile-report failed: store unavailable/);
});
