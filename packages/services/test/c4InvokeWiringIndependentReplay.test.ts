import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { runTasksDatabaseMigrations } from "../src/session/tasksDatabase/migrations.js";
import {
  COLLABORATION_ACCESS_DENY_REASONS,
  canInvokeTarget as realCanInvokeTarget,
  type AccessSubject,
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

/* 协作域 C4.2 独立复验（test-verifier）：canInvoke 接线（原因单源 + A2A 归因 + 行为中立重放）。
 *
 * 独立性声明（本文件的期望值不来自实现者的 C4 diff，也不来自新测试文件）：
 * · 三条 blocked 格的期望 = **C4 之前**就存在的手写字面量（commentService.test.ts 的
 *   「受限可审计（§12.1-12）」用例：门禁格 :855-861 / 归档格 :899-905 / 名册格 :920-926），
 *   本文件把它们逐字重放并**另从 receipt 表读回**核对（返回值与持久事实两条独立观测）；
 * · 目标矩阵与优先序：手写四格 + 交叉格；
 * · A2A：用记录策略直接观测主体入参（agent 作者 + 人类归因 vs 人类作者），并断言目标上下文
 *   只带 kind/id/inRoster（不带 archived/enabled —— §2.1c 不扩格的调用面形态）；
 * · I1/I2：本文件自己实现去注释扫描并独立复算（不 import 实现者测试助手）。
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const WORKITEM_SRC = resolve(HERE, "../src/workitem");
const COMMENT_SERVICE_SRC = readFileSync(resolve(WORKITEM_SRC, "commentService.ts"), "utf8");
const DECISION_SERVICE_SRC = readFileSync(
  resolve(WORKITEM_SRC, "workItemDecisionService.ts"),
  "utf8",
);
const POLICY_SRC = readFileSync(resolve(WORKITEM_SRC, "collaborationAccessPolicy.ts"), "utf8");
/** 本文件自己的去注释实现。 */
const stripComments = (source: string) =>
  source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");

const WS = { path: "/tmp/iv-c42-ws", identity: "iv-c42-ws" };
const WORK_ITEM_ID = "iv-wi-42";
const KNOWN_AGENT_ID = "iv-ann";
const OFF_ROSTER_AGENT_ID = "iv-gone";
const CLOCK = 1_810_000_000_000;
const HUMAN: AuthorRef = { kind: "human", id: "iv-human-42" };
const AGENT_AUTHOR: AuthorRef = { kind: "agent", id: "iv-agent-42" };
const AGENT_INITIATOR: AuthorRef = { kind: "agent", id: "iv-initiator-42" };

type Harness = ReturnType<typeof makeHarness>;

function makeHarness(
  options: {
    policy?: CollaborationAccessPolicy;
    dispatchEnabled?: boolean;
    assigneeAgentId?: string;
    archivedAt?: number;
  } = {},
) {
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
    id: WORK_ITEM_ID,
    workspaceIdentity: WS.identity,
    workspacePath: WS.path,
    title: "C4.2 独立复验工作项",
    body: "",
    status: "todo",
    assignee: { type: "agent", id: options.assigneeAgentId ?? KNOWN_AGENT_ID },
    labels: [],
    properties: {},
    position: 0,
    ...(options.archivedAt !== undefined ? { archivedAt: options.archivedAt } : {}),
  });
  const published: unknown[] = [];
  let seq = 0;
  const service = createCommentService({
    comments,
    activities,
    receipts,
    reactions,
    runs,
    deferred,
    workItems,
    roster: { listAgents: () => [{ id: KNOWN_AGENT_ID, name: "ivann" }], listSquads: () => [] },
    readDispatchEnabled: () => options.dispatchEnabled ?? true,
    publishDispatchRequest: (request) => published.push(request),
    now: () => CLOCK,
    newId: () => `iv-gen-${(seq += 1)}`,
    ...(options.policy !== undefined ? { accessPolicy: options.policy } : {}),
  });
  return { db, comments, receipts, published, service };
}

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
    /** 记录入参后**委派**给判据模块本体：观测真值的同时保持缺省行为的真实结论。 */
    canInvokeTarget: (subject, workItem, target, context) => {
      calls.push({ subject, workItem, target, context });
      return realCanInvokeTarget(subject, workItem, target, context);
    },
  };
}

