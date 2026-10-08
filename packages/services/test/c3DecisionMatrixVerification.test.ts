import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { runTasksDatabaseMigrations } from "../src/session/tasksDatabase/migrations.js";
import { createCommentDispatchReceiptRepo } from "../src/workitem/commentDispatchReceiptRepo.js";
import { createSquadDeferredDispatchRepo } from "../src/workitem/squadDeferredDispatchRepo.js";
import { createSquadRunRepo } from "../src/workitem/squadRunRepo.js";
import { createWorkItemActivityRepo } from "../src/workitem/workItemActivityRepo.js";
import { createWorkItemCollaborationService } from "../src/workitem/workItemCollaborationService.js";
import { createWorkItemCommentReactionRepo } from "../src/workitem/workItemCommentReactionRepo.js";
import { createWorkItemCommentRepo } from "../src/workitem/workItemCommentRepo.js";
import {
  WORK_ITEM_DECISION_KINDS,
  createWorkItemDecisionRepo,
  type WorkItemDecisionKind,
} from "../src/workitem/workItemDecisionRepo.js";
import {
  computeDecisionActivityDedupKey,
  computeDecisionDedupKey,
  createWorkItemDecisionService,
} from "../src/workitem/workItemDecisionService.js";
import { createWorkItemRepo } from "../src/workitem/workItemRepo.js";
import { createWorkItemDeliverableRepo } from "../src/workitem/workItemDeliverableRepo.js";
import { createWorkItemPullRequestRepo } from "../src/workitem/workItemPullRequestRepo.js";
import { createNullPullRequestProvider } from "../src/workitem/pullRequestProvider.js";
import type { SquadRuntime } from "../src/workitem/squadContracts.js";

/* C3 线独立复验（test-verifier）：C3.1 决定写入服务面的**穷举矩阵 + 幂等 + 隔离 + 归档 + 零副作用**。
 *
 * 与 implementer 的 `workItemDecisionService.test.ts` **刻意不同源**：
 * · 夹具自己搭（workspace A/B + 4 个工作项 + 5 条种子父行，id/文案/时钟全不同）；
 * · 期望值是**另一种写法**：kind × 父有无 × 父合法性写成 50 格真值表逐格跑（不是挑代表用例）；
 * · 零副作用走**门面路径**（生产路径）而不是直连服务，且快照取**五张表**整表内容（不是行数）。
 * 目的：如果实现只对 implementer 那几格特判（而不是真按规则实现），这里会红。 */

const WS_A = { path: "/tmp/c3v-ws-a", identity: "c3v-ws-a" };
const WS_B = { path: "/tmp/c3v-ws-b", identity: "c3v-ws-b" };
const HUMAN = { kind: "human" as const, id: "local-user" };
const CLOCK = 1_760_000_000_000;

function workItem(id: string, workspace = WS_A, archived = false) {
  return {
    id,
    workspaceIdentity: workspace.identity,
    workspacePath: workspace.path,
    title: `标题 ${id}`,
    body: "",
    status: "todo" as const,
    assignee: { type: "agent" as const, id: "ag-1" },
    labels: [],
    properties: {},
    position: 0,
    ...(archived ? { archivedAt: CLOCK } : {}),
  };
}

