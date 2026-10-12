// 重启缺口的只读对账（spec 2026-10-08-subagent-orphan-reconcile 裁决 4 = 4C）。
//
// 为什么这组用例承重：board 台账曾把「协调者轮询先取到结果」记成「通知丢失」，与 durable 事实
// 不符（诊断报告 §2）。对账口径必须是**机械可复算**的只读查询，且只用 durable 残留：
//   ① 投递账本（session_input, kind=backgroundNotification）的状态分布；
//   ② resume 收口残留（discarded/session_resumed = 有投递未消费）；
//   ③ 有终态无通知：child 落过 `subagent_outcome{lost}` 但父侧没有 promoted 的丢失唤醒行。
// 禁止在线阈值（完成事件→通知的滞后 p99 39s / max 80s，任何时间窗判断必假阳）。

import assert from "node:assert/strict";
import test from "node:test";
import type {
  SessionEntryInfo,
  SessionId,
  SessionInfo,
  SessionInputRecord,
  SessionStorePort,
} from "@zcode/contracts";
import { buildRestartGapReconcileReport } from "../src/zcode-protocol/restart-gap-reconcile-report.js";

const PARENT_A = "sess_report_parent_a";
const PARENT_B = "sess_report_parent_b";
const CHILD_LOST = "sess_subagent_agent_report_0001";
const CHILD_WOKEN = "sess_subagent_agent_report_0002";

function sessionInfo(id: string, taskType: string): SessionInfo {
  return {
    id: id as SessionId,
    projectID: "proj_report" as SessionInfo["projectID"],
    taskType,
    slug: "report",
    directory: "/tmp/report",
    title: "report",
    version: "0.0.0-test",
    time: { created: 1, updated: 2 },
  } as SessionInfo;
}

function lostEntry(childSessionId: string): SessionEntryInfo {
  return {
    id: `subagent-outcome:${childSessionId}`,
    sessionID: childSessionId as SessionId,
    type: "subagent_outcome",
    time: { created: 10, updated: 10 },
    data: { status: "lost", reason: "runtime_exit", reconciledAt: new Date(10).toISOString() },
  } as SessionEntryInfo;
}

function ledgerRow(input: {
  id: string;
  sessionID: string;
  status: SessionInputRecord["status"];
  statusReason?: string;
}): SessionInputRecord {
  return {
    id: input.id,
    sessionID: input.sessionID as SessionId,
    kind: "backgroundNotification",
    delivery: "queue",
    payload: { text: "<task-notification></task-notification>" },
    admittedSequence: 0,
    status: input.status,
    ...(input.statusReason ? { statusReason: input.statusReason } : {}),
    time: { created: 1, updated: 2 },
  };
}

function createReportStore(input: {
  inputs: SessionInputRecord[];
  entries: Map<string, SessionEntryInfo[]>;
}): SessionStorePort {
  const sessions = [
    sessionInfo(PARENT_A, "interactive"),
    sessionInfo(PARENT_B, "interactive"),
    sessionInfo(CHILD_LOST, "subagent_child"),
    sessionInfo(CHILD_WOKEN, "subagent_child"),
  ];
  return {
    async listSessions() {
      return sessions;
    },
    async listSessionInputs({ sessionID }: { sessionID: string }) {
      return input.inputs.filter((row) => row.sessionID === sessionID);
    },
    async sessionEntries({ sessionID, type }: { sessionID: string; type?: string }) {
      return (input.entries.get(sessionID) ?? []).filter(
        (entry) => type === undefined || entry.type === type,
      );
    },
  } as unknown as SessionStorePort;
}

test("对账：账本状态分布 + resume 收口残留（只用 durable 事实）", async () => {
  const store = createReportStore({
    inputs: [
      ledgerRow({ id: "runtime_command_1", sessionID: PARENT_A, status: "promoted" }),
      ledgerRow({ id: "runtime_command_2", sessionID: PARENT_A, status: "discarded", statusReason: "session_resumed" }),
      ledgerRow({ id: "runtime_command_3", sessionID: PARENT_B, status: "admitted" }),
      ledgerRow({ id: "runtime_command_4", sessionID: PARENT_B, status: "discarded", statusReason: "user_cleared" }),
    ],
    entries: new Map(),
  });

  const report = await buildRestartGapReconcileReport(store);

  assert.deepEqual(report.ledger, { admitted: 1, promoted: 1, discarded: 2, cancelled: 0, failed: 0 });
  assert.equal(report.resumeDiscarded, 1, "只有 session_resumed 收口算「重启残留」");
  assert.equal(report.sessionsScanned, 4);
});

test("对账：有终态无通知（lost entry ∧ 无 promoted 唤醒行）机械点名", async () => {
  const store = createReportStore({
    inputs: [
      // child 2 的唤醒已交付（promoted）。
      ledgerRow({
        id: `subagent-orphan-wake:${CHILD_WOKEN}`,
        sessionID: PARENT_A,
        status: "promoted",
      }),
      // child 1 的唤醒行还停在 admitted（上一条命令在途 / 被收口）⇒ 计未交付。
      ledgerRow({
        id: `subagent-orphan-wake:${CHILD_LOST}`,
        sessionID: PARENT_B,
        status: "admitted",
      }),
    ],
    entries: new Map([
      [CHILD_LOST, [lostEntry(CHILD_LOST)]],
      [CHILD_WOKEN, [lostEntry(CHILD_WOKEN)]],
    ]),
  });

  const report = await buildRestartGapReconcileReport(store);

  assert.equal(report.lostChildren, 2);
  assert.equal(report.wakeDelivered, 1);
  assert.deepEqual(
    report.wakeMissing,
    [{ childSessionId: CHILD_LOST, wakeStatus: "admitted" }],
    "未交付清单必须逐条点名（board 只消费该输出，不直读 db）",
  );
});
