// eslint-disable-next-line typescript-eslint/triple-slash-reference -- 与 schedulerWakeTick.test.ts 同一处声明（不为本文件另写一份）
/// <reference path="../../services/src/runtime-tools/node-forge.d.ts" />
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { commentReceiptSquadId, planDispatch } from "@zcode/services/node";
import { runTasksDatabaseMigrations } from "../../services/src/session/tasksDatabase/migrations.js";
import { createCommentDispatchReceiptRepo } from "../../services/src/workitem/commentDispatchReceiptRepo.js";
import { createCommentService } from "../../services/src/workitem/commentService.js";
import { createSquadDeferredDispatchRepo } from "../../services/src/workitem/squadDeferredDispatchRepo.js";
import { createSquadRunRepo } from "../../services/src/workitem/squadRunRepo.js";
import { createWorkItemActivityRepo } from "../../services/src/workitem/workItemActivityRepo.js";
import {
  createWorkItemCommentRepo,
  type AuthorRef,
} from "../../services/src/workitem/workItemCommentRepo.js";
import { createWorkItemCommentReactionRepo } from "../../services/src/workitem/workItemCommentReactionRepo.js";
import { createWorkItemRepo } from "../../services/src/workitem/workItemRepo.js";
import {
  decideSquadDispatch,
  ledgerActionForRunClass,
  resolveCommentLeaderOverride,
} from "../src/host/squadDispatch.js";
/* D6 插队轮独立复验（test-verifier）：**receipt 事实 → 身份核对 → 派发规划**这条缝的穷举与端到端缝合。

   四条路径（在线入口 / 到期义务重放 / 未收敛补投扫描 / 规则到点）里，前三条在 host 里共用
   `runCommentDispatch` ⇒ 同一个 `performCommentDispatch` ⇒ 同一份 receipt 事实；第四条不走评论通道
   （负责人是 squad ⇒ `planDispatch` 的 `case "squad"`）。所以「同形性」这件事的完整证据链是：
     ① 评论服务把「哪支小队」落进 receipt（在服务面用例里已钉）；
     ② 派发桥按 receipt 事实 + **当前名册**做身份核对（本文件上半，纯函数穷举）；
     ③ 核对命中的那支小队交给 `planDispatch.leaderOverride`，产出与规则路径**逐字段相同**的
        run 事件（本文件下半的端到端缝合：真 repo 里的真 receipt 行 → 真读法 → 真规划）；
     ④ 回写（整份 detail 覆盖）不得抹掉 ② 的事实，否则重放那一次会降级（本文件第三节）。

   期望值取契约面事实（receipt 的 outcome/detail、`DispatchEvent` 字段、七值闭集），不读实现中间量。 */
const WS = "d6v2-ws";
const WSP = "/tmp/d6v2-ws";
const LEAD = "d6v2-leader";
const OTHER_LEAD = "d6v2-other-leader";
const MEMBER = "d6v2-member";
const SQUAD = "d6v2-squad";
const OTHER_SQUAD = "d6v2-other-squad";
const ITEM_AGENT = "d6v2-wi-agent";
const ITEM_SQUAD = "d6v2-wi-squad";
const CLOCK = 1_233_000;
const HUMAN: AuthorRef = { kind: "human", id: "d6v2-human", displayName: "人" };

const rosterSquads = [
  {
    id: SQUAD,
    name: "网关组",
    leaderAgentId: LEAD,
    members: [{ agentId: LEAD, role: "leader" }, { agentId: MEMBER }],
    instructions: { stopCondition: "全部 done 即收工", maxRounds: "5" },
    enabled: true,
  },
  {
    id: OTHER_SQUAD,
    name: "另一个组",
    leaderAgentId: OTHER_LEAD,
    members: [{ agentId: OTHER_LEAD }],
    instructions: {},
    enabled: true,
  },
];

