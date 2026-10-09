import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { runTasksDatabaseMigrations } from "../src/session/tasksDatabase/migrations.js";
import { createCommentDispatchReceiptRepo } from "../src/workitem/commentDispatchReceiptRepo.js";
import { createCommentService, type CreateCommentInput } from "../src/workitem/commentService.js";
import type {
  AccessDecision,
  AccessSubject,
  CollaborationAccessDenyReason,
  CollaborationAccessPolicy,
} from "../src/workitem/collaborationAccessPolicy.js";
import type { SquadRuntime } from "../src/workitem/squadContracts.js";
import { createSquadDeferredDispatchRepo } from "../src/workitem/squadDeferredDispatchRepo.js";
import { createSquadRunRepo } from "../src/workitem/squadRunRepo.js";
import { createWorkItemActivityRepo } from "../src/workitem/workItemActivityRepo.js";
import {
  createWorkItemCollaborationService,
  type WorkItemCollaborationServiceDeps,
} from "../src/workitem/workItemCollaborationService.js";
import { createWorkItemCommentReactionRepo } from "../src/workitem/workItemCommentReactionRepo.js";
import { createWorkItemCommentRepo } from "../src/workitem/workItemCommentRepo.js";
import { createWorkItemDecisionRepo } from "../src/workitem/workItemDecisionRepo.js";
import { createWorkItemDeliverableRepo } from "../src/workitem/workItemDeliverableRepo.js";
import { createWorkItemPullRequestRepo } from "../src/workitem/workItemPullRequestRepo.js";
import { createNullPullRequestProvider } from "../src/workitem/pullRequestProvider.js";
import type {
  CreateDecisionInput,
  WorkItemDecisionRecord,
} from "../src/workitem/workItemDecisionService.js";
import { createWorkItemRepo } from "../src/workitem/workItemRepo.js";
import { createWorkItemSubscriberRepo } from "../src/workitem/workItemSubscriberRepo.js";

/* B5.2 轮 2：工作项协作门面的**四个写入口**（任务卡 §5.3-1）。

   逐条对齐 §2.3 与 §5.3-1：
   (a) `workspaceKey` / `workspacePath` **只**取自 `runtime.boundWorkspace`（调用方传的 target
       只用于现构 runtime，不参与 key 计算）——「读错的 workspace 上写评论」是这一格唯一的失败形态；
   (b) 身份（D1-A）：actor 由**组合根注入一次**（`localHumanActor`），UI 不传、也不拼；
       `initiatedBy` 缺省 = actor；`sourceRun` **恒缺席**（人类 composer 不伪造 run 归属）；
   (c) `clientRequestId` 幂等：同键两次 ⇒ 一行评论、零第二条 Activity、零第二条 receipt；
   (d) 结构负向：写路径不出现 `openMemberRun` / `recordLeaderRun` / `planDispatch`（不创建 Run）；
   (e) 返回形状**原样透传** `CommentService`（不二次包装、不吞异常）。

   期望值全部是手写字面量（独立真源），不是「用实现再算一遍」。 */

const WORKSPACE = { path: "/tmp/b52-ws-a", identity: "b52-ws-a" };
const OTHER_WORKSPACE = { path: "/tmp/b52-ws-other", identity: "b52-ws-other" };
/** D1-A 的注入值（组合根给的常量身份）——测试里的独立真源。 */
const LOCAL_HUMAN = { kind: "human" as const, id: "local-user" };

function workItemRow(
  id: string,
  overrides: Partial<{
    assignee: { type: "agent"; id: string } | { type: "user"; id: string };
  }> = {},
) {
  return {
    id,
    workspaceIdentity: WORKSPACE.identity,
    workspacePath: WORKSPACE.path,
    title: `标题 ${id}`,
    body: "",
    status: "todo" as const,
    assignee: overrides.assignee ?? { type: "agent" as const, id: "ag-1" },
    labels: [],
    properties: {},
    position: 0,
  };
}

