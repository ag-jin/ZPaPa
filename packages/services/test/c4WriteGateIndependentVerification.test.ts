import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { runTasksDatabaseMigrations } from "../src/session/tasksDatabase/migrations.js";
import type {
  AccessSubject,
  CollaborationAccessPolicy,
  CommentAccessAction,
  WorkItemAccessContext,
} from "../src/workitem/collaborationAccessPolicy.js";
import { createCommentDispatchReceiptRepo } from "../src/workitem/commentDispatchReceiptRepo.js";
import { createCommentService } from "../src/workitem/commentService.js";
import type { SquadRuntime } from "../src/workitem/squadContracts.js";
import { createSquadDeferredDispatchRepo } from "../src/workitem/squadDeferredDispatchRepo.js";
import { createSquadRunRepo } from "../src/workitem/squadRunRepo.js";
import { createWorkItemActivityRepo } from "../src/workitem/workItemActivityRepo.js";
import { createWorkItemCommentRepo, type AuthorRef } from "../src/workitem/workItemCommentRepo.js";
import { createWorkItemCommentReactionRepo } from "../src/workitem/workItemCommentReactionRepo.js";
import { createWorkItemCollaborationService } from "../src/workitem/workItemCollaborationService.js";
import { createWorkItemDecisionRepo } from "../src/workitem/workItemDecisionRepo.js";
import { createWorkItemDecisionService } from "../src/workitem/workItemDecisionService.js";
import { createWorkItemRepo } from "../src/workitem/workItemRepo.js";
import { createWorkItemSubscriberRepo } from "../src/workitem/workItemSubscriberRepo.js";
import { createWorkItemDeliverableRepo } from "../src/workitem/workItemDeliverableRepo.js";
import { createWorkItemPullRequestRepo } from "../src/workitem/workItemPullRequestRepo.js";
import { createNullPullRequestProvider } from "../src/workitem/pullRequestProvider.js";

/* 协作域 C4 独立复验（test-verifier）：五写入口并列 + 读面 canView 的行为面复核。
 *
 * 独立性声明：
 * · 每个入口用**各不相同的独立身份值**（human/agent 成对，iv-* 前缀），拒绝文案里必须点名
 *   该入口自己的 initiatedBy 而**不得**出现 actor —— 这同时证明「主体来源」与「逐入口接线」；
 * · 五张表的判定不是 count(*)（行数相同也可能内容变了）：整表 `SELECT * ORDER BY rowid` 深比较；
 * · 控制组（缺省策略）先证明同一调用本身合法，再让注入拒绝策略证明「拒绝是判据给的」；
 * · 读面在注入拒绝时断言「未取任何 repo」——拒绝必须响在取数之前；
 * · 不 import 实现者测试文件的任何助手/夹具。
 */

const WS = { path: "/tmp/iv-c4-ws", identity: "iv-c4-ws" };
const WORK_ITEM_ID = "iv-wi";
const TARGET_AGENT_ID = "iv-ann";
const CLOCK = 1_800_000_000_000;
const TABLES = [
  "work_item_comments",
  "work_item_activities",
  "work_item_comment_reactions",
  "comment_dispatch_receipts",
  "work_item_decisions",
] as const;

function freshDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  runTasksDatabaseMigrations(db);
  return db;
}

function snapshot(db: DatabaseSync): Record<string, unknown[]> {
  return Object.fromEntries(
    TABLES.map((table) => [table, db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()]),
  );
}

function insertWorkItem(
  db: DatabaseSync,
  options: { archivedAt?: number; assignee?: { type: "agent"; id: string } } = {},
): void {
  const workItems = createWorkItemRepo(db);
  workItems.insert({
    id: WORK_ITEM_ID,
    workspaceIdentity: WS.identity,
    workspacePath: WS.path,
    title: "独立复验工作项",
    body: "",
    status: "todo",
    assignee: options.assignee ?? { type: "agent", id: TARGET_AGENT_ID },
    labels: [],
    properties: {},
    position: 0,
    ...(options.archivedAt !== undefined ? { archivedAt: options.archivedAt } : {}),
  });
}

