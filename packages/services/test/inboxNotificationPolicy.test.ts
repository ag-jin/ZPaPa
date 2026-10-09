import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { WORK_ITEM_MAX_DEPTH } from "@zcode/shared";
import { runTasksDatabaseMigrations } from "../src/session/tasksDatabase/migrations.js";
import { createCommentDispatchReceiptRepo } from "../src/workitem/commentDispatchReceiptRepo.js";
import { createCommentService } from "../src/workitem/commentService.js";
import { createSquadDeferredDispatchRepo } from "../src/workitem/squadDeferredDispatchRepo.js";
import { createSquadRunRepo } from "../src/workitem/squadRunRepo.js";
import { createWorkItemActivityRepo } from "../src/workitem/workItemActivityRepo.js";
import { createWorkItemCommentReactionRepo } from "../src/workitem/workItemCommentReactionRepo.js";
import { createWorkItemCommentRepo } from "../src/workitem/workItemCommentRepo.js";
import { createWorkItemDecisionRepo } from "../src/workitem/workItemDecisionRepo.js";
import { createWorkItemDecisionService } from "../src/workitem/workItemDecisionService.js";
import { createWorkItemRepo } from "../src/workitem/workItemRepo.js";
import { createWorkItemService } from "../src/workitem/workItemService.js";
import { createWorkItemSubscriberRepo } from "../src/workitem/workItemSubscriberRepo.js";
import {
  createSubscriberFactRecorder,
  type SubscriberSubject,
} from "../src/workitem/subscriberFacts.js";
import {
  createInboxItemRepo,
  INBOX_ITEM_KINDS,
  INBOX_SEVERITY_BY_KIND,
  type InboxItemKind,
  type InboxItemSeverity,
} from "../src/workitem/inboxItemRepo.js";
import {
  planInboxNotificationItem,
  resolveInboxDeliveryTier,
  resolveInboxRecipients,
  type CommentNotificationFact,
  type DecisionNotificationFact,
  type InboxNotificationFact,
  type InboxSubscriberRow,
} from "../src/workitem/inboxNotificationPolicy.js";

/* SUB.2：Inbox 通知策略的**判据面**（收件人解析 / 三新 kind 准入 / 投递档）。

   期望值来源：
   · 收件人解析 = 拆解报告 §2.3（父子冒泡只影响收件人集合；祖先 scope=subtree 的墓碑静音该子树
     经冒泡的投递，但**直接订阅 > 祖先静音**）+ §2.5（issue = 只退这一条、subtree = 这一条及后代）；
   · 准入 = §2.2 的三格（点名 / 决定 / 关注）与它们**公共的作者排除**前置；
   · 投递档 = §2.2 第 2 条「由既有 severity 单源派生」+ Q3 裁定（comment_attention ⇒ info ⇒ 不推）。
   全部按矩阵逐格抄录，不在测试里重算实现的分子。 */

const HUMAN: SubscriberSubject = { kind: "human", id: "local-user" };
const AGENT: SubscriberSubject = { kind: "agent", id: "ta-ann" };
const SQUAD: SubscriberSubject = { kind: "squad", id: "sq-1" };
const LEADER: SubscriberSubject = { kind: "agent", id: "ta-lead" };

/** 一条订阅行（判据只读三个字段；tombstoned_at 非空 = 显式退订，活动行恒 issue）。 */
function row(
  subject: SubscriberSubject,
  over: Partial<Omit<InboxSubscriberRow, "subjectType" | "subjectId">> = {},
): InboxSubscriberRow {
  return {
    subjectType: subject.kind,
    subjectId: subject.id,
    tombstonedAt: null,
    optOutScope: "issue",
    ...over,
  };
}

/** 行集夹具：`{工作项 → 订阅行}` + 父链（缺省 = 根）。冒泡上溯由实现读这两口。 */
function tree(
  rowsByWorkItem: Record<string, InboxSubscriberRow[]>,
  parents: Record<string, string | null> = {},
) {
  return {
    readSubscribers: (workItemId: string) => rowsByWorkItem[workItemId] ?? [],
    readParentId: (workItemId: string) => parents[workItemId] ?? null,
  };
}

/* ---------- ① 准入（三新 kind 的「要不要产生」） ---------- */

const WS = { key: "ws-policy", path: "/tmp/ws-policy" };

/** 评论通知事实（收件人由 `planInboxNotificationItem` 自己解析 —— 与组合根接线的形状一致）。 */
function commentFact(
  over: Partial<Omit<CommentNotificationFact, "kind">> = {},
): InboxNotificationFact {
  return {
    kind: "comment",
    workspaceKey: WS.key,
    workspacePath: WS.path,
    workItemId: "child",
    workItemTitle: "子任务",
    commentId: "c-1",
    author: HUMAN,
    mentioned: [],
    ...over,
  };
}