function createComment(
  h: Harness,
  over: { id: string; author: AuthorRef; initiatedBy: AuthorRef; body: string },
) {
  return h.service.createComment({
    id: over.id,
    workspaceKey: WS.identity,
    workspacePath: WS.path,
    workItemId: WORK_ITEM_ID,
    author: over.author,
    initiatedBy: over.initiatedBy,
    body: over.body,
  });
}

test("IV-REPLAY｜三条既有 blocked 格逐字重放（独立真源 = C4 前的手写字面量），返回值与 receipt 表双观测", () => {
  const cells = [
    {
      name: "门禁关闭 ⇒ blocked(dispatch_disabled)（commentService.test.ts:855-861 的字面量）",
      options: { dispatchEnabled: false, assigneeAgentId: KNOWN_AGENT_ID },
      commentId: "iv-c-gate",
      body: "@ivann 帮忙",
      expected: {
        targetAgentId: KNOWN_AGENT_ID,
        source: "mention_agent",
        outcome: "blocked",
        detail: { triggerSource: "mention_agent", reason: "dispatch_disabled" },
      },
    },
    {
      name: "工作项归档 ⇒ blocked(work_item_archived)（commentService.test.ts:899-905 的字面量）",
      options: { archivedAt: 123, assigneeAgentId: KNOWN_AGENT_ID },
      commentId: "iv-c-arch",
      body: "看一下",
      expected: {
        targetAgentId: KNOWN_AGENT_ID,
        source: "issue_assignee",
        outcome: "blocked",
        detail: { triggerSource: "issue_assignee", reason: "work_item_archived" },
      },
    },
    {
      name: "名册缺席 ⇒ blocked(agent_not_in_roster)（commentService.test.ts:920-926 的字面量）",
      options: { assigneeAgentId: OFF_ROSTER_AGENT_ID },
      commentId: "iv-c-gone",
      body: "看一下",
      expected: {
        targetAgentId: OFF_ROSTER_AGENT_ID,
        source: "issue_assignee",
        outcome: "blocked",
        detail: { triggerSource: "issue_assignee", reason: "agent_not_in_roster" },
      },
    },
  ] as const;

  for (const cell of cells) {
    const h = makeHarness(cell.options);
    const result = createComment(h, {
      id: cell.commentId,
      author: HUMAN,
      initiatedBy: HUMAN,
      body: cell.body,
    });
    assert.deepEqual(result.dispatches, [cell.expected], `${cell.name}（返回值观测）`);
    // 持久事实观测：receipt 行逐列核对（返回对象与表各看一次，防「返回值自说自话」）。
    const rows = h.receipts.listByWorkItem(WS.identity, WORK_ITEM_ID);
    assert.equal(rows.length, 1, `${cell.name}：恰一行 receipt`);
    const row = rows[0]!;
    assert.equal(row.targetAgentId, cell.expected.targetAgentId);
    assert.equal(row.source, cell.expected.source);
    assert.equal(row.outcome, "blocked");
    assert.deepEqual(row.detail, cell.expected.detail, `${cell.name}：detail 逐字（无多余键）`);
    assert.ok(h.comments.get(cell.commentId), `${cell.name}：评论照写（可审计）`);
    // 可审计不可派发：blocked 不开 run、不登记义务、不外发。
    assert.equal(
      (h.db.prepare("SELECT COUNT(*) AS n FROM squad_runs").get() as { n: number }).n,
      0,
      `${cell.name}：零 run`,
    );
    assert.equal(
      (
        h.db.prepare("SELECT COUNT(*) AS n FROM squad_run_deferred_dispatches").get() as {
          n: number;
        }
      ).n,
      0,
      `${cell.name}：零义务`,
    );
    assert.deepEqual(h.published, [], `${cell.name}：出口零外发`);
  }
});

