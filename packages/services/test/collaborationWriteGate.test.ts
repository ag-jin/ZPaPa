import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { runTasksDatabaseMigrations } from "../src/session/tasksDatabase/migrations.js";
import type {
  AccessDecision,
  AccessSubject,
  CollaborationAccessDenyReason,
  CollaborationAccessPolicy,
  CommentAccessAction,
  InvokeTargetContext,
  WorkItemAccessContext,
} from "../src/workitem/collaborationAccessPolicy.js";
import { createCommentDispatchReceiptRepo } from "../src/workitem/commentDispatchReceiptRepo.js";
import { createCommentService } from "../src/workitem/commentService.js";
import { createSquadDeferredDispatchRepo } from "../src/workitem/squadDeferredDispatchRepo.js";
import { createSquadRunRepo } from "../src/workitem/squadRunRepo.js";
import { createWorkItemActivityRepo } from "../src/workitem/workItemActivityRepo.js";
import { createWorkItemCommentRepo, type AuthorRef } from "../src/workitem/workItemCommentRepo.js";
import { createWorkItemCommentReactionRepo } from "../src/workitem/workItemCommentReactionRepo.js";
import { createWorkItemDecisionRepo } from "../src/workitem/workItemDecisionRepo.js";
import { createWorkItemDecisionService } from "../src/workitem/workItemDecisionService.js";
import { createWorkItemRepo } from "../src/workitem/workItemRepo.js";

/* 协作域 C4.1：**五个写入口并列判据面**（§11.5「权限失败不写半条 Comment，不留下无来源的派发 receipt」）。

   本文件的判据面是 C3 交接义务的落点：`createWorkItemDecision` 必须与四评论入口**并列**纳入同一判据面。
   两半互相咬合：
   · **源码面**（去注释后 token 扫描）：五处调用点、每处恰一次、每处都在该方法第一次写之前；
   · **行为面**：注入拒绝策略 ⇒ 每个入口都响亮抛且**五张表整表内容零变化 + 出口零外发**；
     注入恒放行策略 ⇒ 每入口恰调用一次（防双判），且主体恒来自 `initiatedBy`（A2A 红线）。

   期望值全部是手写字面量（独立真源），不是「用实现再算一遍」。 */

const SRC_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../src");
const WORKITEM_DIR = resolve(SRC_ROOT, "workitem");
const readSource = (file: string) => readFileSync(resolve(WORKITEM_DIR, file), "utf8");
const stripComments = (source: string) =>
  source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
/** 源码扫描一律**去注释**：文件头/行内注释会引用 `.add(`、`canCommentWorkItem(` 这类词作为说明。 */
const readCode = (file: string) => stripComments(readSource(file));
const countOccurrences = (source: string, token: string) => source.split(token).length - 1;

/** 取对象方法 `<name>(…args) { … }` 的实现体（花括号配对；签名行后第一个 `{` 起算）。 */
function methodBodyOf(source: string, name: string): string {
  const start = source.search(new RegExp(`\\n {4}(?:async )?${name}\\(`));
  assert.ok(start >= 0, `源码里找不到方法 ${name}`);
  const bodyStart = source.indexOf("{", source.indexOf("(", start));
  let depth = 0;
  for (let index = bodyStart; index < source.length; index += 1) {
    const char = source[index];
    if (char === "{") depth += 1;
    else if (char === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(bodyStart + 1, index);
    }
  }
  throw new Error(`${name} 的实现体没有配对闭合`);
}

/** 取 `export type <name> = { … };` 的类型块。 */
function typeBlockOf(source: string, name: string): string {
  const start = source.indexOf(`export type ${name} = {`);
  assert.ok(start >= 0, `源码里找不到 ${name} 的类型块`);
  const end = source.indexOf("\n};", start);
  assert.ok(end > 0, `${name} 的类型块没有收尾`);
  return source.slice(start, end);
}

const GATE = "canCommentWorkItem(";
/** 「写」的标记：评论新增/软删/解决态与三张事实表的 `.add(`（先写后判必须被逮住）。 */
const WRITE_MARKERS = [".add(", ".softDelete(", ".setResolved("];
const firstWriteIndex = (body: string) => {
  const found = WRITE_MARKERS.map((marker) => body.indexOf(marker)).filter((index) => index >= 0);
  return found.length === 0 ? -1 : Math.min(...found);
};
const WORK_ITEM_WRITERS = [
  {
    file: "commentService.ts",
    methods: ["createComment", "softDeleteComment", "setCommentResolved", "addCommentReaction"],
  },
  { file: "workItemDecisionService.ts", methods: ["createDecision"] },
] as const;

