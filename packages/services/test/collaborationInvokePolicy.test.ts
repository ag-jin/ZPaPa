import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { runTasksDatabaseMigrations } from "../src/session/tasksDatabase/migrations.js";
import {
  COLLABORATION_ACCESS_DENY_REASONS,
  type AccessDecision,
  type AccessSubject,
  type CollaborationAccessDenyReason,
  type CollaborationAccessPolicy,
  type InvokeAccessContext,
  type InvokeTargetContext,
  type WorkItemAccessContext,
} from "../src/workitem/collaborationAccessPolicy.js";
import { createCommentDispatchReceiptRepo } from "../src/workitem/commentDispatchReceiptRepo.js";
import { createCommentService } from "../src/workitem/commentService.js";
import { createSquadDeferredDispatchRepo } from "../src/workitem/squadDeferredDispatchRepo.js";
import { createSquadRunRepo } from "../src/workitem/squadRunRepo.js";
import { createWorkItemActivityRepo } from "../src/workitem/workItemActivityRepo.js";
import { createWorkItemCommentRepo, type AuthorRef } from "../src/workitem/workItemCommentRepo.js";
import { createWorkItemCommentReactionRepo } from "../src/workitem/workItemCommentReactionRepo.js";
import { createWorkItemRepo } from "../src/workitem/workItemRepo.js";

/* 协作域 C4.2：**目标可调性判据接线**（canInvoke 单源，行为中立）。

   期望值是手写字面量（独立真源 = 既有 receipt 词汇与 §12.1-12 的裁定），不是「用实现再算一遍」：
   · 三原因 `work_item_archived` / `dispatch_disabled` / `agent_not_in_roster` 逐字来自既有 receipt detail
     （commentService.test.ts「受限可审计」逐格断言、b52 门禁格）；
   · 优先序 = 既有实现（`restriction ?? 名册`，其中门禁只写 `??=`）⇒ **归档 > 门禁 > 名册**，逐格贴住；
   · A2A 对照的期望 = §9 第 3 条：同一条评论换作者（agent）不改变任何结论，主体恒为顶层人类 initiatedBy。 */

const WORKSPACE = { path: "/tmp/c42-ws", identity: "c42-ws" };
const HUMAN: AuthorRef = { kind: "human", id: "hu-1" };
const AGENT_AUTHOR: AuthorRef = { kind: "agent", id: "ta-a" };
const KNOWN_AGENT_ID = "ta-ann";
/** 名册外的目标（`TeamAgentService.list()` 里查不到的 agent）：既有行为 ⇒ blocked(agent_not_in_roster)。 */
const OFF_ROSTER_AGENT_ID = "ta-gone";
const CLOCK = 1_700_000_000_000;

/** 判据面替身：三轴各给固定结论（`canInvokeTarget` 的结论就是被测的接线对象）。 */
function fixedPolicy(canInvokeTarget: () => AccessDecision): CollaborationAccessPolicy {
  return {
    canViewWorkItem: () => ({ allowed: true }),
    canCommentWorkItem: () => ({ allowed: true }),
    canInvokeTarget,
  };
}

/** 恒放行但记录每次 canInvoke 的**全部入参**：主体是否来自 `initiatedBy` 只能从这里观察。 */
type InvokeCall = {
  subject: AccessSubject;
  workItem: WorkItemAccessContext;
  target: InvokeTargetContext;
  context: InvokeAccessContext;
};

function recordingPolicy(calls: InvokeCall[]): CollaborationAccessPolicy {
  return {
    canViewWorkItem: () => ({ allowed: true }),
    canCommentWorkItem: () => ({ allowed: true }),
    canInvokeTarget: (subject, workItem, target, context) => {
      calls.push({ subject, workItem, target, context });
      return { allowed: true };
    },
  };
}

/** 逐目标 blocked 报告（既有形状逐字：`source` + `detail.reason`，见 commentService.test.ts 的三格）。 */
function blockedReport(targetAgentId: string, reason: CollaborationAccessDenyReason) {
  return {
    targetAgentId,
    source: "issue_assignee" as const,
    outcome: "blocked" as const,
    detail: { triggerSource: "issue_assignee", reason },
  };
}

type Harness = {
  db: DatabaseSync;
  service: ReturnType<typeof createCommentService>;
  published: unknown[];
};

