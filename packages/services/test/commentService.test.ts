import assert from "node:assert/strict";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { runTasksDatabaseMigrations } from "../src/session/tasksDatabase/migrations.js";
import { computeCommentDispatchKey } from "../src/workitem/commentDispatchKey.js";
import { createCommentDispatchReceiptRepo } from "../src/workitem/commentDispatchReceiptRepo.js";
import {
  createCommentService,
  resolveCommentTrigger,
  type CommentServiceDeps,
  type CommentTriggerContext,
} from "../src/workitem/commentService.js";
import { createSquadDeferredDispatchRepo } from "../src/workitem/squadDeferredDispatchRepo.js";
import { createSquadRunRepo } from "../src/workitem/squadRunRepo.js";
import { createWorkItemActivityRepo } from "../src/workitem/workItemActivityRepo.js";
import {
  createWorkItemCommentRepo,
  type AuthorRef,
} from "../src/workitem/workItemCommentRepo.js";
import { createWorkItemCommentReactionRepo } from "../src/workitem/workItemCommentReactionRepo.js";
import { createWorkItemRepo } from "../src/workitem/workItemRepo.js";

/* 协作域 X1.2：评论派发请求的稳定键（§8.1：**不得复用**既有 eventKey 拼接格式）。
   期望值是手算的字面量（独立真源），不是「用实现再算一遍」。 */

test("稳定键：带长度前缀的独立格式，同输入逐字节相同、任一分量变化即变", () => {
  const key = computeCommentDispatchKey({
    workspaceKey: "ws",
    workItemId: "wi-1",
    targetAgentId: "ta-a",
    commentId: "c-1",
  });
  assert.equal(key, "comment-dispatch:v1:2:ws|4:wi-1|4:ta-a|3:c-1");
  assert.equal(
    key,
    computeCommentDispatchKey({
      workspaceKey: "ws",
      workItemId: "wi-1",
      targetAgentId: "ta-a",
      commentId: "c-1",
    }),
    "同输入两次调用逐字节相同",
  );
  const changed = [
    computeCommentDispatchKey({
      workspaceKey: "ws2",
      workItemId: "wi-1",
      targetAgentId: "ta-a",
      commentId: "c-1",
    }),
    computeCommentDispatchKey({
      workspaceKey: "ws",
      workItemId: "wi-2",
      targetAgentId: "ta-a",
      commentId: "c-1",
    }),
    computeCommentDispatchKey({
      workspaceKey: "ws",
      workItemId: "wi-1",
      targetAgentId: "ta-b",
      commentId: "c-1",
    }),
    computeCommentDispatchKey({
      workspaceKey: "ws",
      workItemId: "wi-1",
      targetAgentId: "ta-a",
      commentId: "c-2",
    }),
  ];
  for (const other of changed) assert.notEqual(other, key);
});

test("与 eventKey 格式不同源：不以 e:/s: 开头；带分隔符的值不碰撞（长度前缀）", () => {
  const key = computeCommentDispatchKey({
    workspaceKey: "ws",
    workItemId: "wi-1",
    targetAgentId: "ta-a",
    commentId: "c-1",
  });
  assert.ok(!key.startsWith("e:") && !key.startsWith("s:"), "不得复用 eventKey 的拼接格式");
  // 朴素 "ws|wi|ta|c" 拼接下这两者会撞键；长度前缀让它们不同。
  const a = computeCommentDispatchKey({
    workspaceKey: "a|b",
    workItemId: "c",
    targetAgentId: "ta",
    commentId: "x",
  });
  const b = computeCommentDispatchKey({
    workspaceKey: "a",
    workItemId: "b|c",
    targetAgentId: "ta",
    commentId: "x",
  });
  assert.notEqual(a, b);
});

test("空白分量拒绝：空/纯空白 id 会让两条不同请求撞键，一律响亮抛", () => {
  assert.throws(
    () =>
      computeCommentDispatchKey({
        workspaceKey: " ",
        workItemId: "wi-1",
        targetAgentId: "ta-a",
        commentId: "c-1",
      }),
    /workspaceKey/,
  );
  assert.throws(
    () =>
      computeCommentDispatchKey({
        workspaceKey: "ws",
        workItemId: "",
        targetAgentId: "ta-a",
        commentId: "c-1",
      }),
    /workItemId/,
  );
  assert.throws(
    () =>
      computeCommentDispatchKey({
        workspaceKey: "ws",
        workItemId: "wi-1",
        targetAgentId: "",
        commentId: "c-1",
      }),
    /targetAgentId/,
  );
  assert.throws(
    () =>
      computeCommentDispatchKey({
        workspaceKey: "ws",
        workItemId: "wi-1",
        targetAgentId: "ta-a",
        commentId: "\t",
      }),
    /commentId/,
  );
});

/* ---------- 级联纯函数（七级命中即止；五源闭集） ---------- */

const humanAuthor: AuthorRef = { kind: "human", id: "hu-1" };
const agentAuthor: AuthorRef = { kind: "agent", id: "ta-a" };

