import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { DatabaseSync } from "node:sqlite";
import { runTasksDatabaseMigrations } from "../src/session/tasksDatabase/migrations.js";
import { createCommentDispatchReceiptRepo } from "../src/workitem/commentDispatchReceiptRepo.js";
import { createCommentService } from "../src/workitem/commentService.js";
import { createSquadDeferredDispatchRepo } from "../src/workitem/squadDeferredDispatchRepo.js";
import { createSquadRunRepo } from "../src/workitem/squadRunRepo.js";
import { createWorkItemActivityRepo } from "../src/workitem/workItemActivityRepo.js";
import { createWorkItemCommentReactionRepo } from "../src/workitem/workItemCommentReactionRepo.js";
import { createWorkItemCommentRepo } from "../src/workitem/workItemCommentRepo.js";
import { createWorkItemRepo } from "../src/workitem/workItemRepo.js";

/* C3.1：决定写入面的**结构负向守卫**（任务卡 §4.4 G1–G7）+ steering 边界（规格 §6 / 主会话裁定
   「C3 的 steering 新增面 = 零」）。

   为什么用源码扫描：本卡的核心承诺不是「决定服务不派发」这句注释，而是**依赖集封顶**——
   WorkItemDecisionService 只拿 decisions/activities/workItems，结构上碰不到 run/receipt/义务/状态机。
   类型能挡住构造，但挡不住有人从 JS 侧或后续改了类型就注入——故这里在源码层再兜一道，
   扫描的 token 一律是**语义 token**（不对空白敏感；fmt 往返不误红，§6.1 末段）。 */

const SRC_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../src");
const WORKITEM_DIR = resolve(SRC_ROOT, "workitem");

const readSource = (file: string) => readFileSync(resolve(SRC_ROOT, file), "utf8");
/** 去注释再扫（文件头注释里可能引用这些词作为「不得出现」的说明）。 */
const stripComments = (source: string) =>
  source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

const DECISION_SERVICE_SRC = readSource("workitem/workItemDecisionService.ts");
const DECISION_SERVICE_CODE = stripComments(DECISION_SERVICE_SRC);
const FACADE_CODE = stripComments(readSource("workitem/workItemCollaborationService.ts"));

test("G1｜决定服务零生命周期/零派发：拿不到也调不动开 run / 队长登记 / 派发规划 / 义务", () => {
  for (const forbidden of [
    "openMemberRun",
    "recordLeaderRun",
    "planDispatch",
    "discardBatch",
    "settleCommentDispatchReceipt",
    "settleStatus",
    "assertDispatchEnabled",
    "publishDispatchRequest",
  ]) {
    assert.ok(
      !DECISION_SERVICE_CODE.includes(forbidden),
      `workItemDecisionService.ts 不得出现 ${forbidden}（决定不派发：结构上就没有这些依赖）`,
    );
  }
});

test("G2｜决定服务零状态写：不碰 transition / updateStatus / workItemService / 工作项 SQL", () => {
  for (const forbidden of ["transition", "updateStatus", "UPDATE work_items", "workItemService"]) {
    assert.ok(
      !DECISION_SERVICE_CODE.includes(forbidden),
      `workItemDecisionService.ts 不得出现 ${forbidden}（状态的唯一写者是 WorkItemService.transition，§5.2）`,
    );
  }
});

test("G3｜steering 边界（负向）：决定服务与门面都不触碰 steer / CommandInbox / admission 面", () => {
  for (const forbidden of [
    "CommandInbox",
    "steer",
    "followupMode",
    "requestedDelivery",
    "admissionSeq",
    "interactionBehavior",
  ]) {
    for (const [name, code] of [
      ["workItemDecisionService.ts", DECISION_SERVICE_CODE],
      ["workItemCollaborationService.ts", FACADE_CODE],
    ] as const) {
      assert.ok(
        !code.includes(forbidden),
        `${name} 不得出现 ${forbidden}：C3 的 steering 新增面 = 零（steering 是既有 turn-steer 一等公民，` +
          "协作域不重造、不在详情页造第二套 admission）",
      );
    }
  }
});

test("G4｜门面零 SQL / 零第二写口（沿用 b52 的同一名单；复验文件本体不改）", () => {
  for (const forbidden of [
    "openMemberRun",
    "recordLeaderRun",
    "planDispatch",
    "discardBatch",
    "settleCommentDispatchReceipt",
    "INSERT INTO",
    "UPDATE ",
    "DELETE FROM",
    ".add(",
  ]) {
    assert.ok(!FACADE_CODE.includes(forbidden), `门面源码（去注释）不得出现 ${forbidden}`);
  }
});

