/* 协作域 X1.3：§4.2 触发矩阵 / §4.5 七级级联 / 三件套的**独立验收**用例。
   与 X1.2 的 `commentService.test.ts` 刻意不复用夹具：名册、workspace key、id 生成、时钟、
   workItemId 全部另起一套（`matrix-*` / `mx-*` / 777000），断言只取规格 §4.2/§4.4/§4.5/§8.1/
   §12.1-12 的结论，不复用实现者的中间假设。

   本文件只落「规格明确 + 当前实现成立」的断言；规格留白或与实现存在解释分歧的格子
   （system 父/根锚点的兜底差异、未解析 mention 是否写 suppressed、同目标双源只留一源、
   评论义务与 R2 义务同表无判别列）在 X1.3 报告里登记为发现，不在此处写成「期望」。 */
import assert from "node:assert/strict";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { runTasksDatabaseMigrations } from "../src/session/tasksDatabase/migrations.js";
import { createSquadRuntime } from "../src/workitem/squadRuntime.js";
import { computeCommentDispatchKey } from "../src/workitem/commentDispatchKey.js";
import { createCommentDispatchReceiptRepo } from "../src/workitem/commentDispatchReceiptRepo.js";
import { createCommentService } from "../src/workitem/commentService.js";
import { createSquadDeferredDispatchRepo } from "../src/workitem/squadDeferredDispatchRepo.js";
import { createSquadRunRepo } from "../src/workitem/squadRunRepo.js";
import { createWorkItemActivityRepo } from "../src/workitem/workItemActivityRepo.js";
import { createWorkItemCommentRepo, type AuthorRef } from "../src/workitem/workItemCommentRepo.js";
import { createWorkItemCommentReactionRepo } from "../src/workitem/workItemCommentReactionRepo.js";
import { createWorkItemRepo } from "../src/workitem/workItemRepo.js";
import { makeRepo } from "./helpers/gitFixture.js";

const WS = "matrix-ws";
const WSP = "/tmp/matrix-ws";
const HUMAN: AuthorRef = { kind: "human", id: "mx-human", displayName: "人" };
const SYS: AuthorRef = { kind: "system", id: "mx-system" };
const ANN = "mx-ann"; // 队员 A
const BOB = "mx-bob"; // 队员 B
const LEAD = "mx-lead"; // 队长（小队 Core 的 leaderAgentId）
const SQUAD = "mx-core";
const HUMAN_NAME = "王小明";
const CLOCK = 777_000;

type Harness = ReturnType<typeof matrixHarness>;

function matrixHarness(
  over: {
    gate?: () => boolean;
    rosterAgents?: Array<{ id: string; name: string }>;
    rosterSquads?: Array<{ id: string; name: string; leaderAgentId: string }>;
  } = {},
) {
  const db = new DatabaseSync(":memory:");
  runTasksDatabaseMigrations(db);
  const comments = createWorkItemCommentRepo(db);
  const activities = createWorkItemActivityRepo(db);
  const receipts = createCommentDispatchReceiptRepo(db);
  const runs = createSquadRunRepo(db);
  const deferred = createSquadDeferredDispatchRepo(db);
  const reactions = createWorkItemCommentReactionRepo(db);
  const workItems = createWorkItemRepo(db);
  let seq = 0;
  const service = createCommentService({
    comments,
    activities,
    receipts,
    runs,
    deferred,
    workItems,
    roster: {
      listAgents: () =>
        over.rosterAgents ?? [
          { id: ANN, name: "Ann" },
          { id: BOB, name: "Bob" },
          { id: LEAD, name: "Boss" },
        ],
      listSquads: () => over.rosterSquads ?? [{ id: SQUAD, name: "Core", leaderAgentId: LEAD }],
    },
    readDispatchEnabled: over.gate ?? (() => true),
    humanNames: new Set([HUMAN_NAME]),
    now: () => CLOCK,
    newId: () => `mx-gen-${++seq}`,
  });
  return { db, comments, activities, receipts, runs, deferred, reactions, workItems, service };
}

function putItem(
  h: Harness,
  id: string,
  assignee:
    | { type: "user"; id: string }
    | { type: "agent"; id: string }
    | { type: "squad"; id: string } = {
    type: "agent",
    id: ANN,
  },
): void {
  h.workItems.insert({
    id,
    workspaceIdentity: WS,
    workspacePath: WSP,
    title: `矩阵 ${id}`,
    body: "",
    status: "todo",
    assignee,
    labels: [],
    properties: {},
    position: 0,
  });
}

function putRun(
  h: Harness,
  input: {
    runId: string;
    workItemId: string;
    agentId: string;
    status: "queued" | "open" | "produced" | "rejected";
  },
): void {
  h.runs.insert({
    runId: input.runId,
    workspaceKey: WS,
    workspacePath: WSP,
    workItemId: input.workItemId,
    parentWorkItemId: input.workItemId,
    agentId: input.agentId,
    isLeaderTask: false,
    branch: input.status === "queued" ? null : `squad/member/${input.runId}`,
    dirName: null,
    status: input.status,
    sessionId: null,
    dispatchCause: null,
    causedByRunId: null,
    createdAt: 500,
    updatedAt: 500,
  });
}

/** 写入口的公共入参（每条用例自带 id/body）。 */
function post(
  h: Harness,
  workItemId: string,
  over: Record<string, unknown>,
): ReturnType<typeof h.service.createComment> {
  return h.service.createComment({
    workspaceKey: WS,
    workspacePath: WSP,
    workItemId,
    author: HUMAN,
    initiatedBy: HUMAN,
    ...over,
  } as Parameters<typeof h.service.createComment>[0]);
}

const kinds = (h: Harness, workItemId: string): string[] =>
  h.activities.listByWorkItem(WS, workItemId).map((activity) => activity.kind);