const triggerCtx = (over: Partial<CommentTriggerContext> = {}): CommentTriggerContext => ({
  author: humanAuthor,
  command: "none",
  mentions: [],
  assignee: { type: "user", id: "hu-1" },
  parent: null,
  threadRoot: null,
  squadLeaders: new Map([["sq-1", "ta-leader"]]),
  ...over,
});

test("级联①：显式 mention 优先于一切（@agent 直指；@squad 直指队长；两者并存各成目标）", () => {
  assert.deepEqual(
    resolveCommentTrigger(
      triggerCtx({
        mentions: [{ kind: "agent", name: "ann", agentId: "ta-ann" }],
        assignee: { type: "squad", id: "sq-1" },
      }),
    ),
    { kind: "targets", targets: [{ agentId: "ta-ann", source: "mention_agent" }] },
    "显式 @agent 压过 assignee 小队级联",
  );
  assert.deepEqual(
    resolveCommentTrigger(
      triggerCtx({
        mentions: [{ kind: "squad", name: "网关组", squadId: "sq-1" }],
        assignee: { type: "agent", id: "ta-other" },
      }),
    ),
    { kind: "targets", targets: [{ agentId: "ta-leader", source: "mention_squad_leader" }] },
    "@squad 的目标 = 该小队的 leaderAgentId",
  );
  assert.deepEqual(
    resolveCommentTrigger(
      triggerCtx({
        mentions: [
          { kind: "agent", name: "ann", agentId: "ta-ann" },
          { kind: "squad", name: "网关组", squadId: "sq-1" },
        ],
      }),
    ),
    {
      kind: "targets",
      targets: [
        { agentId: "ta-ann", source: "mention_agent" },
        { agentId: "ta-leader", source: "mention_squad_leader" },
      ],
    },
    "多个显式目标各自成目标（按出现顺序）",
  );
});

test("级联只对 human 作者生效：agent 评论无显式 @ ⇒ 不路由也不落兜底；显式 @ 仍触发", () => {
  assert.deepEqual(
    resolveCommentTrigger(
      triggerCtx({ author: agentAuthor, assignee: { type: "agent", id: "ta-a" } }),
    ),
    { kind: "none", reason: "non_human_author" },
  );
  assert.deepEqual(
    resolveCommentTrigger(
      triggerCtx({
        author: agentAuthor,
        parent: { author: agentAuthor, deletedAt: null },
      }),
    ),
    { kind: "none", reason: "non_human_author" },
    "agent 评论不参与 thread_parent 隐式路由",
  );
  assert.deepEqual(
    resolveCommentTrigger(
      triggerCtx({
        author: agentAuthor,
        mentions: [{ kind: "agent", name: "bob", agentId: "ta-bob" }],
      }),
    ),
    { kind: "targets", targets: [{ agentId: "ta-bob", source: "mention_agent" }] },
    "A2A 显式 @ 仍产生一次请求",
  );
});

test("级联②③与 /note：/note 压过一切（含 @）；@all 先于 @人名；两者均不落兜底", () => {
  assert.deepEqual(
    resolveCommentTrigger(
      triggerCtx({
        command: "note",
        mentions: [{ kind: "agent", name: "ann", agentId: "ta-ann" }],
        assignee: { type: "agent", id: "ta-a" },
      }),
    ),
    { kind: "suppressed", reason: "note" },
    "/note 优先级高于 mention（不得因为 mention 再派发）",
  );
  assert.deepEqual(
    resolveCommentTrigger(
      triggerCtx({
        author: agentAuthor,
        command: "note",
        mentions: [{ kind: "agent", name: "ann", agentId: "ta-ann" }],
      }),
    ),
    { kind: "suppressed", reason: "note" },
    "/note 无作者之分",
  );
  assert.deepEqual(
    resolveCommentTrigger(
      triggerCtx({ mentions: [{ kind: "all" }], assignee: { type: "agent", id: "ta-a" } }),
    ),
    { kind: "suppressed", reason: "all_mention" },
    "@all 抑制隐式路由且不落兜底",
  );
  assert.deepEqual(
    resolveCommentTrigger(
      triggerCtx({
        mentions: [{ kind: "all" }, { kind: "human", name: "张三" }],
        assignee: { type: "squad", id: "sq-1" },
      }),
    ),
    { kind: "suppressed", reason: "all_mention" },
    "@all 先于 @人名（位次②在③之前）",
  );
  assert.deepEqual(
    resolveCommentTrigger(
      triggerCtx({
        mentions: [{ kind: "human", name: "张三" }],
        assignee: { type: "squad", id: "sq-1" },
      }),
    ),
    { kind: "suppressed", reason: "human_mention" },
    "点名人类成员 ⇒ 说给人听，不惊动 agent",
  );
});

test("未解析 mention（缺席/重名）不算命中也不算抑制：级联继续往下走", () => {
  assert.deepEqual(
    resolveCommentTrigger(
      triggerCtx({
        mentions: [{ kind: "unresolved", name: "不存在", reason: "absent" }],
        assignee: { type: "agent", id: "ta-a" },
      }),
    ),
    { kind: "targets", targets: [{ agentId: "ta-a", source: "issue_assignee" }] },
  );
  assert.deepEqual(
    resolveCommentTrigger(triggerCtx({ author: agentAuthor, mentions: [{ kind: "all" }] })),
    { kind: "none", reason: "non_human_author" },
    "agent 评论不参与隐式级联：@all 无隐式路由可抑制，不写抑制",
  );
});