type Harness = ReturnType<typeof makeHarness>;

function makeHarness(
  options: {
    policy?: CollaborationAccessPolicy;
    dispatchEnabled?: boolean;
    archivedAt?: number;
  } = {},
) {
  const db = freshDb();
  const comments = createWorkItemCommentRepo(db);
  const activities = createWorkItemActivityRepo(db);
  const receipts = createCommentDispatchReceiptRepo(db);
  const reactions = createWorkItemCommentReactionRepo(db);
  const runs = createSquadRunRepo(db);
  const deferred = createSquadDeferredDispatchRepo(db);
  const decisions = createWorkItemDecisionRepo(db);
  insertWorkItem(db, options.archivedAt !== undefined ? { archivedAt: options.archivedAt } : {});
  const published: unknown[] = [];
  let seq = 0;
  const service = createCommentService({
    comments,
    activities,
    receipts,
    reactions,
    runs,
    deferred,
    workItems: createWorkItemRepo(db),
    roster: { listAgents: () => [{ id: TARGET_AGENT_ID, name: "ivann" }], listSquads: () => [] },
    readDispatchEnabled: () => options.dispatchEnabled ?? true,
    publishDispatchRequest: (request) => published.push(request),
    now: () => CLOCK,
    newId: () => `iv-gen-${(seq += 1)}`,
    ...(options.policy !== undefined ? { accessPolicy: options.policy } : {}),
  });
  const decisionService = createWorkItemDecisionService({
    decisions,
    activities,
    workItems: createWorkItemRepo(db),
    now: () => CLOCK,
    newId: () => `iv-dec-${(seq += 1)}`,
    ...(options.policy !== undefined ? { accessPolicy: options.policy } : {}),
  });
  /** 三件套动作的前置种子：作者取该入口的顶层人类（与判据主体同源，动作合法性不受种子影响）。 */
  const seedComment = (id: string, author: AuthorRef) => {
    comments.add({
      id,
      workspaceKey: WS.identity,
      workspacePath: WS.path,
      workItemId: WORK_ITEM_ID,
      author,
      initiatedBy: author,
      body: "独立复验种子评论",
      normalizedBody: "独立复验种子评论",
      mentions: [],
      command: "none",
      inline: null,
      createdAt: CLOCK,
    });
  };
  return {
    db,
    comments,
    activities,
    receipts,
    decisions,
    service,
    decisionService,
    published,
    seedComment,
  };
}

/** 拒绝策略（带采集）：三轴全拒并记录 canComment 的全部入参。 */
function denyWithCapture(): {
  policy: CollaborationAccessPolicy;
  commentCalls: Array<{
    subject: AccessSubject;
    workItem: WorkItemAccessContext;
    action: CommentAccessAction;
  }>;
} {
  const commentCalls: Array<{
    subject: AccessSubject;
    workItem: WorkItemAccessContext;
    action: CommentAccessAction;
  }> = [];
  return {
    commentCalls,
    policy: {
      canViewWorkItem: () => ({ allowed: false, reason: "dispatch_disabled" }),
      canCommentWorkItem: (subject, workItem, action) => {
        commentCalls.push({ subject, workItem, action });
        return { allowed: false, reason: "work_item_archived" };
      },
      canInvokeTarget: () => ({ allowed: false, reason: "agent_not_in_roster" }),
    },
  };
}

type Entry = {
  name: string;
  human: AuthorRef;
  agent: AuthorRef;
  action: CommentAccessAction;
  seedCommentId: string | null;
  act: (h: Harness, ids: { human: AuthorRef; agent: AuthorRef }) => unknown;
};