test("G5｜服务面调用单点：门面经 requireDecisionService 恰调 createDecision；评论四方法原样", () => {
  const decisionCalls = [...FACADE_CODE.matchAll(/requireDecisionService\(runtime\)\.(\w+)/g)].map(
    (match) => match[1],
  );
  assert.deepEqual(
    [...new Set(decisionCalls)].sort(),
    ["createDecision"],
    "第五写入口只允许一个方法（门面不得绕过服务面自行写入）",
  );
  const commentCalls = [...FACADE_CODE.matchAll(/requireCommentService\(runtime\)\.(\w+)/g)].map(
    (match) => match[1],
  );
  assert.deepEqual(
    [...new Set(commentCalls)].sort(),
    ["addCommentReaction", "createComment", "setCommentResolved", "softDeleteComment"],
    "评论面四方法不得因本轮改动增减（b52 的「恰四方法」判据原样绿）",
  );
});

test("G6｜dedupKey 单源：两个纯函数在 workitem/** 各只有一处定义；服务实现体内不拼第二份形状", () => {
  const files = readdirSync(WORKITEM_DIR).filter((name) => name.endsWith(".ts"));
  for (const name of ["computeDecisionDedupKey", "computeDecisionActivityDedupKey"]) {
    const defining = files.filter((file) =>
      readSource(`workitem/${file}`).includes(`export function ${name}(`),
    );
    assert.deepEqual(defining, ["workItemDecisionService.ts"], `${name} 必须只有一处定义`);
  }
  // 服务实现体（去掉两个纯函数定义）不得再出现 `decision:` 字面量拼接（第二份形状）。
  // 注意 `\n\}\n`：函数体里参数对象的收尾行是 `}): string {`，不能被当成函数结尾。
  const withoutKeyFns = DECISION_SERVICE_CODE.replace(
    /export function computeDecisionDedupKey\([\s\S]*?\n\}\n/,
    "",
  ).replace(/export function computeDecisionActivityDedupKey\([\s\S]*?\n\}\n/, "");
  assert.ok(
    !withoutKeyFns.includes("decision:"),
    "dedupKey 形状只能来自两个纯函数：实现体内不得内联 `decision:` 拼接",
  );
});

test("G7｜依赖集封顶：WorkItemDecisionServiceDeps 的属性只有 decisions/activities/workItems/accessPolicy/now/newId/inboxNotifications", () => {
  const block = DECISION_SERVICE_SRC.slice(
    DECISION_SERVICE_SRC.indexOf("export type WorkItemDecisionServiceDeps = {"),
  );
  const end = block.indexOf("\n};");
  assert.ok(end > 0, "找不到 WorkItemDecisionServiceDeps 的类型块");
  const names = [...block.slice(0, end).matchAll(/^\s{2}(\w+)\??:/gm)].map((match) => match[1]);
  assert.deepEqual(
    [...new Set(names)].sort(),
    ["accessPolicy", "activities", "decisions", "inboxNotifications", "newId", "now", "workItems"],
    "依赖集封顶是结构红线：加 runs/receipts/deferred/workItemService 即编译错 + 本守卫红。" +
      "accessPolicy 是 C4.1 的判据口（纯函数面，不是新 repo）——决定写与四评论入口并列过同一判据；" +
      "inboxNotifications 是 SUB.2 的**只写 Inbox 的通知口**（纯函数类型，见 H5）——不是新 repo，" +
      "键集断言逐字列出而不是「包含」，新加面必须显式更新本行",
  );
});

/* H5（SUB.2）：通知口是**只写 Inbox** 的口 —— 类型面只带通知数据。
   为什么单列一条：G7 只数键名个数，数不出「这个口拿到了什么」。若有人把 inboxNotifications
   改成 `(fact, repos)` 或让 fact 带上 run/receipt/状态字段，G1/G2 的字符串名单可能照旧全绿，
   而「决定链结构上碰不到生命周期面」这条红线已经破了。 */