function decisionFact(
  over: Partial<Omit<DecisionNotificationFact, "kind">> = {},
): InboxNotificationFact {
  return {
    kind: "decision",
    workspaceKey: WS.key,
    workspacePath: WS.path,
    workItemId: "child",
    workItemTitle: "子任务",
    decisionId: "d-1",
    author: HUMAN,
    ...over,
  };
}

test("SUB.2 准入｜{作者=本人/他人} × {无收件人/只有本人/有他人} 逐格：只在「非本人 + 有他人」产生", () => {
  const plan = (
    fact: InboxNotificationFact,
    rows: Record<string, InboxSubscriberRow[]>,
    parents: Record<string, string | null> = {},
  ) => planInboxNotificationItem({ fact, ...tree(rows, parents) });

  // 无收件人（订阅表里没有任何行）：两个事实都不产生 —— 没有可通知的对象。
  assert.equal(plan(commentFact(), {}), null, "评论：无订阅者 ⇒ 不产生");
  assert.equal(plan(decisionFact(), {}), null, "决定：无订阅者 ⇒ 不产生");

  // 只有作者自己（单人产品最常见的形态）：**作者排除**是公共前置 ⇒ 不产生（自通知问题）。
  assert.equal(
    plan(commentFact(), { child: [row(HUMAN)] }),
    null,
    "评论：作者是唯一订阅者 ⇒ 不产生",
  );
  assert.equal(
    plan(decisionFact(), { child: [row(HUMAN)] }),
    null,
    "决定：作者是唯一订阅者 ⇒ 不产生",
  );

  // 有他人（本项的直接订阅行）：各自落对应的 kind（dedupKey 单源）。
  const comment = plan(commentFact(), { child: [row(HUMAN), row(AGENT)] });
  assert.equal(comment?.kind, "comment_attention");
  assert.equal(comment?.dedupKey, "comment_attention:c-1");

  const decision = plan(decisionFact(), { child: [row(HUMAN), row(AGENT)] });
  assert.equal(decision?.kind, "decision_required");
  assert.equal(decision?.dedupKey, "decision_required:d-1");

  // 非本人作者：人类作者的项上有一个 agent 订阅者 —— 决定要人裁决 ⇒ 收件人是那个 agent。
  const byAgent = plan(decisionFact({ author: AGENT }), { child: [row(HUMAN), row(AGENT)] });
  assert.equal(byAgent?.kind, "decision_required");
  assert.deepEqual(byAgent?.detail.recipients, [{ kind: "human", id: "local-user" }]);
});

test("SUB.2 准入｜点名优先：显式点名非作者主体 ⇒ mention_action_required（不依赖订阅解析）", () => {
  const plan = (fact: InboxNotificationFact, rows: Record<string, InboxSubscriberRow[]>) =>
    planInboxNotificationItem({ fact, ...tree(rows) });

  // 点名命中且被点名者非作者：**不需要任何订阅行**（点名本身就是收件人来源）。
  const mentioned = plan(commentFact({ mentioned: [AGENT] }), {});
  assert.equal(mentioned?.kind, "mention_action_required");
  assert.equal(mentioned?.dedupKey, "mention_action_required:c-1");
  assert.deepEqual(mentioned?.detail.mentioned, [{ kind: "agent", id: "ta-ann" }]);
  assert.equal(mentioned?.detail.commentId, "c-1");
  assert.equal(
    mentioned?.detail.recipients,
    undefined,
    "点名件不带订阅收件人（收件人由点名给定：detail 形状固定，不适用的一律不出现）",
  );

  // 只点名自己 ⇒ 视作没点名：落到订阅面（作者排除仍然承重）。
  assert.equal(
    plan(commentFact({ mentioned: [HUMAN] }), { child: [row(HUMAN)] }),
    null,
    "@自己不是通知（作者排除对点名面同样成立）",
  );
  // 只点名自己 + 有他人订阅者 ⇒ 落关注件（点名的强事实不成立，但「我关注的工作项有新动静」成立）。
  const attention = plan(commentFact({ mentioned: [HUMAN] }), { child: [row(HUMAN), row(AGENT)] });
  assert.equal(attention?.kind, "comment_attention");

  // 同时有点名与订阅者：**一条评论至多一条条目**，强事实（有人被点名）胜出。
  const both = plan(commentFact({ mentioned: [LEADER] }), { child: [row(HUMAN), row(AGENT)] });
  assert.equal(both?.kind, "mention_action_required");
  assert.deepEqual(both?.detail.mentioned, [{ kind: "agent", id: "ta-lead" }]);

  // 决定没有点名面：同样的「点名 + 订阅者」不适用（事实里没有该字段）。
  const decision = plan(decisionFact({ author: AGENT }), { child: [row(HUMAN)] });
  assert.equal(decision?.kind, "decision_required");
  assert.equal(decision?.detail.mentioned, undefined);
});