function harness(
  options: {
    accessPolicy?: CollaborationAccessPolicy;
    dispatchEnabled?: boolean;
    assigneeAgentId?: string;
    archivedAt?: number;
  } = {},
): Harness {
  const db = new DatabaseSync(":memory:");
  runTasksDatabaseMigrations(db);
  const comments = createWorkItemCommentRepo(db);
  const activities = createWorkItemActivityRepo(db);
  const receipts = createCommentDispatchReceiptRepo(db);
  const reactions = createWorkItemCommentReactionRepo(db);
  const runs = createSquadRunRepo(db);
  const deferred = createSquadDeferredDispatchRepo(db);
  const workItems = createWorkItemRepo(db);
  workItems.insert({
    id: "wi-1",
    workspaceIdentity: WORKSPACE.identity,
    workspacePath: WORKSPACE.path,
    title: "目标可调性工作项",
    body: "",
    status: "todo",
    assignee: { type: "agent", id: options.assigneeAgentId ?? KNOWN_AGENT_ID },
    labels: [],
    properties: {},
    position: 0,
  });
  if (options.archivedAt !== undefined) {
    db.prepare("UPDATE work_items SET archived_at = ? WHERE id = 'wi-1'").run(options.archivedAt);
  }
  const published: unknown[] = [];
  let seq = 0;
  const policyDep =
    options.accessPolicy !== undefined ? { accessPolicy: options.accessPolicy } : {};
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
    roster: { listAgents: () => [{ id: KNOWN_AGENT_ID, name: "ann" }], listSquads: () => [] },
    readDispatchEnabled: () => options.dispatchEnabled ?? true,
    publishDispatchRequest: (request) => published.push(request),
    now: () => CLOCK,
    newId: () => `gen-${++seq}`,
    ...policyDep,
  });
  return { db, service, published };
}

// ---------------------------------------------------------------------------
// A2A 同格对照（§9 第 3 条：按顶层人类 initiatedBy 归因）
// ---------------------------------------------------------------------------

/** 顶层人类之外的另一个主体：证明主体是**归因事实**，既不被作者顶替、也不被写死成本地人类。 */
const AGENT_INITIATOR: AuthorRef = { kind: "agent", id: "ta-initiator" };

const commentInput = (over: {
  id: string;
  author: AuthorRef;
  initiatedBy: AuthorRef;
  body?: string;
}): Parameters<ReturnType<typeof createCommentService>["createComment"]>[0] => ({
  id: over.id,
  workspaceKey: WORKSPACE.identity,
  workspacePath: WORKSPACE.path,
  workItemId: "wi-1",
  author: over.author,
  initiatedBy: over.initiatedBy,
  body: over.body ?? "@ann 看一下",
});

test("A2A 同格对照（§9 第 3 条）：agent 作者 + 人类归因 vs 人类作者 ⇒ 逐格同结论，主体恒取 initiatedBy", () => {
  const expectedDispatches = [
    {
      targetAgentId: KNOWN_AGENT_ID,
      source: "mention_agent",
      outcome: "pending",
      detail: { triggerSource: "mention_agent" },
    },
  ];

  // 半 A（行为面，缺省策略）：同一条评论只换作者 ⇒ receipt 的 outcome/detail 逐格相同。
  const asHuman = harness({ assigneeAgentId: KNOWN_AGENT_ID });
  const humanResult = asHuman.service.createComment(
    commentInput({ id: "c-human", author: HUMAN, initiatedBy: HUMAN }),
  );
  const asAgent = harness({ assigneeAgentId: KNOWN_AGENT_ID });
  const agentResult = asAgent.service.createComment(
    commentInput({ id: "c-agent", author: AGENT_AUTHOR, initiatedBy: HUMAN }),
  );
  assert.deepEqual(humanResult.dispatches, expectedDispatches, "人类作者：显式 @ 的 agent 是目标");
  assert.deepEqual(
    agentResult.dispatches,
    humanResult.dispatches,
    "A2A 正格：作者换成 agent 不改变任何格（归因仍是那个人类 ⇒ 同一主体、同一结论）",
  );
  assert.equal(asAgent.published.length, asHuman.published.length, "出口外发次数逐格相同");

  // 半 B（判据输入面，记录策略）：三格——主体恒取 initiatedBy，且不因作者是 agent 而改变。
  const calls: InvokeCall[] = [];
  const policy = recordingPolicy(calls);
  const cells = [
    { author: HUMAN, initiatedBy: HUMAN },
    { author: AGENT_AUTHOR, initiatedBy: HUMAN },
    { author: AGENT_AUTHOR, initiatedBy: AGENT_INITIATOR },
  ] as const;
  const dispatchesPerCell = cells.map((cell, index) => {
    const h = harness({ accessPolicy: policy, assigneeAgentId: KNOWN_AGENT_ID });
    return h.service.createComment(commentInput({ id: `c-cell-${index}`, ...cell })).dispatches;
  });
  assert.deepEqual(
    dispatchesPerCell[1],
    dispatchesPerCell[0],
    "A2A 正格与人类格逐格同结论（v1 结论不读主体 ⇒ 换作者不该有任何差异）",
  );
  assert.deepEqual(
    dispatchesPerCell[2],
    dispatchesPerCell[0],
    "归因换成 agent 也不改结论：主体是归因事实，不是分档开关",
  );
  assert.deepEqual(
    calls.map((call) => call.subject),
    [HUMAN, HUMAN, AGENT_INITIATOR],
    "主体三格恒取 initiatedBy：agent 作者顶不掉人类归因（负控：改成取 author 必红）",
  );
  assert.deepEqual(
    calls.map((call) => call.target),
    [
      { kind: "agent", id: KNOWN_AGENT_ID, inRoster: true },
      { kind: "agent", id: KNOWN_AGENT_ID, inRoster: true },
      { kind: "agent", id: KNOWN_AGENT_ID, inRoster: true },
    ],
    "目标上下文逐格相同：对照只在主体一格上变化（其余输入固定，差异可归因）",
  );
  assert.deepEqual(
    calls.map((call) => call.workItem),
    [
      { workItemId: "wi-1", archivedAt: null },
      { workItemId: "wi-1", archivedAt: null },
      { workItemId: "wi-1", archivedAt: null },
    ],
    "工作项上下文逐格相同（归档态是真值，不是默认「未归档」）",
  );
  assert.deepEqual(
    calls.map((call) => call.context),
    [{ dispatchEnabled: true }, { dispatchEnabled: true }, { dispatchEnabled: true }],
    "门禁快照逐格相同（一次评论读一次，逐目标复用同一份快照）",
  );
});