function countRows(db: DatabaseSync, table: string): number {
  return (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
}

test("写入口｜createWorkItemComment：workspaceKey/Path 取自 runtime 绑定值，身份由组合根注入（UI 不传）", async () => {
  const calls: CreateCommentInput[] = [];
  // 返回值的独立真源：门面必须**原样**透传（不二次包装成别的形状）。
  const serviceResult = {
    comment: { id: "c-1" } as never,
    dispatches: [
      {
        targetAgentId: "ag-1",
        source: "issue_assignee" as const,
        outcome: "pending" as const,
        detail: {},
      },
    ],
  };
  const commentService = {
    createComment(input: CreateCommentInput) {
      calls.push(input);
      return serviceResult;
    },
  };
  const service = createWorkItemCollaborationService({
    createRuntime: async () =>
      ({
        boundWorkspace: OTHER_WORKSPACE,
        readSquadMergeMode: () => "local",
      }) as unknown as SquadRuntime,
    getRepos: () => {
      throw new Error("写路径不得读 repo（读面是另一个口）");
    },
    localHumanActor: () => LOCAL_HUMAN,
    createCommentService: () => commentService as never,
  });

  // 调用方传的是 ws-a 的 target，但 runtime 绑的是 ws-other（模拟「取错了目标」的接线 bug）。
  const returned = await service.createWorkItemComment(WORKSPACE, {
    workItemId: "wi-1",
    body: "正文",
    clientRequestId: "req-1",
  });

  assert.equal(calls.length, 1);
  assert.equal(
    calls[0]!.workspaceKey,
    OTHER_WORKSPACE.identity,
    "workspaceKey 必须是 runtime 的绑定身份（调用方传的 target 不参与 key 计算）",
  );
  assert.equal(calls[0]!.workspacePath, OTHER_WORKSPACE.path, "workspacePath 同源取自绑定值");
  assert.deepEqual(calls[0]!.author, LOCAL_HUMAN, "actor 由组合根注入（UI 不构造身份）");
  assert.deepEqual(calls[0]!.initiatedBy, LOCAL_HUMAN, "initiatedBy 缺省 = actor");
  assert.ok(!("sourceRun" in calls[0]!), "sourceRun 恒缺席：人类 composer 不伪造 run 归属");
  assert.equal(calls[0]!.clientRequestId, "req-1", "幂等键原样透传");
  assert.equal(calls[0]!.workItemId, "wi-1");
  assert.equal(calls[0]!.body, "正文");
  assert.equal(returned, serviceResult, "返回形状原样透传 CommentService（不二次包装）");
});

test("写入口｜读面 viewerActor = 组合根注入的本地人类身份（C5 的「我已回应」判据）", async () => {
  const db = new DatabaseSync(":memory:");
  runTasksDatabaseMigrations(db);
  const workItemRepo = createWorkItemRepo(db);
  const comments = createWorkItemCommentRepo(db);
  workItemRepo.insert(workItemRow("wi-1"));

  const service = createWorkItemCollaborationService({
    createRuntime: async () =>
      ({
        workItemRepo,
        deliverableRepo: createWorkItemDeliverableRepo(db),
        /* #8 D2：读模型新增 PR 关联清单 + 读数面可用性 —— 夹具按 runtime 契约补齐。 */
        pullRequestRepo: createWorkItemPullRequestRepo(db),
        pullRequestProvider: createNullPullRequestProvider(),
        /* #8 D3：读面带出整批收尾模式（详情页 PR 区的 pr-gate 提示读它）。 */
        readSquadMergeMode: () => "local",
        /* SUB.1：订阅存储面（读模型的 `subscribers` 格取自它）——夹具按 runtime 契约补齐。 */
        subscriberRepo: createWorkItemSubscriberRepo(db),
        boundWorkspace: WORKSPACE,
      }) as unknown as SquadRuntime,
    getRepos: () => ({
      comments,
      activities: createWorkItemActivityRepo(db),
      decisions: createWorkItemDecisionRepo(db),
      reactions: createWorkItemCommentReactionRepo(db),
      receipts: createCommentDispatchReceiptRepo(db),
    }),
    localHumanActor: () => LOCAL_HUMAN,
    createCommentService: () => {
      throw new Error("读路径不得构造写服务");
    },
  });

  const read = await service.getWorkItemCollaboration(WORKSPACE, "wi-1");
  assert.deepEqual(read?.viewerActor, LOCAL_HUMAN);
});

test("写入口｜软删/解决/回应三入口走真实服务面：墓碑 + 根专属拒绝 + 回应作者为注入身份，均不产生派发", async () => {
  const db = new DatabaseSync(":memory:");
  runTasksDatabaseMigrations(db);
  const workItemRepo = createWorkItemRepo(db);
  const comments = createWorkItemCommentRepo(db);
  const activities = createWorkItemActivityRepo(db);
  const reactions = createWorkItemCommentReactionRepo(db);
  const receipts = createCommentDispatchReceiptRepo(db);
  const runs = createSquadRunRepo(db);
  const deferred = createSquadDeferredDispatchRepo(db);
  workItemRepo.insert(workItemRow("wi-1"));

  const deps: WorkItemCollaborationServiceDeps = {
    createRuntime: async () =>
      ({
        workItemRepo,
        deliverableRepo: createWorkItemDeliverableRepo(db),
        /* #8 D2：读模型新增 PR 关联清单 + 读数面可用性 —— 夹具按 runtime 契约补齐。 */
        pullRequestRepo: createWorkItemPullRequestRepo(db),
        pullRequestProvider: createNullPullRequestProvider(),
        /* #8 D3：读面带出整批收尾模式（详情页 PR 区的 pr-gate 提示读它）。 */
        readSquadMergeMode: () => "local",
        /* SUB.1：订阅存储面（读模型的 `subscribers` 格取自它）——夹具按 runtime 契约补齐。 */
        subscriberRepo: createWorkItemSubscriberRepo(db),
        boundWorkspace: WORKSPACE,
      }) as unknown as SquadRuntime,
    getRepos: () => ({
      comments,
      activities,
      decisions: createWorkItemDecisionRepo(db),
      reactions,
      receipts,
    }),
    localHumanActor: () => LOCAL_HUMAN,
    createCommentService: () =>
      createCommentService({
        /* G8：事务口（本文件是既有用例，注入 identity 替身 —— 行为逐字不变；真事务的证据在 commentServiceTransaction.test.ts）。 */
        transact: (fn) => fn(),
        comments,
        activities,
        receipts,
        reactions,
        runs,
        deferred,
        workItems: workItemRepo,
        roster: {
          listAgents: () => [{ id: "ag-1", name: "甲" }],
          listSquads: () => [],
        },
        readDispatchEnabled: () => true,
      }),
  };
  const service = createWorkItemCollaborationService(deps);

  const created = await service.createWorkItemComment(WORKSPACE, {
    workItemId: "wi-1",
    body: "根评论",
    clientRequestId: "req-root",
  });
  const rootId = created.comment.id;
  assert.equal(created.comment.author.id, LOCAL_HUMAN.id, "落库作者 = 注入身份");
  assert.equal(created.comment.workspaceKey, WORKSPACE.identity);
  assert.equal(created.comment.workspacePath, WORKSPACE.path);
  assert.equal(created.comment.sourceRun, null, "sourceRun 落库为空（不伪造 run 归属）");
  assert.deepEqual(
    created.dispatches.map((report) => [report.targetAgentId, report.source, report.outcome]),
    [["ag-1", "issue_assignee", "pending"]],
    "人类评论按指派 agent 隐式路由 ⇒ pending receipt",
  );
  assert.equal(countRows(db, "comment_dispatch_receipts"), 1);
  // 独立真源：一次人类评论落两枚 Activity（comment_created + comment_dispatch_requested）与一条 receipt。
  const activitiesAfterFirst = countRows(db, "work_item_activities");
  assert.equal(activitiesAfterFirst, 2);

  // 幂等：同 (workspace, author, clientRequestId) 重投 ⇒ 一行评论 / 不新增 Activity / 不新增 receipt。
  const retried = await service.createWorkItemComment(WORKSPACE, {
    workItemId: "wi-1",
    body: "根评论",
    clientRequestId: "req-root",
  });
  assert.equal(retried.comment.id, rootId, "同键重投返回既存行");
  assert.equal(countRows(db, "work_item_comments"), 1);
  assert.equal(
    countRows(db, "work_item_activities"),
    activitiesAfterFirst,
    "重投不写第二条 Activity",
  );
  assert.equal(countRows(db, "comment_dispatch_receipts"), 1, "重投不写第二条 receipt");

  const reply = await service.createWorkItemComment(WORKSPACE, {
    workItemId: "wi-1",
    body: "回复",
    parentCommentId: rootId,
    clientRequestId: "req-reply",
  });
  assert.equal(reply.comment.threadId, rootId, "回复线程根 = 根评论 id");

  // 解决态：根可置/消；回复行**响亮拒绝**（门面不吞异常，原样透传服务面的拒绝）。
  const resolved = await service.setWorkItemCommentResolved(WORKSPACE, {
    commentId: rootId,
    resolved: true,
  });
  assert.notEqual(resolved.resolvedAt, null);
  await assert.rejects(
    () =>
      service.setWorkItemCommentResolved(WORKSPACE, {
        commentId: reply.comment.id,
        resolved: true,
      }),
    /不是线程根/,
    "回复行不得被门面静默放行（§3.2 仅根可置/消）",
  );

  // 回应：作者 = 注入身份；同 emoji 重投幂等；永不产生派发（§4.4）。
  const reaction = await service.addWorkItemCommentReaction(WORKSPACE, {
    commentId: rootId,
    emoji: "👍",
  });
  assert.deepEqual(
    { kind: reaction.author.kind, id: reaction.author.id },
    LOCAL_HUMAN,
    "回应作者 = 注入身份",
  );
  assert.equal(reaction.commentId, rootId);
  const receiptsBefore = countRows(db, "comment_dispatch_receipts");
  const again = await service.addWorkItemCommentReaction(WORKSPACE, {
    commentId: rootId,
    emoji: "👍",
  });
  assert.equal(again.id, reaction.id, "同 (comment, author, emoji) 幂等");
  assert.equal(countRows(db, "work_item_comment_reactions"), 1);
  assert.equal(countRows(db, "comment_dispatch_receipts"), receiptsBefore, "回应永不触发派发");

  // 软删：墓碑（正文保留在库里，但读面已由 UI 纯函数折叠）。
  const deleted = await service.softDeleteWorkItemComment(WORKSPACE, { commentId: rootId });
  assert.notEqual(deleted.deletedAt, null);
  assert.equal(countRows(db, "comment_dispatch_receipts"), receiptsBefore, "软删永不触发派发");
});

test("写入口｜跨 workspace 的动作响亮拒绝（门面不把「写错的 workspace」静默写成另一条事实）", async () => {
  const db = new DatabaseSync(":memory:");
  runTasksDatabaseMigrations(db);
  const workItemRepo = createWorkItemRepo(db);
  const comments = createWorkItemCommentRepo(db);
  const activities = createWorkItemActivityRepo(db);
  const reactions = createWorkItemCommentReactionRepo(db);
  const receipts = createCommentDispatchReceiptRepo(db);
  workItemRepo.insert(workItemRow("wi-1"));

  const service = createWorkItemCollaborationService({
    createRuntime: async () =>
      ({
        workItemRepo,
        deliverableRepo: createWorkItemDeliverableRepo(db),
        /* #8 D2：读模型新增 PR 关联清单 + 读数面可用性 —— 夹具按 runtime 契约补齐。 */
        pullRequestRepo: createWorkItemPullRequestRepo(db),
        pullRequestProvider: createNullPullRequestProvider(),
        /* #8 D3：读面带出整批收尾模式（详情页 PR 区的 pr-gate 提示读它）。 */
        readSquadMergeMode: () => "local",
        /* SUB.1：订阅存储面（读模型的 `subscribers` 格取自它）——夹具按 runtime 契约补齐。 */
        subscriberRepo: createWorkItemSubscriberRepo(db),
        boundWorkspace: OTHER_WORKSPACE,
      }) as unknown as SquadRuntime,
    getRepos: () => ({
      comments,
      activities,
      decisions: createWorkItemDecisionRepo(db),
      reactions,
      receipts,
    }),
    localHumanActor: () => LOCAL_HUMAN,
    createCommentService: () =>
      createCommentService({
        /* G8：事务口（本文件是既有用例，注入 identity 替身 —— 行为逐字不变；真事务的证据在 commentServiceTransaction.test.ts）。 */
        transact: (fn) => fn(),
        comments,
        activities,
        receipts,
        reactions,
        runs: createSquadRunRepo(db),
        deferred: createSquadDeferredDispatchRepo(db),
        workItems: workItemRepo,
        roster: { listAgents: () => [{ id: "ag-1", name: "甲" }], listSquads: () => [] },
        readDispatchEnabled: () => true,
      }),
  });

  // runtime 绑 ws-other，但工作项在 ws-a ⇒ 写评论必须响亮拒绝（不落到「别人家」的库里）。
  await assert.rejects(
    () =>
      service.createWorkItemComment(OTHER_WORKSPACE, {
        workItemId: "wi-1",
        body: "越界",
        clientRequestId: "req-x",
      }),
    /workspace/,
  );
  assert.equal(countRows(db, "work_item_comments"), 0);
});

/* ---------- 结构负向（任务卡 §5.3-1d）：写路径不创建 Run、不写派发、不过门禁 ---------- */

const SERVICE_SOURCE = readFileSync(
  resolve(
    dirname(fileURLToPath(import.meta.url)),
    "../src/workitem/workItemCollaborationService.ts",
  ),
  "utf8",
);

test("结构负向｜写路径不出现 Run 创建 / 队长登记 / 派发规划 / 门禁（评论链不得自己开 run，§5.2）", () => {
  for (const forbidden of [
    "openMemberRun",
    "recordLeaderRun",
    "planDispatch",
    "discardBatch",
    "settleCommentDispatchReceipt",
    "assertDispatchEnabled",
  ]) {
    assert.ok(
      !SERVICE_SOURCE.includes(forbidden),
      `门面不得出现 ${forbidden}（写只经 CommentService 一个口）`,
    );
  }
});

test("结构负向｜门面文件保持浏览器安全：CommentService / repo 一律 import type（不经值导入拉进 node 侧）", () => {
  for (const module of [
    "./commentService.js",
    "./commentDispatchReceiptRepo.js",
    "./workItemActivityRepo.js",
    "./workItemCommentRepo.js",
    "./workItemCommentReactionRepo.js",
    "./workItemDecisionRepo.js",
    "./workItemDecisionService.js",
  ]) {
    const importing = SERVICE_SOURCE.split("\n").filter((line) =>
      line.includes(`from "${module}"`),
    );
    assert.ok(importing.length > 0, `门面应当引用 ${module}`);
    for (const line of importing) {
      const statement = SERVICE_SOURCE.slice(
        Math.max(0, SERVICE_SOURCE.indexOf(line) - 400),
        SERVICE_SOURCE.indexOf(line) + line.length,
      );
      const lastImport = statement.lastIndexOf("import ");
      assert.ok(
        statement.slice(lastImport).startsWith("import type"),
        `${module} 必须是 import type（值导入会把 node 侧依赖带进 renderer 包）`,
      );
    }
  }
  assert.ok(!SERVICE_SOURCE.includes("node:crypto"), "门面不得依赖 node 侧运行时模块");
});

/* ---------- 组合根接线（node.ts）：X2.1 未落的那半由本轮补齐（任务卡 §5.2 / §8.1） ---------- */

const NODE_SOURCE = readFileSync(
  resolve(dirname(fileURLToPath(import.meta.url)), "../src/node.ts"),
  "utf8",
);

/** 从 `createCommentService({` 起切片（组合根里应恰好只有一处构造，见下一条断言）。 */
function commentServiceConstruction(): string {
  const start = NODE_SOURCE.indexOf("createCommentService({");
  assert.ok(
    start >= 0,
    "组合根没有构造 CommentService（评论写路径没有实现体，四个写入口必然响亮抛）",
  );
  return NODE_SOURCE.slice(start, start + 2000);
}

test("组合根接线｜本地人类身份只定义一处、注入一处（D1-A：UI 零身份拼装）", () => {
  const definition = NODE_SOURCE.match(/const LOCAL_HUMAN_ACTOR[^=]*=\s*\{[^}]*\}/);
  assert.ok(definition, "组合根必须定义本地人类身份常量（D1-A 的注入值来源）");
  assert.match(
    definition[0]!,
    /kind:\s*"human",\s*id:\s*"[^"]+"/,
    "身份取值必须是 (kind=human, 非空 id)",
  );
  const registerStart = NODE_SOURCE.indexOf(
    "IWorkItemCollaborationService,\n      createWorkItemCollaborationService({",
  );
  assert.ok(registerStart >= 0, "找不到 IWorkItemCollaborationService 的注册块");
  const register = NODE_SOURCE.slice(registerStart, registerStart + 2000);
  assert.match(
    register,
    /localHumanActor:\s*\(\)\s*=>\s*LOCAL_HUMAN_ACTOR/,
    "门面必须从组合根拿到身份（漏接 ⇒ 写入口把空身份写进审计列；读面也没有「我已回应」判据）",
  );
  assert.match(
    register,
    /createCommentService:\s*createCommentServiceFor/,
    "门面必须拿到评论服务的构造口（漏接 ⇒ 四个写入口全响亮抛，界面点了没反应）",
  );
});