test("IV-PRIORITY｜服务面优先序四格（独立值）：归档 > 门禁 > 名册；只由判据单源给出", () => {
  const cells = [
    {
      name: "归档 ∧ 门禁关 ∧ 名册外 ⇒ 归档",
      options: { archivedAt: 9, dispatchEnabled: false, assigneeAgentId: OFF_ROSTER_AGENT_ID },
      detail: { triggerSource: "issue_assignee", reason: "work_item_archived" },
      publishes: 0,
    },
    {
      name: "未归档 ∧ 门禁关 ∧ 名册外 ⇒ 门禁",
      options: { dispatchEnabled: false, assigneeAgentId: OFF_ROSTER_AGENT_ID },
      detail: { triggerSource: "issue_assignee", reason: "dispatch_disabled" },
      publishes: 0,
    },
    {
      name: "未归档 ∧ 门禁开 ∧ 名册外 ⇒ 名册",
      options: { assigneeAgentId: OFF_ROSTER_AGENT_ID },
      detail: { triggerSource: "issue_assignee", reason: "agent_not_in_roster" },
      publishes: 0,
    },
    {
      name: "未归档 ∧ 门禁开 ∧ 名册内 ⇒ pending",
      options: { assigneeAgentId: KNOWN_AGENT_ID },
      detail: { triggerSource: "issue_assignee" },
      publishes: 1,
    },
  ] as const;

  for (const [index, cell] of cells.entries()) {
    const h = makeHarness(cell.options);
    const result = createComment(h, {
      id: `iv-c-priority-${index}`,
      author: HUMAN,
      initiatedBy: HUMAN,
      body: "看一下",
    });
    assert.equal(result.dispatches.length, 1, cell.name);
    assert.deepEqual(result.dispatches[0]!.detail, cell.detail, cell.name);
    assert.equal(h.published.length, cell.publishes, `${cell.name}：外发次数`);
  }
});

test("IV-A2A｜记录策略独立跑 A2A：主体恒 initiatedBy、目标上下文恰三键、同格同结论", () => {
  const calls: InvokeCall[] = [];
  const policy = recordingPolicy(calls);
  const h = makeHarness({ policy, assigneeAgentId: KNOWN_AGENT_ID });

  const asHuman = createComment(h, {
    id: "iv-c-human",
    author: HUMAN,
    initiatedBy: HUMAN,
    body: "@ivann 看一下",
  });
  const asAgent = createComment(h, {
    id: "iv-c-agent",
    author: AGENT_AUTHOR,
    initiatedBy: HUMAN,
    body: "@ivann 看一下",
  });
  const agentInitiated = createComment(h, {
    id: "iv-c-agent-initiated",
    author: AGENT_AUTHOR,
    initiatedBy: AGENT_INITIATOR,
    body: "@ivann 看一下",
  });

  // 结论逐格相同（v1 判据不读主体 ⇒ 换作者/换归因都不改 blocked/pending 结论）。
  assert.deepEqual(
    asAgent.dispatches,
    asHuman.dispatches,
    "agent 作者 + 人类归因 ⇒ 与人类作者同格",
  );
  assert.deepEqual(agentInitiated.dispatches, asHuman.dispatches, "换归因主体同样不改结论");

  // 主体观测：三格的主体分别是 人类 / 人类（不被 agent 作者顶掉）/ agent 归因者。
  assert.deepEqual(
    calls.map((call) => call.subject),
    [HUMAN, HUMAN, AGENT_INITIATOR],
  );
  // 目标上下文：恰 kind/id/inRoster 三键（调用面不带 archived/enabled ⇒ §2.1c 不扩格）。
  for (const call of calls) {
    assert.deepEqual(
      Object.keys(call.target).sort(),
      ["id", "inRoster", "kind"],
      "判据目标上下文不得悄悄带上 archived/enabled（那会暗示请求面扩格）",
    );
    assert.equal(call.target.inRoster, true);
    assert.deepEqual(call.workItem, { workItemId: WORK_ITEM_ID, archivedAt: null });
    assert.deepEqual(call.context, { dispatchEnabled: true });
  }
  // 防双判：每条评论恰一个目标 ⇒ 恰一次 canInvoke。
  assert.equal(calls.length, 3);
  assert.equal(h.published.length, 3, "三条 pending 各外发一次（与人类格外发次数一致）");
});