test("SUB.2 准入｜冒泡可达的祖先订阅者同样让事实产生（条目仍恰一条，dedup 不因收件人变化）", () => {
  const item = planInboxNotificationItem({
    fact: commentFact(),
    ...tree({ child: [], parent: [row(HUMAN), row(AGENT)] }, { child: "parent", parent: null }),
  });
  assert.equal(item?.kind, "comment_attention", "仅祖先有订阅者 ⇒ 解析命中（冒泡）");
  assert.deepEqual(item?.detail.recipients, [{ kind: "agent", id: "ta-ann" }]);
  assert.equal(
    item?.dedupKey,
    "comment_attention:c-1",
    "去重键只含事实 id：收件人怎么解析出来不改变「这是哪条事实」",
  );

  // 事实所在项一条活动行都没有、祖先也没有 ⇒ 不产生。
  assert.equal(
    planInboxNotificationItem({
      fact: commentFact(),
      ...tree({ child: [], parent: [] }, { child: "parent", parent: null }),
    }),
    null,
  );
});

test("SUB.2 准入｜收件人全部退订 ⇒ 不产生（「把订阅者退订 ⇒ 不再产生」）", () => {
  const TOMB = 1_700_000_000_000;
  assert.equal(
    planInboxNotificationItem({
      fact: commentFact(),
      ...tree({ child: [row(AGENT, { tombstonedAt: TOMB, optOutScope: "subtree" })] }),
    }),
    null,
    "唯一的收件人已显式退订 ⇒ 事实照样成立，但没有收件人 ⇒ 不产生条目",
  );
});

/* ---------- ② 投递档（「需决策才推」的判据面；推送本身归 SUB.3b） ---------- */

test("SUB.2 投递档｜由 severity 单源派生（action_required/attention ⇒ 推、info ⇒ 只落 Inbox）", () => {
  // 期望值来源：拆解报告 §2.2 第 2 条（severity 单源派生）+ Q3（comment_attention ⇒ info ⇒ 不推）。
  for (const kind of INBOX_ITEM_KINDS) {
    const tier = resolveInboxDeliveryTier(kind);
    assert.ok(
      tier === "push" || tier === "inbox_only",
      `${kind} 的投递档必须落在两值闭集内（穷尽由 Record<…> 空域保证，这里再按值域断言）`,
    );
    assert.equal(
      tier,
      INBOX_SEVERITY_BY_KIND[kind] === "info" ? "inbox_only" : "push",
      `${kind}：档必须与自己的 severity 一致（info 只落 Inbox，其余进渠道）`,
    );
  }
  assert.equal(resolveInboxDeliveryTier("merge_conflict"), "push", "要人拍板 ⇒ 推");
  assert.equal(resolveInboxDeliveryTier("member_failed"), "push", "要人看一眼 ⇒ 推");
  assert.equal(resolveInboxDeliveryTier("dispatch_skipped"), "inbox_only", "只是通知 ⇒ 不推");
  assert.equal(resolveInboxDeliveryTier("mention_action_required"), "push", "点名要人回应 ⇒ 推");
  assert.equal(resolveInboxDeliveryTier("decision_required"), "push", "要人裁决 ⇒ 推");
  assert.equal(resolveInboxDeliveryTier("comment_attention"), "inbox_only", "Q3：仅需关注 ⇒ 不推");

  /* 「无第二张 kind→推/不推 的表」的机械证明：把某 kind 的 severity 改一格，
     档**必须**跟着变。若判据里还藏着另一张 per-kind 表，这一格不会变红。 */
  const mutable = INBOX_SEVERITY_BY_KIND as Record<InboxItemKind, InboxItemSeverity>;
  const original = mutable.comment_attention;
  try {
    mutable.comment_attention = "attention";
    assert.equal(
      resolveInboxDeliveryTier("comment_attention"),
      "push",
      "severity 改一格 ⇒ 投递结论跟着变（单源派生的机械证明）",
    );
  } finally {
    mutable.comment_attention = original;
  }
  assert.equal(resolveInboxDeliveryTier("comment_attention"), "inbox_only", "复原后回到原档");
});

test("SUB.2 解析｜上溯止于工作项树的深度上界（含自身）；坏父链成环也不挂死", () => {
  // 链：n0（事实所在）→ n1 → … → n5。上界 = WORK_ITEM_MAX_DEPTH（含自身）⇒ 恰读 n0..n4 五级。
  const ids = Array.from({ length: WORK_ITEM_MAX_DEPTH + 1 }, (_, index) => `n${index}`);
  const rows: Record<string, InboxSubscriberRow[]> = {};
  const parents: Record<string, string | null> = {};
  ids.forEach((id, index) => {
    rows[id] = [];
    parents[id] = ids[index + 1] ?? null;
  });
  rows[`n${WORK_ITEM_MAX_DEPTH - 1}`] = [row(HUMAN)]; // 最后一格（第 4 级祖先）：读得到
  rows[`n${WORK_ITEM_MAX_DEPTH}`] = [row(AGENT)]; // 更深一级：树不可能有这个深度 ⇒ 读不到

  assert.deepEqual(
    resolveInboxRecipients({ workItemId: "n0", ...tree(rows, parents) }),
    [{ subject: HUMAN, via: "ancestor", fromWorkItemId: `n${WORK_ITEM_MAX_DEPTH - 1}` }],
    "上溯深度 = 工作项树自身的上界（含自身）：再深的一级不读（树比它深已是坏数据，多走只会读不存在的祖先）",
  );

  // 坏父链（环）：n0 → n1 → n0。判据不靠树的自洽性，走一遍就停（不挂死、不重复计入）。
  assert.deepEqual(
    resolveInboxRecipients({
      workItemId: "n0",
      ...tree({ n0: [], n1: [row(SQUAD)] }, { n0: "n1", n1: "n0" }),
    }),
    [{ subject: SQUAD, via: "ancestor", fromWorkItemId: "n1" }],
    "坏父链成环：每个工作项只读一次，读到重复就停",
  );
});