// ---------------------------------------------------------------------------
// 优先序：与既有实现逐格同序（归档 > 门禁 > 名册），缺省策略下逐格贴住
// ---------------------------------------------------------------------------

test("优先序逐格（缺省策略）：归档 > 门禁 > 名册 —— 同格竞争时取前者，全不命中才 pending", () => {
  /* 既有实现是 `restriction ?? 名册`，其中门禁只写 `restriction ??=` ⇒ 归档压过门禁、门禁压过名册。
     这里是服务面的逐格贴住（`commentService.ts` 内的优先级已不存在：结论只由 canInvokeTarget 给出）。 */
  const cells = [
    {
      name: "归档 ∧ 门禁关 ∧ 名册外 ⇒ 归档",
      options: { archivedAt: 123, dispatchEnabled: false, assigneeAgentId: OFF_ROSTER_AGENT_ID },
      expected: blockedReport(OFF_ROSTER_AGENT_ID, "work_item_archived"),
    },
    {
      name: "未归档 ∧ 门禁关 ∧ 名册外 ⇒ 门禁",
      options: { dispatchEnabled: false, assigneeAgentId: OFF_ROSTER_AGENT_ID },
      expected: blockedReport(OFF_ROSTER_AGENT_ID, "dispatch_disabled"),
    },
    {
      name: "未归档 ∧ 门禁开 ∧ 名册外 ⇒ 名册",
      options: { assigneeAgentId: OFF_ROSTER_AGENT_ID },
      expected: blockedReport(OFF_ROSTER_AGENT_ID, "agent_not_in_roster"),
    },
    {
      name: "未归档 ∧ 门禁开 ∧ 名册内 ⇒ pending",
      options: { assigneeAgentId: KNOWN_AGENT_ID },
      expected: {
        targetAgentId: KNOWN_AGENT_ID,
        source: "issue_assignee",
        outcome: "pending",
        detail: { triggerSource: "issue_assignee" },
      },
    },
  ] as const;

  for (const cell of cells) {
    const h = harness(cell.options);
    const result = h.service.createComment({
      id: "c-priority",
      workspaceKey: WORKSPACE.identity,
      workspacePath: WORKSPACE.path,
      workItemId: "wi-1",
      author: HUMAN,
      initiatedBy: HUMAN,
      body: "看一下",
    });
    assert.deepEqual(result.dispatches, [cell.expected], cell.name);
    assert.equal(
      h.published.length,
      cell.expected.outcome === "pending" ? 1 : 0,
      `${cell.name}：只有 pending 外发`,
    );
  }
});

// ---------------------------------------------------------------------------
// 原因词汇单源（I1/I2）：commentService 零字面量，服务实际吐出的词表 == 判据闭集
// ---------------------------------------------------------------------------

/** 去注释再扫（文件头/行内注释会引用这三个词作为「不得出现」的说明）。 */
const stripComments = (source: string) =>
  source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

const COMMENT_SERVICE_CODE = stripComments(
  readFileSync(
    resolve(dirname(fileURLToPath(import.meta.url)), "../src/workitem/commentService.ts"),
    "utf8",
  ),
);