const WORKSPACE = { path: "/tmp/c41-ws", identity: "c41-ws" };
const HUMAN: AccessSubject = { kind: "human", id: "local-user" };
/** agent「代人类执行」：作者是 agent，顶层人类归因仍是 HUMAN（A2A 红线）。 */
const AGENT_AUTHOR: AuthorRef = { kind: "agent", id: "ta-agent" };
const CLOCK = 1_700_000_000_000;
const TABLES = [
  "work_item_comments",
  "work_item_activities",
  "work_item_comment_reactions",
  "comment_dispatch_receipts",
  "work_item_decisions",
] as const;

function tableSnapshot(db: DatabaseSync): Record<string, unknown[]> {
  return Object.fromEntries(
    TABLES.map((table) => [table, db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()]),
  );
}

function denyPolicy(reason: CollaborationAccessDenyReason): CollaborationAccessPolicy {
  const deny = (): AccessDecision => ({ allowed: false, reason });
  return {
    canViewWorkItem: deny,
    canCommentWorkItem: deny,
    canInvokeTarget: deny,
  };
}

/** 恒放行但记录每次调用的策略：防双判 + 记录判据真的拿到的主体（A2A 红线的行为面）。 */
function countingPolicy(): { policy: CollaborationAccessPolicy; calls: string[] } {
  const calls: string[] = [];
  const tag = (subject: AccessSubject) => `${subject.kind}:${subject.id}`;
  return {
    calls,
    policy: {
      canViewWorkItem: (subject: AccessSubject) => {
        calls.push(`view:${tag(subject)}`);
        return { allowed: true };
      },
      canCommentWorkItem: (
        subject: AccessSubject,
        _workItem: WorkItemAccessContext,
        action: CommentAccessAction,
      ) => {
        calls.push(`comment:${action}:${tag(subject)}`);
        return { allowed: true };
      },
      canInvokeTarget: (
        _subject: AccessSubject,
        _workItem: WorkItemAccessContext,
        _target: InvokeTargetContext,
      ) => {
        calls.push("invoke");
        return { allowed: true };
      },
    },
  };
}

type Harness = {
  db: DatabaseSync;
  service: ReturnType<typeof createCommentService>;
  decisionService: ReturnType<typeof createWorkItemDecisionService>;
  comments: ReturnType<typeof createWorkItemCommentRepo>;
  published: unknown[];
  seedComment: (id: string) => void;
};

function harness(options: { accessPolicy?: CollaborationAccessPolicy } = {}): Harness {
  const db = new DatabaseSync(":memory:");
  runTasksDatabaseMigrations(db);
  const comments = createWorkItemCommentRepo(db);
  const activities = createWorkItemActivityRepo(db);
  const receipts = createCommentDispatchReceiptRepo(db);
  const reactions = createWorkItemCommentReactionRepo(db);
  const runs = createSquadRunRepo(db);
  const deferred = createSquadDeferredDispatchRepo(db);
  const decisions = createWorkItemDecisionRepo(db);
  const workItems = createWorkItemRepo(db);
  workItems.insert({
    id: "wi-1",
    workspaceIdentity: WORKSPACE.identity,
    workspacePath: WORKSPACE.path,
    title: "判据面工作项",
    body: "",
    status: "todo",
    assignee: { type: "agent", id: AGENT_AUTHOR.id },
    labels: [],
    properties: {},
    position: 0,
  });
  const published: unknown[] = [];
  let seq = 0;
  const policyDep =
    options.accessPolicy !== undefined ? { accessPolicy: options.accessPolicy } : {};
  const service = createCommentService({
    comments,
    activities,
    receipts,
    reactions,
    runs,
    deferred,
    workItems,
    roster: { listAgents: () => [{ id: AGENT_AUTHOR.id, name: "Ann" }], listSquads: () => [] },
    readDispatchEnabled: () => true,
    publishDispatchRequest: (request) => published.push(request),
    now: () => CLOCK,
    newId: () => `gen-${++seq}`,
    ...policyDep,
  });
  const decisionService = createWorkItemDecisionService({
    decisions,
    activities,
    workItems,
    now: () => CLOCK,
    newId: () => `dec-${++seq}`,
    ...policyDep,
  });
  const seedComment = (id: string) => {
    comments.add({
      id,
      workspaceKey: WORKSPACE.identity,
      workspacePath: WORKSPACE.path,
      workItemId: "wi-1",
      author: HUMAN,
      initiatedBy: HUMAN,
      body: "种子评论",
      normalizedBody: "种子评论",
      mentions: [],
      command: "none",
      inline: null,
      createdAt: CLOCK,
    });
  };
  return { db, service, decisionService, comments, published, seedComment };
}