/** 缝合夹具：真 sqlite + 真评论服务（消费真 receipt repo）+ 真名册。 */
function harness() {
  const db = new DatabaseSync(":memory:");
  runTasksDatabaseMigrations(db);
  const workItems = createWorkItemRepo(db);
  const receipts = createCommentDispatchReceiptRepo(db);
  const published: string[] = [];
  const service = createCommentService({
    comments: createWorkItemCommentRepo(db),
    activities: createWorkItemActivityRepo(db),
    receipts,
    reactions: createWorkItemCommentReactionRepo(db),
    runs: createSquadRunRepo(db),
    deferred: createSquadDeferredDispatchRepo(db),
    workItems,
    roster: {
      listAgents: () => [
        { id: LEAD, name: "队长" },
        { id: OTHER_LEAD, name: "别队队长" },
        { id: MEMBER, name: "队员" },
      ],
      listSquads: () => rosterSquads,
    },
    readDispatchEnabled: () => true,
    publishDispatchRequest: (request) => published.push(request.kind ?? "assignment"),
    now: () => CLOCK,
    newId: () => "d6v2-gen",
  });
  for (const [id, assignee] of [
    [ITEM_AGENT, { type: "agent" as const, id: MEMBER }],
    [ITEM_SQUAD, { type: "squad" as const, id: SQUAD }],
  ] as const) {
    workItems.insert({
      id,
      workspaceIdentity: WS,
      workspacePath: WSP,
      title: `D6 复验 ${id}`,
      body: "",
      status: "todo",
      assignee,
      labels: [],
      properties: {},
      position: 0,
    });
  }
  return { db, receipts, workItems, service, published };
}

const item = (id: string, assignee: { type: "agent" | "squad"; id: string }) =>
  ({
    id,
    workspaceIdentity: WS,
    workspacePath: WSP,
    title: `D6 复验 ${id}`,
    body: "",
    status: "todo",
    assignee,
    labels: [],
    properties: {},
    position: 0,
  }) as never;

test("D6 身份核对：只有「receipt 记的小队在册、且该队队长正是本次目标」才走队长支（四否定格 + 边角）", () => {
  const target = LEAD;
  assert.deepEqual(
    resolveCommentLeaderOverride({ targetAgentId: target, squadId: SQUAD, squads: rosterSquads }),
    rosterSquads[0],
    "命中 ⇒ 返回**名册里那份**小队（简报/花名册/指令都从它出，不从 receipt 反推）",
  );

  /* 否定格一：receipt 落库后队长换人（现在是 ta-x）⇒ 目标已不是队长。 */
  assert.equal(
    resolveCommentLeaderOverride({
      targetAgentId: OTHER_LEAD,
      squadId: SQUAD,
      squads: rosterSquads,
    }),
    null,
    "换队长后重放：绝不把「你是队长」的简报发给一个不是队长的人",
  );
  /* 否定格二：receipt 里没有小队（@普通智能体 / 回复锚点 / ⑦ 兜底）。 */
  assert.equal(
    resolveCommentLeaderOverride({
      targetAgentId: target,
      squadId: undefined,
      squads: rosterSquads,
    }),
    null,
  );
  /* 否定格三：小队不在名册（已删 / 指派引用失效）。 */
  assert.equal(
    resolveCommentLeaderOverride({
      targetAgentId: target,
      squadId: "d6v2-gone",
      squads: rosterSquads,
    }),
    null,
    "小队查不到 ⇒ 退回普通 agent 覆盖（目标本身是真实智能体，请求不丢）",
  );
  /* 否定格四：目标是**别队**的队长（同名/同人跨队不算命中）。 */
  assert.equal(
    resolveCommentLeaderOverride({
      targetAgentId: OTHER_LEAD,
      squadId: SQUAD,
      squads: rosterSquads,
    }),
    null,
  );
  /* 边角：名册为空 / squadId 为空串（receipt 侧读法会先抛，这里是防御性的第二道）。 */
  assert.equal(
    resolveCommentLeaderOverride({ targetAgentId: target, squadId: SQUAD, squads: [] }),
    null,
  );
  assert.equal(
    resolveCommentLeaderOverride({ targetAgentId: target, squadId: "", squads: rosterSquads }),
    null,
  );
});