test("SUB.2 解析｜本项墓碑静音本项事实；祖先墓碑只有 subtree 档静音后代；直接订阅 > 祖先静音", () => {
  const TOMB = 1_700_000_000_000;
  const resolve = (
    rows: Record<string, InboxSubscriberRow[]>,
    parents: Record<string, string | null>,
  ) => resolveInboxRecipients({ workItemId: "child", ...tree(rows, parents) });

  // (a) 本项墓碑（issue 档）：该主体对本项事实静音 —— 即便某个祖先也有它的活动行（§2.5「issue = 只退这一条」）。
  assert.deepEqual(
    resolve(
      { child: [row(HUMAN, { tombstonedAt: TOMB, optOutScope: "issue" })], parent: [row(HUMAN)] },
      { child: "parent", parent: null },
    ),
    [],
    "本项墓碑（issue）：本项事实不投给它（退订不是「只退这一条的子项」）",
  );

  // (b) 本项墓碑（subtree 档）：本项照样静音（「这一条及其全部后代」含自身）。
  assert.deepEqual(
    resolve(
      { child: [row(HUMAN, { tombstonedAt: TOMB, optOutScope: "subtree" })], parent: [row(HUMAN)] },
      { child: "parent", parent: null },
    ),
    [],
    "本项墓碑（subtree）：本项与后代都静音，含自身",
  );

  // (c) 祖先墓碑（issue 档）：**不**静音后代 —— 父项的 issue 档只退那一条祖先。
  assert.deepEqual(
    resolve(
      { child: [], parent: [row(HUMAN, { tombstonedAt: TOMB, optOutScope: "issue" })] },
      { child: "parent", parent: null },
    ),
    [],
    "父项墓碑（issue）本身不是子项的订阅行（退订行不留投递效力）",
  );
  assert.deepEqual(
    resolve(
      {
        child: [],
        parent: [
          row(HUMAN, { tombstonedAt: TOMB, optOutScope: "issue" }),
          row(AGENT, { tombstonedAt: TOMB, optOutScope: "subtree" }),
        ],
        root: [row(HUMAN)],
      },
      { child: "parent", parent: "root", root: null },
    ),
    [{ subject: HUMAN, via: "ancestor", fromWorkItemId: "root" }],
    "父项的 issue 档墓碑只退那一条：更上一级的活动行照旧把子项事实投给同一主体",
  );

  // (d) 祖先墓碑（subtree 档）：静音该子树经冒泡的投递。
  assert.deepEqual(
    resolve(
      {
        child: [],
        parent: [row(HUMAN, { tombstonedAt: TOMB, optOutScope: "subtree" })],
        root: [row(HUMAN)],
      },
      { child: "parent", parent: "root", root: null },
    ),
    [],
    "祖先 subtree 档墓碑静音整个子树（更上一级的活动行也救不回来）",
  );

  // (e) 直接订阅 > 祖先静音：本项自身的活动行不受祖先墓碑影响（§2.3 冻结）。
  assert.deepEqual(
    resolve(
      {
        child: [row(HUMAN)],
        parent: [row(HUMAN, { tombstonedAt: TOMB, optOutScope: "subtree" })],
      },
      { child: "parent", parent: null },
    ),
    [{ subject: HUMAN, via: "direct", fromWorkItemId: "child" }],
    "直接订阅 > 祖先静音：对**这一条**明确订阅过就收得到",
  );

  // (f) 祖先链上**任一**节点的 subtree 墓碑都静音该子树：近祖先的活动行也压不过更远的 subtree 墓碑。
  assert.deepEqual(
    resolve(
      {
        child: [],
        parent: [row(HUMAN)],
        root: [row(HUMAN, { tombstonedAt: TOMB, optOutScope: "subtree" })],
      },
      { child: "parent", parent: "root", root: null },
    ),
    [],
    "subtree 墓碑静音的是「这一条及其全部后代」：后代自己那一级的活动订阅行也在静音面内" +
      "（只有**本项**的直接订阅才压得过 —— 见上一格）",
  );
});

