/* D6 插队轮（§6 / §11-C2）：**评论派发也要产生 leader 类 run**。

   本轮修的是「评论通道拿到队长却按 standalone 起 run」这条残留。它有两个半边：
   ① **事实半边**（本文件上半）：级联把目标解析成队长时，**哪支小队**这条事实必须落进 receipt
      —— 否则 host 拿不到简报来源，只能把队长当普通 agent 派发（无简报、无队长台账行、
      不参与 §5.7(1) 合并）。两个来源都要带：显式 `@小队`（mention_squad_leader）与
      ④ 指派给小队（issue_assignee）。
   ② **派发半边**（本文件下半）：`planDispatch` 的 `leaderOverride` 分支产出与「指派给小队」
      完全同形的 leader 事件（isLeaderTask / runClass / squadId / briefing），且复用同一处
      归档·停用判据。

   期望值全部取契约面字面量（级联五源闭集、receipt 七值、Event 形状），不读实现中间量。 */
import assert from "node:assert/strict";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { LEADER_PROTOCOL_TEXT } from "../src/workitem/leaderDispatch.js";
import { runTasksDatabaseMigrations } from "../src/session/tasksDatabase/migrations.js";
import { computeCommentDispatchKey } from "../src/workitem/commentDispatchKey.js";
import {
  createCommentDispatchReceiptRepo,
  commentReceiptSquadId,
} from "../src/workitem/commentDispatchReceiptRepo.js";
import { createCommentService, type CommentService } from "../src/workitem/commentService.js";
import { planDispatch, type SquadBriefing } from "../src/workitem/leaderDispatch.js";
import type { Squad } from "@zcode/shared";
import type { SquadDispatchRequest } from "../src/workitem/squadDispatchRequests.js";
import { createSquadDeferredDispatchRepo } from "../src/workitem/squadDeferredDispatchRepo.js";
import { createSquadRunRepo } from "../src/workitem/squadRunRepo.js";
import { createWorkItemActivityRepo } from "../src/workitem/workItemActivityRepo.js";
import { createWorkItemCommentRepo, type AuthorRef } from "../src/workitem/workItemCommentRepo.js";
import { createWorkItemCommentReactionRepo } from "../src/workitem/workItemCommentReactionRepo.js";
import { createWorkItemRepo } from "../src/workitem/workItemRepo.js";

const WS = "d6-ws";
const WSP = "/tmp/d6-ws";
const AGENT = "d6-agent"; // 指派给单个智能体的项（显式 @小队 的落点）
const LEAD = "d6-leader"; // 小队队长
const SQUAD = "d6-squad";
const ITEM_AGENT = "d6-wi-agent"; // assignee = agent
const ITEM_SQUAD = "d6-wi-squad"; // assignee = squad（④ 兜底源）
const CLOCK = 917_000;
const HUMAN: AuthorRef = { kind: "human", id: "d6-human", displayName: "人" };

function harness() {
  const db = new DatabaseSync(":memory:");
  runTasksDatabaseMigrations(db);
  const workItems = createWorkItemRepo(db);
  const receipts = createCommentDispatchReceiptRepo(db);
  const published: SquadDispatchRequest[] = [];
  const service: CommentService = createCommentService({
    /* G8：事务口（本文件是既有用例，注入 identity 替身 —— 行为逐字不变；真事务的证据在 commentServiceTransaction.test.ts）。 */
    transact: (fn) => fn(),
    comments: createWorkItemCommentRepo(db),
    activities: createWorkItemActivityRepo(db),
    receipts,
    reactions: createWorkItemCommentReactionRepo(db),
    runs: createSquadRunRepo(db),
    deferred: createSquadDeferredDispatchRepo(db),
    workItems,
    roster: {
      listAgents: () => [
        { id: AGENT, name: "Ann" },
        { id: LEAD, name: "队长" },
      ],
      listSquads: () => [{ id: SQUAD, name: "网关组", leaderAgentId: LEAD }],
    },
    readDispatchEnabled: () => true,
    publishDispatchRequest: (request) => published.push(request),
    now: () => CLOCK,
    newId: () => "d6-gen",
  });
  for (const [id, assignee] of [
    [ITEM_AGENT, { type: "agent" as const, id: AGENT }],
    [ITEM_SQUAD, { type: "squad" as const, id: SQUAD }],
  ] as const) {
    workItems.insert({
      id,
      workspaceIdentity: WS,
      workspacePath: WSP,
      title: `D6 ${id}`,
      body: "",
      status: "todo",
      assignee,
      labels: [],
      properties: {},
      position: 0,
    });
  }
  const keyFor = (workItemId: string, targetAgentId: string, commentId: string): string =>
    computeCommentDispatchKey({ workspaceKey: WS, workItemId, targetAgentId, commentId });
  return { db, receipts, published, service, keyFor };
}

