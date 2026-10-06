// eslint-disable-next-line typescript-eslint/triple-slash-reference -- 与 x21CommentDispatchWiring.test.ts 同一处声明（不为本文件另写一份）
/// <reference path="../../services/src/runtime-tools/node-forge.d.ts" />
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  commentReceiptObligationPairKey,
  commentReceiptSettlementFor,
  decideUnsettledReceiptRedispatch,
} from "../src/host/squadDispatch.js";

/* X2.2 评论回执收敛（实现者轮）：纯函数面（可行为断言）。

   为什么这些判据必须是纯函数（而不是散在 host 的 async 分支里）：补投扫描叠着三条**沉默的**
   判断 —— ① 派发桥的 deferred 里哪一格是「并入既有义务」（应当终局 coalesced，而不是停在 deferred）；
   ② 哪些未收敛 receipt 此刻**不得**重投（会话在执行 / 探测不可得 / 自己的 run 非 open /
   自己的义务还挂着）；③ 哪些历史行可以按合并语义终局收敛。三条错任何一条的表现都是
   「同一条请求跑了两次」或「receipt 永停未收敛」，都不报错。 */

/* ---------- ① 派发桥落点 → receipt outcome：coalesced 携带并入目标 ---------- */

test("X2.2 落定映射：coalesced 携带 coalescedInto（deferred 分支的并入窗口不得记成 deferred）", () => {
  assert.deepEqual(
    commentReceiptSettlementFor({ kind: "coalesced", coalescedInto: "cdk-existing" }),
    { outcome: "coalesced", detail: { coalescedInto: "cdk-existing" } },
    "并入既有义务 ⇒ 终局 coalesced + 并入目标（与源头修同一语义）",
  );
  // 无并入目标的 coalesced（排队分支的形态）保持既有形状（加法：既有断言不变）。
  assert.deepEqual(commentReceiptSettlementFor({ kind: "coalesced" }), { outcome: "coalesced" });
});

/* ---------- ② 未收敛 receipt 的补投判据（D4：防重复 prompt / 防抢通道） ---------- */

const receipt = { dispatchKey: "cdk-1", workItemId: "wi-1", targetAgentId: "ta-1" };
const pairKey = commentReceiptObligationPairKey("wi-1", "ta-1");

const decide = (input: {
  runHistory?: Array<{ runId: string; status: string; sessionId: string | null }>;
  executingSessionIds?: string[];
  sessionProbeAvailable?: boolean;
  obligationsByPair?: Array<[string, string]>;
}) =>
  decideUnsettledReceiptRedispatch({
    receipt,
    runHistory: input.runHistory ?? [],
    executingSessionIds: new Set(input.executingSessionIds ?? []),
    sessionProbeAvailable: input.sessionProbeAvailable ?? true,
    obligationsByPair: new Map(input.obligationsByPair ?? []),
  });

test("X2.2 补投判据：会话在执行 / 探测不可得 / 自己的 run 非 open ⇒ 跳过（防重复 Run）", () => {
  // 自己的 run（runId = dispatchKey）是 open 且绑定会话正在执行 ⇒ 跳过（重发会重复一次 prompt）。
  assert.deepEqual(
    decide({
      runHistory: [{ runId: "cdk-1", status: "open", sessionId: "s-1" }],
      executingSessionIds: ["s-1"],
    }),
    { action: "skip", reason: "session_executing" },
  );
  // 探测能力不可得（agent 服务未注册）：有绑定会话时**不猜**（不可知不重发）。
  assert.deepEqual(
    decide({
      runHistory: [{ runId: "cdk-1", status: "open", sessionId: "s-1" }],
      sessionProbeAvailable: false,
    }),
    { action: "skip", reason: "session_unprobeable" },
  );
  // 自己的 run 已不是 open（排队/已产出/被打回/终态）：执行已发生或已排上，重投会重复 —— 跳过。
  for (const status of ["queued", "produced", "rejected", "merged", "discarded"]) {
    assert.deepEqual(
      decide({ runHistory: [{ runId: "cdk-1", status, sessionId: null }] }),
      { action: "skip", reason: "own_run_not_open" },
      `run 状态 ${status}：不得重投`,
    );
  }
});