const rowCount = (h: Harness, table: string): number =>
  (h.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;

const workItemRow = (h: Harness, id: string): unknown =>
  h.db.prepare("SELECT * FROM work_items WHERE id = ?").get(id);

const dispatchKey = (workItemId: string, agentId: string, commentId: string): string =>
  computeCommentDispatchKey({ workspaceKey: WS, workItemId, targetAgentId: agentId, commentId });

/* ---------- §4.2 逐行：C/A/D/N-R ---------- */

test("行1 普通人类评论（无 mention、assignee=agent）：C+A+D(issue_assignee 兜底)，本卡不写 run", () => {
  const h = matrixHarness();
  putItem(h, "wi-1");
  const before = workItemRow(h, "wi-1");
  const result = post(h, "wi-1", { id: "m-1", body: "看一下" });
  assert.equal(result.comment.body, "看一下");
  assert.equal(result.comment.command, "none");
  assert.deepEqual(result.comment.mentions, []);
  assert.deepEqual(result.comment.author, HUMAN, "author 展示名快照落库（author_display_name 列）");
  assert.deepEqual(result.dispatches, [
    {
      targetAgentId: ANN,
      source: "issue_assignee",
      outcome: "pending",
      detail: { triggerSource: "issue_assignee" },
    },
  ]);
  assert.deepEqual(kinds(h, "wi-1"), ["comment_created", "comment_dispatch_requested"]);
  const receipt = h.receipts.get(dispatchKey("wi-1", ANN, "m-1"));
  assert.equal(receipt?.outcome, "pending");
  assert.equal(receipt?.source, "issue_assignee");
  assert.equal(receipt?.createdAt, CLOCK);
  assert.equal(rowCount(h, "squad_runs"), 0, "R 列：评论服务绝不自开 run（开跑归 host 派发桥）");
  assert.deepEqual(workItemRow(h, "wi-1"), before, "不改 assignee/status/updated_at");
});

test("行2 普通 agent 评论（作者=assignee 本人，无 mention）：只写 comment_created，零 receipt 零抑制", () => {
  const h = matrixHarness();
  putItem(h, "wi-2", { type: "agent", id: ANN });
  const result = post(h, "wi-2", {
    id: "m-2",
    author: { kind: "agent", id: ANN },
    sourceRun: { runId: "run-m2", agentId: ANN, role: "member" },
    body: "进展：一半",
  });
  assert.deepEqual(result.dispatches, []);
  assert.deepEqual(
    kinds(h, "wi-2"),
    ["comment_created"],
    "agent 评论不参与隐式路由，也没有隐式路由可抑制",
  );
  assert.equal(h.receipts.listByWorkItem(WS, "wi-2").length, 0);
  assert.equal(rowCount(h, "squad_runs"), 0);
  assert.deepEqual(result.comment.sourceRun, { runId: "run-m2", agentId: ANN, role: "member" });
  assert.deepEqual(
    result.comment.author,
    { kind: "agent", id: ANN },
    "服务不替调用方补展示名：author 按入参原样落库",
  );
  // initiatedBy 只落 (kind, id)：displayName 不是身份键，读回不带展示名（X1.3 报告登记为展示面小缺口）。
  assert.deepEqual(result.comment.initiatedBy, { kind: "human", id: HUMAN.id });
});

test("行5/6/7 /note、@all、@人名：抑制事实 + 零 receipt；/note 原文留存、normalized 去前缀", () => {
  const h = matrixHarness();
  putItem(h, "wi-3");
  const note = post(h, "wi-3", { id: "m-note", body: "/note @Ann 记一笔" });
  const noteOnly = post(h, "wi-3", { id: "m-note-only", body: "/note" });
  const all = post(h, "wi-3", { id: "m-all", body: "@all 周知" });
  const human = post(h, "wi-3", { id: "m-human", body: `@${HUMAN_NAME} 你看看` });
  assert.deepEqual(
    [note.dispatches, noteOnly.dispatches, all.dispatches, human.dispatches],
    [[], [], [], []],
  );
  assert.equal(note.comment.command, "note");
  assert.equal(note.comment.body, "/note @Ann 记一笔", "原文（含前缀）逐字节留存（§12.1-4）");
  assert.equal(note.comment.normalizedBody, "@Ann 记一笔", "normalized 去前缀供展示（§12.1-4）");
  assert.equal(noteOnly.comment.command, "note");
  assert.equal(noteOnly.comment.normalizedBody, "");
  assert.deepEqual(
    h.activities
      .listByWorkItem(WS, "wi-3")
      .filter((activity) => activity.kind === "comment_dispatch_suppressed")
      .map((activity) => [activity.commentId, activity.payload["reason"]]),
    [
      ["m-note", "note"],
      ["m-note-only", "note"],
      ["m-all", "all_mention"],
      ["m-human", "human_mention"],
    ],
  );
  assert.equal(
    h.receipts.listByWorkItem(WS, "wi-3").length,
    0,
    "§4.4：/note、@all、@人名绝不产生 dispatch event",
  );
  assert.equal(rowCount(h, "squad_runs"), 0);
  // @all 与显式目标并存：@all 只抑制隐式路由，不吞显式目标（§12.1-3）。
  const both = post(h, "wi-3", { id: "m-all-explicit", body: "@all @Ann 一起" });
  assert.deepEqual(both.dispatches, [
    {
      targetAgentId: ANN,
      source: "mention_agent",
      outcome: "pending",
      detail: { triggerSource: "mention_agent" },
    },
  ]);
  assert.equal(
    h.activities
      .listByWorkItem(WS, "wi-3")
      .filter(
        (activity) =>
          activity.commentId === "m-all-explicit" &&
          activity.kind === "comment_dispatch_suppressed",
      ).length,
    0,
  );
});

test("行4 队长/队员显式 @：三件套 + 一次请求；initiatedBy 沿顶层人类传递；A2A 不自动放大", () => {
  const h = matrixHarness();
  putItem(h, "wi-4", { type: "user", id: HUMAN.id });
  const before = workItemRow(h, "wi-4");
  const sourceRun = { runId: "run-m4", agentId: BOB, squadId: SQUAD, role: "member" } as const;
  const asked = post(h, "wi-4", {
    id: "m-a2a",
    author: { kind: "agent", id: BOB },
    sourceRun,
    initiatedBy: HUMAN,
    body: "请 @Ann 接手",
  });
  assert.deepEqual(asked.dispatches, [
    {
      targetAgentId: ANN,
      source: "mention_agent",
      outcome: "pending",
      detail: { triggerSource: "mention_agent" },
    },
  ]);
  assert.deepEqual(asked.comment.sourceRun, sourceRun);
  assert.deepEqual(
    asked.comment.initiatedBy,
    { kind: "human", id: HUMAN.id },
    "顶层人类归因不得被最后一个 agent 覆盖",
  );
  const acts = h.activities.listByWorkItem(WS, "wi-4");
  assert.deepEqual(
    acts.map((activity) => activity.kind),
    ["comment_created", "comment_mention_parsed", "comment_dispatch_requested"],
  );
  for (const activity of acts) {
    assert.deepEqual(activity.actor, { kind: "agent", id: BOB });
    assert.deepEqual(
      activity.initiatedBy,
      { kind: "human", id: HUMAN.id },
      "每条 Activity 都沿 initiatedBy 传递",
    );
  }
  // Activity.sourceRun 目前只落 run_id（agent/squad/role 三列不存在，读回 role 恒为 "member"）——
  // 这是 X1.3 报告登记的 X0.2 存储面缺口（0011 反向形状），本用例只断言存活的那一半。
  assert.equal(acts[0]!.sourceRun?.runId, sourceRun.runId);
  assert.deepEqual(workItemRow(h, "wi-4"), before, "@ 不改负责人/状态（§5.2：@agent 不等于改派）");

  // 同一 agent 作者、同一线程回复（无 @）⇒ 不参与隐式路由（与 human 对照）。
  post(h, "wi-4", {
    id: "m-a2a-root",
    author: { kind: "agent", id: ANN },
    sourceRun,
    initiatedBy: HUMAN,
    body: "报告",
  });
  const reply = post(h, "wi-4", {
    id: "m-a2a-reply",
    author: { kind: "agent", id: ANN },
    sourceRun,
    initiatedBy: HUMAN,
    parentCommentId: "m-a2a-root",
    body: "补充",
  });
  assert.deepEqual(reply.dispatches, [], "agent 评论不参与 thread_parent 隐式路由");
  assert.equal(h.receipts.listByWorkItem(WS, "wi-4").length, 1, "全库只有显式 @ 那一条 receipt");
});

test("行8 未知 slash command：响亮抛且零事实（comments/activities/receipts 行数不变）", () => {
  const h = matrixHarness();
  putItem(h, "wi-5");
  const before = { c: rowCount(h, "work_item_comments"), a: rowCount(h, "work_item_activities") };
  assert.throws(() => post(h, "wi-5", { id: "m-bad", body: "/clos 试试" }), /未知评论命令/);
  assert.equal(rowCount(h, "work_item_comments"), before.c, "解析失败发生在写任何事实之前");
  assert.equal(rowCount(h, "work_item_activities"), before.a);
  assert.equal(h.receipts.listByWorkItem(WS, "wi-5").length, 0);
  assert.equal(h.comments.get("m-bad"), null);
});

test("行9/10 内联评论：无 mention 走级联、有 @ 走三件套；锚点原样落库不改变触发语义", () => {
  const h = matrixHarness();
  putItem(h, "wi-6", { type: "user", id: HUMAN.id });
  const anchor = { path: "src/a.ts", startLine: 12, startColumn: 3, baseRevision: "abc123" };
  const plain = post(h, "wi-6", { id: "m-inline", body: "这行有问题", inline: anchor });
  assert.deepEqual(plain.dispatches, [], "行9：assignee=user 且无级联命中 ⇒ N");
  assert.deepEqual(plain.comment.inline, anchor, "锚点（含 baseRevision）原样落库");
  assert.deepEqual(kinds(h, "wi-6"), ["comment_created"]);
  const mentioned = post(h, "wi-6", { id: "m-inline-at", body: "请 @Ann 看这行", inline: anchor });
  assert.deepEqual(mentioned.dispatches, [
    {
      targetAgentId: ANN,
      source: "mention_agent",
      outcome: "pending",
      detail: { triggerSource: "mention_agent" },
    },
  ]);
  assert.deepEqual(
    kinds(h, "wi-6").slice(1),
    ["comment_created", "comment_mention_parsed", "comment_dispatch_requested"],
    "行10：内联不抑制触发（评论三件套 + D）",
  );
  assert.deepEqual(mentioned.comment.inline, anchor);
});

test("行11/12 连续评论合并（队列状态窗）：每条 C/A 均留，待开行恒 1，明细逐条留痕", () => {
  const h = matrixHarness();
  putItem(h, "wi-7");
  putRun(h, { runId: "run-q7", workItemId: "wi-7", agentId: ANN, status: "queued" });
  const first = post(h, "wi-7", { id: "m-q1", body: "@Ann 第一条" });
  const second = post(h, "wi-7", { id: "m-q2", body: "@Ann 第二条" });
  assert.deepEqual(first.dispatches, [
    {
      targetAgentId: ANN,
      source: "mention_agent",
      outcome: "coalesced",
      detail: { triggerSource: "mention_agent", targetRunId: "run-q7" },
    },
  ]);
  assert.deepEqual(second.dispatches, first.dispatches, "窗口内第二条并入同一待开 run");
  assert.equal(
    h.receipts.listByWorkItem(WS, "wi-7").length,
    2,
    "两条请求两条 receipt（请求身份各自独立）",
  );
  assert.equal(
    h.runs.listQueued(WS).filter((run) => run.agentId === ANN).length,
    1,
    "待开行至多一个",
  );
  assert.equal(rowCount(h, "squad_runs"), 1, "服务面不自开 run：行数仍是那条排队行");
  const details = h.db
    .prepare(
      "SELECT request_run_id, target_run_id FROM squad_run_coalesced_details ORDER BY request_run_id",
    )
    .all() as Array<{ request_run_id: string; target_run_id: string }>;
  assert.deepEqual(
    details.map((detail) => detail.target_run_id),
    ["run-q7", "run-q7"],
  );
  assert.deepEqual(
    details.map((detail) => detail.request_run_id).sort(),
    [dispatchKey("wi-7", ANN, "m-q1"), dispatchKey("wi-7", ANN, "m-q2")].sort(),
    "并入留痕按请求身份逐条：逻辑 dispatch 合并，评论/Activity 不合并",
  );
  assert.equal(rowCount(h, "work_item_comments"), 2, "评论事实不合并、不丢原文");
  assert.equal(kinds(h, "wi-7").filter((kind) => kind === "comment_created").length, 2);
  assert.equal(kinds(h, "wi-7").filter((kind) => kind === "comment_dispatch_requested").length, 2);
});

test("行13 不同 agent 作者连续评论：按目标各自裁决，不因时间接近跨作者合并", () => {
  const h = matrixHarness();
  putItem(h, "wi-8", { type: "user", id: HUMAN.id });
  putRun(h, { runId: "run-q8", workItemId: "wi-8", agentId: ANN, status: "queued" });
  const byBob = post(h, "wi-8", {
    id: "m-by-bob",
    author: { kind: "agent", id: BOB },
    sourceRun: { runId: "run-b", agentId: BOB, role: "member" },
    body: "@Ann 请接手",
  });
  const byLead = post(h, "wi-8", {
    id: "m-by-lead",
    author: { kind: "agent", id: LEAD },
    sourceRun: { runId: "run-l", agentId: LEAD, role: "leader" },
    body: "@Bob 请接手",
  });
  assert.equal(byBob.dispatches[0]?.outcome, "coalesced", "目标已有待开 ⇒ 并入");
  assert.deepEqual(byLead.dispatches, [
    {
      targetAgentId: BOB,
      source: "mention_agent",
      outcome: "pending",
      detail: { triggerSource: "mention_agent" },
    },
  ]);
  assert.equal(h.receipts.listByWorkItem(WS, "wi-8").length, 2);
  assert.equal(h.runs.listQueued(WS).length, 1, "另一目标不因时间接近被并进别人的待开");
});

test("行14 回复：mention 优先于 thread_parent；人回人不触发也不落兜底", () => {
  const h = matrixHarness();
  putItem(h, "wi-9", { type: "agent", id: ANN });
  post(h, "wi-9", {
    id: "m-root",
    author: { kind: "agent", id: ANN },
    sourceRun: { runId: "run-9", agentId: ANN, role: "member" },
    body: "报告：一半",
  });
  const withMention = post(h, "wi-9", {
    id: "m-rep-mention",
    parentCommentId: "m-root",
    body: "@Bob 帮忙",
  });
  assert.deepEqual(withMention.dispatches, [
    {
      targetAgentId: BOB,
      source: "mention_agent",
      outcome: "pending",
      detail: { triggerSource: "mention_agent" },
    },
  ]);
  assert.equal(withMention.comment.threadId, "m-root", "回复落同一 thread（根 id）");
  const withoutMention = post(h, "wi-9", {
    id: "m-rep-plain",
    parentCommentId: "m-root",
    body: "继续",
  });
  assert.deepEqual(withoutMention.dispatches, [
    {
      targetAgentId: ANN,
      source: "thread_parent",
      outcome: "pending",
      detail: { triggerSource: "thread_parent" },
    },
  ]);
  // 人回人：父作者为人类 ⇒ 零请求，且不落到 assignee 兜底（另起一个 assignee=user 的项，
  // 免得「人类根评论对 agent 指派项的兜底触发」混进本格）。
  putItem(h, "wi-9b", { type: "user", id: HUMAN.id });
  post(h, "wi-9b", { id: "m-human-root", body: "人的根" });
  const humanToHuman = post(h, "wi-9b", {
    id: "m-h2h",
    parentCommentId: "m-human-root",
    body: "人回人",
  });
  assert.deepEqual(humanToHuman.dispatches, []);
  assert.equal(
    h.activities
      .listByWorkItem(WS, "wi-9b")
      .some(
        (activity) =>
          activity.commentId === "m-h2h" && activity.kind === "comment_dispatch_suppressed",
      ),
    false,
    "人回人是不触发（非抑制），不写 suppressed 事实",
  );
  assert.equal(
    h.receipts.listByWorkItem(WS, "wi-9").length,
    2,
    "全库 receipt 只有 mention 与 thread_parent 两条",
  );
  assert.equal(h.receipts.listByWorkItem(WS, "wi-9b").length, 0, "人回人零 receipt");
});

test("行14 软删父评论不算 thread_parent：线程内回复不升格，根 owner agent 接管", () => {
  const h = matrixHarness();
  putItem(h, "wi-10");
  post(h, "wi-10", {
    id: "m-r",
    author: { kind: "agent", id: ANN },
    sourceRun: { runId: "run-10", agentId: ANN, role: "member" },
    body: "根",
  });
  post(h, "wi-10", { id: "m-r2", body: "回复", parentCommentId: "m-r" });
  h.comments.softDelete("m-r2");
  const deep = post(h, "wi-10", { id: "m-r3", body: "再问", parentCommentId: "m-r2" });
  assert.deepEqual(deep.dispatches, [
    {
      targetAgentId: ANN,
      source: "conversation_continuation",
      outcome: "pending",
      detail: { triggerSource: "conversation_continuation" },
    },
  ]);
  assert.equal(deep.comment.threadId, "m-r", "已删父的回复仍是线程内回复，不升格为新请求");
  assert.deepEqual(deep.comment.parentCommentId, "m-r2");
});

test("行15/16 结构面：服务入口是闭集（评论写事实 + 三件套动作，无派发/生命周期写入口）；Activity 事实本身不产生派发", () => {
  const h = matrixHarness();
  putItem(h, "wi-11");
  // 闭集断言：新入口只能经批准名单加入（X1.3 修复轮补三件套动作入口；仍无开 run / 派发 / 会话写入口）。
  assert.deepEqual(
    Object.keys(h.service).sort(),
    ["addCommentReaction", "createComment", "setCommentResolved", "softDeleteComment"],
    "共享沟通会话/系统事实没有第二条写入口经此服务",
  );
  // 行16：直接写系统类 Activity（run/状态/合并事实）——不产生 receipt、不开 run。
  h.activities.add({
    id: "act-sys-1",
    workspaceKey: WS,
    workspacePath: WSP,
    workItemId: "wi-11",
    kind: "run_completed",
    occurredAt: CLOCK,
    actor: SYS,
    initiatedBy: HUMAN,
    payload: { runId: "run-any" },
    dedupKey: "sys:run_completed:1",
    createdAt: CLOCK,
  });
  h.activities.add({
    id: "act-sys-2",
    workspaceKey: WS,
    workspacePath: WSP,
    workItemId: "wi-11",
    kind: "status_changed",
    occurredAt: CLOCK + 1,
    actor: SYS,
    initiatedBy: HUMAN,
    payload: { from: "todo", to: "in_review" },
    dedupKey: "sys:status_changed:1",
    createdAt: CLOCK + 1,
  });
  assert.equal(
    h.receipts.listByWorkItem(WS, "wi-11").length,
    0,
    "Activity 不是执行器：不产生任何 receipt",
  );
  assert.equal(rowCount(h, "squad_runs"), 0);
  assert.deepEqual(kinds(h, "wi-11"), ["run_completed", "status_changed"]);
});

test("三件套动作（软删/解决态/表情回应）均不触发：receipt 与 run 零变化，解决态不动触发语义", () => {
  const h = matrixHarness();
  putItem(h, "wi-12");
  post(h, "wi-12", {
    id: "m-t-root",
    author: { kind: "agent", id: ANN },
    sourceRun: { runId: "run-12", agentId: ANN, role: "member" },
    body: "根",
  });
  const parentRoute = post(h, "wi-12", {
    id: "m-t-reply",
    parentCommentId: "m-t-root",
    body: "回复",
  });
  assert.equal(parentRoute.dispatches[0]?.source, "thread_parent");
  const before = {
    receipts: h.receipts.listByWorkItem(WS, "wi-12").length,
    runs: rowCount(h, "squad_runs"),
  };
  // 线程解决态：置位/取消各一次——不影响任何触发语义（下面这条回复仍走 thread_parent）。
  h.comments.setResolved("m-t-root", true);
  const afterResolved = post(h, "wi-12", {
    id: "m-t-reply-2",
    parentCommentId: "m-t-root",
    body: "解决后回复",
  });
  assert.equal(afterResolved.dispatches[0]?.source, "thread_parent", "解决态不改触发");
  h.comments.setResolved("m-t-root", false);
  h.comments.softDelete("m-t-reply");
  h.reactions.add({
    id: "mx-rx-1",
    workspaceKey: WS,
    commentId: "m-t-root",
    author: HUMAN,
    emoji: "👍",
    createdAt: CLOCK,
  });
  h.reactions.add({
    id: "mx-rx-2",
    workspaceKey: WS,
    commentId: "m-t-root",
    author: HUMAN,
    emoji: "👍",
    createdAt: CLOCK,
  });
  assert.equal(h.reactions.listByComment("m-t-root").length, 1, "(commentId, author, emoji) 幂等");
  assert.equal(
    h.receipts.listByWorkItem(WS, "wi-12").length,
    before.receipts + 1,
    "新增的只是那条「解决后回复」的 receipt",
  );
  assert.equal(rowCount(h, "squad_runs"), before.runs, "三件套不开 run");
});

/* ---------- 边界：多目标 / 同目标双源 / 未解析 / 系统作者 / 门禁翻转 / 幂等 ---------- */

test("多目标并存：@Ann @Bob @Core 三个显式目标三条 receipt；同目标双源合并为一条", () => {
  const h = matrixHarness();
  putItem(h, "wi-13", { type: "user", id: HUMAN.id });
  const three = post(h, "wi-13", { id: "m-three", body: "@Ann @Bob @Core 看一下" });
  assert.deepEqual(three.dispatches, [
    {
      targetAgentId: ANN,
      source: "mention_agent",
      outcome: "pending",
      detail: { triggerSource: "mention_agent" },
    },
    {
      targetAgentId: BOB,
      source: "mention_agent",
      outcome: "pending",
      detail: { triggerSource: "mention_agent" },
    },
    {
      targetAgentId: LEAD,
      source: "mention_squad_leader",
      outcome: "pending",
      detail: { triggerSource: "mention_squad_leader", squadId: SQUAD },
    },
  ]);
  assert.equal(
    h.receipts.listByWorkItem(WS, "wi-13").length,
    3,
    "每目标一条 receipt（§4.3 合并键含目标 agent）",
  );
  assert.equal(rowCount(h, "squad_runs"), 0);

  // 同目标双源：小队的队长就是被显式 @ 的那个人 ⇒ 一份逻辑请求（一条 receipt、两次如实上报）。
  const same = matrixHarness({
    rosterAgents: [
      { id: ANN, name: "Ann" },
      { id: BOB, name: "Bob" },
    ],
    rosterSquads: [{ id: SQUAD, name: "Core", leaderAgentId: ANN }],
  });
  putItem(same, "wi-14", { type: "user", id: HUMAN.id });
  const dup = post(same, "wi-14", { id: "m-dup", body: "@Ann @Core 同一个人" });
  assert.equal(dup.dispatches.length, 2, "两条上报（逐目标）");
  assert.deepEqual(dup.dispatches[0], dup.dispatches[1], "同一目标只留一条事实");
  assert.equal(
    same.receipts.listByWorkItem(WS, "wi-14").length,
    1,
    "目标身份去重：不写第二条 receipt",
  );
});

test("R3 未解析 mention：缺席/重名都不猜身份、不指向任何一侧；显式目标照常命中", () => {
  const h = matrixHarness({
    rosterAgents: [
      { id: ANN, name: "Ann" },
      { id: "mx-dup-1", name: "Dup" },
      { id: "mx-dup-2", name: "Dup" },
    ],
  });
  putItem(h, "wi-15", { type: "user", id: HUMAN.id });
  const ambiguous = post(h, "wi-15", { id: "m-dup", body: "@Dup 看一下" });
  assert.deepEqual(ambiguous.dispatches, [], "重名 ⇒ 不猜：零目标（不落到任何一侧）");
  assert.deepEqual(ambiguous.comment.mentions, [], "未解析项不进 mention 快照（§3.2）");
  const absent = post(h, "wi-15", { id: "m-absent", body: "@Nobody 看一下" });
  assert.deepEqual(absent.dispatches, [], "缺席 + 无 agent 语境 ⇒ 不触发");
  const mixed = post(h, "wi-15", { id: "m-mixed", body: "@Nobody @Ann 一起" });
  assert.deepEqual(mixed.dispatches, [
    {
      targetAgentId: ANN,
      source: "mention_agent",
      outcome: "pending",
      detail: { triggerSource: "mention_agent" },
    },
  ]);
  assert.equal(
    h.receipts.listByWorkItem(WS, "wi-15").length,
    1,
    "未解析项不写 receipt、也不写 suppressed",
  );
  // 未解析项进 comment_mention_parsed 的 payload（解析事实），但不进快照。
  const parsedActivity = h.activities
    .listByWorkItem(WS, "wi-15")
    .find(
      (activity) => activity.kind === "comment_mention_parsed" && activity.commentId === "m-mixed",
    );
  assert.ok(parsedActivity);
  assert.deepEqual(parsedActivity.payload["mentions"], [
    { kind: "unresolved", name: "Nobody", reason: "absent" },
    { kind: "agent", name: "Ann", agentId: ANN },
  ]);
});

test("system 作者：评论可写（可审计），但不参与任何隐式路由、零 receipt", () => {
  const h = matrixHarness();
  putItem(h, "wi-16", { type: "agent", id: ANN });
  const root = post(h, "wi-16", { id: "m-sys", author: SYS, initiatedBy: SYS, body: "系统事实" });
  assert.deepEqual(root.dispatches, []);
  assert.deepEqual(kinds(h, "wi-16"), ["comment_created"]);
  // 系统作者带显式 @：与 agent 作者同规（显式命中仍产生一次请求）。
  const explicit = post(h, "wi-16", {
    id: "m-sys-at",
    author: SYS,
    initiatedBy: HUMAN,
    body: "@Bob 处理",
  });
  assert.deepEqual(explicit.dispatches, [
    {
      targetAgentId: BOB,
      source: "mention_agent",
      outcome: "pending",
      detail: { triggerSource: "mention_agent" },
    },
  ]);
  assert.deepEqual(explicit.comment.initiatedBy, { kind: "human", id: HUMAN.id });
  assert.deepEqual(kinds(h, "wi-16").slice(2), [
    "comment_mention_parsed",
    "comment_dispatch_requested",
  ]);
});

test("门禁关→开（§12.1-12）：关时 blocked 可审计；开后新评论 pending；旧评论重投不改写既存结论", () => {
  let gateOpen = false;
  const h = matrixHarness({ gate: () => gateOpen });
  putItem(h, "wi-17", { type: "user", id: HUMAN.id });
  const blocked = h.service.createComment({
    workspaceKey: WS,
    workspacePath: WSP,
    workItemId: "wi-17",
    id: "m-gate-1",
    author: HUMAN,
    initiatedBy: HUMAN,
    body: "@Ann 帮忙",
    clientRequestId: "mx-req-gate",
  });
  assert.deepEqual(blocked.dispatches, [
    {
      targetAgentId: ANN,
      source: "mention_agent",
      outcome: "blocked",
      detail: { triggerSource: "mention_agent", reason: "dispatch_disabled" },
    },
  ]);
  assert.ok(h.comments.get("m-gate-1"), "评论照写（可审计不可派发）");
  assert.equal(rowCount(h, "squad_runs"), 0);
  assert.equal(rowCount(h, "squad_run_deferred_dispatches"), 0, "被拒目标不登记重放义务");
  const suppressed = h.activities
    .listByWorkItem(WS, "wi-17")
    .find((activity) => activity.kind === "comment_dispatch_suppressed");
  assert.equal(suppressed?.payload["reason"], "blocked");
  // 门禁开：同一评论重投 ⇒ 首写即事实（blocked 不被改写），新评论 ⇒ pending。
  gateOpen = true;
  const retry = h.service.createComment({
    workspaceKey: WS,
    workspacePath: WSP,
    workItemId: "wi-17",
    id: "m-gate-1b",
    author: HUMAN,
    initiatedBy: HUMAN,
    body: "@Ann 帮忙",
    clientRequestId: "mx-req-gate",
  });
  assert.equal(retry.comment.id, "m-gate-1");
  assert.deepEqual(retry.dispatches, blocked.dispatches, "重投不改写既存 blocked 结论");
  const fresh = post(h, "wi-17", { id: "m-gate-2", body: "@Ann 再试" });
  assert.equal(fresh.dispatches[0]?.outcome, "pending");
  assert.equal(h.receipts.listByWorkItem(WS, "wi-17").length, 2);
});

test("幂等（§8.1）：同 clientRequestId 重投（窗口已变为排队）不新增事实、不重裁决、attemptCount 不涨", () => {
  const h = matrixHarness();
  putItem(h, "wi-18");
  const input = {
    workspaceKey: WS,
    workspacePath: WSP,
    workItemId: "wi-18",
    author: HUMAN,
    initiatedBy: HUMAN,
    body: "@Ann 第一次",
    clientRequestId: "mx-req-18",
  } as const;
  const first = h.service.createComment({ ...input, id: "m-18" });
  assert.equal(first.dispatches[0]?.outcome, "pending");
  putRun(h, { runId: "run-q18", workItemId: "wi-18", agentId: ANN, status: "queued" });
  const retry = h.service.createComment({ ...input, id: "m-18-retry" });
  assert.equal(retry.comment.id, "m-18");
  assert.equal(retry.comment.body, "@Ann 第一次", "重投返回既存行，正文不被第二次入参覆盖");
  assert.deepEqual(retry.dispatches, first.dispatches, "既存 receipt 首写即事实，窗口变化不重裁决");
  assert.equal(
    h.receipts.get(dispatchKey("wi-18", ANN, "m-18"))?.attemptCount,
    1,
    "重复调用不累计尝试次数",
  );
  assert.equal(h.receipts.listByWorkItem(WS, "wi-18").length, 1);
  assert.equal(rowCount(h, "work_item_comments"), 1);
  assert.equal(rowCount(h, "squad_run_deferred_dispatches"), 0, "重投不因窗口变化新增义务");
  assert.equal(rowCount(h, "squad_run_coalesced_details"), 0, "重投不新增并入留痕");
  assert.deepEqual(kinds(h, "wi-18"), [
    "comment_created",
    "comment_mention_parsed",
    "comment_dispatch_requested",
  ]);
});

test("行11 同一作者连续普通评论：每条 C/A 均写、不丢原文；服务面不开 run", () => {
  const h = matrixHarness();
  putItem(h, "wi-19");
  const first = post(h, "wi-19", { id: "m-19a", body: "第一句" });
  const second = post(h, "wi-19", { id: "m-19b", body: "第二句" });
  assert.deepEqual(
    [first.comment.body, second.comment.body],
    ["第一句", "第二句"],
    "评论事实不合并、不丢原文",
  );
  assert.equal(rowCount(h, "work_item_comments"), 2);
  assert.equal(kinds(h, "wi-19").filter((kind) => kind === "comment_created").length, 2);
  assert.equal(rowCount(h, "squad_runs"), 0, "服务面绝不自开 run");
  // §4.2 行11 的 D 列写「否」，而 assignee=agent 时 §4.5-7 兜底会对每条各产生一次请求——
  // 规格内部张力，本轮只断言事实面（C/A 逐条 + 不开 run），D 列差异登记在 X1.3 报告缺口表，
  // 待规格裁定（实现不改）。
  assert.deepEqual(
    first.dispatches.map((report) => report.source),
    second.dispatches.map((report) => report.source),
    "两条同形态评论在无窗口变化时结论一致",
  );
});

test("§8.5 workspace identity：跨 workspace 引用响亮拒绝，且不写任何事实", () => {
  const h = matrixHarness();
  h.workItems.insert({
    id: "wi-other",
    workspaceIdentity: "other-ws",
    workspacePath: "/tmp/other",
    title: "别人的项",
    body: "",
    status: "todo",
    assignee: { type: "agent", id: ANN },
    labels: [],
    properties: {},
    position: 0,
  });
  const before = { c: rowCount(h, "work_item_comments"), a: rowCount(h, "work_item_activities") };
  assert.throws(() => post(h, "wi-other", { id: "m-cw", body: "跨 workspace" }), /不一致/);
  assert.equal(rowCount(h, "work_item_comments"), before.c);
  assert.equal(rowCount(h, "work_item_activities"), before.a);
  assert.equal(h.receipts.listByWorkItem(WS, "wi-other").length, 0);
});

/* ---------- 迁移 0012 独立验证（从零 / 老库补跑 / 反向 DDL） ---------- */

function tableColumns(db: DatabaseSync, table: string): string[] {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map(
    (row) => row.name,
  );
}

function indexNames(db: DatabaseSync, like: string): string[] {
  return (
    db
      .prepare("SELECT name FROM sqlite_master WHERE type='index' AND name LIKE ?")
      .all(like) as Array<{ name: string }>
  )
    .map((row) => row.name)
    .sort();
}

const RECEIPT_COLUMNS = [
  "dispatch_key",
  "workspace_key",
  "work_item_id",
  "target_agent_id",
  "comment_id",
  "thread_id",
  "source",
  "outcome",
  "detail_json",
  "attempt_count",
  "created_at",
  "updated_at",
];

test("迁移 0012 从零建库：receipt 表形状 + 两索引 + 主键唯一 + 账本登记", () => {
  const db = new DatabaseSync(":memory:");
  runTasksDatabaseMigrations(db);
  assert.deepEqual(tableColumns(db, "comment_dispatch_receipts"), RECEIPT_COLUMNS);
  assert.deepEqual(indexNames(db, "idx_comment_dispatch_receipts%"), [
    "idx_comment_dispatch_receipts_item",
    "idx_comment_dispatch_receipts_outcome",
  ]);
  const pk = (
    db.prepare("PRAGMA table_info(comment_dispatch_receipts)").all() as Array<{
      name: string;
      pk: number;
    }>
  )
    .filter((column) => column.pk === 1)
    .map((column) => column.name);
  assert.deepEqual(pk, ["dispatch_key"], "主键兜同键重投（不靠先查后插）");
  const ledger = db
    .prepare("SELECT id FROM tasks_schema_migration WHERE id = '0012_comment_dispatch_receipts'")
    .get();
  assert.ok(ledger, "迁移账本必须登记 0012");
  // 主键唯一真的兜底：绕过 repo 直插两次同键 ⇒ 第二次必须被约束拒绝。
  const raw = (key: string) =>
    db
      .prepare(
        `INSERT INTO comment_dispatch_receipts (dispatch_key, workspace_key, work_item_id, target_agent_id,
           comment_id, thread_id, source, outcome, detail_json, attempt_count, created_at, updated_at)
         VALUES (?, 'matrix-ws', 'wi-x', 'a', 'c', 'c', 'issue_assignee', 'pending', '{}', 1, 1, 1)`,
      )
      .run(key);
  raw("dup-key");
  assert.throws(() => raw("dup-key"), /UNIQUE|constraint/i, "主键唯一是存储层最后一道幂等");
});

test("迁移 0009 起的老库补跑（退到 0008 之前形态）：全部补回、结构一致、既有数据一字未动", () => {
  const db = new DatabaseSync(":memory:");
  runTasksDatabaseMigrations(db);
  const fullLedger = db
    .prepare("SELECT id FROM tasks_schema_migration ORDER BY id")
    .all() as Array<{ id: string }>;
  // 本用例只关心「0009 起（含后续新增，如 0014 看门狗）的迁移能完整补跑」：不再钉「最后一条是谁」。
  // 退库：用登记的反向 DDL 把 0009 起（含 0013）建出的对象逐条撤掉 + 删账本行。
  const reverse: Record<string, string[]> = {
    "0009_squad_run_queue": [
      "DROP INDEX idx_squad_runs_one_queued_per_item_agent",
      "DROP INDEX idx_squad_runs_agent_capacity",
      "DROP TABLE squad_run_coalesced_details",
      "DROP TABLE squad_run_deferred_dispatches",
    ],
    "0010_workitem_collaboration": [
      "DROP INDEX idx_work_item_comment_reactions_comment",
      "DROP INDEX idx_work_item_comments_thread",
      "DROP INDEX idx_work_item_comments_item",
      "DROP TABLE work_item_comment_reactions",
      "DROP TABLE work_item_comments",
    ],
    "0011_workitem_activity_decision": [
      "DROP INDEX idx_work_item_decisions_item",
      "DROP INDEX idx_work_item_activities_item",
      "DROP TABLE work_item_decisions",
      "DROP TABLE work_item_activities",
    ],
    "0012_comment_dispatch_receipts": [
      "DROP INDEX idx_comment_dispatch_receipts_outcome",
      "DROP INDEX idx_comment_dispatch_receipts_item",
      "DROP TABLE comment_dispatch_receipts",
    ],
    // 0013（X1.3 修复）：往 0009/0011 建的表上加列，反向 DDL 逐列 DROP。
    "0013_collaboration_source_run_and_origin": [
      "ALTER TABLE squad_run_deferred_dispatches DROP COLUMN origin",
      "ALTER TABLE work_item_activities DROP COLUMN source_run_role",
      "ALTER TABLE work_item_activities DROP COLUMN source_run_squad_id",
      "ALTER TABLE work_item_activities DROP COLUMN source_run_agent_id",
    ],
    // 0014（看门狗 W1）：squad_runs 加 opened_at / settle_reason 两列 + 回填。
    "0014_squad_run_watchdog": [
      "ALTER TABLE squad_runs DROP COLUMN settle_reason",
      "ALTER TABLE squad_runs DROP COLUMN opened_at",
    ],
    // 0015（#6 按 run 用量记账 CT.1）：squad_runs 加 9 个用量列（零回填），反向 DDL 逐列 DROP。
    "0015_squad_run_usage": [
      "ALTER TABLE squad_runs DROP COLUMN usage_recorded_at",
      "ALTER TABLE squad_runs DROP COLUMN usage_model_error_count",
      "ALTER TABLE squad_runs DROP COLUMN usage_model_request_count",
      "ALTER TABLE squad_runs DROP COLUMN usage_cache_read_tokens",
      "ALTER TABLE squad_runs DROP COLUMN usage_cache_creation_tokens",
      "ALTER TABLE squad_runs DROP COLUMN usage_reasoning_tokens",
      "ALTER TABLE squad_runs DROP COLUMN usage_output_tokens",
      "ALTER TABLE squad_runs DROP COLUMN usage_input_tokens",
      "ALTER TABLE squad_runs DROP COLUMN usage_total_tokens",
    ],
    // 0016（#7 交付物 D1a）：只建一张新表 + 两索引（反向 DDL 先索引后表，与 0010/0011/0012 同序）。
    "0016_work_item_deliverables": [
      "DROP INDEX idx_work_item_deliverables_run",
      "DROP INDEX idx_work_item_deliverables_item",
      "DROP TABLE work_item_deliverables",
    ],
    // 0017（#8 PR 关联+快照 D2）：同样只建一张新表 + 两索引（反向 DDL 先索引后表，同 0016 的序）。
    "0017_work_item_pull_requests": [
      "DROP INDEX idx_work_item_pull_requests_pr",
      "DROP INDEX idx_work_item_pull_requests_item",
      "DROP TABLE work_item_pull_requests",
    ],
  };
  const fromIndex = fullLedger.findIndex((row) => row.id === "0009_squad_run_queue");
  /* 自适配守卫：从 0009 起的**每一条**账本迁移都必须登记了反向 DDL，否则退库不完整
     （重跑会撞「duplicate column / table already exists」）——新增迁移忘了登记时先红的是这里。 */
  for (const row of fullLedger.slice(fromIndex))
    assert.ok(reverse[row.id], `迁移 ${row.id} 缺反向 DDL 登记（退库不完整）`);
  // 逆序退库（最后应用的最先撤）：0013 的反向 DDL 引用的表会被 0009/0011 整表 drop。
  for (const row of fullLedger.slice(fromIndex).reverse()) {
    for (const sql of reverse[row.id] ?? []) db.exec(sql);
    db.prepare("DELETE FROM tasks_schema_migration WHERE id = ?").run(row.id);
  }
  // 老库形态：receipt 相关对象必须全部消失（反向 DDL 无漏项），且还留着一条旧数据。
  assert.deepEqual(indexNames(db, "idx_comment_dispatch_receipts%"), []);
  assert.equal(
    (
      db
        .prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name = 'comment_dispatch_receipts'")
        .get() as { n: number }
    ).n,
    0,
  );
  db.prepare(
    `INSERT INTO work_items (id, workspace_key, workspace_path, parent_id, stage, title, body, status,
       assignee_type, assignee_id, labels, properties, position, archived_at, created_at, updated_at)
     VALUES ('legacy-wi', 'matrix-ws', '/tmp/matrix-ws', NULL, NULL, '老项', '', 'todo',
       'user', 'mx-human', '[]', '{}', 0, NULL, 1, 1)`,
  ).run();

  runTasksDatabaseMigrations(db);
  assert.deepEqual(
    (
      db.prepare("SELECT id FROM tasks_schema_migration ORDER BY id").all() as Array<{ id: string }>
    ).map((row) => row.id),
    fullLedger.map((row) => row.id),
    "补跑后账本与「一开始就完整跑满」逐行一致",
  );
  assert.deepEqual(tableColumns(db, "comment_dispatch_receipts"), RECEIPT_COLUMNS);
  assert.deepEqual(indexNames(db, "idx_comment_dispatch_receipts%"), [
    "idx_comment_dispatch_receipts_item",
    "idx_comment_dispatch_receipts_outcome",
  ]);
  // 0013（X1.3 修复）：Activity 补出 sourceRun 全形状三列、义务表补出 origin——老库升级后
  // 与从零建库同形状（列序 = ALTER 追加序）。
  assert.deepEqual(
    tableColumns(db, "work_item_activities").filter((name) => name.startsWith("source_run_")),
    ["source_run_id", "source_run_agent_id", "source_run_squad_id", "source_run_role"],
  );
  assert.ok(
    tableColumns(db, "squad_run_deferred_dispatches").includes("origin"),
    "0013 必须给义务表补出 origin 来源判别列",
  );
  // 既有数据一字未动 + receipt 表在升级后可写。
  assert.equal(
    (db.prepare("SELECT title FROM work_items WHERE id = 'legacy-wi'").get() as { title: string })
      .title,
    "老项",
  );
  const receipts = createCommentDispatchReceiptRepo(db);
  receipts.insertIfAbsent({
    dispatchKey: "legacy-upgrade-key",
    workspaceKey: WS,
    workItemId: "legacy-wi",
    targetAgentId: ANN,
    commentId: "c-legacy",
    threadId: "c-legacy",
    source: "issue_assignee",
    outcome: "pending",
    createdAt: 1,
  });
  assert.equal(receipts.get("legacy-upgrade-key")?.outcome, "pending");
});

/* ---------- 与 C 组（R2）义务的跨组边界：同表同判据 ---------- */

test("跨组边界：评论 deferred 义务（run_id=dispatchKey、cause=NULL）会被 claimDue 一视同仁认领", async () => {
  const repoRoot = await makeRepo();
  const db = new DatabaseSync(":memory:");
  runTasksDatabaseMigrations(db);
  const runtime = await createSquadRuntime({
    db,
    workspacePath: repoRoot,
    workspaceIdentity: WS,
    readExperimentEnabled: () => true,
  });
  const agent = runtime.teamAgentService.create({
    name: "Ann",
    systemPrompt: "s",
    memoryScope: "project",
    maxConcurrentRuns: 1,
  });
  const item = runtime.workItemService.create({
    workspaceIdentity: WS,
    workspacePath: repoRoot,
    title: "跨组边界",
    body: "",
    assignee: { type: "agent", id: agent.id },
  });
  const receipts = createCommentDispatchReceiptRepo(db);
  const comments = createWorkItemCommentRepo(db);
  const activities = createWorkItemActivityRepo(db);
  const reactions = createWorkItemCommentReactionRepo(db);
  const service = createCommentService({
    comments,
    activities,
    receipts,
    reactions,
    runs: runtime.squadRunRepo,
    deferred: runtime.squadDeferredDispatchRepo,
    workItems: runtime.workItemRepo,
    roster: { listAgents: () => [{ id: agent.id, name: "Ann" }], listSquads: () => [] },
    readDispatchEnabled: () => true,
    now: () => CLOCK,
    newId: () => "mx-gen-shared",
  });
  // 活跃 run 占树 ⇒ 评论登记完成重放义务。
  assert.equal(
    (
      await runtime.lifecycle.openMemberRun({
        runId: "run-active-shared",
        workItemId: item.id,
        parentWorkItemId: item.id,
        agentId: agent.id,
        isLeaderTask: false,
      })
    ).kind,
    "opened",
  );
  const result = service.createComment({
    workspaceKey: WS,
    workspacePath: repoRoot,
    workItemId: item.id,
    id: "m-cross",
    author: HUMAN,
    initiatedBy: HUMAN,
    body: "@Ann 帮忙",
  });
  assert.equal(result.dispatches[0]?.outcome, "deferred");
  const key = dispatchKey(item.id, agent.id, "m-cross");
  const obligation = runtime.squadDeferredDispatchRepo.list(WS)[0]!;
  assert.equal(obligation.runId, key, "义务 id 直接就是评论请求身份（来源由 origin 判别）");
  assert.equal(obligation.origin, "comment", "G4 修复后：评论义务带来源判别列（X2.1 据此分流）");
  assert.equal(obligation.dispatchCause, null, "评论成因未扩展（C2 前为 NULL）——判别位是 origin");
  assert.deepEqual(
    runtime.squadDeferredDispatchRepo.claimDue(WS),
    [],
    "活跃 run 占树 ⇒ 不到期（与 R2 判据同一条 SQL）",
  );

  // R2 请求后到（同 (workItem,agent) 已有评论义务）：并入既有义务 —— 留痕指向 comment 请求身份。
  const r2 = await runtime.lifecycle.openMemberRun({
    runId: "run-r2-request",
    workItemId: item.id,
    parentWorkItemId: item.id,
    agentId: agent.id,
    isLeaderTask: false,
    dispatchCause: "user_reassign",
  });
  assert.equal(r2.kind, "deferred");
  const detail = db
    .prepare(
      "SELECT request_run_id, target_run_id FROM squad_run_coalesced_details WHERE request_run_id = 'run-r2-request'",
    )
    .get() as { request_run_id: string; target_run_id: string };
  assert.equal(detail.target_run_id, key, "R2 请求被并进评论请求身份：target 不是任何 run 行");
  assert.equal(
    runtime.squadRunRepo.get("run-r2-request"),
    null,
    "R2 请求自身的 runId 从未落台账（身份丢失）",
  );

  // 活跃 run 收尾 ⇒ 评论义务到期被认领：C 组重放回路会拿它当一次待重放的派发。
  runtime.squadRunRepo.setStatus("run-active-shared", "discarded");
  const claimed = runtime.squadDeferredDispatchRepo.claimDue(WS);
  assert.deepEqual(
    claimed.map((record) => record.runId),
    [key],
    "认领无来源过滤：评论义务与 R2 义务同判据",
  );
  assert.equal(claimed[0]?.dispatchCause, null);
  assert.equal(claimed[0]?.origin, "comment", "认领读回亦带来源判别（消费者不猜）");
  assert.equal(
    runtime.squadRunRepo.get(key),
    null,
    "该身份在 run 台账里没有行：重放只能用 eventKey 现造一条",
  );
  assert.equal(
    receipts.get(key)?.outcome,
    "deferred",
    "认领不清账：receipt 仍停在 deferred（回写归 X2.1）",
  );
});