/** 五入口的调用与它们的**前置种子**（三件套动作指向已存在的评论）。 */
const WRITE_ENTRIES = [
  {
    name: "createComment",
    seed: () => {},
    act: (h: Harness) =>
      h.service.createComment({
        id: "c-deny",
        workspaceKey: WORKSPACE.identity,
        workspacePath: WORKSPACE.path,
        workItemId: "wi-1",
        author: HUMAN,
        initiatedBy: HUMAN,
        body: "@Ann 看一下",
      }),
  },
  {
    name: "softDeleteComment",
    seed: (h: Harness) => h.seedComment("c-del"),
    act: (h: Harness) =>
      h.service.softDeleteComment({
        commentId: "c-del",
        workspaceKey: WORKSPACE.identity,
        actor: HUMAN,
        initiatedBy: HUMAN,
      }),
  },
  {
    name: "setCommentResolved",
    seed: (h: Harness) => h.seedComment("c-res"),
    act: (h: Harness) =>
      h.service.setCommentResolved({
        commentId: "c-res",
        workspaceKey: WORKSPACE.identity,
        resolved: true,
        actor: HUMAN,
        initiatedBy: HUMAN,
      }),
  },
  {
    name: "addCommentReaction",
    seed: (h: Harness) => h.seedComment("c-react"),
    act: (h: Harness) =>
      h.service.addCommentReaction({
        commentId: "c-react",
        workspaceKey: WORKSPACE.identity,
        author: HUMAN,
        initiatedBy: HUMAN,
        emoji: "🚀",
      }),
  },
  {
    name: "createWorkItemDecision",
    seed: () => {},
    act: (h: Harness) =>
      h.decisionService.createDecision({
        workspaceKey: WORKSPACE.identity,
        workspacePath: WORKSPACE.path,
        workItemId: "wi-1",
        kind: "proposal",
        subject: "采用方案 A",
        author: HUMAN,
        initiatedBy: HUMAN,
        sourceRequestId: "req-deny",
      }),
  },
] as const;

// ---------------------------------------------------------------------------
// 源码面：五入口并列（G3）
// ---------------------------------------------------------------------------

test("G3｜五入口并列：`canCommentWorkItem(` 在两个写者内恰 5 处（评论 4 + 决定 1），其余文件零处", () => {
  for (const { file, methods } of WORK_ITEM_WRITERS) {
    assert.equal(
      countOccurrences(readCode(file), GATE),
      methods.length,
      `${file} 的判据调用数必须等于它的写方法数（漏一个入口 ⇒ 该入口绕过判据面）`,
    );
  }
  const exempt = new Set([
    "commentService.ts",
    "workItemDecisionService.ts",
    "collaborationAccessPolicy.ts",
  ]);
  for (const name of readdirSync(WORKITEM_DIR).filter((file) => file.endsWith(".ts"))) {
    if (exempt.has(name)) continue;
    assert.ok(
      !readCode(name).includes(GATE),
      `${name} 不得出现判据调用：五个写入口都在门面/两服务内，别处再调就是第二份判据`,
    );
  }
  const policyCode = readCode("collaborationAccessPolicy.ts");
  assert.equal(
    countOccurrences(policyCode, "export function canCommentWorkItem("),
    1,
    "判据模块内恰一处实现（单源）",
  );
});

