import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { runTasksDatabaseMigrations } from "../src/session/tasksDatabase/migrations.js";
import { createCommentDispatchReceiptRepo } from "../src/workitem/commentDispatchReceiptRepo.js";
import { createCommentService, type CommentServiceDeps } from "../src/workitem/commentService.js";
import { createSquadDeferredDispatchRepo } from "../src/workitem/squadDeferredDispatchRepo.js";
import { createSquadRunRepo } from "../src/workitem/squadRunRepo.js";
import { createWorkItemActivityRepo } from "../src/workitem/workItemActivityRepo.js";
import { createWorkItemCommentRepo, type AuthorRef } from "../src/workitem/workItemCommentRepo.js";
import { createWorkItemCommentReactionRepo } from "../src/workitem/workItemCommentReactionRepo.js";
import { createWorkItemRepo } from "../src/workitem/workItemRepo.js";
import { createSqliteTransact } from "../src/workitem/sqliteTransact.js";

/* 协作域 G8（§8.3）：Comment 与 receipt 的**同事务**边界。
   §8.3 原文要的是「事实已落库则请求可重放」的事务边界，x22 收官把显式事务包裏登记为缓办；
   本卡补上：`createComment` 的「评论落库 → Activity → 裁决读窗 → receipt 落库」整段在显式事务内，
   `transact` 由组合根注入（生产 = tasks-index 同一连接上的 BEGIN IMMEDIATE）。

   本文件是**事务契约**的用例，不重复 commentService.test.ts 的编排矩阵：
   · seam ①：注入的 `transact` 恰被调用一次，且写入/读窗全在它的回调内、外发全在它之后；
   · seam ②：中途抛错 ⇒ 评论 / Activity / receipt 三类行数全为零（真 sqlite + 真事务）；
   · seam ③：真并发的状态窗裁决不双写（两连接同库文件）。 */

const HUMAN: AuthorRef = { kind: "human", id: "local-user" };
const AGENT = "ta-ann";
const WS = { key: "ws-tx", path: "/tmp/ws-tx" };

type Recorder = {
  /** 按发生次序记录「事务内 / 事务外」：`in:` = transact 回调尚未返回。 */
  events: string[];
  transactCalls: number;
};

/**
 * 记录事务窗口的夹具：真 repo（真 sqlite）外面套一层「记账」包装，
 * `transact` 是测试替身（identity + 进出窗口计数）——它必须被 createComment 调用，
 * 且调用它的那一次必须把**全部**写入与读窗包住（断言见下）。
 */
function recordingHarness(over: Partial<CommentServiceDeps> = {}) {
  const db = new DatabaseSync(":memory:");
  runTasksDatabaseMigrations(db);
  const recorder: Recorder = { events: [], transactCalls: 0 };
  let depth = 0;
  const note = (name: string): void => {
    recorder.events.push(`${depth > 0 ? "in" : "out"}:${name}`);
  };

  const baseComments = createWorkItemCommentRepo(db);
  const baseActivities = createWorkItemActivityRepo(db);
  const baseReceipts = createCommentDispatchReceiptRepo(db);
  const baseRuns = createSquadRunRepo(db);
  const baseDeferred = createSquadDeferredDispatchRepo(db);
  const workItems = createWorkItemRepo(db);
  workItems.insert({
    id: "wi-tx",
    workspaceIdentity: WS.key,
    workspacePath: WS.path,
    title: "事务用例工作项",
    body: "",
    status: "todo",
    assignee: { type: "agent", id: AGENT },
    labels: [],
    properties: {},
    position: 0,
  });

  const published: string[] = [];
  let seq = 0;
  const service = createCommentService({
    comments: {
      ...baseComments,
      add: (input) => {
        note("comments.add");
        return baseComments.add(input);
      },
    },
    activities: {
      ...baseActivities,
      add: (input) => {
        note(`activities.add:${input.kind}`);
        return baseActivities.add(input);
      },
    },
    receipts: {
      ...baseReceipts,
      insertIfAbsent: (input) => {
        note("receipts.insertIfAbsent");
        return baseReceipts.insertIfAbsent(input);
      },
    },
    reactions: createWorkItemCommentReactionRepo(db),
    runs: {
      ...baseRuns,
      hasQueuedRunForPair: (workspaceKey, workItemId, agentId) => {
        note("runs.hasQueuedRunForPair");
        return baseRuns.hasQueuedRunForPair(workspaceKey, workItemId, agentId);
      },
      hasActiveRunForPair: (workspaceKey, workItemId, agentId) => {
        note("runs.hasActiveRunForPair");
        return baseRuns.hasActiveRunForPair(workspaceKey, workItemId, agentId);
      },
    },
    deferred: baseDeferred,
    workItems,
    roster: { listAgents: () => [{ id: AGENT, name: "ann" }], listSquads: () => [] },
    readDispatchEnabled: () => true,
    publishDispatchRequest: (request) => {
      note("publishDispatchRequest");
      published.push(request.dispatchKey);
    },
    newId: () => `gen-${++seq}`,
    now: () => 1000,
    transact: <T>(fn: () => T): T => {
      recorder.transactCalls += 1;
      depth += 1;
      try {
        return fn();
      } finally {
        depth -= 1;
      }
    },
    ...over,
  });
  return { db, service, recorder, published };
}