test("IV-A2A-archived｜归档格的判据输入是真实归档值（不是默认「未归档」）", () => {
  const calls: InvokeCall[] = [];
  const h = makeHarness({
    policy: recordingPolicy(calls),
    archivedAt: 4_242,
    assigneeAgentId: KNOWN_AGENT_ID,
  });
  const result = createComment(h, {
    id: "iv-c-arch-a2a",
    author: AGENT_AUTHOR,
    initiatedBy: HUMAN,
    body: "@ivann 看一下",
  });
  assert.equal(result.dispatches[0]!.outcome, "blocked");
  assert.deepEqual(
    calls.map((call) => call.workItem),
    [{ workItemId: WORK_ITEM_ID, archivedAt: 4_242 }],
  );
  assert.deepEqual(
    calls.map((call) => call.subject),
    [HUMAN],
    "归档格主体也恒取 initiatedBy",
  );
});

test("IV-I1｜原因词汇单源独立复算：commentService / decision 服务去注释后零三原因字面量", () => {
  for (const [name, code] of [
    ["commentService.ts", stripComments(COMMENT_SERVICE_SRC)],
    ["workItemDecisionService.ts", stripComments(DECISION_SERVICE_SRC)],
  ] as const) {
    for (const reason of COLLABORATION_ACCESS_DENY_REASONS) {
      assert.ok(
        !code.includes(`"${reason}"`),
        `${name} 不得内联 ${reason}（独立去注释扫描）——内联即第二套可独立演化的词表`,
      );
    }
  }
  assert.match(
    stripComments(COMMENT_SERVICE_SRC),
    /export type CommentRestrictReason = CollaborationAccessDenyReason;/,
    "原因类型必须是判据闭集的别名（值集同一份）",
  );
  // 单源正证：三个字面量只出现在判据模块（写者零处在上面已断言），且模块内每个原因至少定义一次。
  const policyCode = stripComments(POLICY_SRC);
  for (const reason of COLLABORATION_ACCESS_DENY_REASONS) {
    assert.ok(
      policyCode.includes(`"${reason}"`),
      `${reason} 必须在判据模块内有定义（单源的定义点）`,
    );
  }
});

test("IV-I2｜服务实际吐出的原因词表 == 判据闭集（独立驱动三格，观测 detail.reason）", () => {
  const observe = (options: Parameters<typeof makeHarness>[0]): string => {
    const h = makeHarness(options);
    const result = createComment(h, {
      id: "iv-c-vocab",
      author: HUMAN,
      initiatedBy: HUMAN,
      body: "看一下",
    });
    assert.equal(result.dispatches.length, 1);
    const observed = result.dispatches[0]!.detail["reason"];
    assert.equal(typeof observed, "string", "blocked 格的 detail 必带 reason 字符串");
    return observed as string;
  };
  const observed = [
    observe({ dispatchEnabled: false, assigneeAgentId: OFF_ROSTER_AGENT_ID }),
    observe({ archivedAt: 1, assigneeAgentId: OFF_ROSTER_AGENT_ID }),
    observe({ assigneeAgentId: OFF_ROSTER_AGENT_ID }),
  ];
  assert.deepEqual(observed, ["dispatch_disabled", "work_item_archived", "agent_not_in_roster"]);
  assert.deepEqual(
    [...new Set(observed)].sort(),
    [...COLLABORATION_ACCESS_DENY_REASONS].sort(),
    "观测值集与判据闭集同一份（无第五个词，也无缺词）",
  );
});