test("级联④-⑦优先级：assignee 小队 > thread_parent > conversation_continuation > assignee 兜底", () => {
  const agentParent = { author: agentAuthor, deletedAt: null };
  const humanParent = { author: humanAuthor, deletedAt: null };
  const agentRoot = { author: agentAuthor, deletedAt: null };
  const humanRoot = { author: humanAuthor, deletedAt: null };

  // ④ assignee=squad 压过父评论与兜底。
  assert.deepEqual(
    resolveCommentTrigger(
      triggerCtx({
        assignee: { type: "squad", id: "sq-1" },
        parent: agentParent,
        threadRoot: agentRoot,
      }),
    ),
    { kind: "targets", targets: [{ agentId: "ta-leader", source: "issue_assignee" }] },
  );
  // ⑤ 父评论作者为 agent 且未软删 ⇒ 压过⑥⑦。
  assert.deepEqual(
    resolveCommentTrigger(
      triggerCtx({
        assignee: { type: "agent", id: "ta-a" },
        parent: agentParent,
        threadRoot: humanRoot,
      }),
    ),
    { kind: "targets", targets: [{ agentId: "ta-a", source: "thread_parent" }] },
  );
  // ⑥ 父评论软删 ⇒ 线程根 owner（agent）⇒ conversation_continuation；压过⑦兜底。
  assert.deepEqual(
    resolveCommentTrigger(
      triggerCtx({
        assignee: { type: "agent", id: "ta-fallback" },
        parent: { author: agentAuthor, deletedAt: 123 },
        threadRoot: agentRoot,
      }),
    ),
    { kind: "targets", targets: [{ agentId: "ta-a", source: "conversation_continuation" }] },
  );
  // ⑦ 兜底：assignee=agent。
  assert.deepEqual(resolveCommentTrigger(triggerCtx({ assignee: { type: "agent", id: "ta-a" } })), {
    kind: "targets",
    targets: [{ agentId: "ta-a", source: "issue_assignee" }],
  });
  // 人回人不落兜底（即使 assignee=agent）。
  assert.deepEqual(
    resolveCommentTrigger(
      triggerCtx({ assignee: { type: "agent", id: "ta-a" }, parent: humanParent }),
    ),
    { kind: "none", reason: "human_to_human" },
  );
  // 线程根作者为人类同样不落兜底。
  assert.deepEqual(
    resolveCommentTrigger(
      triggerCtx({
        assignee: { type: "agent", id: "ta-a" },
        parent: { author: agentAuthor, deletedAt: 123 },
        threadRoot: humanRoot,
      }),
    ),
    { kind: "none", reason: "human_to_human" },
  );
  // ④ 小队缺席（定义不存在）⇒ 解析不出队长，继续往下。
  assert.deepEqual(
    resolveCommentTrigger(
      triggerCtx({ assignee: { type: "squad", id: "sq-gone" }, parent: agentParent }),
    ),
    { kind: "targets", targets: [{ agentId: "ta-a", source: "thread_parent" }] },
  );
  // 无 assignee（工作项不可读）且无锚点 ⇒ 无语境。
  assert.deepEqual(resolveCommentTrigger(triggerCtx({ assignee: null })), {
    kind: "none",
    reason: "no_agent_context",
  });
  // assignee=user 且无锚点 ⇒ 无语境不兜底。
  assert.deepEqual(resolveCommentTrigger(triggerCtx()), {
    kind: "none",
    reason: "no_agent_context",
  });
});

/* ---------- createComment 编排（评论服务层；C/A/D 逐场景断言） ---------- */

type Harness = {
  db: DatabaseSync;
  service: ReturnType<typeof createCommentService>;
  comments: ReturnType<typeof createWorkItemCommentRepo>;
  activities: ReturnType<typeof createWorkItemActivityRepo>;
  receipts: ReturnType<typeof createCommentDispatchReceiptRepo>;
  runs: ReturnType<typeof createSquadRunRepo>;
  workItems: ReturnType<typeof createWorkItemRepo>;
};

function harness(over: Partial<CommentServiceDeps> = {}): Harness {
  const db = new DatabaseSync(":memory:");
  runTasksDatabaseMigrations(db);
  const comments = createWorkItemCommentRepo(db);
  const activities = createWorkItemActivityRepo(db);
  const receipts = createCommentDispatchReceiptRepo(db);
  const reactions = createWorkItemCommentReactionRepo(db);
  const runs = createSquadRunRepo(db);
  const deferred = createSquadDeferredDispatchRepo(db);
  const workItems = createWorkItemRepo(db);
  let seq = 0;
  const service = createCommentService({
    comments,
    activities,
    receipts,
    reactions,
    runs,
    deferred,
    workItems,
    roster: {
      listAgents: () => [
        { id: "ta-ann", name: "ann" },
        { id: "ta-bob", name: "bob" },
        { id: "ta-leader", name: "队长" },
      ],
      listSquads: () => [{ id: "sq-1", name: "网关组", leaderAgentId: "ta-leader" }],
    },
    readDispatchEnabled: () => true,
    now: () => 1000,
    newId: () => `gen-${++seq}`,
    ...over,
  });
  return { db, service, comments, activities, receipts, runs, workItems };
}