test("X2.2 补投判据：可安全补投的两格（崩溃恢复 / 会话空闲）与义务通道归属", () => {
  // 自己的 run 是 open 但未绑会话（崩在「登记台账 → 建会话」之间）⇒ 补投续完原派发。
  assert.deepEqual(decide({ runHistory: [{ runId: "cdk-1", status: "open", sessionId: null }] }), {
    action: "redispatch",
  });
  // 自己的 run open、绑定会话不在执行（重启后）⇒ 补投（resume 后发 prompt）。
  assert.deepEqual(
    decide({
      runHistory: [{ runId: "cdk-1", status: "open", sessionId: "s-1" }],
      executingSessionIds: [],
    }),
    { action: "redispatch" },
  );
  // 无该身份的 run、无义务（transient 失败 / 桥不可用留下的 pending）⇒ 补投。
  assert.deepEqual(decide({}), { action: "redispatch" });
  // 该身份的 run 是别人的（runId 不同）、自己挂着**自己的**义务 ⇒ 义务通道拥有执行，跳过。
  assert.deepEqual(
    decide({
      runHistory: [{ runId: "other-run", status: "open", sessionId: null }],
      obligationsByPair: [[pairKey, "cdk-1"]],
    }),
    { action: "skip", reason: "own_obligation_pending" },
  );
  // 同键义务属于**另一个请求**（X2.2 前的历史行 / 并入窗口）⇒ 按合并语义终局收敛为 coalesced。
  assert.deepEqual(
    decide({
      runHistory: [{ runId: "other-run", status: "open", sessionId: null }],
      obligationsByPair: [[pairKey, "cdk-existing"]],
    }),
    { action: "settle_coalesced", coalescedInto: "cdk-existing" },
  );
  // 键隔离：另一个 (workItem, agent) 的义务不属于本请求。
  assert.notEqual(pairKey, commentReceiptObligationPairKey("wi-2", "ta-1"));
  assert.deepEqual(
    decide({ obligationsByPair: [[commentReceiptObligationPairKey("wi-2", "ta-1"), "cdk-x"]] }),
    { action: "redispatch" },
  );
});

/* ---------- ③ host 接线（结构守卫）：补投挂点、A1 统一、deferred 的并入窗口 ---------- */

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const readHost = (): string => readFileSync(join(repoRoot, "packages/desktop/src/host/index.ts"), "utf8");