test("D6 端到端缝合（三条评论路径共用的事实面）：真 receipt → 真读法 → 真身份核对 → 与规则路径同一个 leader run", () => {
  const h = harness();

  /* 规则路径的基准：负责人是 squad（规则/队长工具/UI 改派三路共用 `case "squad"`）。 */
  const byRule = planDispatch({
    workItem: item(ITEM_SQUAD, { type: "squad", id: SQUAD }),
    squad: rosterSquads[0] as never,
    trigger: "rule",
    ruleId: "d6v2-rule",
  });
  const ruleRun = byRule.find((event) => event.kind === "run.enqueued");
  assert.ok(ruleRun?.kind === "run.enqueued");

  /* 评论的两条源各自落一条 receipt：① 显式 @小队（agent 项的评论）；② assignee=squad 的兜底源。 */
  h.service.createComment({
    id: "d6v2-c-mention",
    workspaceKey: WS,
    workspacePath: WSP,
    workItemId: ITEM_AGENT,
    author: HUMAN,
    initiatedBy: HUMAN,
    body: "@网关组 看一下",
  });
  h.service.createComment({
    id: "d6v2-c-assignee",
    workspaceKey: WS,
    workspacePath: WSP,
    workItemId: ITEM_SQUAD,
    author: HUMAN,
    initiatedBy: HUMAN,
    body: "看一下",
  });

  const commentRunFor = (workItemId: string, assignee: { type: "agent" | "squad"; id: string }) => {
    const rows = h.receipts.listByWorkItem(WS, workItemId);
    assert.equal(rows.length, 1, `${workItemId} 应恰有一条 receipt`);
    const receipt = rows[0]!;
    /* ② 派发桥的两份事实：receipt 的 squadId（读法唯一）+ 当前名册。 */
    const squadId = commentReceiptSquadId(receipt);
    assert.equal(squadId, SQUAD, "receipt 必须把「哪支小队」落库（否则 host 无从知道简报来源）");
    const matched = resolveCommentLeaderOverride({
      targetAgentId: receipt.targetAgentId,
      squadId,
      squads: rosterSquads,
    });
    assert.notEqual(matched, null, "目标确是该队队长 ⇒ 走队长支");
    /* ③ 把核对结论交给 planDispatch —— 与 host 派发桥同一处入参形状。 */
    return planDispatch({
      workItem: item(workItemId, assignee),
      squad: null,
      trigger: "user",
      leaderOverride: { squad: matched as never },
    }).find((event) => event.kind === "run.enqueued");
  };

  /* 同形性比对把 workItemId 归一（每条事件当然带自己的项 id，那是形状之外的定位事实）。 */
  const shape = (event: unknown): Record<string, unknown> => ({
    ...(event as Record<string, unknown>),
    workItemId: "<本项>",
  });

  assert.deepEqual(
    shape(commentRunFor(ITEM_AGENT, { type: "agent", id: MEMBER })),
    shape(ruleRun),
    "@小队：评论通道的 run 事件必须与规则路径逐字段相同（标记/类别/squadId/三段简报）",
  );
  assert.deepEqual(
    shape(commentRunFor(ITEM_SQUAD, { type: "squad", id: SQUAD })),
    shape(ruleRun),
    "assignee=squad 的兜底源同理（同一条事实、同一个结论）",
  );

  /* 负向半边：@普通智能体的 receipt 没有 squadId ⇒ 身份核对不命中 ⇒ 退回普通覆盖，绝不带队长形态。 */
  h.service.createComment({
    id: "d6v2-c-agent",
    workspaceKey: WS,
    workspacePath: WSP,
    workItemId: ITEM_AGENT,
    author: HUMAN,
    initiatedBy: HUMAN,
    body: "@队员 看一下",
  });
  const plain = h.receipts
    .listByWorkItem(WS, ITEM_AGENT)
    .find((row) => row.commentId === "d6v2-c-agent");
  assert.ok(plain !== undefined);
  const plainSquadId = commentReceiptSquadId(plain);
  assert.equal(
    plainSquadId,
    undefined,
    "@agent 的请求事实里没有小队（附一个会让下游误起队长 run）",
  );
  const plainTarget = resolveCommentLeaderOverride({
    targetAgentId: plain.targetAgentId,
    squadId: plainSquadId,
    squads: rosterSquads,
  });
  assert.equal(plainTarget, null);
  const plainRun = planDispatch({
    workItem: item(ITEM_AGENT, { type: "agent", id: MEMBER }),
    squad: null,
    trigger: "user",
    targetOverride: { type: "agent", id: plain.targetAgentId },
    runClass: "standalone",
  }).find((event) => event.kind === "run.enqueued");
  assert.ok(plainRun?.kind === "run.enqueued");
  assert.equal(plainRun.isLeaderTask, false);
  assert.equal(plainRun.briefing, undefined);
  assert.equal(plainRun.squadId, undefined);
});