test("SUB.2 解析｜自身活动行 ⇒ direct；仅祖先有 ⇒ ancestor；同一主体多级命中取最近一级", () => {
  const recipients = resolveInboxRecipients({
    workItemId: "child",
    ...tree(
      {
        child: [row(HUMAN)],
        parent: [row(AGENT), row(SQUAD)],
        root: [row(AGENT), row(LEADER)],
      },
      { child: "parent", parent: "root", root: null },
    ),
  });
  assert.deepEqual(
    recipients,
    [
      // AGENT 同时在 parent 与 root 有行：取最近一级（parent），不是根。
      { subject: AGENT, via: "ancestor", fromWorkItemId: "parent" },
      { subject: LEADER, via: "ancestor", fromWorkItemId: "root" },
      { subject: HUMAN, via: "direct", fromWorkItemId: "child" },
      { subject: SQUAD, via: "ancestor", fromWorkItemId: "parent" },
    ],
    "收件人 = 本项订阅者 ∪ 祖先链订阅者（主体键升序）；via 指出命中路径（冒泡的可观察面）",
  );
});

/* ---------- 写链：评论 / 决定写入后经通知口落条目（零 dispatch / 零第二行） ----------

   通知口在这里按**与组合根同形**的方式装配：`planInboxNotificationItem` + 唯一写收口
   `inboxItemRepo.insertIfAbsent`，两口读绑定到真 repo。判据本身在策略模块里已逐格测过，
   这一段测的是「真实评论/决定写进去之后，链条真的接通了」——缺接线的表现是「评论照常、
   条目永远不出现」，而全链不报错（本域反复出现的静默缺口形态）。 */

const CHAIN_WS = { key: "ws-chain", path: "/tmp/ws-chain" };