test("X2.2 接线：未收敛补投挂进 advanceSquadQueueAfterSettlement（结算事件与启动第四步共用同一实现）", () => {
  const host = readHost();
  // 挂点证明：结算 hub 转到的就是本函数（启动第四步也调它 ⇒ 一个落点覆盖两条触发源）。
  assert.match(
    host,
    /onSquadRunSettled: \(settlement\) =>\s*advanceSquadQueueAfterSettlement\(/,
    "结算事件必须转到推进函数（补投挂在不变量处的前提）",
  );
  const advanceStart = host.indexOf("async function advanceSquadQueueAfterSettlement(");
  const advanceEnd = host.indexOf("async function redispatchUnsettledCommentReceipts(", advanceStart);
  assert.ok(advanceStart >= 0 && advanceEnd > advanceStart, "找不到 advance 函数的边界");
  const advance = host.slice(advanceStart, advanceEnd);
  const obligationAt = advance.indexOf("claimDueSquadDeferredObligations");
  const scanAt = advance.indexOf("redispatchUnsettledCommentReceipts(services, squadRuntime, target);");
  assert.ok(obligationAt >= 0, "义务认领必须在推进函数里（既有回路）");
  assert.ok(scanAt > obligationAt, "补投段必须排在排队/义务臂之后（读到前两段释放后的最新事实）");
  // 启动第四步的落点（同一函数）排在队长和解之后 —— 既有次序契约不动。
  const settleIdx = host.indexOf("await settleStaleLeaderRunsBestEffort(activeServices, candidates);");
  const startupCallIdx = host.indexOf("advanceSquadQueueAfterSettlement(activeServices, target)", settleIdx);
  assert.ok(
    settleIdx >= 0 && startupCallIdx > settleIdx,
    "启动兜底必须经同一实现、且仍在队长和解之后（不得另写一套启动专用补投）",
  );
});

test("X2.2 接线：补投扫描只用服务面读口 + 唯一派发入口，A1 不过 ⇒ blocked（不复活）", () => {
  const host = readHost();
  const start = host.indexOf("async function redispatchUnsettledCommentReceipts(");
  const end = host.indexOf("function commentReplayRejectionReason(", start);
  assert.ok(start >= 0 && end > start, "找不到补投扫描的边界");
  const scan = host.slice(start, end);
  assert.match(scan, /listUnsettledCommentDispatchReceipts\(target\)/, "取数经服务面只读口（不直连 repo）");
  assert.match(scan, /decideUnsettledReceiptRedispatch\(\{/, "跳过/重投必须走纯函数判据（不在扫描里手写）");
  assert.match(scan, /sessionProbeAvailable: probe !== undefined/, "探测能力必须如实交给判据（不可得时不猜）");
  assert.match(scan, /await runCommentDispatch\(squadRuntime, target, receipt\.dispatchKey\)/, "重投走评论派发唯一入口");
  assert.doesNotMatch(scan, /runSquadDispatch\(/, "补投不得自己拼派发消息（绕过 receipt 事实与落定）");
  assert.match(scan, /outcome: "blocked"/, "A1 重验不过必须落 blocked（可审计收敛，不复活）");
  assert.match(scan, /reason: rejection/, "blocked 原因取 A1 判据的结论（同一事实同一文案）");

  // A1 判据与原因文案：唯一实现，且工作项缺失用的是稳定原因码。
  const helperStart = host.indexOf("function commentReplayRejectionReason(");
  const helperEnd = host.indexOf("\n}", helperStart);
  const helper = host.slice(helperStart, helperEnd);
  assert.match(helper, /return WORK_ITEM_MISSING_REASON;/, "工作项缺失的稳定原因码只有一处");
  assert.match(helper, /isTerminalWorkItemStatus\(workItem\.status\)/, "终态必须拦下（不复活）");
  assert.match(helper, /workItem\.archivedAt !== undefined/, "归档必须拦下（不复活）");
});

test("X2.2 接线：评论派发入口按 dispatchKey 在途去重（在线/重放/补投并发不重复建 run）", () => {
  const host = readHost();
  const start = host.indexOf("async function runCommentDispatch(");
  const end = host.indexOf("async function performCommentDispatch(", start);
  assert.ok(start >= 0 && end > start, "找不到评论派发入口与执行体的边界");
  const wrapper = host.slice(start, end);
  assert.match(wrapper, /commentDispatchInFlight\.has\(dispatchKey\)/, "在途相同请求必须被识别");
  assert.match(wrapper, /commentDispatchInFlight\.add\(dispatchKey\)/, "进入执行前必须占位");
  assert.match(
    wrapper,
    /finally \{[\s\S]*commentDispatchInFlight\.delete\(dispatchKey\)/,
    "执行结束（含抛错）必须释放占位",
  );
  assert.match(
    wrapper,
    /await performCommentDispatch\(squadRuntime, target, dispatchKey\)/,
    "去重后仍走同一执行体（不得另开路径）",
  );
});

test("X2.2 接线：派发桥 deferred 分支按 coalescedInto 分流（并入别的请求 ⇒ 终局 coalesced），工作项缺失统一 blocked", () => {
  const host = readHost();
  const start = host.indexOf("async function runSquadDispatch(");
  const end = host.indexOf('parentPort.on("message",', start);
  assert.ok(start >= 0 && end > start, "找不到派发桥的边界");
  const bridge = host.slice(start, end);
  assert.match(
    bridge,
    /coalescedInto !== undefined && coalescedInto !== eventKey/,
    "并入窗口必须区分「并入别的请求」与「命中自己登记的义务」",
  );
  assert.match(bridge, /bridge: \{ kind: "coalesced", coalescedInto \}/, "并入别的请求 ⇒ 终局 coalesced 携带目标");
  assert.match(
    bridge,
    /kind: "blocked",\s*reason: WORK_ITEM_MISSING_REASON/,
    "工作项查不到 ⇒ 与义务重放同一终局 blocked（不得记 failed）",
  );
});