function insertWorkItem(
  workItems: ReturnType<typeof createWorkItemRepo>,
  over: Partial<Parameters<ReturnType<typeof createWorkItemRepo>["insert"]>[0]> = {},
): void {
  workItems.insert({
    id: "wi-1",
    workspaceIdentity: "ws",
    workspacePath: "/tmp/ws",
    title: "标题",
    body: "",
    status: "todo",
    assignee: { type: "user", id: "hu-1" },
    labels: [],
    properties: {},
    position: 0,
    ...over,
  });
}

function commentRow(db: DatabaseSync, id = "wi-1"): unknown {
  return db.prepare("SELECT * FROM work_items WHERE id = ?").get(id);
}

test("createComment 写事实：raw/normalized/mention 快照落库 + comment_created；无语境人类评论零 receipt、assignee/status 逐字节不变", () => {
  const h = harness();
  insertWorkItem(h.workItems);
  const before = commentRow(h.db);
  const result = h.service.createComment({
    id: "c-1",
    workspaceKey: "ws",
    workspacePath: "/tmp/ws",
    workItemId: "wi-1",
    author: humanAuthor,
    initiatedBy: humanAuthor,
    body: "  看一下这个  ",
  });
  assert.equal(result.comment.id, "c-1");
  assert.equal(result.comment.body, "  看一下这个  ", "原文逐字节保存（含空白）");
  assert.equal(result.comment.normalizedBody, "  看一下这个  ");
  assert.equal(result.comment.command, "none");
  assert.deepEqual(result.comment.mentions, []);
  assert.equal(result.comment.threadId, "c-1", "根评论 threadId = id");
  assert.deepEqual(result.dispatches, [], "无语境 ⇒ 零派发目标");
  const acts = h.activities.listByWorkItem("ws", "wi-1");
  assert.deepEqual(
    acts.map((a) => a.kind),
    ["comment_created"],
    "矩阵 A 列：普通评论只写 comment_created",
  );
  assert.equal(acts[0]!.commentId, "c-1");
  assert.deepEqual(acts[0]!.actor, humanAuthor);
  assert.deepEqual(h.receipts.listByWorkItem("ws", "wi-1"), [], "零目标 ⇒ 零 receipt");
  assert.deepEqual(commentRow(h.db), before, "assignee/status/updated_at 逐字节不变");
});

test("显式 @agent/@squad：pending receipt + comment_dispatch_requested；本卡不写 squad_runs（派发归 X2.1）", () => {
  const h = harness();
  insertWorkItem(h.workItems);
  const before = commentRow(h.db);
  const result = h.service.createComment({
    id: "c-1",
    workspaceKey: "ws",
    workspacePath: "/tmp/ws",
    workItemId: "wi-1",
    author: humanAuthor,
    initiatedBy: humanAuthor,
    body: "@ann @网关组 一起看一下",
  });
  assert.deepEqual(result.dispatches, [
    {
      targetAgentId: "ta-ann",
      source: "mention_agent",
      outcome: "pending",
      detail: { triggerSource: "mention_agent" },
    },
    {
      targetAgentId: "ta-leader",
      source: "mention_squad_leader",
      outcome: "pending",
      detail: { triggerSource: "mention_squad_leader" },
    },
  ]);
  const first = h.receipts.get(
    computeCommentDispatchKey({
      workspaceKey: "ws",
      workItemId: "wi-1",
      targetAgentId: "ta-ann",
      commentId: "c-1",
    }),
  );
  assert.ok(first);
  assert.equal(first.outcome, "pending");
  assert.equal(first.source, "mention_agent");
  assert.equal(first.commentId, "c-1");
  assert.equal(first.threadId, "c-1");
  assert.equal(first.attemptCount, 1);
  assert.equal(first.createdAt, 1000);
  assert.deepEqual(
    h.activities.listByWorkItem("ws", "wi-1").map((a) => a.kind),
    ["comment_created", "comment_mention_parsed", "comment_dispatch_requested"],
  );
  const requested = h.activities.listByWorkItem("ws", "wi-1").at(-1)!;
  assert.deepEqual(requested.payload["targets"], result.dispatches, "派发事实带逐目标结论");
  assert.deepEqual(h.runs.listQueued("ws"), [], "pending 的实际派发归 X2.1：本卡不写 squad_runs");
  assert.deepEqual(commentRow(h.db), before, "@agent 不改负责人/状态");
});