const ENTRIES: Entry[] = [
  {
    name: "createComment",
    human: { kind: "human", id: "iv-human-create" },
    agent: { kind: "agent", id: "iv-agent-create" },
    action: "create",
    seedCommentId: null,
    act: (h, ids) =>
      h.service.createComment({
        id: "iv-c-create",
        workspaceKey: WS.identity,
        workspacePath: WS.path,
        workItemId: WORK_ITEM_ID,
        author: ids.agent,
        initiatedBy: ids.human,
        body: "看一下",
      }),
  },
  {
    name: "softDeleteComment",
    human: { kind: "human", id: "iv-human-delete" },
    agent: { kind: "agent", id: "iv-agent-delete" },
    action: "delete",
    seedCommentId: "iv-c-delete",
    act: (h, ids) =>
      h.service.softDeleteComment({
        commentId: "iv-c-delete",
        workspaceKey: WS.identity,
        actor: ids.agent,
        initiatedBy: ids.human,
      }),
  },
  {
    name: "setCommentResolved",
    human: { kind: "human", id: "iv-human-resolve" },
    agent: { kind: "agent", id: "iv-agent-resolve" },
    action: "resolve",
    seedCommentId: "iv-c-resolve",
    act: (h, ids) =>
      h.service.setCommentResolved({
        commentId: "iv-c-resolve",
        workspaceKey: WS.identity,
        resolved: true,
        actor: ids.agent,
        initiatedBy: ids.human,
      }),
  },
  {
    name: "addCommentReaction",
    human: { kind: "human", id: "iv-human-react" },
    agent: { kind: "agent", id: "iv-agent-react" },
    action: "react",
    seedCommentId: "iv-c-react",
    act: (h, ids) =>
      h.service.addCommentReaction({
        commentId: "iv-c-react",
        workspaceKey: WS.identity,
        author: ids.agent,
        initiatedBy: ids.human,
        emoji: "🧪",
      }),
  },
  {
    name: "createWorkItemDecision",
    human: { kind: "human", id: "iv-human-decide" },
    agent: { kind: "agent", id: "iv-agent-decide" },
    action: "decide",
    seedCommentId: null,
    act: (h, ids) =>
      h.decisionService.createDecision({
        workspaceKey: WS.identity,
        workspacePath: WS.path,
        workItemId: WORK_ITEM_ID,
        kind: "proposal",
        subject: "独立复验决定",
        author: ids.agent,
        initiatedBy: ids.human,
        sourceRequestId: "iv-req-1",
      }),
  },
];

for (const entry of ENTRIES) {
  test(`IV-GATE｜${entry.name}：注入拒绝 ⇒ 响亮抛（点名本入口 initiatedBy）、五表整表零变化、出口零外发`, () => {
    const ids = { human: entry.human, agent: entry.agent };
    // 控制组：缺省策略下同一调用（含种子）必须成功 —— 否则「被拒」与「坏请求」分不开。
    const control = makeHarness();
    if (entry.seedCommentId !== null) control.seedComment(entry.seedCommentId, entry.human);
    assert.doesNotThrow(() => entry.act(control, ids), "负控：缺省策略下该入口必须成功");

    // 实验组：注入拒绝策略。
    const { policy, commentCalls } = denyWithCapture();
    const h = makeHarness({ policy });
    if (entry.seedCommentId !== null) h.seedComment(entry.seedCommentId, entry.human);
    const before = snapshot(h.db);
    assert.throws(
      () => entry.act(h, ids),
      (error: Error) =>
        error.message.includes("原因=work_item_archived") &&
        error.message.includes(entry.human.id) &&
        !error.message.includes(entry.agent.id),
      `${entry.name} 拒绝文案必须点名本入口的顶层人类主体而不是 actor`,
    );
    assert.deepEqual(snapshot(h.db), before, "五张表整表内容零变化（不是行数不变）");
    assert.deepEqual(h.published, [], "出口零外发（不留无来源的派发 receipt）");
    assert.equal(commentCalls.length, 1, "恰一次 canComment 判据调用（防双判/漏判）");
    assert.equal(commentCalls[0]!.action, entry.action, "action 轴逐入口对应");
    assert.deepEqual(commentCalls[0]!.subject, entry.human, "主体恒取 initiatedBy（actor 顶不掉）");
    assert.deepEqual(
      commentCalls[0]!.workItem,
      { workItemId: WORK_ITEM_ID, archivedAt: null },
      "判据上下文带真实归档态（未归档 ⇒ null）",
    );
  });
}