test("事务边界｜写入与读窗全在注入的 transact 回调内，外发在它之后（恰一次包裹）", () => {
  const h = recordingHarness();
  const result = h.service.createComment({
    id: "c-tx",
    workspaceKey: WS.key,
    workspacePath: WS.path,
    workItemId: "wi-tx",
    author: HUMAN,
    initiatedBy: HUMAN,
    body: "@ann 看一下",
  });

  assert.equal(
    result.dispatches[0]!.outcome,
    "pending",
    "前置：本用例走「有目标 ⇒ 落 receipt」路径",
  );
  assert.equal(
    h.recorder.transactCalls,
    1,
    "createComment 恰调用一次注入的事务口（不是零次，也不是两次）",
  );
  const outs = h.recorder.events.filter((event) => event.startsWith("out:"));
  assert.deepEqual(
    outs,
    ["out:publishDispatchRequest"],
    "只有外发发生在事务之外：写入与队列状态窗的读+写都必须在同一个事务回调内" +
      "（外发在提交之后，消费者读库才不会读到尚未提交的 receipt）",
  );
  assert.deepEqual(
    h.recorder.events.filter((event) => event.startsWith("in:")),
    [
      "in:comments.add",
      "in:activities.add:comment_created",
      "in:activities.add:comment_mention_parsed",
      "in:runs.hasQueuedRunForPair",
      "in:runs.hasActiveRunForPair",
      "in:receipts.insertIfAbsent",
      "in:activities.add:comment_dispatch_requested",
    ],
    "写入与裁决读窗的次序原样（事务只加边界，不重排事实）",
  );
});