test("G3｜先判后写（逐方法下标序）：每个写方法内判据调用必须早于该方法第一次写", () => {
  let checked = 0;
  for (const { file, methods } of WORK_ITEM_WRITERS) {
    const code = readCode(file);
    for (const method of methods) {
      const body = methodBodyOf(code, method);
      const gateIndex = body.indexOf(GATE);
      const writeIndex = firstWriteIndex(body);
      assert.equal(countOccurrences(body, GATE), 1, `${file}#${method} 恰一处判据调用（防双判）`);
      assert.ok(gateIndex >= 0, `${file}#${method} 必须在实现体内调用判据`);
      assert.ok(writeIndex >= 0, `${file}#${method} 必须能找到写标记（否则本断言空转）`);
      assert.ok(
        gateIndex < writeIndex,
        `${file}#${method} 先写后判：判据下标 ${gateIndex} 不得晚于第一次写下标 ${writeIndex}`,
      );
      checked += 1;
    }
  }
  assert.equal(checked, 5, "五个写方法逐个检查（不是抽样）");
});

test("deps 守卫：两个写服务的依赖类型都开了 accessPolicy? 口（缺省 = 单人策略）", () => {
  for (const [file, typeName] of [
    ["commentService.ts", "CommentServiceDeps"],
    ["workItemDecisionService.ts", "WorkItemDecisionServiceDeps"],
  ] as const) {
    const block = typeBlockOf(readSource(file), typeName);
    assert.match(
      block,
      /accessPolicy\?: CollaborationAccessPolicy/,
      `${file} 的 ${typeName} 必须有可选 accessPolicy 口（测试注入拒绝策略是本卡唯一的拒绝路径来源）`,
    );
  }
});

test("读面并列：门面恰一处 canViewWorkItem 调用，且在读任何事实之前（拒绝时不返回 null）", () => {
  const facade = stripComments(readSource("workItemCollaborationService.ts"));
  assert.equal(countOccurrences(facade, "canViewWorkItem("), 1, "读面恰一处 canView 判据");
  const body = methodBodyOf(facade, "getWorkItemCollaboration");
  const gateIndex = body.indexOf("canViewWorkItem(");
  const readIndex = body.indexOf("listByWorkItem(");
  assert.ok(gateIndex >= 0, "getWorkItemCollaboration 必须调用 canView 判据");
  assert.ok(readIndex >= 0, "必须能找到取数标记（否则本断言空转）");
  assert.ok(gateIndex < readIndex, "判据必须早于任何 repo 取数：拒绝 ⇒ 不读也不返回 null");
});

// ---------------------------------------------------------------------------
// 行为面：注入拒绝 ⇒ 响亮抛 + 五张表零变化 + 出口零外发（§11.5）
// ---------------------------------------------------------------------------

for (const entry of WRITE_ENTRIES) {
  test(`注入拒绝策略 ⇒ ${entry.name} 响亮抛（文案含原因与主体），五张表整表零变化、出口零外发`, () => {
    const control = harness();
    entry.seed(control);
    assert.doesNotThrow(
      () => entry.act(control),
      `负控：同一调用在缺省策略下必须成功（否则「被拒」与「坏请求」分不开）`,
    );

    const h = harness({ accessPolicy: denyPolicy("work_item_archived") });
    entry.seed(h);
    const before = tableSnapshot(h.db);
    assert.throws(
      () => entry.act(h),
      (error: Error) =>
        error.message.includes("协作访问判据拒绝") &&
        error.message.includes("work_item_archived") &&
        error.message.includes(HUMAN.id),
      `${entry.name} 必须响亮抛并点名原因与主体（静默 no-op 会让用户以为写入成功）`,
    );
    assert.deepEqual(
      tableSnapshot(h.db),
      before,
      "权限失败不写半条事实（五张表整表内容逐字节不变）",
    );
    assert.deepEqual(h.published, [], "不留下无来源的派发 receipt：出口零外发");
  });
}

test("注入拒绝策略 ⇒ 五个入口逐个都真的过判据（拒绝不是靠别的前置校验抛的）", () => {
  const reasons = ["work_item_archived", "agent_not_in_roster", "dispatch_disabled"] as const;
  for (const reason of reasons) {
    for (const entry of WRITE_ENTRIES) {
      const h = harness({ accessPolicy: denyPolicy(reason) });
      entry.seed(h);
      assert.throws(
        () => entry.act(h),
        (error: Error) => error.message.includes(`原因=${reason}`),
        `${entry.name} 在注入 ${reason} 时必须报出该原因（判据结论是唯一拒绝来源）`,
      );
    }
  }
});

// ---------------------------------------------------------------------------
// 行为面：缺省 / 放行策略 ⇒ 形状不变 + 恰调用一次
// ---------------------------------------------------------------------------