test("抑制与绝不触发清单：/note、@all、@人名 ⇒ suppressed + 零 receipt；agent 评论/软删/表情回应零 receipt", () => {
  const h = harness({ humanNames: new Set(["张三"]) });
  insertWorkItem(h.workItems, { assignee: { type: "agent", id: "ta-bob" } }); // 有 agent 语境
  const common = {
    workspaceKey: "ws",
    workspacePath: "/tmp/ws",
    workItemId: "wi-1",
  };
  const noted = h.service.createComment({
    ...common,
    id: "c-note",
    author: humanAuthor,
    initiatedBy: humanAuthor,
    body: "/note @ann 记一笔",
  });
  const all = h.service.createComment({
    ...common,
    id: "c-all",
    author: humanAuthor,
    initiatedBy: humanAuthor,
    body: "@all 周知",
  });
  const humanMention = h.service.createComment({
    ...common,
    id: "c-human",
    author: humanAuthor,
    initiatedBy: humanAuthor,
    body: "@张三 你看看",
  });
  const agentComment = h.service.createComment({
    ...common,
    id: "c-agent",
    author: { kind: "agent", id: "ta-ann" },
    sourceRun: { runId: "r-1", agentId: "ta-ann", role: "member" },
    initiatedBy: humanAuthor,
    body: "进展：一半",
  });
  assert.deepEqual(
    [noted.dispatches, all.dispatches, humanMention.dispatches, agentComment.dispatches],
    [[], [], [], []],
  );
  assert.deepEqual(
    h.activities
      .listByWorkItem("ws", "wi-1")
      .filter((a) => a.kind === "comment_dispatch_suppressed")
      .map((a) => [a.commentId, a.payload["reason"]]),
    [
      ["c-note", "note"],
      ["c-all", "all_mention"],
      ["c-human", "human_mention"],
    ],
  );
  assert.deepEqual(h.receipts.listByWorkItem("ws", "wi-1"), [], "抑制/无语境 ⇒ 绝不产生 receipt");
  assert.deepEqual(
    h.activities
      .listByWorkItem("ws", "wi-1")
      .filter((a) => a.commentId === "c-agent")
      .map((a) => a.kind),
    ["comment_created"],
    "agent 评论无显式 @ ⇒ 只写 comment_created（不路由也不抑制）",
  );
  // 软删请求与表情回应：repo 级动作不产生任何 receipt（永不触发，§4.4）。
  h.comments.softDelete("c-all");
  // 表情回应走表直插（workItemCommentRepo.test.ts 同款先例）：reaction repo 的 add 目前写
  // author_display_name 列，而 0010 表没有该列——X0.1 遗留缺陷不在本卡范围，已在报告中登记。
  h.db
    .prepare(
      `INSERT OR IGNORE INTO work_item_comment_reactions (id, workspace_key, comment_id, author_kind, author_id, emoji, created_at)
       VALUES ('react-1', 'ws', 'c-all', 'human', 'hu-1', '👍', 1000)`,
    )
    .run();
  assert.deepEqual(h.receipts.listByWorkItem("ws", "wi-1"), []);
  assert.deepEqual(h.runs.listQueued("ws"), []);
});

test("五源经服务命中：assignee agent/squad、thread_parent、conversation_continuation；回复落同 thread", () => {
  const h = harness();
  insertWorkItem(h.workItems, { assignee: { type: "agent", id: "ta-bob" } });
  insertWorkItem(h.workItems, { id: "wi-2", assignee: { type: "squad", id: "sq-1" } });
  const common = { workspaceKey: "ws", workspacePath: "/tmp/ws" } as const;
  const agentRun = { runId: "r-1", agentId: "ta-ann", role: "member" } as const;

  // ⑦ 兜底：assignee = agent。
  const fallback = h.service.createComment({
    ...common,
    workItemId: "wi-1",
    id: "c-fallback",
    author: humanAuthor,
    initiatedBy: humanAuthor,
    body: "看一下",
  });
  assert.deepEqual(fallback.dispatches, [
    {
      targetAgentId: "ta-bob",
      source: "issue_assignee",
      outcome: "pending",
      detail: { triggerSource: "issue_assignee" },
    },
  ]);

  // ④ assignee = squad ⇒ 队长。
  const squadAssignee = h.service.createComment({
    ...common,
    workItemId: "wi-2",
    id: "c-squad",
    author: humanAuthor,
    initiatedBy: humanAuthor,
    body: "看一下",
  });
  assert.deepEqual(squadAssignee.dispatches, [
    {
      targetAgentId: "ta-leader",
      source: "issue_assignee",
      outcome: "pending",
      detail: { triggerSource: "issue_assignee" },
    },
  ]);

  // agent 写根评论（无显式 @ ⇒ 零 receipt）。
  const root = h.service.createComment({
    ...common,
    workItemId: "wi-1",
    id: "c-root",
    author: { kind: "agent", id: "ta-ann" },
    sourceRun: agentRun,
    initiatedBy: humanAuthor,
    body: "报告：一半完成",
  });
  assert.deepEqual(root.dispatches, []);

  // ⑤ thread_parent：回复未软删的 agent 评论 ⇒ 该 agent；且回复落同一 thread。
  const reply = h.service.createComment({
    ...common,
    workItemId: "wi-1",
    id: "c-reply",
    author: humanAuthor,
    initiatedBy: humanAuthor,
    parentCommentId: "c-root",
    body: "继续",
  });
  assert.equal(reply.comment.threadId, "c-root", "回复的 threadId = 父评论 threadId");
  assert.deepEqual(reply.dispatches, [
    {
      targetAgentId: "ta-ann",
      source: "thread_parent",
      outcome: "pending",
      detail: { triggerSource: "thread_parent" },
    },
  ]);

  // ⑥ conversation_continuation：父评论软删后，线程根 owner（agent）接管。
  h.comments.softDelete("c-reply");
  const deep = h.service.createComment({
    ...common,
    workItemId: "wi-1",
    id: "c-deep",
    author: humanAuthor,
    initiatedBy: humanAuthor,
    parentCommentId: "c-reply",
    body: "再问一句",
  });
  assert.equal(deep.comment.threadId, "c-root");
  assert.deepEqual(deep.dispatches, [
    {
      targetAgentId: "ta-ann",
      source: "conversation_continuation",
      outcome: "pending",
      detail: { triggerSource: "conversation_continuation" },
    },
  ]);

  // 五源 receipt 齐活（每源至少一条命中；同刻写入按 dispatch_key 定序，此处比集合）。
  const sources = h.receipts
    .listByWorkItem("ws", "wi-1")
    .map((r) => r.source)
    .sort();
  assert.deepEqual(sources, ["conversation_continuation", "issue_assignee", "thread_parent"]);

  // 父评论校验：缺失/跨项一律响亮抛（在写任何事实之前）。
  assert.throws(
    () =>
      h.service.createComment({
        ...common,
        workItemId: "wi-1",
        id: "c-bad",
        author: humanAuthor,
        initiatedBy: humanAuthor,
        parentCommentId: "不存在",
        body: "回复",
      }),
    /父评论/,
  );
  assert.throws(
    () =>
      h.service.createComment({
        ...common,
        workItemId: "wi-2",
        id: "c-cross",
        author: humanAuthor,
        initiatedBy: humanAuthor,
        parentCommentId: "c-root",
        body: "跨项回复",
      }),
    /父评论/,
  );
  assert.equal(h.comments.get("c-bad"), null);
  assert.equal(h.comments.get("c-cross"), null);
});