test("组合根接线｜CommentService 只构造一次，且按 runtime 装（名册/repo 都是按 workspace 的）", () => {
  const constructions = NODE_SOURCE.match(/createCommentService\(\{/g) ?? [];
  assert.equal(constructions.length, 1, "组合根**唯一**构造点：第二次构造 = 两套判据");
  const body = commentServiceConstruction();
  for (const [pattern, why] of [
    [/runs:\s*runtime\.squadRunRepo/, "队列状态窗要看排队/活跃 run（缺它 ⇒ 裁决读到空表）"],
    [
      /deferred:\s*runtime\.squadDeferredDispatchRepo/,
      "完成重放义务表是 deferred 的落点（缺它 ⇒ 运行中评论无处登记）",
    ],
    [/workItems:\s*runtime\.workItemRepo/, "工作项存在性/归档判定与门面同一份 repo"],
  ] as const) {
    assert.match(body, pattern, why);
  }
  assert.match(
    body,
    /listAgents:\s*\(\)\s*=>\s*runtime\.teamAgentService\.list\(\)/,
    "名册按本次 runtime 取（跨 workspace 的单例名册会让 A 项目的评论触发 B 项目的 agent）",
  );
  assert.match(
    body,
    /listSquads:\s*\(\)\s*=>\s*runtime\.squadService\.list\(\)/,
    "小队名册同源（@小队 ⇒ 队长目标要靠它解析）",
  );
});

test("组合根接线｜评论派发请求接上 hub、门禁读同一份快照（X2.1 未落的那半在本轮补齐）", () => {
  const body = commentServiceConstruction();
  assert.match(
    body,
    /publishDispatchRequest:\s*\(request\)\s*=>\s*squadDispatchRequests\.publish\(request\)/,
    "pending 请求必须外发到组合根那份 hub（漏接 ⇒ 评论永久停在 pending，没有任何东西会执行它）",
  );
  assert.match(
    body,
    /readDispatchEnabled:\s*\(\)\s*=>\s*squadsEnabled/,
    "门禁读组合根的**同一份**同步快照（另读一次 settingService 会与呈现漂移）",
  );
});

/* ---------- C3.1：第五写入口（决定）——门面转发 + 组合根接线 ---------- */

test("写入口｜createWorkItemDecision：workspace/身份由门面派生，形状原样透传（不二次包装）", async () => {
  const calls: CreateDecisionInput[] = [];
  // 返回值的独立真源：门面必须**原样**透传（不包装成别的形状）。
  const serviceResult = { id: "dec-1" } as unknown as WorkItemDecisionRecord;
  const decisionService = {
    createDecision(input: CreateDecisionInput) {
      calls.push(input);
      return serviceResult;
    },
  };
  const service = createWorkItemCollaborationService({
    createRuntime: async () =>
      ({
        boundWorkspace: OTHER_WORKSPACE,
        readSquadMergeMode: () => "local",
      }) as unknown as SquadRuntime,
    getRepos: () => {
      throw new Error("写路径不得读 repo（读面是另一个口）");
    },
    localHumanActor: () => LOCAL_HUMAN,
    createCommentService: () => {
      throw new Error("决定写路径不得构造评论服务（两服务各自显式）");
    },
    createDecisionService: () => decisionService as never,
  });

  // 调用方传 ws-a 的 target，但 runtime 绑 ws-other（模拟「取错了目标」的接线 bug）。
  const returned = await service.createWorkItemDecision(WORKSPACE, {
    workItemId: "wi-1",
    kind: "superseded",
    subject: "方案 C",
    rationale: "更省",
    parentDecisionId: "dec-parent",
    sourceRequestId: "req-1",
  });

  assert.equal(calls.length, 1);
  assert.equal(
    calls[0]!.workspaceKey,
    OTHER_WORKSPACE.identity,
    "workspaceKey 必须是 runtime 的绑定身份（调用方 target 不参与 key 计算）",
  );
  assert.equal(calls[0]!.workspacePath, OTHER_WORKSPACE.path, "workspacePath 同源取自绑定值");
  assert.equal(calls[0]!.workItemId, "wi-1");
  assert.equal(calls[0]!.kind, "superseded");
  assert.equal(calls[0]!.subject, "方案 C");
  assert.equal(calls[0]!.rationale, "更省");
  assert.equal(calls[0]!.parentDecisionId, "dec-parent");
  assert.equal(calls[0]!.sourceRequestId, "req-1", "幂等键原样透传");
  assert.deepEqual(calls[0]!.author, LOCAL_HUMAN, "作者由组合根注入（D1-A：UI 零身份拼装）");
  assert.deepEqual(calls[0]!.initiatedBy, LOCAL_HUMAN, "initiatedBy 缺省 = 注入身份");
  assert.ok(!("sourceRunId" in calls[0]!), "人类入口不伪造 run 归属");
  assert.ok(!("threadId" in calls[0]!), "v1 不传 threadId（恒 null）");
  assert.equal(returned, serviceResult, "返回形状原样透传（不二次包装、不吞异常）");

  // 可选字段缺省 ⇒ 不构造 undefined 字段（服务面靠「字段缺席」判「没给父」）。
  await service.createWorkItemDecision(WORKSPACE, {
    workItemId: "wi-1",
    kind: "proposal",
    subject: "方案 B",
    sourceRequestId: "req-2",
  });
  const bare = calls.at(-1)!;
  assert.ok(!("rationale" in bare) && !("parentDecisionId" in bare), "可选字段缺席即缺席");

  // 未注入工厂 ⇒ 响亮抛（不 no-op：静默会让用户以为决定已经记下来了）。
  const missing = createWorkItemCollaborationService({
    createRuntime: async () =>
      ({ boundWorkspace: WORKSPACE, readSquadMergeMode: () => "local" }) as unknown as SquadRuntime,
    getRepos: () => {
      throw new Error("写路径不得读 repo");
    },
    localHumanActor: () => LOCAL_HUMAN,
  });
  await assert.rejects(
    () =>
      missing.createWorkItemDecision(WORKSPACE, {
        workItemId: "wi-1",
        kind: "proposal",
        subject: "方案 B",
        sourceRequestId: "req-3",
      }),
    /createDecisionService|未接通/,
  );
});

test("组合根接线｜DecisionService 只构造一次、依赖集封顶（decisions/activities/workItems）、门面注入工厂", () => {
  const constructions = NODE_SOURCE.match(/createWorkItemDecisionService\(\{/g) ?? [];
  assert.equal(constructions.length, 1, "组合根**唯一**构造点：第二次构造 = 两套判据");
  const start = NODE_SOURCE.indexOf("createWorkItemDecisionService({");
  const body = NODE_SOURCE.slice(start, start + 1200);
  for (const [pattern, why] of [
    [/decisions:\s*createWorkItemDecisionRepo\(db\)/, "决定 repo 缺 ⇒ 写不进去"],
    [/activities:\s*createWorkItemActivityRepo\(db\)/, "活动 repo 缺 ⇒ 时间线没有锚"],
    [/workItems:\s*runtime\.workItemRepo/, "工作项判定与门面同一份 repo（归档项仍允许写）"],
  ] as const) {
    assert.match(body, pattern, why);
  }
  for (const forbidden of ["runs:", "receipts:", "deferred:", "workItemService"]) {
    assert.ok(
      !body.includes(forbidden),
      `DecisionService 依赖集封顶：组合根不得注入 ${forbidden}（决定链结构上碰不到派发/状态面）`,
    );
  }
  const registerStart = NODE_SOURCE.indexOf(
    "IWorkItemCollaborationService,\n      createWorkItemCollaborationService({",
  );
  assert.ok(registerStart >= 0, "找不到 IWorkItemCollaborationService 的注册块");
  const register = NODE_SOURCE.slice(registerStart, registerStart + 2000);
  assert.match(
    register,
    /createDecisionService:\s*createDecisionServiceFor/,
    "门面必须拿到决定服务的构造口（漏接 ⇒ 第五写入口响亮抛，界面点了没反应）",
  );
});

/* ---------- C4.1：读面 canView 判据（§9 的三轴里唯一落在门面的一处） ---------- */

function denyPolicy(reason: CollaborationAccessDenyReason): CollaborationAccessPolicy {
  const deny = (): AccessDecision => ({ allowed: false, reason });
  return { canViewWorkItem: deny, canCommentWorkItem: deny, canInvokeTarget: deny };
}

/** 读面夹具：一条在读项 + 一条归档项；runtime 绑定值可换（用于 §8.5 与 §9 两条抛的分界）。 */
function readFixture(
  options: {
    accessPolicy?: CollaborationAccessPolicy;
    boundWorkspace?: { path: string; identity: string };
  } = {},
) {
  const db = new DatabaseSync(":memory:");
  runTasksDatabaseMigrations(db);
  const workItemRepo = createWorkItemRepo(db);
  workItemRepo.insert(workItemRow("wi-1"));
  workItemRepo.insert({ ...workItemRow("wi-arch"), archivedAt: 1234 });
  const service = createWorkItemCollaborationService({
    createRuntime: async () =>
      ({
        workItemRepo,
        deliverableRepo: createWorkItemDeliverableRepo(db),
        /* #8 D2：读模型新增 PR 关联清单 + 读数面可用性 —— 夹具按 runtime 契约补齐。 */
        pullRequestRepo: createWorkItemPullRequestRepo(db),
        pullRequestProvider: createNullPullRequestProvider(),
        /* #8 D3：读面带出整批收尾模式（详情页 PR 区的 pr-gate 提示读它）。 */
        readSquadMergeMode: () => "local",
        /* SUB.1：订阅存储面（读模型的 `subscribers` 格取自它）——夹具按 runtime 契约补齐。 */
        subscriberRepo: createWorkItemSubscriberRepo(db),
        boundWorkspace: options.boundWorkspace ?? WORKSPACE,
      }) as unknown as SquadRuntime,
    getRepos: () => ({
      comments: createWorkItemCommentRepo(db),
      activities: createWorkItemActivityRepo(db),
      decisions: createWorkItemDecisionRepo(db),
      reactions: createWorkItemCommentReactionRepo(db),
      receipts: createCommentDispatchReceiptRepo(db),
    }),
    localHumanActor: () => LOCAL_HUMAN,
    ...(options.accessPolicy !== undefined ? { accessPolicy: options.accessPolicy } : {}),
  });
  return { service };
}

test("读面｜canView 判据（C4.1）：注入拒绝策略 ⇒ 响亮抛（点名原因与主体），不返回 null", async () => {
  const { service } = readFixture({ accessPolicy: denyPolicy("work_item_archived") });
  await assert.rejects(
    () => service.getWorkItemCollaboration(WORKSPACE, "wi-1"),
    (error: Error) =>
      error.message.includes("协作访问判据拒绝") &&
      error.message.includes("work_item_archived") &&
      error.message.includes(LOCAL_HUMAN.id),
    "读面被拒必须响亮抛：返回 null 会把「权限被拒」显示成「这条工作项不存在」",
  );
});

test("读面｜缺省策略下 canView 恒放行：归档项照返回、不存在仍 null，且与 §8.5 的跨 workspace 抛是两条不同的抛", async () => {
  const { service } = readFixture();
  const archived = await service.getWorkItemCollaboration(WORKSPACE, "wi-arch");
  assert.equal(archived?.workItem.id, "wi-arch", "归档项仍可寻址（归档 ≠ 不存在）");
  assert.equal(await service.getWorkItemCollaboration(WORKSPACE, "wi-missing"), null);
  // 跨 workspace：runtime 绑在别的 workspace，工作项属本 workspace ⇒ §8.5 响亮抛（与 §9 的拒绝不同源）。
  const other = readFixture({ boundWorkspace: OTHER_WORKSPACE });
  await assert.rejects(
    () => other.service.getWorkItemCollaboration(WORKSPACE, "wi-1"),
    (error: Error) => error.message.includes("§8.5") && !error.message.includes("协作访问判据拒绝"),
    "跨 workspace 拒绝必须保留原有文案（不得被 canView 的拒绝文案顶替）",
  );
});

test("读面｜判据只在服务层判：门面读面恰一次 canView（主体 = 注入身份），门面写入口零判据调用", async () => {
  const calls: string[] = [];
  const tagged = (subject: AccessSubject) => `${subject.kind}:${subject.id}`;
  const policy: CollaborationAccessPolicy = {
    canViewWorkItem: (subject: AccessSubject) => {
      calls.push(`view:${tagged(subject)}`);
      return { allowed: true };
    },
    canCommentWorkItem: () => {
      calls.push("comment");
      return { allowed: true };
    },
    canInvokeTarget: () => ({ allowed: true }),
  };
  const { service } = readFixture({ accessPolicy: policy });
  await service.getWorkItemCollaboration(WORKSPACE, "wi-1");
  assert.deepEqual(
    calls,
    [`view:${tagged(LOCAL_HUMAN)}`],
    "读面恰一次 canView，主体 = 组合根注入的本地人类",
  );
  // 门面写入口**零判据**：判据在服务层（门面再判一份就是第二份判据，漂移不报错）。
  const forwarding = createWorkItemCollaborationService({
    createRuntime: async () =>
      ({ boundWorkspace: WORKSPACE, readSquadMergeMode: () => "local" }) as unknown as SquadRuntime,
    getRepos: () => {
      throw new Error("写路径不得读 repo");
    },
    localHumanActor: () => LOCAL_HUMAN,
    accessPolicy: policy,
    createCommentService: () =>
      ({ createComment: () => ({ comment: { id: "c-1" }, dispatches: [] }) }) as never,
    createDecisionService: () => ({ createDecision: () => ({ id: "dec-1" }) }) as never,
  });
  await forwarding.createWorkItemComment(WORKSPACE, {
    workItemId: "wi-1",
    body: "正文",
    clientRequestId: "req-1",
  });
  assert.deepEqual(
    calls,
    [`view:${tagged(LOCAL_HUMAN)}`],
    "门面写入口不得调用判据（判据面在服务层）",
  );
});

/* ---------- G7（§8.4-3）：半途事务扫描的公开入口 ---------- */

test("G7 门面｜backfillWorkItemCommentFacts：workspaceKey 取自 runtime 绑定值、报告原样透传", async () => {
  const seen: string[] = [];
  // 独立真源：报告由注入实现给出，门面必须**原样**透传（不重算、不包装）。
  const report = {
    scannedComments: 7,
    scannedReceipts: 3,
    replayedCommentActivities: 2,
    replayedDispatchActivities: 1,
  };
  const service = createWorkItemCollaborationService({
    createRuntime: async () =>
      ({
        boundWorkspace: OTHER_WORKSPACE,
        readSquadMergeMode: () => "local",
      }) as unknown as SquadRuntime,
    getRepos: () => {
      throw new Error("补写扫描不得走读面 repo（懒取口不是它的依赖）");
    },
    localHumanActor: () => LOCAL_HUMAN,
    backfillCommentFacts: (workspaceKey) => {
      seen.push(workspaceKey);
      return report;
    },
  });

  // 调用方传 ws-a 的 target，但 runtime 绑 ws-other（模拟「取错了目标」的接线 bug）。
  const returned = await service.backfillWorkItemCommentFacts(WORKSPACE);

  assert.deepEqual(
    seen,
    [OTHER_WORKSPACE.identity],
    "扫的是 runtime 绑定的 workspace（target 不参与 key 计算）",
  );
  assert.deepEqual(returned, report, "报告原样透传（挂点日志与用例断言读到同一份结论）");
});

test("G7 门面｜backfillCommentFacts 未注入 ⇒ 响亮抛（静默 no-op 会把残行伪装成「本来就没有」）", async () => {
  const service = createWorkItemCollaborationService({
    createRuntime: async () =>
      ({ boundWorkspace: WORKSPACE, readSquadMergeMode: () => "local" }) as unknown as SquadRuntime,
    getRepos: () => ({}) as never,
    localHumanActor: () => LOCAL_HUMAN,
  });

  await assert.rejects(
    () => service.backfillWorkItemCommentFacts(WORKSPACE),
    /backfillCommentFacts/,
    "缺接线必须抛（且点名缺的是哪一格）",
  );
});

test("G7 组合根接线｜补写扫描与 CommentService 复用同一份评论族 repo 构造（唯一出处）", () => {
  const definitions = NODE_SOURCE.match(/const commentFactReposFor = /g) ?? [];
  assert.equal(
    definitions.length,
    1,
    "评论族 repo 构造只能有一处（两处 = 两条写路径，键一漂移就重复补）",
  );
  assert.match(
    commentServiceConstruction(),
    /\.\.\.commentFactReposFor\(\)/,
    "CommentService 的 comments/activities/receipts 必须来自那份共用构造",
  );
  assert.match(
    NODE_SOURCE,
    /backfillCommentFacts:\s*\(workspaceKey\)\s*=>\s*backfillMissingCommentFacts\(commentFactReposFor\(\), workspaceKey\)/,
    "补写扫描必须复用同一份构造（host 侧零 repo、零连接、零键拼装）",
  );
});