test("H5｜SUB.2 通知口只写 Inbox：类型字段只有通知数据；服务面恰调一次且缺省不产生", () => {
  const POLICY_SRC = stripComments(readSource("workitem/inboxNotificationPolicy.ts"));
  for (const typeName of ["DecisionNotificationFact", "CommentNotificationFact"]) {
    const marker = `export type ${typeName} = {`;
    const block = POLICY_SRC.slice(POLICY_SRC.indexOf(marker));
    const end = block.indexOf("\n};");
    assert.ok(POLICY_SRC.includes(marker) && end > 0, `找不到 ${typeName} 的类型块`);
    const fields = [...block.slice(0, end).matchAll(/^\s{2}(\w+)\??:/gm)].map((match) => match[1]);
    for (const field of fields) {
      assert.ok(
        [
          "author",
          "commentId",
          "decisionId",
          "mentioned",
          "workItemId",
          "workItemTitle",
          "workspaceKey",
          "workspacePath",
        ].includes(field),
        `${typeName}.${field} 不在通知数据白名单内：通知口只带「谁对哪件事做了什么」，` +
          "不得带上 repo / run / receipt / 义务 / 状态面（决定链的依赖集封顶红线）",
      );
    }
    for (const forbidden of ["runs", "receipt", "Receipt", "deferred", "status", "transition"]) {
      assert.ok(
        !block.slice(0, end).includes(forbidden),
        `${typeName} 不得出现 ${forbidden}（只写 Inbox 的口拿不到生命周期面）`,
      );
    }
  }
  // 调用面恰一处、且是**可选**注入（缺省不产生条目）。
  assert.equal(
    [...DECISION_SERVICE_CODE.matchAll(/deps\.inboxNotifications\(/g)].length,
    1,
    "决定写成功后恰报一次事实（不多报、不漏报）",
  );
  const depsBlock = DECISION_SERVICE_SRC.slice(
    DECISION_SERVICE_SRC.indexOf("export type WorkItemDecisionServiceDeps = {"),
  );
  assert.ok(
    depsBlock.slice(0, depsBlock.indexOf("\n};")).includes("inboxNotifications?: "),
    "通知口必须是可选注入（缺省 = 不产生，既有调用方与测试行为逐字不变）",
  );
});

/* ---------- steering 边界的**回归断言**（既有队列语义，不新做机制） ---------- */

const WORKSPACE = { path: "/tmp/c31-guards-ws", identity: "c31-guards-ws" };
const HUMAN = { kind: "human" as const, id: "local-user" };
const CLOCK = 1_700_000_000_000;

test("steering 边界（回归）｜目标忙 ⇒ 评论走 deferred 义务，不注入在途 Run（Comment 不是 steering）", () => {
  const db = new DatabaseSync(":memory:");
  runTasksDatabaseMigrations(db);
  const workItems = createWorkItemRepo(db);
  const comments = createWorkItemCommentRepo(db);
  const activities = createWorkItemActivityRepo(db);
  const receipts = createCommentDispatchReceiptRepo(db);
  const reactions = createWorkItemCommentReactionRepo(db);
  const runs = createSquadRunRepo(db);
  const deferred = createSquadDeferredDispatchRepo(db);
  workItems.insert({
    id: "wi-1",
    workspaceIdentity: WORKSPACE.identity,
    workspacePath: WORKSPACE.path,
    title: "标题 wi-1",
    body: "",
    status: "todo" as const,
    assignee: { type: "agent" as const, id: "ag-1" },
    labels: [],
    properties: {},
    position: 0,
  });
  // 在途 Run 占树（"open" ∈ 活跃集）：目标的「忙」由既有队列状态窗回答。
  runs.insert({
    runId: "run-inflight",
    workspaceKey: WORKSPACE.identity,
    workspacePath: WORKSPACE.path,
    workItemId: "wi-1",
    parentWorkItemId: "wi-1",
    agentId: "ag-1",
    isLeaderTask: false,
    branch: "b/inflight",
    dirName: "inflight",
    status: "open",
    sessionId: null,
    dispatchCause: null,
    causedByRunId: null,
    createdAt: CLOCK,
    updatedAt: CLOCK,
  });
  const runRowBefore = JSON.stringify(db.prepare("SELECT * FROM squad_runs").all());

  const service = createCommentService({
    /* G8：事务口（本文件是既有用例，注入 identity 替身 —— 行为逐字不变；真事务的证据在 commentServiceTransaction.test.ts）。 */
    transact: (fn) => fn(),
    comments,
    activities,
    receipts,
    reactions,
    runs,
    deferred,
    workItems,
    roster: { listAgents: () => [{ id: "ag-1", name: "Ann" }], listSquads: () => [] },
    readDispatchEnabled: () => true,
    now: () => CLOCK,
    newId: () => "c-1",
  });
  const result = service.createComment({
    workspaceKey: WORKSPACE.identity,
    workspacePath: WORKSPACE.path,
    workItemId: "wi-1",
    author: HUMAN,
    initiatedBy: HUMAN,
    body: "@Ann 补充说明",
  });

  assert.deepEqual(
    result.dispatches.map((report) => report.outcome),
    ["deferred"],
    "目标忙 ⇒ 派发落完成重放义务（deferred），不是注入在途 Run",
  );
  const obligation = deferred.find(WORKSPACE.identity, "wi-1", "ag-1");
  assert.ok(obligation !== null, "义务行必须落库（否则这条评论永远不会被重放）");
  assert.equal(obligation.origin, "comment", "义务来源判别列 = comment（X2.1 据此分流）");
  assert.equal(
    JSON.stringify(db.prepare("SELECT * FROM squad_runs").all()),
    runRowBefore,
    "在途 Run 一字未动：评论内容不得被注入（仅 host 侧既有 CommandInbox/turn-steer 拥有 steering 面）",
  );
});