test("I1｜原因词汇单源：commentService.ts 去注释后零三原因字面量，类型是闭集的别名而非内联联合", () => {
  for (const reason of COLLABORATION_ACCESS_DENY_REASONS) {
    assert.ok(
      !COMMENT_SERVICE_CODE.includes(`"${reason}"`),
      `commentService.ts 不得内联 ${reason}：原因词汇单源在判据模块，内联即第二套词汇（漂移不报错）`,
    );
  }
  assert.match(
    COMMENT_SERVICE_CODE,
    /export type CommentRestrictReason = CollaborationAccessDenyReason;/,
    "CommentRestrictReason 必须是判据闭集的**别名**（内联联合会重新长出一份可独立演化的词表）",
  );
  assert.ok(
    COMMENT_SERVICE_CODE.includes('from "./collaborationAccessPolicy.js"'),
    "原因类型必须从判据模块导入（单源的引用形态）",
  );
});

test("I2｜服务实际吐出的原因词表 == 判据闭集：三条原因逐条驱动，观测值与手写字面量逐字相同", () => {
  const reasonOf = (options: Parameters<typeof harness>[0]): string => {
    const h = harness(options);
    const result = h.service.createComment({
      id: "c-vocab",
      workspaceKey: WORKSPACE.identity,
      workspacePath: WORKSPACE.path,
      workItemId: "wi-1",
      author: HUMAN,
      initiatedBy: HUMAN,
      body: "看一下",
    });
    assert.equal(result.dispatches.length, 1, "每条驱动评论恰一个目标（否则词表观测不成立）");
    return String(result.dispatches[0]!.detail["reason"]);
  };
  // 观测值（服务行为）；顺序 = 驱动顺序（门禁 / 归档 / 名册）。
  const observed = [
    reasonOf({ dispatchEnabled: false, assigneeAgentId: OFF_ROSTER_AGENT_ID }),
    reasonOf({ archivedAt: 123, assigneeAgentId: OFF_ROSTER_AGENT_ID }),
    reasonOf({ assigneeAgentId: OFF_ROSTER_AGENT_ID }),
  ];
  assert.deepEqual(
    observed,
    ["dispatch_disabled", "work_item_archived", "agent_not_in_roster"],
    "服务实际吐出的三原因与既有 receipt 词汇逐字相同（手写字面量 = 独立真源）",
  );
  assert.deepEqual(
    [...new Set(observed)].sort(),
    [...COLLABORATION_ACCESS_DENY_REASONS].sort(),
    "观测词表与判据闭集是同一份值集：服务不会吐出闭集之外的第五个词（防两套词汇）",
  );
});

// ---------------------------------------------------------------------------
// 接线：判据单源（C4.2 的核心；摘除接线即红）
// ---------------------------------------------------------------------------

test("接线（判据单源）：receipt 的目标可调性结论来自注入策略，而非服务内的内联表达式", () => {
  // 格 1：策略**放行**一个名册外目标（既有内联判据会把它判 blocked(agent_not_in_roster)）⇒ 必须 pending。
  const allowHarness = harness({
    accessPolicy: fixedPolicy(() => ({ allowed: true })),
    assigneeAgentId: OFF_ROSTER_AGENT_ID,
  });
  const allowed = allowHarness.service.createComment({
    id: "c-allow",
    workspaceKey: WORKSPACE.identity,
    workspacePath: WORKSPACE.path,
    workItemId: "wi-1",
    author: HUMAN,
    initiatedBy: HUMAN,
    body: "看一下",
  });
  assert.deepEqual(
    allowed.dispatches,
    [
      {
        targetAgentId: OFF_ROSTER_AGENT_ID,
        source: "issue_assignee",
        outcome: "pending",
        detail: { triggerSource: "issue_assignee" },
      },
    ],
    "放行结论由策略给出：目标是否在名册不再由本文件内联判定",
  );
  assert.equal(allowHarness.published.length, 1, "放行 ⇒ pending 请求仍经出口外发恰一次");

  // 格 2：策略**拒绝**一个名册内、门禁开、工作项未归档的目标 ⇒ receipt 必须 blocked 并逐字带策略给的原因。
  const denyHarness = harness({
    accessPolicy: fixedPolicy(() => ({ allowed: false, reason: "dispatch_disabled" })),
    assigneeAgentId: KNOWN_AGENT_ID,
  });
  const denied = denyHarness.service.createComment({
    id: "c-deny",
    workspaceKey: WORKSPACE.identity,
    workspacePath: WORKSPACE.path,
    workItemId: "wi-1",
    author: HUMAN,
    initiatedBy: HUMAN,
    body: "看一下",
  });
  assert.deepEqual(
    denied.dispatches,
    [
      {
        targetAgentId: KNOWN_AGENT_ID,
        source: "issue_assignee",
        outcome: "blocked",
        detail: { triggerSource: "issue_assignee", reason: "dispatch_disabled" },
      },
    ],
    "拒绝结论同样由策略给出（原因逐字进 detail，不产生第二套词汇）",
  );
  assert.deepEqual(denyHarness.published, [], "被拒 ⇒ 出口零外发");
});
