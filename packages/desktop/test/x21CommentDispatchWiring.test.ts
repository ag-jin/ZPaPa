// eslint-disable-next-line typescript-eslint/triple-slash-reference -- 与 schedulerWakeTick.test.ts 同一处声明（不为本文件另写一份）
/// <reference path="../../services/src/runtime-tools/node-forge.d.ts" />
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  COMMENT_DISPATCH_UNSETTLED_OUTCOMES,
  type CommentDispatchOutcome,
} from "@zcode/services/node";
import {
  commentReceiptSettlementFor,
  isUnsettledCommentDispatchReceipt,
  type SquadDispatchBridgeResult,
} from "../src/host/squadDispatch.js";

/* X2.1 独立复验（test-verifier，2026-10-06）：**接线**那一半。

   实现者的 X2.1 用例钉住了「入口函数体长什么样」（dispatchCommentDispatch 里出现
   runSquadDispatch / trigger:"comment" / eventKey=receipt.dispatchKey）、以及 origin 分流在
   R2 之前。本文件补三处**它们够不到**的接线（每处都对应一个「全绿但功能是死的」形态）：

   ① 组合根有没有把评论派发请求**接上执行体**：`onCommentDispatchRequested: dispatchCommentDispatch`。
      漏了这一格，host 里那条入口写得再对也**永远没人调**；而实现者已有的用例全部只读
      `dispatchCommentDispatch` 的函数体，删掉这行 option 不会让任何一条变红（死接线）。
   ② 组合根有没有把 hub 的请求**按 kind 分流**、且评论支**就地 return**。少了那个 return，
      评论请求会一路落到改派执行体 —— 目标被换成 assignee（§5.2 明令禁止的「@ 当改派」），
      而且因为两边都是「派一次」，没有任何用例会红。
   ③ 评论义务重放有没有**按 receipt 事实重投评论入口**（而不是把义务行当 R2 请求现造 run）：
      义务行的 agentId 是「谁被点名」，只有当它等于 assignee 时 R2 才不老实地「碰巧对」——
      所以这里钉的是「重放体里不出现义务行的 runId/agentId 当派发身份」+「走 runCommentDispatch」。

   最后一节是**行为**断言（纯函数层）：落定映射的像与「未收敛」判据必须自洽 —— 五个终局落点
   不得被判成未收敛（否则已收敛的行会被再次执行），deferred 必须仍是未收敛（等重放通道回写）；
   这条交互实现者的两条用例各自都没断言（一条只测映射、一条只测闭集）。 */

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const readHost = (): string =>
  readFileSync(join(repoRoot, "packages/desktop/src/host/index.ts"), "utf8");
const readServicesNode = (): string =>
  readFileSync(join(repoRoot, "packages/services/src/node.ts"), "utf8");

test("X2.1 接线：组合根把评论派发请求接到 dispatchCommentDispatch（漏接 ⇒ 入口是死的）", () => {
  const host = readHost();
  const start = host.indexOf("createLocalServices({");
  assert.ok(start >= 0, "host 里没有组合根调用（createLocalServices）");
  const end = host.indexOf("activeServices = initializedServices;", start);
  assert.ok(end > start, "找不到组合根调用的结束边界");
  const options = host.slice(start, end);
  assert.match(
    options,
    /onSquadDispatchRequested:\s*dispatchSquadAssignment,/,
    "改派执行体的接线（既有；作为本断言的对照，证明切的是 options 区域）",
  );
  assert.match(
    options,
    /onCommentDispatchRequested:\s*dispatchCommentDispatch,/,
    "评论派发请求必须接上执行体（缺这行 = 评论触发永远不开 run，且所有入口体用例仍然全绿）",
  );
});