test("IV-GATE｜归档工作项：五入口判据上下文带真归档值（可审计不可派发；本卡不改该格）", () => {
  const { policy, commentCalls } = denyWithCapture();
  const h = makeHarness({ policy, archivedAt: 4_242 });
  const before = snapshot(h.db);
  assert.throws(() =>
    h.service.createComment({
      id: "iv-c-arch",
      workspaceKey: WS.identity,
      workspacePath: WS.path,
      workItemId: WORK_ITEM_ID,
      author: { kind: "human", id: "iv-human-arch" },
      initiatedBy: { kind: "human", id: "iv-human-arch" },
      body: "看一下",
    }),
  );
  assert.equal(commentCalls.length, 1);
  assert.deepEqual(commentCalls[0]!.workItem, { workItemId: WORK_ITEM_ID, archivedAt: 4_242 });
  assert.deepEqual(snapshot(h.db), before, "归档项下被拒也零写入");
});

test("IV-READ｜读面 canView：注入拒绝 ⇒ 响亮抛且未取 repo（不返回 null）；缺省 ⇒ 具名返回/不存在 null", async () => {
  const db = freshDb();
  insertWorkItem(db);
  let repoReads = 0;
  const repos = {
    comments: createWorkItemCommentRepo(db),
    activities: createWorkItemActivityRepo(db),
    decisions: createWorkItemDecisionRepo(db),
    reactions: createWorkItemCommentReactionRepo(db),
    receipts: createCommentDispatchReceiptRepo(db),
  };
  const LOCAL_HUMAN: AuthorRef = { kind: "human", id: "iv-local-human" };
  const base = {
    createRuntime: async () =>
      ({
        workItemRepo: createWorkItemRepo(db),
        deliverableRepo: createWorkItemDeliverableRepo(db),
        /* #8 D2：读模型新增 PR 关联清单 + 读数面可用性 —— 夹具按 runtime 契约补齐。 */
        pullRequestRepo: createWorkItemPullRequestRepo(db),
        pullRequestProvider: createNullPullRequestProvider(),
        /* #8 D3：读面带出整批收尾模式（详情页 PR 区的 pr-gate 提示读它）。 */
        readSquadMergeMode: () => "local",
        /* SUB.1：订阅存储面（读模型的 `subscribers` 格取自它）——夹具按 runtime 契约补齐。 */
        subscriberRepo: createWorkItemSubscriberRepo(db),
        boundWorkspace: WS,
      }) as unknown as SquadRuntime,
    getRepos: () => {
      repoReads += 1;
      return repos;
    },
    localHumanActor: () => LOCAL_HUMAN,
  };

  // 拒绝格：以归档原因拒绝 ⇒ 抛，且不返回 null、不读任何 repo。
  const denied = createWorkItemCollaborationService({
    ...base,
    accessPolicy: {
      canViewWorkItem: () => ({ allowed: false, reason: "work_item_archived" }),
      canCommentWorkItem: () => ({ allowed: true }),
      canInvokeTarget: () => ({ allowed: true }),
    },
  });
  await assert.rejects(
    () => denied.getWorkItemCollaboration({ path: WS.path, identity: WS.identity }, WORK_ITEM_ID),
    (error: Error) =>
      error.message.includes("原因=work_item_archived") && error.message.includes(LOCAL_HUMAN.id),
    "读面被拒必须响亮抛并点名主体（返回 null 会把「权限被拒」伪装成「不存在」）",
  );
  assert.equal(repoReads, 0, "拒绝位次必须在取任何事实之前");

  // 缺省格：具名返回 + 归档照可读 + 不存在仍 null。
  const normal = createWorkItemCollaborationService(base);
  const live = await normal.getWorkItemCollaboration(
    { path: WS.path, identity: WS.identity },
    WORK_ITEM_ID,
  );
  assert.equal(live?.workItem.id, WORK_ITEM_ID);
  assert.equal(
    await normal.getWorkItemCollaboration({ path: WS.path, identity: WS.identity }, "iv-missing"),
    null,
  );
});