function countRows(db: DatabaseSync, table: string): number {
  return (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
}

function setup() {
  const db = new DatabaseSync(":memory:");
  runTasksDatabaseMigrations(db);
  const workItems = createWorkItemRepo(db);
  const decisions = createWorkItemDecisionRepo(db);
  const activities = createWorkItemActivityRepo(db);
  for (const item of [
    workItem("wi-a1"),
    workItem("wi-a2"),
    workItem("wi-arch", WS_A, true),
    workItem("wi-b1", WS_B),
  ]) {
    workItems.insert(item);
  }
  let generated = 0;
  const service = createWorkItemDecisionService({
    decisions,
    activities,
    workItems,
    now: () => CLOCK,
    newId: () => `c3v-dec-${++generated}`,
  });
  return { db, workItems, decisions, activities, service };
}

function input(overrides: Record<string, unknown> = {}) {
  return {
    workspaceKey: WS_A.identity,
    workspacePath: WS_A.path,
    workItemId: "wi-a1",
    kind: "proposal" as WorkItemDecisionKind,
    subject: "默认事项",
    author: HUMAN,
    sourceRequestId: "default-req",
    ...overrides,
  };
}

function rawRow(db: DatabaseSync, id: string) {
  return JSON.stringify(db.prepare("SELECT * FROM work_item_decisions WHERE id = ?").get(id));
}

/* ---------- 1：kind 五键 × 父有无 × 父合法性（50 格真值表） ----------
 *
 * 真值表的规则来源（规格 §3.4 + 任务卡 §2.2，与实现无关）：
 * · proposal / accepted / rejected —— 父**可选**：给了父就必须能回答「父是谁」；
 * · superseded —— 父**必填**，且父必须存在、同 workspace、同工作项、非自身（链式合法）；
 * · reopened —— 父必填，且父 kind ∈ {accepted, rejected, superseded}（proposal/reopened 是死格）。
 * 格子构成：5（无父）+ 5×5（child × parent kind）+ 5（父不存在）+ 5（父跨 workspace）
 *          + 5（父跨工作项）+ 5（父 = 自身）= 50。 */

type Expect =
  | "ok"
  | "missing-required-parent"
  | "parent-not-found"
  | "cross-ws"
  | "cross-item"
  | "self"
  | "bad-parent-kind";

type Cell = {
  label: string;
  kind: WorkItemDecisionKind;
  /** `undefined` = 不带父；`"self"` = 预生成 id 与父相同；其余 = 父决定 id。 */
  parent: string | undefined | "self";
  expect: Expect;
};

const ERROR_PATTERN: Record<Exclude<Expect, "ok">, RegExp> = {
  "missing-required-parent": /必须带 parentDecisionId/,
  "parent-not-found": /不存在/,
  "cross-ws": /不一致/,
  "cross-item": /不一致/,
  self: /自身/,
  "bad-parent-kind": /不在 \{accepted, rejected, superseded\}/,
};

test("矩阵｜kind × 父有无 × 父合法性 50 格逐格：合法格恰 +1 决定 +1 锚定活动；非法格响亮拒且零写入", () => {
  const f = setup();
  let expectedDecisions = 0;
  let expectedActivities = 0;

  const seed = (kind: WorkItemDecisionKind, extra: Record<string, unknown> = {}) => {
    const row = f.service.createDecision(
      input({ kind, subject: `种子 ${kind}`, sourceRequestId: `seed-${kind}`, ...extra }),
    );
    expectedDecisions += 1;
    expectedActivities += 1;
    return row;
  };

  // 五种 kind 的父行各一条（reopened 的父用 rejected；superseded 的父用 accepted —— 都是合法格）。
  const parentsByKind: Record<WorkItemDecisionKind, string> = {
    proposal: seed("proposal").id,
    accepted: seed("accepted").id,
    rejected: seed("rejected").id,
    superseded: "",
    reopened: "",
  };
  parentsByKind.superseded = seed("superseded", {
    parentDecisionId: parentsByKind.accepted,
  }).id;
  parentsByKind.reopened = seed("reopened", { parentDecisionId: parentsByKind.rejected }).id;
  const otherItemParent = f.service.createDecision(
    input({ workItemId: "wi-a2", subject: "另一项的父", sourceRequestId: "seed-other-item" }),
  ).id;
  expectedDecisions += 1;
  expectedActivities += 1;
  const foreignParent = f.service.createDecision(
    input({
      workspaceKey: WS_B.identity,
      workspacePath: WS_B.path,
      workItemId: "wi-b1",
      subject: "别人家的父",
      sourceRequestId: "seed-foreign",
    }),
  ).id;
  expectedDecisions += 1;
  expectedActivities += 1;

  // 「只增不改」的基线：种子父行的整行原始列快照（后续 26 次合法写入不得动它们）。
  const parentSnapshots = new Map(
    [parentsByKind.proposal, parentsByKind.accepted, parentsByKind.rejected].map((id) => [
      id,
      rawRow(f.db, id),
    ]),
  );

  /** 父 kind 对该 child 是否合法（手写真值表）。 */
  const parentKindLegalFor = (child: WorkItemDecisionKind, parentKind: WorkItemDecisionKind) =>
    child === "reopened" ? parentKind !== "proposal" && parentKind !== "reopened" : true;

  const cells: Cell[] = [];
  for (const kind of WORK_ITEM_DECISION_KINDS) {
    cells.push({
      label: `${kind} / 无父`,
      kind,
      parent: undefined,
      expect: kind === "superseded" || kind === "reopened" ? "missing-required-parent" : "ok",
    });
    for (const parentKind of WORK_ITEM_DECISION_KINDS) {
      cells.push({
        label: `${kind} / 父=${parentKind}`,
        kind,
        parent: parentsByKind[parentKind],
        expect: parentKindLegalFor(kind, parentKind) ? "ok" : "bad-parent-kind",
      });
    }
    cells.push({
      label: `${kind} / 父不存在`,
      kind,
      parent: "c3v-dec-ghost",
      expect: "parent-not-found",
    });
    cells.push({
      label: `${kind} / 父跨 workspace`,
      kind,
      parent: foreignParent,
      expect: "cross-ws",
    });
    cells.push({
      label: `${kind} / 父跨工作项`,
      kind,
      parent: otherItemParent,
      expect: "cross-item",
    });
    cells.push({ label: `${kind} / 父 = 自身`, kind, parent: "self", expect: "self" });
  }
  assert.equal(cells.length, 50, "矩阵必须是 5 + 25 + 5 + 5 + 5 + 5 = 50 格");

  let okCells = 0;
  let rejectedCells = 0;
  for (const [cellIndex, cell] of cells.entries()) {
    const decisionsBefore = countRows(f.db, "work_item_decisions");
    const activitiesBefore = countRows(f.db, "work_item_activities");
    assert.equal(
      decisionsBefore,
      expectedDecisions,
      `第 ${cellIndex} 格（${cell.label}）实测决定行数与累计期望一致`,
    );
    assert.equal(
      activitiesBefore,
      expectedActivities,
      `第 ${cellIndex} 格（${cell.label}）实测活动行数与累计期望一致`,
    );
    const subject = `矩阵 ${cellIndex} ${cell.label}`;
    const args = input({
      kind: cell.kind,
      subject,
      sourceRequestId: `matrix-${cellIndex}`,
      ...(cell.parent === undefined
        ? {}
        : cell.parent === "self"
          ? { id: otherItemParent, parentDecisionId: otherItemParent }
          : { parentDecisionId: cell.parent }),
    });

    if (cell.expect === "ok") {
      const written = f.service.createDecision(args);
      expectedDecisions += 1;
      expectedActivities += 1;
      okCells += 1;
      assert.equal(written.kind, cell.kind, `${cell.label}：kind 原样落库`);
      assert.equal(written.subject, subject, `${cell.label}：subject 原样落库`);
      assert.equal(
        written.parentDecisionId,
        cell.parent === undefined ? null : cell.parent,
        `${cell.label}：父引用按规则落库（取代/重审要能回答「后来由什么取代」）`,
      );
      const anchored = f.activities
        .listByWorkItem(WS_A.identity, "wi-a1")
        .filter((row) => row.decisionId === written.id);
      assert.equal(anchored.length, 1, `${cell.label}：恰一枚锚定活动`);
      assert.equal(anchored[0]!.kind, "decision_created");
      assert.equal(
        anchored[0]!.dedupKey,
        `decision:${written.id}:created`,
        `${cell.label}：活动键 = 事实身份（同一决策只写一枚）`,
      );
      assert.equal(
        countRows(f.db, "work_item_decisions"),
        decisionsBefore + 1,
        `${cell.label}：合法格恰 +1 决定行`,
      );
      assert.equal(
        countRows(f.db, "work_item_activities"),
        activitiesBefore + 1,
        `${cell.label}：合法格恰 +1 活动行（不多不少）`,
      );
    } else {
      assert.throws(
        () => f.service.createDecision(args),
        ERROR_PATTERN[cell.expect],
        `${cell.label}：必须响亮拒（期望 ${cell.expect}）`,
      );
      rejectedCells += 1;
      assert.equal(
        countRows(f.db, "work_item_decisions"),
        decisionsBefore,
        `${cell.label}：非法格零新增决定（不留孤儿/半成品）`,
      );
      assert.equal(
        countRows(f.db, "work_item_activities"),
        activitiesBefore,
        `${cell.label}：非法格零新增活动`,
      );
      assert.equal(
        f.decisions.get("c3v-dec-ghost"),
        null,
        `${cell.label}：不存在的 id 没有凭空落库`,
      );
      assert.equal(
        f.decisions.listByWorkItem(WS_A.identity, "wi-a1").some((row) => row.subject === subject),
        false,
        `${cell.label}：被拒的 subject 一行都不存在`,
      );
    }
  }
  // 合法 = 3（无父的三键）+ 25 - 2（reopened 的两格死父）；非法 = 2 + 2 + 5×4。
  assert.equal(okCells, 26, "合法格 26");
  assert.equal(rejectedCells, 24, "非法格 24");
  assert.equal(okCells + rejectedCells, 50, "50 格全部跑到");

  for (const [id, snapshot] of parentSnapshots) {
    assert.equal(rawRow(f.db, id), snapshot, `种子父行 ${id} 整行未被改写（只增不改，§5.1）`);
  }
});

/* ---------- 2：幂等（冻结键形状） ---------- */

test("幂等｜同键重投返回原行且逐列不变；换 subject / 换 requestId / 换 initiatedBy 各自新行；键形状字面量", () => {
  const f = setup();
  const base = input({
    kind: "accepted",
    subject: "A:B: 含冒号与空格的事项", // 键里可含任意文本 ⇒ 该字符串永不解析（P1 游标教训）
    rationale: "首投理由",
    sourceRequestId: "req-1",
  });

  const first = f.service.createDecision(base);
  const firstRowSnapshot = rawRow(f.db, first.id);
  // 冻结形状（手写字面量；独立真源 = 规格 §8.1 的四个分量 + 卡 §2.3 的六段式）。
  assert.equal(
    first.dedupKey,
    "decision:wi-a1:A:B: 含冒号与空格的事项:human:local-user:req-1",
    "决定行键 = decision:<workItemId>:<subject>:<initiatedBy.kind>:<initiatedBy.id>:<sourceRequestId>",
  );
  assert.equal(
    computeDecisionDedupKey({
      workItemId: "wi-a1",
      subject: "A:B: 含冒号与空格的事项",
      initiatedBy: HUMAN,
      sourceRequestId: "req-1",
    }),
    first.dedupKey,
    "落库键必须等于导出纯函数的返回值（形状单源）",
  );
  assert.equal(computeDecisionActivityDedupKey(first.id), `decision:${first.id}:created`);
  const firstActivity = f.activities.listByWorkItem(WS_A.identity, "wi-a1")[0]!;
  assert.equal(firstActivity.dedupKey, computeDecisionActivityDedupKey(first.id));

  // 同键重投（同 subject + 同 sourceRequestId + 同 initiatedBy）：既存行原样返回。
  const retry = f.service.createDecision({ ...base, rationale: "重投时换了理由" });
  assert.equal(retry.id, first.id, "同键重投返回既存行（含原 id）");
  assert.equal(retry.rationale, "首投理由", "既存事实一字不动（重投不刷新内容）");
  assert.equal(retry.subject, base.subject, "含冒号的 subject 原样读回（键永不解析 ⇒ 无自读不回）");
  assert.equal(rawRow(f.db, first.id), firstRowSnapshot, "重投后整行逐列不变");
  assert.equal(countRows(f.db, "work_item_decisions"), 1, "重投不翻倍");
  assert.equal(countRows(f.db, "work_item_activities"), 1, "重投不翻倍活动");

  const otherSubject = f.service.createDecision({ ...base, subject: "另一个事项" });
  assert.notEqual(otherSubject.id, first.id, "换 subject = 不同裁决 ⇒ 新行");
  const otherRequest = f.service.createDecision({ ...base, sourceRequestId: "req-2" });
  assert.notEqual(otherRequest.id, first.id, "换 requestId = 另一次明确请求 ⇒ 新行");
  const otherInitiator = f.service.createDecision({
    ...base,
    initiatedBy: { kind: "human", id: "another-user" },
  });
  assert.notEqual(otherInitiator.id, first.id, "initiatedBy 是幂等键分量：换归因人 = 另一次请求");

  // 边界登记（规格 §8.1 的键只含 initiatedBy，不含 author）：同 initiatedBy + 同 subject + 同 requestId
  // 而 author 不同 ⇒ 命中同一键（首写胜），返回值就是既存行。v1 门面 author === initiatedBy，
  // 故这条路径今天不可达；写下来是为了让「键的分量」在将来扩 agent 工具面时不会静默变化。
  const sameInitiatorOtherAuthor = f.service.createDecision({
    ...base,
    author: { kind: "agent", id: "ag-9" },
    initiatedBy: HUMAN,
  });
  assert.equal(
    sameInitiatorOtherAuthor.id,
    first.id,
    "键由 initiatedBy 决定（§8.1）：author 不进键 ⇒ 同键重投返回既存行",
  );
  assert.deepEqual(
    sameInitiatorOtherAuthor.author,
    HUMAN,
    "既存行一字不动（不因后来的 author 改写历史）",
  );

  assert.deepEqual(
    f.activities
      .listByWorkItem(WS_A.identity, "wi-a1")
      .map((row) => [row.sequence, row.decisionId]),
    [
      [1, first.id],
      [2, otherSubject.id],
      [3, otherRequest.id],
      [4, otherInitiator.id],
    ],
    "每次新决定恰一枚活动（+ 上面那次重投不再写活动），sequence 1..4 顺延",
  );
  assert.equal(countRows(f.db, "work_item_decisions"), 4);
  assert.equal(countRows(f.db, "work_item_activities"), 4);
});

/* ---------- 3：workspace 隔离 ---------- */

test("workspace 隔离｜异己 key 传本 ws 的 workItemId 双向响亮拒且零写入；两 ws 各自只见自己的决定与活动", () => {
  const f = setup();
  const before = {
    decisions: countRows(f.db, "work_item_decisions"),
    activities: countRows(f.db, "work_item_activities"),
  };

  // 跨 workspace：拿 B 的 key 指 A 的工作项（与门面「写错库」同一个错法）。
  assert.throws(
    () =>
      f.service.createDecision(
        input({
          workspaceKey: WS_B.identity,
          workspacePath: WS_B.path,
          workItemId: "wi-a1",
          subject: "越界",
          sourceRequestId: "req-x",
        }),
      ),
    /不一致/,
  );
  // 反向：拿 A 的 key 指 B 的工作项。
  assert.throws(
    () =>
      f.service.createDecision(
        input({ workspaceKey: WS_A.identity, workspacePath: WS_A.path, workItemId: "wi-b1" }),
      ),
    /不一致/,
  );
  assert.equal(countRows(f.db, "work_item_decisions"), before.decisions, "跨 ws 零写入");
  assert.equal(countRows(f.db, "work_item_activities"), before.activities, "跨 ws 零活动");

  const inA = f.service.createDecision(input({ subject: "A 的事项", sourceRequestId: "req-a" }));
  const inB = f.service.createDecision(
    input({
      workspaceKey: WS_B.identity,
      workspacePath: WS_B.path,
      workItemId: "wi-b1",
      subject: "B 的事项",
      sourceRequestId: "req-b",
    }),
  );
  // 同请求重投在 B 仍然幂等（键的作用域按 workspace 隔离，各自成立）。
  const inBAgain = f.service.createDecision(
    input({
      workspaceKey: WS_B.identity,
      workspacePath: WS_B.path,
      workItemId: "wi-b1",
      subject: "B 的事项",
      sourceRequestId: "req-b",
    }),
  );
  assert.equal(inBAgain.id, inB.id, "同一 workspace 内同键重投返回既存行");

  assert.deepEqual(
    f.decisions.listByWorkItem(WS_A.identity, "wi-a1").map((row) => [row.id, row.subject]),
    [[inA.id, "A 的事项"]],
    "A 读口看不到 B 的决定",
  );
  assert.deepEqual(
    f.decisions.listByWorkItem(WS_B.identity, "wi-b1").map((row) => [row.id, row.subject]),
    [[inB.id, "B 的事项"]],
    "B 读口看不到 A 的决定，且重投不产生第二行",
  );
  assert.deepEqual(
    f.activities.listByWorkItem(WS_B.identity, "wi-b1").map((row) => row.decisionId),
    [inB.id],
    "活动面同样按 workspace 隔离（A 的时间线里没有 B 的条目）",
  );
  assert.deepEqual(
    f.activities.listByWorkItem(WS_A.identity, "wi-a1").map((row) => row.decisionId),
    [inA.id],
  );
});

/* ---------- 4：归档项允许（Q4 裁定：服务面允许 + UI 禁用） ---------- */

test("归档项｜服务面允许写决定且活动照写；归档不豁免闭集与父规则（坏请求仍零写入）", () => {
  const f = setup();
  const decision = f.service.createDecision(
    input({ workItemId: "wi-arch", subject: "归档项的裁决", sourceRequestId: "req-arch" }),
  );
  assert.equal(decision.workItemId, "wi-arch");
  assert.deepEqual(
    f.activities.listByWorkItem(WS_A.identity, "wi-arch").map((row) => [row.kind, row.decisionId]),
    [["decision_created", decision.id]],
    "归档项的决定同样落锚定活动（否则归档时间线看不到这条裁决）",
  );
  // 归档行对 get 不可见 ⇒ 「允许写」必须显式经 getIncludingArchived（否则归档项会被当成不存在）。
  assert.equal(f.workItems.get("wi-arch"), null);
  assert.notEqual(f.workItems.getIncludingArchived("wi-arch"), null);

  const archBefore = countRows(f.db, "work_item_decisions");
  assert.throws(
    () =>
      f.service.createDecision(
        input({ workItemId: "wi-arch", kind: "superseded", sourceRequestId: "req-arch-2" }),
      ),
    /必须带 parentDecisionId/,
    "归档不是父规则的豁免口",
  );
  assert.throws(
    () =>
      f.service.createDecision(
        input({ workItemId: "wi-arch", subject: "   ", sourceRequestId: "req-arch-3" }),
      ),
    /subject/,
    "归档不是 subject 校验的豁免口",
  );
  assert.equal(
    countRows(f.db, "work_item_decisions"),
    archBefore,
    "归档项上的坏请求同样零写入（校验先于写入）",
  );
});

/* ---------- 5：零副作用（门面路径 + 五表整表快照） ---------- */

test("零副作用｜经门面写 5 种 kind：work_items / runs / receipts / 义务 / 评论五面一字不动，活动只有 decision_created", async () => {
  const f = setup();
  // 种子行：让「不变」不是空表对空表（每张表各一条与 wi-a1 相关的行）。
  createSquadRunRepo(f.db).insert({
    runId: "c3v-run-seed",
    workspaceKey: WS_A.identity,
    workspacePath: WS_A.path,
    workItemId: "wi-a1",
    parentWorkItemId: "wi-a1",
    agentId: "ag-1",
    isLeaderTask: false,
    branch: "b/c3v",
    dirName: "c3v",
    status: "discarded",
    sessionId: null,
    dispatchCause: null,
    causedByRunId: null,
    createdAt: CLOCK,
    updatedAt: CLOCK,
  });
  createCommentDispatchReceiptRepo(f.db).insertIfAbsent({
    dispatchKey: "c3v-key-seed",
    workspaceKey: WS_A.identity,
    workItemId: "wi-a1",
    targetAgentId: "ag-1",
    commentId: "c-seed",
    threadId: "c-seed",
    source: "issue_assignee",
    outcome: "pending",
    createdAt: CLOCK,
  });
  createSquadDeferredDispatchRepo(f.db).insertIfAbsent({
    runId: "c3v-key-seed",
    workspaceKey: WS_A.identity,
    workItemId: "wi-a1",
    agentId: "ag-2",
    dispatchCause: null,
    origin: "comment",
    createdAt: CLOCK,
    updatedAt: CLOCK,
  });
  const comments = createWorkItemCommentRepo(f.db);
  comments.add({
    id: "c-seed",
    workspaceKey: WS_A.identity,
    workspacePath: WS_A.path,
    workItemId: "wi-a1",
    author: HUMAN,
    initiatedBy: HUMAN,
    body: "种子评论",
    normalizedBody: "种子评论",
    mentions: [],
    command: "none",
    createdAt: CLOCK,
  });

  const snapshot = () => ({
    workItems: JSON.stringify(f.db.prepare("SELECT * FROM work_items ORDER BY id").all()),
    runs: JSON.stringify(f.db.prepare("SELECT * FROM squad_runs ORDER BY run_id").all()),
    receipts: JSON.stringify(
      f.db.prepare("SELECT * FROM comment_dispatch_receipts ORDER BY dispatch_key").all(),
    ),
    obligations: JSON.stringify(
      f.db.prepare("SELECT * FROM squad_run_deferred_dispatches ORDER BY run_id").all(),
    ),
    comments: JSON.stringify(f.db.prepare("SELECT * FROM work_item_comments ORDER BY id").all()),
  });
  const before = snapshot();
  assert.deepEqual(
    [countRows(f.db, "squad_runs"), countRows(f.db, "comment_dispatch_receipts")],
    [1, 1],
    "种子行就位（否则下面的不变式是空转）",
  );

  const facade = createWorkItemCollaborationService({
    createRuntime: async () =>
      ({
        workItemRepo: f.workItems,
        deliverableRepo: createWorkItemDeliverableRepo(f.db),
        /* #8 D2：读模型新增 PR 关联清单 + 读数面可用性 —— 夹具按 runtime 契约补齐。 */
        pullRequestRepo: createWorkItemPullRequestRepo(f.db),
        pullRequestProvider: createNullPullRequestProvider(),
        /* #8 D3：读面带出整批收尾模式（详情页 PR 区的 pr-gate 提示读它）。 */
        readSquadMergeMode: () => "local",
        boundWorkspace: WS_A,
      }) as unknown as SquadRuntime,
    getRepos: () => ({
      comments,
      activities: f.activities,
      decisions: f.decisions,
      reactions: createWorkItemCommentReactionRepo(f.db),
      receipts: createCommentDispatchReceiptRepo(f.db),
    }),
    localHumanActor: () => HUMAN,
    createDecisionService: () => f.service,
  });

  const accepted = await facade.createWorkItemDecision(WS_A, {
    workItemId: "wi-a1",
    kind: "accepted",
    subject: "接受方案",
    sourceRequestId: "facade-1",
  });
  const written = [
    accepted,
    await facade.createWorkItemDecision(WS_A, {
      workItemId: "wi-a1",
      kind: "proposal",
      subject: "提出方案",
      sourceRequestId: "facade-2",
    }),
    await facade.createWorkItemDecision(WS_A, {
      workItemId: "wi-a1",
      kind: "rejected",
      subject: "拒绝方案",
      sourceRequestId: "facade-3",
    }),
    await facade.createWorkItemDecision(WS_A, {
      workItemId: "wi-a1",
      kind: "superseded",
      subject: "取代方案",
      parentDecisionId: accepted.id,
      sourceRequestId: "facade-4",
    }),
    await facade.createWorkItemDecision(WS_A, {
      workItemId: "wi-a1",
      kind: "reopened",
      subject: "重审方案",
      parentDecisionId: accepted.id,
      sourceRequestId: "facade-5",
    }),
  ];
  assert.deepEqual(
    written.map((row) => row.kind),
    ["accepted", "proposal", "rejected", "superseded", "reopened"],
    "门面五写各落一条（返回形状原样透传）",
  );

  assert.deepEqual(
    snapshot(),
    before,
    "决定绝不写：工作项 / run 台账 / 派发回执 / 义务 / 评论五面一字不动",
  );
  const activities = f.activities.listByWorkItem(WS_A.identity, "wi-a1");
  assert.deepEqual(
    activities.map((row) => [row.sequence, row.kind, row.decisionId]),
    [
      [1, "decision_created", written[0]!.id],
      [2, "decision_created", written[1]!.id],
      [3, "decision_created", written[2]!.id],
      [4, "decision_created", written[3]!.id],
      [5, "decision_created", written[4]!.id],
    ],
    "活动面只有 decision_created 且逐条锚回决定行（无 comment_* / status_changed / 派发事实）",
  );
  assert.equal(
    activities.filter((row) => row.dispatchEventId !== null).length,
    0,
    "决定不派发：没有任何 dispatchEventId",
  );
  assert.equal(countRows(f.db, "work_item_decisions"), 5, "五种 kind 各一行");
});

test("零副作用｜读面闭合：门面读回 decisions 与锚 Activity 指向同一行（时间线合同的服务面半边）", async () => {
  const f = setup();
  const facade = createWorkItemCollaborationService({
    createRuntime: async () =>
      ({
        workItemRepo: f.workItems,
        deliverableRepo: createWorkItemDeliverableRepo(f.db),
        /* #8 D2：读模型新增 PR 关联清单 + 读数面可用性 —— 夹具按 runtime 契约补齐。 */
        pullRequestRepo: createWorkItemPullRequestRepo(f.db),
        pullRequestProvider: createNullPullRequestProvider(),
        /* #8 D3：读面带出整批收尾模式（详情页 PR 区的 pr-gate 提示读它）。 */
        readSquadMergeMode: () => "local",
        boundWorkspace: WS_A,
      }) as unknown as SquadRuntime,
    getRepos: () => ({
      comments: createWorkItemCommentRepo(f.db),
      activities: f.activities,
      decisions: f.decisions,
      reactions: createWorkItemCommentReactionRepo(f.db),
      receipts: createCommentDispatchReceiptRepo(f.db),
    }),
    localHumanActor: () => HUMAN,
    createDecisionService: () => f.service,
  });
  const written = await facade.createWorkItemDecision(WS_A, {
    workItemId: "wi-a1",
    kind: "rejected",
    subject: "读面闭合事项",
    sourceRequestId: "closure-1",
  });
  const read = await facade.getWorkItemCollaboration(WS_A, "wi-a1");
  assert.ok(read !== null);
  assert.deepEqual(
    read.decisions.map((row) => row.id),
    [written.id],
  );
  assert.deepEqual(
    read.activities.map((row) => [row.kind, row.decisionId]),
    [["decision_created", written.id]],
  );
  assert.equal(
    read.activities[0]!.decisionId,
    read.decisions[0]!.id,
    "锚双向指得通 ⇒ UI 的 link-error 分支在这条路径上不可达",
  );
  assert.equal(read.receipts.length, 0, "决定不产生派发回执");
  assert.equal(read.comments.length, 0, "决定不是评论");
});