test("缺省策略（不注入）⇒ 五入口形状与既有行为一致：评论照写、派发照外发、三件套各落事实、决定照写", () => {
  const h = harness();
  h.seedComment("c-del");
  h.seedComment("c-res");
  h.seedComment("c-react");
  const created = h.service.createComment({
    id: "c-1",
    workspaceKey: WORKSPACE.identity,
    workspacePath: WORKSPACE.path,
    workItemId: "wi-1",
    author: HUMAN,
    initiatedBy: HUMAN,
    body: "@Ann 看一下",
  });
  assert.deepEqual(
    created.dispatches,
    [
      {
        targetAgentId: AGENT_AUTHOR.id,
        source: "mention_agent",
        outcome: "pending",
        detail: { triggerSource: "mention_agent" },
      },
    ],
    "缺省策略下派发请求照落 pending（判据接入不得改变任何既有结论）",
  );
  assert.equal(h.published.length, 1, "pending 请求仍经出口外发恰一次");
  const deleted = h.service.softDeleteComment({
    commentId: "c-del",
    workspaceKey: WORKSPACE.identity,
    actor: HUMAN,
  });
  assert.equal(deleted.id, "c-del");
  assert.equal(typeof deleted.deletedAt, "number", "软删仍落墓碑（时间戳由评论 repo 自己写）");
  const resolved = h.service.setCommentResolved({
    commentId: "c-res",
    workspaceKey: WORKSPACE.identity,
    resolved: true,
    actor: HUMAN,
  });
  assert.equal(resolved.id, "c-res");
  assert.equal(typeof resolved.resolvedAt, "number", "解决态仍落库");
  assert.equal(
    h.service.addCommentReaction({
      commentId: "c-react",
      workspaceKey: WORKSPACE.identity,
      author: HUMAN,
      emoji: "🚀",
    }).emoji,
    "🚀",
  );
  const decision = h.decisionService.createDecision({
    workspaceKey: WORKSPACE.identity,
    workspacePath: WORKSPACE.path,
    workItemId: "wi-1",
    kind: "proposal",
    subject: "采用方案 A",
    author: HUMAN,
    initiatedBy: HUMAN,
    sourceRequestId: "req-1",
  });
  assert.equal(decision.kind, "proposal");
  assert.equal(decision.initiatedBy.id, HUMAN.id);
});

test("注入恒放行策略 ⇒ 每个写入口恰调用一次判据，且主体恒来自 initiatedBy（agent 作者压不过人类归因）", () => {
  const { policy, calls } = countingPolicy();
  const h = harness({ accessPolicy: policy });
  h.seedComment("c-del");
  h.seedComment("c-res");
  h.seedComment("c-react");
  h.service.createComment({
    id: "c-a2a",
    workspaceKey: WORKSPACE.identity,
    workspacePath: WORKSPACE.path,
    workItemId: "wi-1",
    author: AGENT_AUTHOR,
    initiatedBy: HUMAN,
    body: "@Ann 看一下",
  });
  h.service.softDeleteComment({
    commentId: "c-del",
    workspaceKey: WORKSPACE.identity,
    actor: AGENT_AUTHOR,
    initiatedBy: HUMAN,
  });
  h.service.setCommentResolved({
    commentId: "c-res",
    workspaceKey: WORKSPACE.identity,
    resolved: false,
    actor: AGENT_AUTHOR,
    initiatedBy: HUMAN,
  });
  h.service.addCommentReaction({
    commentId: "c-react",
    workspaceKey: WORKSPACE.identity,
    author: AGENT_AUTHOR,
    initiatedBy: HUMAN,
    emoji: "🚀",
  });
  h.decisionService.createDecision({
    workspaceKey: WORKSPACE.identity,
    workspacePath: WORKSPACE.path,
    workItemId: "wi-1",
    kind: "proposal",
    subject: "采用方案 A",
    author: AGENT_AUTHOR,
    initiatedBy: HUMAN,
    sourceRequestId: "req-a2a",
  });
  assert.deepEqual(
    calls,
    [
      "comment:create:human:local-user",
      "comment:delete:human:local-user",
      "comment:resolve:human:local-user",
      "comment:react:human:local-user",
      "comment:decide:human:local-user",
    ],
    "五入口各恰一次判据调用，action 逐一对应；主体是 initiatedBy（A2A 的 agent 作者顶不掉人类归因）",
  );
});