test("队列状态窗：排队行 ⇒ coalesced（含并入留痕）；活跃 run ⇒ deferred（义务表）；排队优先于活跃", () => {
  const h = harness();
  insertWorkItem(h.workItems, { assignee: { type: "agent", id: "ta-bob" } });
  const run = (over: { runId: string; agentId: string; status: "queued" | "open" }) => ({
    runId: over.runId,
    workspaceKey: "ws",
    workspacePath: "/tmp/ws",
    workItemId: "wi-1",
    parentWorkItemId: "wi-1",
    agentId: over.agentId,
    isLeaderTask: false,
    branch: over.status === "queued" ? null : `squad/member/${over.runId}`,
    dirName: null,
    status: over.status,
    sessionId: null,
    dispatchCause: null,
    causedByRunId: null,
    createdAt: 500,
    updatedAt: 500,
  });
  h.runs.insert(run({ runId: "run-q", agentId: "ta-bob", status: "queued" }));
  const common = { workspaceKey: "ws", workspacePath: "/tmp/ws", workItemId: "wi-1" } as const;
  const coalesced = h.service.createComment({
    ...common,
    id: "c-q",
    author: humanAuthor,
    initiatedBy: humanAuthor,
    body: "@bob 帮忙",
  });
  const qKey = computeCommentDispatchKey({
    workspaceKey: "ws",
    workItemId: "wi-1",
    targetAgentId: "ta-bob",
    commentId: "c-q",
  });
  assert.deepEqual(coalesced.dispatches, [
    {
      targetAgentId: "ta-bob",
      source: "mention_agent",
      outcome: "coalesced",
      detail: { triggerSource: "mention_agent", targetRunId: "run-q" },
    },
  ]);
  assert.equal(h.receipts.get(qKey)!.outcome, "coalesced");
  const detail = h.db
    .prepare("SELECT request_run_id, target_run_id FROM squad_run_coalesced_details")
    .get() as { request_run_id: string; target_run_id: string };
  assert.equal(detail.request_run_id, qKey, "并入留痕按请求身份幂等");
  assert.equal(detail.target_run_id, "run-q");

  // 活跃 run（open）⇒ deferred 义务，不排新 run、不注入。
  h.runs.insert(run({ runId: "run-a", agentId: "ta-ann", status: "open" }));
  const deferred = h.service.createComment({
    ...common,
    id: "c-d",
    author: humanAuthor,
    initiatedBy: humanAuthor,
    body: "@ann 帮忙",
  });
  const dKey = computeCommentDispatchKey({
    workspaceKey: "ws",
    workItemId: "wi-1",
    targetAgentId: "ta-ann",
    commentId: "c-d",
  });
  assert.deepEqual(deferred.dispatches, [
    {
      targetAgentId: "ta-ann",
      source: "mention_agent",
      outcome: "deferred",
      detail: { triggerSource: "mention_agent" },
    },
  ]);
  assert.equal(h.receipts.get(dKey)!.outcome, "deferred");
  assert.equal(
    h.db.prepare("SELECT run_id FROM squad_run_deferred_dispatches").get().run_id,
    dKey,
    "义务 id = 请求身份（dispatchKey）",
  );

  // 排队优先于活跃（ta-bob 同时有 queued 与 open 行）⇒ 仍走 coalesced，不新增义务。
  h.runs.insert(run({ runId: "run-a2", agentId: "ta-bob", status: "open" }));
  const both = h.service.createComment({
    ...common,
    id: "c-both",
    author: humanAuthor,
    initiatedBy: humanAuthor,
    body: "@bob 又来一条",
  });
  assert.equal(both.dispatches[0]!.outcome, "coalesced");
  assert.equal(
    (h.db.prepare("SELECT COUNT(*) AS n FROM squad_run_deferred_dispatches").get() as { n: number })
      .n,
    1,
    "排队优先：不得为同一目标再登记义务",
  );
  // 服务全程不新增 squad_runs（只裁决既有窗口，不开 run —— §5.2）。
  assert.equal((h.db.prepare("SELECT COUNT(*) AS n FROM squad_runs").get() as { n: number }).n, 3);
});

