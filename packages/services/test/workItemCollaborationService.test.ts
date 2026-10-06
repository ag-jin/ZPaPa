import assert from "node:assert/strict";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { runTasksDatabaseMigrations } from "../src/session/tasksDatabase/migrations.js";
import { createCommentDispatchReceiptRepo } from "../src/workitem/commentDispatchReceiptRepo.js";
import type { SquadRuntime } from "../src/workitem/squadContracts.js";
import { createWorkItemActivityRepo } from "../src/workitem/workItemActivityRepo.js";
import {
  createWorkItemCollaborationService,
  IWorkItemCollaborationService,
  type WorkItemCollaborationServiceDeps,
} from "../src/workitem/workItemCollaborationService.js";
import { createWorkItemCommentReactionRepo } from "../src/workitem/workItemCommentReactionRepo.js";
import { createWorkItemCommentRepo } from "../src/workitem/workItemCommentRepo.js";
import { createWorkItemDecisionRepo } from "../src/workitem/workItemDecisionRepo.js";
import { createWorkItemRepo } from "../src/workitem/workItemRepo.js";

/* B5.1 轮 1：工作项协作读门面（`IWorkItemCollaborationService`）的服务面验收。

   逐条对齐任务卡 §2.3 的门面语义纪律：
   ① workspace 唯一权威（取自 runtime.boundWorkspace，不接受调用方传 key）；
   ② not-found ⇒ null；跨 workspace ⇒ 响亮抛；归档行照返回；
   ③ 排序零重排（五个数组原样来自 repo）；
   ④ **不过门禁**（读不是新派发）——runtime stub 的 assertDispatchEnabled **恒抛**，
      读路径只要碰它就会红；
   ⑤ 读面无写（调用前后行数不变）。
   期望值全部是手写字面量（独立真源），不是「用实现再算一遍」。 */

const WORKSPACE = { path: "/tmp/ws-a", identity: "ws-a" };
const OTHER_WORKSPACE = { path: "/tmp/ws-other", identity: "ws-other" };

function workItemRow(
  id: string,
  overrides: Partial<{
    workspaceIdentity: string;
    workspacePath: string;
    archivedAt: number;
  }> = {},
) {
  return {
    id,
    workspaceIdentity: overrides.workspaceIdentity ?? WORKSPACE.identity,
    workspacePath: overrides.workspacePath ?? WORKSPACE.path,
    title: `标题 ${id}`,
    body: "",
    status: "todo" as const,
    assignee: { type: "user" as const, id: "user" },
    labels: [],
    properties: {},
    position: 0,
    ...(overrides.archivedAt === undefined ? {} : { archivedAt: overrides.archivedAt }),
  };
}

function commentRow(
  id: string,
  workItemId: string,
  options: { workspaceKey?: string; workspacePath?: string; createdAt?: number } = {},
) {
  const workspaceKey = options.workspaceKey ?? WORKSPACE.identity;
  const workspacePath = options.workspacePath ?? WORKSPACE.path;
  const human = { kind: "human" as const, id: "hu-1" };
  return {
    id,
    workspaceKey,
    workspacePath,
    workItemId,
    author: human,
    initiatedBy: human,
    body: `正文 ${id}`,
    normalizedBody: `正文 ${id}`,
    mentions: [],
    createdAt: options.createdAt ?? 1,
  };
}

function setup() {
  const db = new DatabaseSync(":memory:");
  runTasksDatabaseMigrations(db);
  const workItemRepo = createWorkItemRepo(db);
  const comments = createWorkItemCommentRepo(db);
  const activities = createWorkItemActivityRepo(db);
  const decisions = createWorkItemDecisionRepo(db);
  const reactions = createWorkItemCommentReactionRepo(db);
  const receipts = createCommentDispatchReceiptRepo(db);
  /** 门禁（若被读到就红）：本门面的读路径**不该**碰它。 */
  let dispatchGateCalls = 0;
  const runtimeOf = (boundWorkspace = WORKSPACE): SquadRuntime =>
    ({
      workItemRepo,
      boundWorkspace,
      async assertDispatchEnabled() {
        dispatchGateCalls += 1;
        throw new Error("读门面不得过门禁：读不是新派发（spec §5.7.6）");
      },
    }) as unknown as SquadRuntime;
  let currentRuntime = runtimeOf();
  const service = createWorkItemCollaborationService({
    createRuntime: async () => currentRuntime,
    getRepos: () => ({ comments, activities, decisions, reactions, receipts }),
  });
  return {
    db,
    workItemRepo,
    comments,
    activities,
    decisions,
    reactions,
    receipts,
    service,
    /** 把下一次调用的 runtime 绑到某个 workspace 上（模拟「取错了目标」的接线 bug）。 */
    bindRuntime: (boundWorkspace = WORKSPACE) => {
      currentRuntime = runtimeOf(boundWorkspace);
    },
    runtime: () => currentRuntime,
    get dispatchGateCalls() {
      return dispatchGateCalls;
    },
  };
}