// ---------------------------------------------------------------------------
// 源码面：五入口并列的独立复算（本文件自己的去注释 / 函数体提取实现）
// ---------------------------------------------------------------------------

const WORKITEM_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "../src/workitem");
const GATE_CALL = "canCommentWorkItem(";
const WRITE_MARKERS = [".add(", ".softDelete(", ".setResolved("];

/** 取 `<name>(…){…}` 实现体：从「行首 4 空格 + 方法名(」起，花括号配对。 */
function independentMethodBody(source: string, name: string): string {
  const start = source.search(new RegExp(`\\n {4}(?:async )?${name}\\(`));
  assert.ok(start >= 0, `找不到方法 ${name}`);
  const bodyStart = source.indexOf("{", source.indexOf("(", start));
  let depth = 0;
  for (let index = bodyStart; index < source.length; index += 1) {
    if (source[index] === "{") depth += 1;
    else if (source[index] === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(bodyStart + 1, index);
    }
  }
  throw new Error(`${name} 花括号不配对`);
}

test("IV-G3｜源码面独立复算：恰 5 处判据调用，每处在该方法第一次写之前（含目录级零重复）", () => {
  const strip = (source: string) =>
    source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
  const writers = [
    {
      file: "commentService.ts",
      methods: ["createComment", "softDeleteComment", "setCommentResolved", "addCommentReaction"],
    },
    { file: "workItemDecisionService.ts", methods: ["createDecision"] },
  ] as const;
  let checked = 0;
  let total = 0;
  for (const { file, methods } of writers) {
    const code = strip(readFileSync(resolve(WORKITEM_DIR, file), "utf8"));
    total += code.split(GATE_CALL).length - 1;
    for (const method of methods) {
      const body = independentMethodBody(code, method);
      assert.equal(
        body.split(GATE_CALL).length - 1,
        1,
        `${file}#${method} 恰一处判据调用（独立计数）`,
      );
      const gateIndex = body.indexOf(GATE_CALL);
      const writeIndexes = WRITE_MARKERS.map((marker) => body.indexOf(marker)).filter(
        (index) => index >= 0,
      );
      assert.ok(writeIndexes.length > 0, `${file}#${method} 必须能找到写标记（防空转）`);
      assert.ok(
        gateIndex < Math.min(...writeIndexes),
        `${file}#${method} 判据必须先于第一次写（独立下标序）`,
      );
      checked += 1;
    }
  }
  assert.equal(checked, 5, "五个写方法逐个复算");
  assert.equal(total, 5, "两个写者内判据调用总数恰 5（四个评论入口 + 一个决定入口）");
  // 目录级：除两个写者与判据模块自身外，workitem/** 不得再出现判据调用（第二份判据）。
  const exempt = new Set([
    "commentService.ts",
    "workItemDecisionService.ts",
    "collaborationAccessPolicy.ts",
  ]);
  for (const name of readdirSync(WORKITEM_DIR).filter((entry) => entry.endsWith(".ts"))) {
    if (exempt.has(name)) continue;
    assert.ok(
      !strip(readFileSync(resolve(WORKITEM_DIR, name), "utf8")).includes(GATE_CALL),
      `${name} 不得调用判据（独立目录扫描）`,
    );
  }
});