test("受限可审计（§12.1-12）：门禁关闭/工作项归档/名册缺席 ⇒ 评论照写 + suppressed + blocked receipt", () => {
  const common = { workspaceKey: "ws", workspacePath: "/tmp/ws", workItemId: "wi-1" } as const;

  // 门禁关闭：显式 @ 目标已知 ⇒ blocked(dispatch_disabled)，不开 run、不登记义务。
  const closed = harness({ readDispatchEnabled: () => false });
  insertWorkItem(closed.workItems, { assignee: { type: "agent", id: "ta-bob" } });
  const gated = closed.service.createComment({
    ...common,
    id: "c-gate",
    author: humanAuthor,
    initiatedBy: humanAuthor,
    body: "@bob 帮忙",
  });
  assert.deepEqual(gated.dispatches, [
    {
      targetAgentId: "ta-bob",
      source: "mention_agent",
      outcome: "blocked",
      detail: { triggerSource: "mention_agent", reason: "dispatch_disabled" },
    },
  ]);
  assert.ok(closed.comments.get("c-gate"), "评论照写（可审计）");
  assert.equal(closed.receipts.listByWorkItem("ws", "wi-1")[0]!.outcome, "blocked");
  assert.equal(
    (
      closed.activities
        .listByWorkItem("ws", "wi-1")
        .find((a) => a.kind === "comment_dispatch_suppressed")!.payload["blocked"] as unknown[]
    ).length,
    1,
    "blocked 目标进 suppressed 事实（带原因）",
  );
  assert.equal(
    (closed.db.prepare("SELECT COUNT(*) AS n FROM squad_runs").get() as { n: number }).n,
    0,
  );
  assert.equal(
    (
      closed.db.prepare("SELECT COUNT(*) AS n FROM squad_run_deferred_dispatches").get() as {
        n: number;
      }
    ).n,
    0,
  );

  // 工作项归档：读归档行的 assignee 解析出目标 ⇒ blocked(work_item_archived)；评论照写、负责人不动。
  const archived = harness();
  insertWorkItem(archived.workItems, { assignee: { type: "agent", id: "ta-bob" } });
  archived.db.prepare("UPDATE work_items SET archived_at = 123 WHERE id = 'wi-1'").run();
  const archivedBefore = commentRow(archived.db);
  const restricted = archived.service.createComment({
    ...common,
    id: "c-arch",
    author: humanAuthor,
    initiatedBy: humanAuthor,
    body: "看一下",
  });
  assert.deepEqual(restricted.dispatches, [
    {
      targetAgentId: "ta-bob",
      source: "issue_assignee",
      outcome: "blocked",
      detail: { triggerSource: "issue_assignee", reason: "work_item_archived" },
    },
  ]);
  assert.ok(archived.comments.get("c-arch"));
  assert.deepEqual(commentRow(archived.db), archivedBefore, "归档行的 assignee/status 逐字节不变");

  // 名册缺席：assignee 指向已不存在的 agent ⇒ blocked(agent_not_in_roster)。
  const gone = harness();
  insertWorkItem(gone.workItems, { assignee: { type: "agent", id: "ta-gone" } });
  const missingAgent = gone.service.createComment({
    ...common,
    id: "c-gone",
    author: humanAuthor,
    initiatedBy: humanAuthor,
    body: "看一下",
  });
  assert.deepEqual(missingAgent.dispatches, [
    {
      targetAgentId: "ta-gone",
      source: "issue_assignee",
      outcome: "blocked",
      detail: { triggerSource: "issue_assignee", reason: "agent_not_in_roster" },
    },
  ]);
  assert.ok(gone.comments.get("c-gone"), "评论照写，派发目标如实上报为 blocked");

  // 工作项根本不存在 ⇒ 响亮抛（不写孤儿评论）。
  const h = harness();
  assert.throws(
    () =>
      h.service.createComment({
        ...common,
        workItemId: "wi-missing",
        id: "c-orphan",
        author: humanAuthor,
        initiatedBy: humanAuthor,
        body: "看一下",
      }),
    /工作项/,
  );
  assert.equal(h.comments.get("c-orphan"), null);
});