function chainFixture() {
  const db = new DatabaseSync(":memory:");
  runTasksDatabaseMigrations(db);
  const workItems = createWorkItemRepo(db);
  const subscribers = createWorkItemSubscriberRepo(db);
  const inbox = createInboxItemRepo(db);
  const events: string[] = [];
  const published: unknown[] = [];
  const workItemService = createWorkItemService({
    repo: workItems,
    emit: (event) => events.push(event.kind),
    subscribers: createSubscriberFactRecorder(subscribers, CHAIN_WS),
  });
  /* 收件箱通知口（唯一装配形态）：解析 + 准入 + 构建都在策略模块，这里只有绑定与唯一写收口。 */
  const notify = (fact: InboxNotificationFact) => {
    const item = planInboxNotificationItem({
      fact,
      readSubscribers: (workItemId) => subscribers.listByWorkItem(CHAIN_WS.key, workItemId),
      readParentId: (workItemId) => workItems.get(workItemId)?.parentId ?? null,
    });
    if (item !== null) inbox.insertIfAbsent(item);
  };
  const commentService = createCommentService({
    /* G8：事务口（本文件是既有用例，注入 identity 替身 —— 行为逐字不变；真事务的证据在 commentServiceTransaction.test.ts）。 */
    transact: (fn) => fn(),
    comments: createWorkItemCommentRepo(db),
    activities: createWorkItemActivityRepo(db),
    receipts: createCommentDispatchReceiptRepo(db),
    reactions: createWorkItemCommentReactionRepo(db),
    runs: createSquadRunRepo(db),
    deferred: createSquadDeferredDispatchRepo(db),
    workItems,
    roster: {
      listAgents: () => [
        { id: AGENT.id, name: "Ann" },
        { id: LEADER.id, name: "Bob" },
      ],
      listSquads: () => [],
    },
    readDispatchEnabled: () => true,
    subscribers: createSubscriberFactRecorder(subscribers, CHAIN_WS),
    inboxNotifications: (fact) => notify({ kind: "comment", ...fact }),
  });
  const decisionService = createWorkItemDecisionService({
    decisions: createWorkItemDecisionRepo(db),
    activities: createWorkItemActivityRepo(db),
    workItems,
    inboxNotifications: (fact) => notify({ kind: "decision", ...fact }),
  });
  const countRows = (table: string): number =>
    (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
  /** dedup_key 是存储层列、**不在读模型**上：读裸列验证构建件的形状（不被读面回声骗过）。 */
  const dedupKeys = (): string[] =>
    (
      db.prepare("SELECT dedup_key FROM inbox_items ORDER BY dedup_key").all() as Array<{
        dedup_key: string;
      }>
    ).map((row) => row.dedup_key);
  return {
    db,
    workItems,
    subscribers,
    inbox,
    workItemService,
    commentService,
    decisionService,
    events,
    published,
    countRows,
    dedupKeys,
  };
}

/** 建一个「人类自建自领」的工作项（订阅表里因此只有人类自己那一行 —— 单人产品的默认形态）。 */
function ownedItem(f: ReturnType<typeof chainFixture>, id: string, parentId?: string) {
  return f.workItemService.create({
    id,
    workspaceIdentity: CHAIN_WS.key,
    workspacePath: CHAIN_WS.path,
    title: `标题 ${id}`,
    ...(parentId !== undefined ? { parentId } : {}),
    assignee: { type: "user", id: "user" },
    creator: { kind: "human", id: HUMAN.id },
  });
}

test("SUB.2 写链｜非本人作者的评论 ⇒ 恰一条 comment_attention / info；作者自己的评论不产生（自通知）", () => {
  const f = chainFixture();
  const item = ownedItem(f, "wi-1");
  const comment = (author: SubscriberSubject, commentId: string) =>
    f.commentService.createComment({
      id: commentId,
      workspaceKey: CHAIN_WS.key,
      workspacePath: CHAIN_WS.path,
      workItemId: item.id,
      author,
      initiatedBy: { kind: "human", id: HUMAN.id },
      body: "补充一句",
      clientRequestId: `req-${commentId}`,
    });

  // 人类作者：订阅表里唯一的活动行就是他本人 ⇒ 自通知不产生（作者排除承重）。
  comment(HUMAN, "c-self");
  assert.deepEqual(f.inbox.listAll(), [], "作者是唯一收件人 ⇒ 不产生条目");

  // 非本人作者（agent 代笔）：人类的订阅行不是作者 ⇒ 产生恰一条关注件。
  comment(AGENT, "c-agent");
  const items = f.inbox.listAll();
  assert.equal(items.length, 1, "一条评论恰一条条目");
  const [row0] = items;
  assert.ok(row0);
  assert.equal(row0.kind, "comment_attention");
  assert.equal(row0.severity, "info", "severity 由 repo 从 kind 单源补（不入参）");
  assert.deepEqual(
    f.dedupKeys(),
    ["comment_attention:c-agent"],
    "dedup 形状由构建件单源（读裸列）",
  );
  assert.equal(row0.workItemId, item.id);
  assert.equal(row0.title, "标题 wi-1", "title 是工作项标题");
  assert.deepEqual(row0.detail.recipients, [{ kind: "human", id: HUMAN.id }]);
  assert.deepEqual(row0.detail.author, { kind: "agent", id: AGENT.id });

  // 同一条评论重投（同 clientRequestId ⇒ 既存评论）：条目仍恰一条（dedup 在存储层）。
  const replayed = f.commentService.createComment({
    workspaceKey: CHAIN_WS.key,
    workspacePath: CHAIN_WS.path,
    workItemId: item.id,
    author: AGENT,
    initiatedBy: { kind: "human", id: HUMAN.id },
    body: "改过的正文不该覆盖",
    clientRequestId: "req-c-agent",
  });
  assert.equal(replayed.comment.id, "c-agent", "同 clientRequestId 返回既存评论");
  assert.equal(f.inbox.listAll().length, 1, "重投不得产生第二条（同 dedupKey 被唯一索引拦下）");
});

test("SUB.2 写链｜点名 / 决定 / 冒泡三条路径都落条目；全链零 dispatch、状态零变化", () => {
  const f = chainFixture();
  const parent = ownedItem(f, "wi-p");
  const child = ownedItem(f, "wi-c", parent.id);
  const statusBefore = f.workItems.get(child.id)?.status;

  // (a) 点名：agent 作者 @Bob（名册内的另一个 agent）—— 被点名者 ≠ 作者 ⇒ 点名件。
  f.commentService.createComment({
    id: "c-mention",
    workspaceKey: CHAIN_WS.key,
    workspacePath: CHAIN_WS.path,
    workItemId: child.id,
    author: AGENT,
    initiatedBy: { kind: "human", id: HUMAN.id },
    body: "请 @Bob 看一下",
    clientRequestId: "req-mention",
  });
  const mentionItems = f.inbox.listAll();
  assert.equal(mentionItems.length, 1);
  assert.equal(mentionItems[0]?.kind, "mention_action_required");
  assert.equal(mentionItems[0]?.severity, "action_required");
  assert.deepEqual(mentionItems[0]?.detail.mentioned, [{ kind: "agent", id: LEADER.id }]);
  // 点名评论会留下**既有评论派发链**的 receipt（@agent 触发派发请求，与本卡无关）；通知链自身
  // 不碰 run / 义务 —— 那两张表必须还是零。
  assert.equal(f.countRows("squad_runs"), 0, "零 run");
  assert.equal(f.countRows("squad_run_deferred_dispatches"), 0, "零完成重放义务");

  // 以下两条事实**结构上不派发**（无人点名的评论 / 决定）⇒ 前后快照逐表不动。
  const runsBefore = f.countRows("squad_runs");
  const receiptsBefore = f.countRows("comment_dispatch_receipts");
  const deferredBefore = f.countRows("squad_run_deferred_dispatches");

  // (b) 冒泡：子项自己的活动行只有作者（被排除），而**父项**有非作者订阅者 ⇒ 仍产生条目（收件人经冒泡）。
  f.subscribers.upsertActive({
    workspaceKey: CHAIN_WS.key,
    workspacePath: CHAIN_WS.path,
    workItemId: parent.id,
    subjectType: "human",
    subjectId: "parent-reader",
    reason: "manual",
  });
  f.commentService.createComment({
    id: "c-bubble",
    workspaceKey: CHAIN_WS.key,
    workspacePath: CHAIN_WS.path,
    workItemId: child.id,
    author: AGENT,
    initiatedBy: { kind: "human", id: HUMAN.id },
    body: "子项进展",
    clientRequestId: "req-bubble",
  });
  const afterBubble = f.inbox.listAll();
  assert.equal(afterBubble.length, 2, "冒泡只改收件人集合：条目数按事实增加（不产生第二条）");
  const bubbleItem = afterBubble.find((entry) => entry.detail.commentId === "c-bubble");
  assert.ok(bubbleItem);
  assert.deepEqual(
    bubbleItem.detail.recipients,
    [
      { kind: "agent", id: LEADER.id },
      { kind: "human", id: HUMAN.id },
      { kind: "human", id: "parent-reader" },
    ],
    "收件人 = 本项订阅者 ∪ 父项订阅者：parent-reader 在子项**没有任何行**，只能经冒泡可达",
  );
  assert.equal(
    f.countRows("work_item_subscribers"),
    5,
    "冒泡只读订阅行、不写订阅行（父项的订阅者不会被子项事实复制一份）",
  );

  // (c) 决定：非本人作者 ⇒ decision_required / action_required。
  f.decisionService.createDecision({
    id: "d-1",
    workspaceKey: CHAIN_WS.key,
    workspacePath: CHAIN_WS.path,
    workItemId: child.id,
    kind: "proposal",
    subject: "是否合入",
    author: AGENT,
    initiatedBy: { kind: "human", id: HUMAN.id },
    sourceRequestId: "req-d-1",
  });
  const afterDecision = f.inbox.listAll();
  assert.equal(afterDecision.length, 3);
  const decisionItem = afterDecision.find((entry) => entry.detail.decisionId === "d-1");
  assert.ok(decisionItem);
  assert.equal(decisionItem.severity, "action_required");
  assert.equal(decisionItem.workItemId, child.id);
  assert.deepEqual(
    f.dedupKeys(),
    ["comment_attention:c-bubble", "decision_required:d-1", "mention_action_required:c-mention"],
    "三条事实三个 dedup 形状（读裸列；新增件按 kind 单源）",
  );

  // 零 dispatch：通知链不碰 run / receipt / 义务，也不改状态（通知不是派发：12-11 / §12.1-12）。
  assert.equal(f.countRows("squad_runs"), runsBefore, "零 run");
  assert.equal(f.countRows("comment_dispatch_receipts"), receiptsBefore, "零派发 receipt");
  assert.equal(f.countRows("squad_run_deferred_dispatches"), deferredBefore, "零完成重放义务");
  assert.equal(
    f.workItems.get(child.id)?.status,
    statusBefore,
    "状态零变化（唯一写者仍是 transition）",
  );
});

test("SUB.2 写链｜未注入通知口 ⇒ 零条目（既有行为逐格不变：sink 是可选加法）", () => {
  const f = chainFixture();
  const item = ownedItem(f, "wi-1");
  const bare = createCommentService({
    /* G8：事务口（本文件是既有用例，注入 identity 替身 —— 行为逐字不变；真事务的证据在 commentServiceTransaction.test.ts）。 */
    transact: (fn) => fn(),
    comments: createWorkItemCommentRepo(f.db),
    activities: createWorkItemActivityRepo(f.db),
    receipts: createCommentDispatchReceiptRepo(f.db),
    reactions: createWorkItemCommentReactionRepo(f.db),
    runs: createSquadRunRepo(f.db),
    deferred: createSquadDeferredDispatchRepo(f.db),
    workItems: f.workItems,
    roster: { listAgents: () => [{ id: AGENT.id, name: "Ann" }], listSquads: () => [] },
    readDispatchEnabled: () => true,
  });
  bare.createComment({
    id: "c-bare",
    workspaceKey: CHAIN_WS.key,
    workspacePath: CHAIN_WS.path,
    workItemId: item.id,
    author: AGENT,
    initiatedBy: { kind: "human", id: HUMAN.id },
    body: "没有通知口",
    clientRequestId: "req-bare",
  });
  assert.deepEqual(f.inbox.listAll(), [], "缺省不注入 ⇒ 不产生条目（加法前行为逐字不变）");
});

/* ---------- 结构守卫（源码扫描，去注释）：判据单源 / 零派发 / dedup 单源 / 组合根装配 ---------- */

const SRC_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../src");
const WORKITEM_DIR = resolve(SRC_ROOT, "workitem");
/** 去注释再扫（文件头注释里可能引用这些词作为「不得出现」的说明）。 */
const stripComments = (source: string) =>
  source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
const workitemSource = (name: string) =>
  stripComments(readFileSync(resolve(WORKITEM_DIR, name), "utf8"));

const POLICY_CODE = workitemSource("inboxNotificationPolicy.ts");

test("守卫 H2｜准入 / 收件人解析 / 投递档只在策略模块一处：构建件与两个写服务内零判据", () => {
  for (const name of ["inboxItemProducers.ts", "commentService.ts", "workItemDecisionService.ts"]) {
    const code = workitemSource(name);
    for (const forbidden of [
      "resolveInboxRecipients",
      "planInboxNotificationItem",
      "resolveInboxDeliveryTier",
      "INBOX_SEVERITY_BY_KIND",
      "inbox_only",
    ]) {
      assert.ok(
        !code.includes(forbidden),
        `${name}（去注释）不得出现 ${forbidden}：准入与投递档只有 inboxNotificationPolicy 一处实现，` +
          "写服务只报事实（第二份判据漂移时不报错）",
      );
    }
  }
  // 三个判据函数各只有一处定义。
  const files = readdirSync(WORKITEM_DIR).filter((name) => name.endsWith(".ts"));
  for (const fn of [
    "planInboxNotificationItem",
    "resolveInboxRecipients",
    "resolveInboxDeliveryTier",
  ]) {
    assert.deepEqual(
      files.filter((name) => workitemSource(name).includes(`export function ${fn}(`)),
      ["inboxNotificationPolicy.ts"],
      `${fn} 必须只有一处定义`,
    );
  }
  // severity → kind 的单源映射不得被抄第二份（值只在 repo 声明、策略消费）。
  assert.deepEqual(
    files.filter((name) => workitemSource(name).includes("INBOX_SEVERITY_BY_KIND")),
    ["inboxItemRepo.ts", "inboxNotificationPolicy.ts"],
    "kind→severity 的单源在 repo；策略只**消费**它（不在别处再列一份）",
  );
});

test("守卫 H3｜通知链零派发（结构面）：策略模块不含派发 / 生命周期 / 存储写口", () => {
  for (const forbidden of [
    "publishDispatchRequest",
    "planDispatch",
    "openMemberRun",
    "recordLeaderRun",
    "dispatch_requested",
    "requestedDelivery",
    "squad_runs",
    "comment_dispatch_receipts",
    "transition",
    "updateStatus",
    "insertIfAbsent",
    "db.",
  ]) {
    assert.ok(
      !POLICY_CODE.includes(forbidden),
      `inboxNotificationPolicy.ts（去注释）不得出现 ${forbidden}：` +
        "策略只回答「要不要产生 / 谁收得到」，写库归唯一写收口（inboxItemRepo.insertIfAbsent）",
    );
  }
});

test("守卫 H4｜三新 dedup 形状只在 computeInboxDedupKey 一处：构建件不得自拼第二份", () => {
  const producers = workitemSource("inboxItemProducers.ts");
  const fromFn = producers.slice(producers.indexOf("export function computeInboxDedupKey("));
  const fnBody = fromFn.slice(0, fromFn.indexOf("\n}\n"));
  assert.ok(fnBody.length > 0, "找不到 computeInboxDedupKey 的实现体");
  const outside = producers.replace(fnBody, "");
  for (const prefix of ["mention_action_required:", "decision_required:", "comment_attention:"]) {
    assert.ok(
      fnBody.includes(`\`${prefix}`),
      `${prefix} 的形状必须由唯一形状函数给出（调用方不得自拼）`,
    );
    assert.ok(
      !outside.includes(`\`${prefix}`),
      `${prefix} 在构建件里另拼了一份：拼错不报错，只会表现成「同一件事反复出现」`,
    );
  }
});

test("守卫｜组合根装配：通知口恰一处装配、判据恰一调、写收口恰一次、失败只留痕", () => {
  const nodeSource = stripComments(readFileSync(resolve(SRC_ROOT, "node.ts"), "utf8"));
  const fromFactory = nodeSource.slice(
    nodeSource.indexOf("const createInboxNotificationPortFor = ("),
  );
  const region = fromFactory.slice(0, fromFactory.indexOf("/* C3.1：决定服务的**唯一构造点**"));
  assert.ok(region.length > 0, "找不到组合根的通知口装配段");
  assert.equal(
    [...nodeSource.matchAll(/createInboxNotificationPortFor/g)].length,
    3,
    "装配函数定义一次 + 两个写服务各绑定一次（漏一个 ⇒ 那一半永远不产生条目）",
  );
  assert.ok(region.includes("planInboxNotificationItem("), "判据恰在通知口里调一次");
  assert.equal([...region.matchAll(/planInboxNotificationItem\(/g)].length, 1);
  assert.equal(
    [...region.matchAll(/insertIfAbsent\(/g)].length,
    1,
    "唯一写收口：通知链不得另开写路径（挂接点恰一处）",
  );
  assert.ok(
    region.includes("subscriberRepo.listByWorkItem("),
    "订阅行读口绑定到 SUB.1 的唯一存储面",
  );
  assert.ok(
    region.includes("workItemRepo.get("),
    "父链读口绑定到工作项树（归档行被 get 过滤 ⇒ 上溯自然停下）",
  );
  assert.ok(
    region.includes("try {") &&
      region.includes("catch (error)") &&
      region.includes("squadRuntimeLog.warn("),
    "失败只留痕：条目是派生投影，抛出会把一次成功的评论/决定翻转成响亮失败",
  );
});