test("D6 回写是整份 detail 覆盖：带上 squadId 才保住重放/补投的同形；抹掉它即降级（对照）", () => {
  const h = harness();
  const receipt = h.receipts.insertIfAbsent({
    dispatchKey: "d6v2-k1",
    workspaceKey: WS,
    workItemId: ITEM_AGENT,
    targetAgentId: LEAD,
    commentId: "d6v2-c1",
    threadId: "d6v2-t1",
    source: "mention_squad_leader",
    outcome: "pending",
    detail: { triggerSource: "mention_squad_leader", squadId: SQUAD },
    createdAt: CLOCK,
  });
  assert.equal(commentReceiptSquadId(receipt), SQUAD);

  /* host 的回写形状（settleCommentReceipt）：triggerSource + squadId + 落点 detail。 */
  assert.equal(
    h.receipts.settleIfUnsettled({
      dispatchKey: receipt.dispatchKey,
      outcome: "deferred",
      detail: { triggerSource: receipt.source, squadId: SQUAD, coalescedInto: "d6v2-other" },
      updatedAt: CLOCK + 1,
    }),
    true,
  );
  const after = h.receipts.get(receipt.dispatchKey)!;
  assert.equal(after.outcome, "deferred");
  assert.equal(
    commentReceiptSquadId(after),
    SQUAD,
    "回写之后「哪支小队」仍在：deferred 重放/补投走的是这一份事实",
  );

  /* 对照（修前形态）：回写不带 squadId ⇒ 事实被抹掉 ⇒ 身份核对必然落空 ⇒ 重放那一次降级成
     standalone（无简报、无队长台账行、不参与 §5.7(1) 合并）。本格只证明「为什么必须带」。 */
  const legacy = h.receipts.insertIfAbsent({
    dispatchKey: "d6v2-k2",
    workspaceKey: WS,
    workItemId: ITEM_AGENT,
    targetAgentId: LEAD,
    commentId: "d6v2-c2",
    threadId: "d6v2-t2",
    source: "mention_squad_leader",
    outcome: "pending",
    detail: { triggerSource: "mention_squad_leader", squadId: SQUAD },
    createdAt: CLOCK,
  });
  assert.equal(
    h.receipts.settleIfUnsettled({
      dispatchKey: legacy.dispatchKey,
      outcome: "deferred",
      detail: { triggerSource: legacy.source },
      updatedAt: CLOCK + 1,
    }),
    true,
  );
  const wiped = h.receipts.get(legacy.dispatchKey)!;
  assert.equal(commentReceiptSquadId(wiped), undefined, "整份覆盖：不带就丢");
  assert.equal(
    resolveCommentLeaderOverride({
      targetAgentId: wiped.targetAgentId,
      squadId: commentReceiptSquadId(wiped),
      squads: rosterSquads,
    }),
    null,
    "丢了 squadId ⇒ 重放降级成普通 agent run（这正是 host 回写必须带上它的原因）",
  );
});