test("D6 级联两源：@小队 与 指派给小队 都把 squadId 落进 receipt（重放/补投据此才能起 leader run）", () => {
  const h = harness();

  // 源一：显式 @小队 ⇒ 目标 = 队长，来源 mention_squad_leader，squadId = 被点名的小队。
  const mentioned = h.service.createComment({
    id: "d6-c-mention",
    workspaceKey: WS,
    workspacePath: WSP,
    workItemId: ITEM_AGENT,
    author: HUMAN,
    initiatedBy: HUMAN,
    body: "@网关组 看一下",
  });
  assert.deepEqual(mentioned.dispatches, [
    {
      targetAgentId: LEAD,
      source: "mention_squad_leader",
      outcome: "pending",
      detail: { triggerSource: "mention_squad_leader", squadId: SQUAD },
    },
  ]);
  const mentionReceipt = h.receipts.get(h.keyFor(ITEM_AGENT, LEAD, "d6-c-mention"));
  assert.ok(mentionReceipt, "receipt 必须落库");
  assert.deepEqual(
    mentionReceipt.detail,
    { triggerSource: "mention_squad_leader", squadId: SQUAD },
    "落库的请求事实带 squadId：补投扫描读的是这一份（不读内存里的 dispatches）",
  );

  // 源二：assignee = squad ⇒ ④ 兜底解析出队长，来源仍是 issue_assignee，但要带上是哪支小队。
  const assigned = h.service.createComment({
    id: "d6-c-assignee",
    workspaceKey: WS,
    workspacePath: WSP,
    workItemId: ITEM_SQUAD,
    author: HUMAN,
    initiatedBy: HUMAN,
    body: "看一下",
  });
  assert.deepEqual(assigned.dispatches, [
    {
      targetAgentId: LEAD,
      source: "issue_assignee",
      outcome: "pending",
      detail: { triggerSource: "issue_assignee", squadId: SQUAD },
    },
  ]);
  assert.deepEqual(
    h.receipts.get(h.keyFor(ITEM_SQUAD, LEAD, "d6-c-assignee"))?.detail,
    { triggerSource: "issue_assignee", squadId: SQUAD },
    "④ 兜底源的 squadId 同样是请求事实（缺了它 host 只能按普通 agent 起 run）",
  );

  // 反例（同一条级联、同一批断言里）：@普通智能体 不带 squadId —— 不能给任何目标都附一个 squad。
  const plain = h.service.createComment({
    id: "d6-c-agent",
    workspaceKey: WS,
    workspacePath: WSP,
    workItemId: ITEM_AGENT,
    author: HUMAN,
    initiatedBy: HUMAN,
    body: "@Ann 看一下",
  });
  assert.deepEqual(plain.dispatches, [
    {
      targetAgentId: AGENT,
      source: "mention_agent",
      outcome: "pending",
      detail: { triggerSource: "mention_agent" },
    },
  ]);
});

/* ---------- 派发半边：planDispatch 的 leaderOverride ---------- */
const squadFixture = (over: Partial<Squad> = {}): Squad =>
  ({
    id: SQUAD,
    name: "网关组",
    leaderAgentId: LEAD,
    members: [{ agentId: LEAD, role: "leader" }, { agentId: AGENT }],
    instructions: { stopCondition: "全部 done 即收工", maxRounds: "5" },
    enabled: true,
    ...over,
  }) as Squad;

/** 被评论的工作项：指派给**单个智能体**（评论目标与 assignee 不是同一人，正是评论通道的常态格）。 */
const commentWorkItem = () =>
  ({
    id: "d6-wi-comment",
    workspaceIdentity: WS,
    workspacePath: WSP,
    title: "评论触发的队长 run",
    body: "",
    status: "todo",
    assignee: { type: "agent", id: AGENT },
    labels: [],
    properties: {},
    position: 0,
  }) as never;