/** 三张表的行数（裸 SQL：断言不消费服务返回的包装形状）。 */
function tableCounts(db: DatabaseSync): { comments: number; activities: number; receipts: number } {
  const count = (table: string): number =>
    (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
  return {
    comments: count("work_item_comments"),
    activities: count("work_item_activities"),
    receipts: count("comment_dispatch_receipts"),
  };
}

/**
 * 原子性夹具：真 sqlite + 真事务（组合根的 `createSqliteTransact`），**receipt 落库那一步抛**
 * ——它前面已经写过评论行与两条 Activity（comment_created / comment_mention_parsed），
 * 正是「写到一半崩」的最长路径。
 */
function atomicityHarness(options: { failAtReceipt: boolean }) {
  const db = new DatabaseSync(":memory:");
  runTasksDatabaseMigrations(db);
  const baseReceipts = createCommentDispatchReceiptRepo(db);
  const workItems = createWorkItemRepo(db);
  workItems.insert({
    id: "wi-tx",
    workspaceIdentity: WS.key,
    workspacePath: WS.path,
    title: "原子性工作项",
    body: "",
    status: "todo",
    assignee: { type: "agent", id: AGENT },
    labels: [],
    properties: {},
    position: 0,
  });
  const published: string[] = [];
  let seq = 0;
  const service = createCommentService({
    comments: createWorkItemCommentRepo(db),
    activities: createWorkItemActivityRepo(db),
    receipts: options.failAtReceipt
      ? {
          ...baseReceipts,
          insertIfAbsent: (input) => {
            baseReceipts.insertIfAbsent(input); // 真的写进去了 —— 随后崩溃
            throw new Error("模拟崩溃：receipt 落库之后进程死掉（本行由测试注入）");
          },
        }
      : baseReceipts,
    reactions: createWorkItemCommentReactionRepo(db),
    runs: createSquadRunRepo(db),
    deferred: createSquadDeferredDispatchRepo(db),
    workItems,
    roster: { listAgents: () => [{ id: AGENT, name: "ann" }], listSquads: () => [] },
    readDispatchEnabled: () => true,
    publishDispatchRequest: (request) => published.push(request.dispatchKey),
    newId: () => `gen-${++seq}`,
    now: () => 1000,
    transact: createSqliteTransact(db),
  });
  return { db, service, published };
}

test("原子性｜写入途中抛错 ⇒ 评论 / Activity / receipt 三类行数全为零（真事务回滚）", () => {
  const h = atomicityHarness({ failAtReceipt: true });
  assert.throws(
    () =>
      h.service.createComment({
        id: "c-atomic",
        workspaceKey: WS.key,
        workspacePath: WS.path,
        workItemId: "wi-tx",
        author: HUMAN,
        initiatedBy: HUMAN,
        body: "@ann 这条写不完",
      }),
    /模拟崩溃/,
    "注入的失败必须原样冒到调用方（事务不吞异常）",
  );
  assert.deepEqual(
    tableCounts(h.db),
    { comments: 0, activities: 0, receipts: 0 },
    "半条事实一律不留：评论、Activity、receipt 全部随事务回滚",
  );
  assert.deepEqual(h.published, [], "回滚的事实不得外发派发请求");
});

test("原子性对照｜同一夹具不注入失败 ⇒ 三张表各就各位（零行不是夹具自身的产物）", () => {
  const h = atomicityHarness({ failAtReceipt: false });
  const result = h.service.createComment({
    id: "c-atomic",
    workspaceKey: WS.key,
    workspacePath: WS.path,
    workItemId: "wi-tx",
    author: HUMAN,
    initiatedBy: HUMAN,
    body: "@ann 这条写得完",
  });
  assert.equal(result.dispatches[0]!.outcome, "pending");
  assert.deepEqual(
    tableCounts(h.db),
    { comments: 1, activities: 3, receipts: 1 },
    "对照：comment_created + comment_mention_parsed + comment_dispatch_requested 三条 Activity",
  );
  assert.equal(h.published.length, 1, "提交之后外发一次 pending 请求");
});

test("并发窗｜队列状态窗的读在写锁内：另一连接在裁决读窗期间拿不到写锁", () => {
  /* 这条断言证的是 §8.3 的**附带收益**：状态窗的「读 + 写」在同一把 IMMEDIATE 锁里 ——
     读窗期间另一条连接（多窗口 Host 的另一窗口）拿不到写锁，故「读到无排队行 ⇒ 写 pending」
     不可能被别的窗口插进中间。探针放在 `hasQueuedRunForPair` 里：那一刻事务已 BEGIN IMMEDIATE、
     裁决尚未落 receipt。 */
  const dir = mkdtempSync(join(tmpdir(), "zcode-comment-tx-"));
  const file = join(dir, "tasks-index.sqlite");
  try {
    const dbA = new DatabaseSync(file);
    runTasksDatabaseMigrations(dbA);
    const workItems = createWorkItemRepo(dbA);
    workItems.insert({
      id: "wi-tx",
      workspaceIdentity: WS.key,
      workspacePath: WS.path,
      title: "并发窗工作项",
      body: "",
      status: "todo",
      assignee: { type: "agent", id: AGENT },
      labels: [],
      properties: {},
      position: 0,
    });
    const dbB = new DatabaseSync(file);
    dbB.exec("PRAGMA busy_timeout = 50"); // 探针不等待：拿不到锁就当场报 BUSY

    const baseRuns = createSquadRunRepo(dbA);
    let probe: { acquired: boolean; error: unknown } | null = null;
    let seq = 0;
    const service = createCommentService({
      comments: createWorkItemCommentRepo(dbA),
      activities: createWorkItemActivityRepo(dbA),
      receipts: createCommentDispatchReceiptRepo(dbA),
      reactions: createWorkItemCommentReactionRepo(dbA),
      runs: {
        ...baseRuns,
        hasQueuedRunForPair: (workspaceKey, workItemId, agentId) => {
          if (probe === null) {
            try {
              dbB.exec("BEGIN IMMEDIATE");
              dbB.exec("ROLLBACK");
              probe = { acquired: true, error: null };
            } catch (error) {
              probe = { acquired: false, error };
            }
          }
          return baseRuns.hasQueuedRunForPair(workspaceKey, workItemId, agentId);
        },
      },
      deferred: createSquadDeferredDispatchRepo(dbA),
      workItems,
      roster: { listAgents: () => [{ id: AGENT, name: "ann" }], listSquads: () => [] },
      readDispatchEnabled: () => true,
      newId: () => `gen-${++seq}`,
      now: () => 1000,
      transact: createSqliteTransact(dbA),
    });
    service.createComment({
      id: "c-lock",
      workspaceKey: WS.key,
      workspacePath: WS.path,
      workItemId: "wi-tx",
      author: HUMAN,
      initiatedBy: HUMAN,
      body: "@ann 看一下",
    });

    assert.ok(probe !== null, "探针必须被触发（否则本断言空转）");
    assert.equal(
      probe.acquired,
      false,
      "裁决读窗期间另一连接不得拿到写锁：否则「读到无排队行 ⇒ 写 pending」会被跨窗口的写插进中间",
    );
    assert.match(
      String((probe as { error: unknown }).error),
      /SQLITE_BUSY|database is locked/i,
      "另一连接拿到的是「库被写锁占住」这一种失败，而不是别的错误",
    );
    // 事务提交之后锁即释放：另一连接此刻能正常起事务。
    dbB.exec("BEGIN IMMEDIATE");
    dbB.exec("ROLLBACK");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