function countRows(db: DatabaseSync, table: string): number {
  return (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
}

test("服务面：空工作项 ⇒ 六个字段齐备，除 workItem 外全为空数组，且门禁未被触碰", async () => {
  const f = setup();
  f.workItemRepo.insert(workItemRow("wi-1"));

  const read = await f.service.getWorkItemCollaboration(WORKSPACE, "wi-1");

  assert.ok(read, "存在的工作项必须返回读模型（不是 null）");
  assert.deepEqual(Object.keys(read).sort(), [
    "activities",
    "comments",
    "decisions",
    "reactions",
    "receipts",
    "workItem",
  ]);
  assert.equal(read.workItem.id, "wi-1");
  assert.equal(read.workItem.title, "标题 wi-1");
  assert.equal(read.comments.length, 0);
  assert.equal(read.activities.length, 0);
  assert.equal(read.decisions.length, 0);
  assert.equal(read.reactions.length, 0);
  assert.equal(read.receipts.length, 0);
  assert.equal(f.dispatchGateCalls, 0, "读面不得调 assertDispatchEnabled（读不是新派发）");
});

test("服务面：五个数组原样来自 repo——sequence 主序不被 occurredAt 重排；评论不被 id 重排", async () => {
  const f = setup();
  f.workItemRepo.insert(workItemRow("wi-1"));
  const human = { kind: "human" as const, id: "hu-1" };
  // 三条活动：occurredAt 故意与 sequence 反序（补偿事件形态：更早发生、更晚记录）。
  for (const [id, kind, occurredAt, dedupKey] of [
    ["act-1", "run_started", 900, "d-1"],
    ["act-2", "run_completed", 100, "d-2"],
    ["act-3", "status_changed", 500, "d-3"],
  ] as const) {
    f.activities.add({
      id,
      workspaceKey: WORKSPACE.identity,
      workspacePath: WORKSPACE.path,
      workItemId: "wi-1",
      kind,
      occurredAt,
      actor: human,
      initiatedBy: human,
      dedupKey,
      createdAt: 1000,
    });
  }
  // 两条评论：createdAt 顺序与 id 顺序**相反**（c-b 更早）——按 id 重排会露馅。
  f.comments.add(commentRow("c-b", "wi-1", { createdAt: 100 }));
  f.comments.add(commentRow("c-a", "wi-1", { createdAt: 200 }));

  const read = (await f.service.getWorkItemCollaboration(WORKSPACE, "wi-1"))!;

  assert.deepEqual(
    read.activities.map((a) => [a.id, a.occurredAt]),
    [
      ["act-1", 900],
      ["act-2", 100],
      ["act-3", 500],
    ],
    "sequence ASC 原样（若改成 occurredAt 排序会变成 act-2/act-3/act-1）",
  );
  assert.deepEqual(
    read.comments.map((c) => c.id),
    ["c-b", "c-a"],
    "createdAt ASC 原样（若改成 id 排序会变成 c-a/c-b）",
  );
});

test("服务面：归档工作项仍返回（archivedAt 可见）——归档与不存在必须可区分", async () => {
  const f = setup();
  f.workItemRepo.insert(workItemRow("wi-archived", { archivedAt: 777 }));

  const read = await f.service.getWorkItemCollaboration(WORKSPACE, "wi-archived");

  assert.ok(read, "归档行必须照返回：否则设计案 §4.1 的归档态在详情页不可达");
  assert.equal(read.workItem.id, "wi-archived");
  assert.equal(read.workItem.archivedAt, 777);
});

test("服务面：不存在 ⇒ null（不是故障）；跨 workspace 引用 ⇒ 响亮抛（不静默当不存在）", async () => {
  const f = setup();
  f.workItemRepo.insert(
    workItemRow("wi-other", {
      workspaceIdentity: OTHER_WORKSPACE.identity,
      workspacePath: OTHER_WORKSPACE.path,
    }),
  );

  f.bindRuntime(OTHER_WORKSPACE);
  const own = await f.service.getWorkItemCollaboration(OTHER_WORKSPACE, "wi-other");
  assert.equal(own?.workItem.id, "wi-other", "绑定 workspace 命中自己的行 ⇒ 正常返回");

  f.bindRuntime(WORKSPACE);
  assert.equal(
    await f.service.getWorkItemCollaboration(WORKSPACE, "wi-nonexistent"),
    null,
    "本 workspace 内没有这条 ⇒ null（不是故障，不抛）",
  );
  await assert.rejects(
    () => f.service.getWorkItemCollaboration(WORKSPACE, "wi-other"),
    /跨 workspace/,
    "行存在但属于异己 workspace ⇒ 抛（静默当不存在会把接线 bug 伪装成正常缺口）",
  );
});

test("服务面：读面无写——调用前后 comments/activities/receipts 行数不变", async () => {
  const f = setup();
  f.workItemRepo.insert(workItemRow("wi-1"));
  const human = { kind: "human" as const, id: "hu-1" };
  f.comments.add(commentRow("c-1", "wi-1"));
  f.activities.add({
    id: "act-1",
    workspaceKey: WORKSPACE.identity,
    workspacePath: WORKSPACE.path,
    workItemId: "wi-1",
    kind: "comment_created",
    occurredAt: 1,
    actor: human,
    initiatedBy: human,
    commentId: "c-1",
    dedupKey: "d-1",
    createdAt: 1,
  });
  f.receipts.insertIfAbsent({
    dispatchKey: "dk-1",
    workspaceKey: WORKSPACE.identity,
    workItemId: "wi-1",
    targetAgentId: "ag-1",
    commentId: "c-1",
    threadId: "c-1",
    source: "issue_assignee",
    outcome: "pending",
    createdAt: 1,
  });
  const tables = ["work_item_comments", "work_item_activities", "comment_dispatch_receipts"];
  const before = tables.map((table) => [table, countRows(f.db, table)] as const);

  const read = (await f.service.getWorkItemCollaboration(WORKSPACE, "wi-1"))!;

  assert.equal(read.comments.length, 1);
  assert.equal(read.activities.length, 1);
  assert.equal(read.receipts.length, 1);
  assert.deepEqual(
    tables.map((table) => [table, countRows(f.db, table)] as const),
    before,
    "读面在结构上不得写任何行",
  );
});

test("服务面：回应按本工作项全部评论扁平聚合（分组是 UI 纯函数的活）", async () => {
  const f = setup();
  f.workItemRepo.insert(workItemRow("wi-1"));
  f.workItemRepo.insert(workItemRow("wi-2"));
  const human = { kind: "human" as const, id: "hu-1" };
  for (const [commentId, workItemId] of [
    ["c-1", "wi-1"],
    ["c-2", "wi-1"],
    ["c-other", "wi-2"],
  ] as const) {
    f.comments.add(commentRow(commentId, workItemId));
  }
  for (const [id, commentId, emoji, createdAt] of [
    ["r-1", "c-1", "👍", 10],
    ["r-2", "c-2", "🎉", 20],
    ["r-x", "c-other", "👀", 30],
  ] as const) {
    f.reactions.add({
      id,
      workspaceKey: WORKSPACE.identity,
      commentId,
      author: human,
      emoji,
      createdAt,
    });
  }

  const read = (await f.service.getWorkItemCollaboration(WORKSPACE, "wi-1"))!;

  assert.deepEqual(
    read.reactions.map((r) => [r.commentId, r.emoji]),
    [
      ["c-1", "👍"],
      ["c-2", "🎉"],
    ],
    "只聚合本工作项评论的回应（c-other 属 wi-2，不得混入）",
  );
});

test("服务面：repo 懒取口未注入 ⇒ 响亮抛（不静默返回空表把「没接通」伪装成「没有数据」）", async () => {
  const f = setup();
  f.workItemRepo.insert(workItemRow("wi-1"));
  const service = createWorkItemCollaborationService({
    createRuntime: async () => f.runtime(),
    getRepos: undefined as unknown as WorkItemCollaborationServiceDeps["getRepos"],
  });

  await assert.rejects(
    () => service.getWorkItemCollaboration(WORKSPACE, "wi-1"),
    /getRepos/,
    "未注入懒取口必须抛（静默空表会让界面显示「这条工作项没有任何协作数据」而库里其实有）",
  );
});

test("服务面：workspaceKey 取自 runtime 绑定值——调用方传的 target 不参与 key 计算", async () => {
  const f = setup();
  f.workItemRepo.insert(
    workItemRow("wi-bound", {
      workspaceIdentity: OTHER_WORKSPACE.identity,
      workspacePath: OTHER_WORKSPACE.path,
    }),
  );
  f.comments.add(
    commentRow("c-bound", "wi-bound", {
      workspaceKey: OTHER_WORKSPACE.identity,
      workspacePath: OTHER_WORKSPACE.path,
    }),
  );
  // runtime 绑 ws-other，但调用方传的 target 是 ws-a（伪造/陈旧目标）。
  f.bindRuntime(OTHER_WORKSPACE);

  const read = await f.service.getWorkItemCollaboration(WORKSPACE, "wi-bound");

  assert.deepEqual(
    read?.comments.map((c) => c.id),
    ["c-bound"],
    "按 runtime 绑定 workspace 取评论",
  );
  assert.equal(read?.workItem.id, "wi-bound");
});

test("接线守卫：描述符频道名冻结为 work-item-collaboration（改它 = 三处接线同时失配）", () => {
  assert.equal(IWorkItemCollaborationService.channelName, "work-item-collaboration");
});