test("D6 同形性（台账行/执行形状那一格）：leader 事件 ⇒ 台账动作 record_leader_run，且缺树不算失败（队长在目标工作区执行）", () => {
  /* 派发桥按 `enqueued.runClass` 查表定台账动作 —— 评论队长支与「指派给小队」给出同一个 runClass，
     于是**必然**走同一条台账/执行形状（队长台账行、无工作树、简报必填）。 */
  assert.equal(ledgerActionForRunClass("leader"), "record_leader_run");
  assert.equal(ledgerActionForRunClass("member"), "open_member_run");
  assert.equal(ledgerActionForRunClass("standalone"), "none", "单独安排无台账行（§6.1）");

  const leader = decideSquadDispatch({
    dispatchEnabled: true,
    databaseReady: true,
    busy: false,
    kind: "leader",
    leaderRunInProgress: false,
    briefingPrompt: "简报",
    memberPrompt: "队员",
    standalonePrompt: "单独",
    worktree: undefined,
  });
  assert.equal(leader.action, "dispatch", "队长没有工作树是正确形状（缺树判据只对队员）");
  assert.deepEqual(
    decideSquadDispatch({
      dispatchEnabled: true,
      databaseReady: true,
      busy: false,
      kind: "member",
      leaderRunInProgress: false,
      briefingPrompt: "简报",
      memberPrompt: "队员",
      standalonePrompt: "单独",
      worktree: undefined,
    }),
    { action: "fail", reason: "member_run_requires_worktree" },
    "负向半边：队员缺树才是失败（这条判据不得套到队长身上）",
  );

  /* §5.7(1) 合并判据对队长 run 生效（评论队长支与规则路径共用同一条台账读法）。 */
  const merged = decideSquadDispatch({
    dispatchEnabled: true,
    databaseReady: true,
    busy: false,
    kind: "leader",
    leaderRunInProgress: true,
    briefingPrompt: "简报",
    memberPrompt: "队员",
    standalonePrompt: "单独",
    worktree: undefined,
  });
  assert.deepEqual(merged, { action: "skip", reason: "leader_run_merged" });
});

test("D6 偏差一致性（结构面）：run 身份贯穿绑定/收口/失败/重投四处 —— 同 runId 重开是唯一可行形态", () => {
  const source = readFileSync(
    join(
      resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", ".."),
      "packages/desktop/src/host/index.ts",
    ),
    "utf8",
  );
  const dispatchStart = source.indexOf("async function runSquadDispatch(");
  const dispatchEnd = source.indexOf('parentPort.on("message",', dispatchStart);
  const dispatchBody = source.slice(dispatchStart, dispatchEnd);
  /* 开树（台账行 runId）与绑定会话都按 eventKey：换 runId 重开会让绑定落到一条不存在的行上。 */
  assert.match(
    dispatchBody,
    /openMemberRun\(target,\s*\{\s*runId:\s*eventKey,/,
    "开树按 eventKey 落台账",
  );
  assert.match(
    dispatchBody,
    /bindMemberRunSession\(target,\s*\{[\s\S]{0,120}runId:\s*eventKey,/,
    "会话回写按 eventKey（换 runId ⇒ requireRun 抛，会话与台账对不上）",
  );
  assert.match(
    dispatchBody,
    /failMemberRun\(target,\s*\{[\s\S]{0,120}runId:\s*eventKey,/,
    "失败出口按 eventKey（换 runId ⇒ 失败收不到那条行上）",
  );
  assert.match(
    dispatchBody,
    /watchMemberRunSettlement\(\{[\s\S]{0,160}runId:\s*eventKey,/,
    "终态收口订阅按 eventKey",
  );
  assert.match(
    dispatchBody,
    /const boundSessionId\s*=\s*\n?\s*snapshot\.runs\.find\(\(record\) => record\.runId === eventKey\)/,
    "忙探测读的也是 eventKey 那条行（换 runId ⇒ 重投永远另建会话）",
  );

  const performStart = source.indexOf("async function performCommentDispatch(");
  const performEnd = source.indexOf("async function settleCommentReceipt(", performStart);
  assert.match(
    source.slice(performStart, performEnd),
    /eventKey:\s*receipt\.dispatchKey,/,
    "评论派发的 run 身份 = receipt.dispatchKey（补投扫描按它找 own-run）",
  );
});