test("幂等（§8.1）：同 clientRequestId 重投只一条评论/一组 Activity/一条 receipt；窗口变化不改写既存结论", () => {
  const h = harness();
  insertWorkItem(h.workItems, { assignee: { type: "agent", id: "ta-bob" } });
  const input = {
    workspaceKey: "ws",
    workspacePath: "/tmp/ws",
    workItemId: "wi-1",
    author: humanAuthor,
    initiatedBy: humanAuthor,
    body: "@bob 帮忙",
    clientRequestId: "req-1",
  } as const;
  const first = h.service.createComment({ ...input, id: "c-1" });
  assert.equal(first.dispatches[0]!.outcome, "pending");

  // 窗口变化：目标随后获得活跃 run（重投不得把它改判成 deferred，也不得登记新义务）。
  h.runs.insert({
    runId: "run-a",
    workspaceKey: "ws",
    workspacePath: "/tmp/ws",
    workItemId: "wi-1",
    parentWorkItemId: "wi-1",
    agentId: "ta-bob",
    isLeaderTask: false,
    branch: "squad/member/run-a",
    dirName: null,
    status: "open",
    sessionId: null,
    dispatchCause: null,
    causedByRunId: null,
    createdAt: 500,
    updatedAt: 500,
  });
  const retry = h.service.createComment({ ...input, id: "c-2" });
  assert.equal(retry.comment.id, "c-1", "同 (workspace,author,clientRequestId) 重投返回既存行");
  assert.deepEqual(retry.dispatches, first.dispatches, "既存 receipt 结论不被窗口变化改写");
  assert.equal(
    (h.db.prepare("SELECT COUNT(*) AS n FROM work_item_comments").get() as { n: number }).n,
    1,
  );
  assert.equal(
    (h.db.prepare("SELECT COUNT(*) AS n FROM comment_dispatch_receipts").get() as { n: number }).n,
    1,
  );
  assert.equal(
    (h.db.prepare("SELECT COUNT(*) AS n FROM squad_run_deferred_dispatches").get() as { n: number })
      .n,
    0,
    "重投不得因窗口变化新增派发义务",
  );
  assert.deepEqual(
    h.activities.listByWorkItem("ws", "wi-1").map((a) => a.kind),
    ["comment_created", "comment_mention_parsed", "comment_dispatch_requested"],
    "重投不重复写 Activity（dedupKey 幂等）",
  );
});

test("矩阵补充：@all 不吞显式目标；内联锚点原样落库；未知命令响亮拒且零事实", () => {
  const h = harness();
  insertWorkItem(h.workItems, { assignee: { type: "agent", id: "ta-bob" } });
  const common = { workspaceKey: "ws", workspacePath: "/tmp/ws", workItemId: "wi-1" } as const;
  const explicitWithAll = h.service.createComment({
    ...common,
    id: "c-both",
    author: humanAuthor,
    initiatedBy: humanAuthor,
    body: "@all @ann 一起看",
  });
  assert.deepEqual(explicitWithAll.dispatches, [
    {
      targetAgentId: "ta-ann",
      source: "mention_agent",
      outcome: "pending",
      detail: { triggerSource: "mention_agent" },
    },
  ]);
  assert.equal(
    h.activities
      .listByWorkItem("ws", "wi-1")
      .filter((a) => a.kind === "comment_dispatch_suppressed").length,
    0,
    "§12.1-3：@all 与显式目标并存时只抑制隐式路由，不吞显式目标",
  );
  const inline = h.service.createComment({
    ...common,
    id: "c-inline",
    author: humanAuthor,
    initiatedBy: humanAuthor,
    body: "看这一行",
    inline: { path: "a.ts", startLine: 3, startColumn: 1 },
  });
  assert.deepEqual(h.comments.get("c-inline")!.inline, {
    path: "a.ts",
    startLine: 3,
    startColumn: 1,
  });
  assert.deepEqual(
    inline.dispatches,
    [
      {
        targetAgentId: "ta-bob",
        source: "issue_assignee",
        outcome: "pending",
        detail: { triggerSource: "issue_assignee" },
      },
    ],
    "内联锚点只提供上下文：无 mention 时按隐式级联（assignee=agent）走",
  );
  assert.throws(
    () =>
      h.service.createComment({
        ...common,
        id: "c-bad",
        author: humanAuthor,
        initiatedBy: humanAuthor,
        body: "/foo 试试",
      }),
    /未知评论命令/,
  );
  assert.equal(h.comments.get("c-bad"), null);
  assert.equal(
    h.activities.listByWorkItem("ws", "wi-1").filter((a) => a.commentId === "c-bad").length,
    0,
    "未知命令发生在写任何事实之前",
  );
});

test("结构守卫（§5.2）：commentService.ts 源码不得出现生命周期写入口 openMemberRun/recordLeaderRun/planDispatch", async () => {
  const { readFile } = await import("node:fs/promises");
  const source = await readFile(
    new URL("../src/workitem/commentService.ts", import.meta.url),
    "utf8",
  );
  assert.doesNotMatch(source, /openMemberRun|recordLeaderRun|planDispatch/);
});

test("软删父评论不算 thread_parent：已删的 agent 父评论退位，线程根 owner 接管", () => {
  assert.deepEqual(
    resolveCommentTrigger(
      triggerCtx({
        parent: { author: agentAuthor, deletedAt: 5 },
        threadRoot: { author: agentAuthor, deletedAt: null },
      }),
    ),
    { kind: "targets", targets: [{ agentId: "ta-a", source: "conversation_continuation" }] },
    "墓碑父评论不是回复锚点：不得回 thread_parent",
  );
});