test("X2.1 接线：评论在线入口只做转发（身份 = request.dispatchKey，不自己拼派发消息）", () => {
  const host = readHost();
  const start = host.indexOf("async function dispatchCommentDispatch(");
  assert.ok(start >= 0, "host 里没有 dispatchCommentDispatch（评论在线入口）");
  const end = host.indexOf("async function runCommentDispatch(", start);
  assert.ok(end > start, "找不到在线入口的结束边界");
  const body = host.slice(start, end);
  assert.match(
    body,
    /await runCommentDispatch\(squadRuntime, target, request\.dispatchKey\)/,
    "入口必须把请求身份交给唯一执行体（自己拼派发消息 = 绕过 receipt 事实与回写）",
  );
  assert.doesNotMatch(body, /runSquadDispatch\(/, "入口不得自己拼派发消息");
  assert.doesNotMatch(body, /request\.assignee/, "评论请求没有 assignee 这一格");
});

test("X2.1 接线：hub 按 kind 分流且评论支就地 return（否则评论请求落到改派执行体）", () => {
  const src = readServicesNode();
  const start = src.indexOf("squadDispatchRequests.subscribe((request: SquadDispatchRequest) => {");
  assert.ok(start >= 0, "node.ts 里没有派发请求 hub 的订阅");
  const end = src.indexOf("const squadRunSettlements = createSquadRunSettlementHub();", start);
  assert.ok(end > start, "找不到订阅块的结束边界");
  const sub = src.slice(start, end);

  const guardAt = sub.indexOf('request.kind === "comment"');
  const commentCallAt = sub.indexOf("dispatchComment(request)");
  const assignmentAt = sub.indexOf("options?.onSquadDispatchRequested");
  assert.ok(guardAt >= 0, "订阅体必须按 kind 判别评论请求");
  assert.ok(commentCallAt > guardAt, "评论支必须调 onCommentDispatchRequested 的执行体");
  assert.ok(assignmentAt > commentCallAt, "改派执行体只能在评论支之后被读取");
  assert.match(
    sub.slice(commentCallAt, assignmentAt),
    /return;/,
    "评论支必须**就地返回**：少了它，同一请求会继续落到改派执行体（目标被换成 assignee —— §5.2 禁止的「@ 当改派」）",
  );
  assert.doesNotMatch(
    sub.slice(guardAt, commentCallAt),
    /request\.assignee/,
    "评论请求没有 assignee 这一格：在评论支里读它说明请求形状被混用",
  );
});

test("X2.1 接线：评论义务重放按 receipt 事实重投评论入口（不拿义务行现造 run 身份）", () => {
  const host = readHost();
  const start = host.indexOf("async function replayCommentObligation(");
  assert.ok(start >= 0, "host 里没有 replayCommentObligation（评论义务重放通道）");
  const end = host.indexOf("async function dispatchSquadAssignment(", start);
  assert.ok(end > start, "找不到评论义务重放的结束边界");
  const body = host.slice(start, end);
  assert.match(
    body,
    /commentObligationReplayFacts\(/,
    "重放前必须做三条恒等式校验（receipt ↔ 义务）",
  );
  assert.match(
    body,
    /runCommentDispatch\(squadRuntime, target, facts\.dispatchKey\)/,
    "重投必须走评论派发入口，且身份取自 receipt（facts.dispatchKey）",
  );
  assert.doesNotMatch(
    body,
    /eventKey:\s*obligation\.runId/,
    "义务行的 runId 不得直接当派发身份（那是 R2 通道的形状）",
  );
  assert.doesNotMatch(
    body,
    /agentId:\s*obligation\.agentId/,
    "义务行的 agentId 不得直接当派发目标（评论目标 ≠ assignee 是常态格）",
  );
  assert.doesNotMatch(body, /runSquadDispatch\(/, "重放体只能经评论入口转发，不得自己拼派发消息");
  assert.match(body, /outcome: "blocked"/, "评论版 A1 不过时必须落 blocked（可审计收敛，不复活）");
});

test("X2.1 接线：派发桥的等待型/可重试型落点标注（transient 不得记 failed）", () => {
  const host = readHost();
  const start = host.indexOf("async function runSquadDispatch(");
  assert.ok(start >= 0, "host 里没有 runSquadDispatch");
  const end = host.indexOf('parentPort.on("message",', start);
  assert.ok(end > start, "找不到派发桥的结束边界");
  const branch = host.slice(start, end);
  assert.match(
    branch,
    /bridge:\s*error instanceof BoundSessionBusyError \? \{ kind: "deferred" \} : \{ kind: "retry" \}/,
    "忙 ⇒ deferred（等待型，仍可重投）；其余抛错 ⇒ retry（保持未收敛）——两者都不得落 failed",
  );
});

/* ---------- 落定映射 × 未收敛判据：自洽性（行为断言） ---------- */

test("X2.1 自洽：落定映射的五个终局落点不得被判成未收敛；deferred 必须仍可认领", () => {
  // 期望值取需求面字面量（receipt 七值闭集与其中五个终局），不取实现产出的集合。
  const UNSETTLED = ["pending", "deferred"];
  const TERMINAL = ["opened", "queued", "coalesced", "blocked", "failed"];
  assert.deepEqual(
    [...COMMENT_DISPATCH_UNSETTLED_OUTCOMES].sort(),
    [...UNSETTLED].sort(),
    "未收敛集合必须恰是 pending/deferred（其余五值是终局）",
  );

  const terminalBridge: SquadDispatchBridgeResult[] = [
    { kind: "dispatched" },
    { kind: "queued" },
    { kind: "coalesced" },
    { kind: "blocked", reason: "目标已归档" },
    { kind: "failed", error: "数据违例" },
  ];
  const seen: CommentDispatchOutcome[] = [];
  for (const bridge of terminalBridge) {
    const settlement = commentReceiptSettlementFor(bridge);
    assert.ok(settlement !== null, `${bridge.kind} 必须落定（终局结论）`);
    seen.push(settlement.outcome);
    assert.ok(
      TERMINAL.includes(settlement.outcome),
      `${bridge.kind} 的落点必须落在五个终局里（得到 ${settlement.outcome}）`,
    );
    assert.equal(
      isUnsettledCommentDispatchReceipt(settlement.outcome),
      false,
      `${bridge.kind} ⇒ ${settlement.outcome}：终局落点不得被判成未收敛（否则会被再执行一次）`,
    );
  }
  assert.deepEqual(
    [...seen].sort(),
    [...TERMINAL].sort(),
    "五类派发结论 → 五个终局落点，必须一一覆盖",
  );

  // 等待型：落定成 deferred —— 行被写了一次，但**仍在未收敛集合里**，等重放/扫描回写。
  const waiting = commentReceiptSettlementFor({ kind: "deferred" });
  assert.ok(waiting !== null);
  assert.equal(waiting.outcome, "deferred");
  assert.equal(
    isUnsettledCommentDispatchReceipt(waiting.outcome),
    true,
    "deferred 必须仍可认领（否则重放通道回写会被条件更新拒掉）",
  );
  // 可重试型：完全不落定（保持 pending，行停在未收敛态等重投）。
  assert.equal(commentReceiptSettlementFor({ kind: "retry" }), null, "transient 不落定");
  assert.ok(UNSETTLED.includes("pending"), "retry 的落点是 pending —— 它必须在未收敛集合里");
});