test("D6 leaderOverride：产出与「指派给小队」同形的 leader 事件（标记/类别/squadId/三段简报），assignee 不动", () => {
  const workItem = commentWorkItem();
  const before = JSON.stringify(workItem);
  const events = planDispatch({
    workItem,
    squad: null,
    trigger: "user",
    leaderOverride: { squad: squadFixture() },
  });
  const run = events.find((event) => event.kind === "run.enqueued");
  assert.ok(run?.kind === "run.enqueued", "队长支必须产出 run（不是 skip）");
  assert.equal(run.agentId, LEAD, "目标 = 小队队长");
  assert.equal(run.isLeaderTask, true, "队长类标记（宿主据此走 recordLeaderRun，不开工作树）");
  assert.equal(run.runClass, "leader", "显式类别：消费者不得靠 squadId 的有无去猜");
  assert.equal(run.squadId, SQUAD);
  const briefing: SquadBriefing | undefined = run.briefing;
  assert.ok(briefing !== undefined, "队长 run 必须带简报（缺简报的队长不知道该干什么，且不报错）");
  assert.equal(briefing.squadId, SQUAD);
  assert.equal(briefing.leaderAgentId, LEAD);
  assert.deepEqual(briefing.roster, [{ agentId: LEAD, role: "leader" }, { agentId: AGENT }]);
  assert.equal(briefing.instructions.maxRounds, "5");
  assert.equal(briefing.protocol, LEADER_PROTOCOL_TEXT, "机制段是系统常量，不取自用户可写指令");
  // 纯函数：入参工作项一字不改（§5.2「@ 不等于改派」在规划层的落点）。
  assert.equal(JSON.stringify(workItem), before, "入参工作项被改写 = 评论把 @ 伪装成了改派");
});

test("D6 leaderOverride 复用同一处小队归档/停用判据：与「指派给小队」逐字同因、且不派发", () => {
  // 判据是**一处**的差分证据：同一支小队（归档 / 停用）两条入口给出的 reason 必须逐字相同。
  const archived = squadFixture({ archivedAt: 7 });
  const byAssignee = planDispatch({
    workItem: { ...commentWorkItem(), assignee: { type: "squad", id: SQUAD } } as never,
    squad: archived,
    trigger: "user",
  });
  const byOverride = planDispatch({
    workItem: commentWorkItem(),
    squad: null,
    trigger: "user",
    leaderOverride: { squad: archived },
  });
  assert.deepEqual(
    byOverride,
    byAssignee,
    "同一支已归档小队：两条入口必须给出同一个结论（复制第二份判据迟早分叉，而分叉不报错）",
  );
  assert.equal(
    byOverride.find((event) => event.kind === "run.enqueued"),
    undefined,
    "归档 ⇒ 不派发",
  );
  const archivedReason = byOverride.find((event) => event.kind === "inbox.notified");
  assert.ok(archivedReason?.kind === "inbox.notified");
  assert.match(
    archivedReason.reason,
    /已归档/,
    "归档原因要与停用可分辨（人去取消归档 vs 重新启用）",
  );

  const disabled = squadFixture({ enabled: false });
  const disabledOverride = planDispatch({
    workItem: commentWorkItem(),
    squad: null,
    trigger: "user",
    leaderOverride: { squad: disabled },
  });
  assert.deepEqual(
    disabledOverride,
    planDispatch({
      workItem: { ...commentWorkItem(), assignee: { type: "squad", id: SQUAD } } as never,
      squad: disabled,
      trigger: "user",
    }),
    "停用与归档是并列的两条状态，两条入口一样要同结论",
  );

  /* 旧契约**不动**（D6 是新分支不是改旧契约）：`targetOverride`（@agent 评论）命中时，
     即便本项被指派给小队，也**不得**夹带队长标记/简报 —— 被点名的普通智能体不该以为自己要去派单。 */
  const override = planDispatch({
    workItem: { ...commentWorkItem(), assignee: { type: "squad", id: SQUAD } } as never,
    squad: archived,
    trigger: "user",
    targetOverride: { type: "agent", id: AGENT },
    runClass: "standalone",
  });
  const overrideRun = override.find((event) => event.kind === "run.enqueued");
  assert.ok(overrideRun?.kind === "run.enqueued");
  assert.equal(overrideRun.agentId, AGENT, "点名者才是目标（覆盖优先于 assignee 推导）");
  assert.equal(overrideRun.isLeaderTask, false);
  assert.equal(overrideRun.briefing, undefined);
});

/* ---------- 读回：小队来源的读法（host 派发侧与回写侧共用同一处） ---------- */

test("D6 读回：squadId 缺席 = 不是队长目标（undefined）；写坏的值响亮抛（不得静默降级）", () => {
  assert.equal(
    commentReceiptSquadId({ dispatchKey: "k-1", detail: { triggerSource: "mention_agent" } }),
    undefined,
    "普通目标没有 squadId（历史行 / 非队长目标都是这一格）",
  );
  assert.equal(commentReceiptSquadId({ dispatchKey: "k-2", detail: { squadId: SQUAD } }), SQUAD);
  assert.throws(
    () => commentReceiptSquadId({ dispatchKey: "k-3", detail: { squadId: 7 } }),
    /squadId 非法/,
    "非字符串 ⇒ 抛：静默读成 undefined 会把队长 run 降级成 standalone 且不报错",
  );
  assert.throws(
    () => commentReceiptSquadId({ dispatchKey: "k-4", detail: { squadId: "  " } }),
    /squadId 非法/,
    "空白串同样不是有效的小队 id",
  );
});
