import assert from "node:assert/strict";
import test from "node:test";
import type {
  WorkItemActivityKind,
  WorkItemActivityRecord,
  WorkItemCommentRecord,
  WorkItemDecisionRecord,
} from "@zcode/services";
import { WORK_ITEM_ACTIVITY_KINDS, type AuthorRef, type SquadSnapshot } from "@zcode/services";
import type { Squad, TeamAgent, WorkItem } from "@zcode/shared";
import { SUBAGENT_COLOR_CLASS } from "../src/lib/subagentColors.js";
import {
  activeMentionQuery,
  buildMentionMenu,
  mentionOptionInsertText,
  moveMentionSelection,
} from "../src/squad/workItemMentionViewModel.js";
import {
  buildWorkItemTimelineEntries,
  commentDisplayBody,
  commentIndentLevel,
  draftHasNotePrefix,
  groupCommentReactions,
  indexWorkItemComments,
  projectMention,
  toggleNotePrefix,
  WORK_ITEM_ACTIVITY_KIND_MESSAGE_IDS,
  workItemDetailAssigneeLabel,
} from "../src/squad/workItemCollaborationViewModel.js";

/* B5.1 轮 1：混排时间线投影 `buildWorkItemTimelineEntries` 的逐格用例（ui 包无渲染设施，
   判据留在纯函数上、由 node:test 钉住 —— 本项目的既定做法，见 workItemsPage.test.ts）。

   设计案 §2.2 的六条排序/混排纪律逐条对应到本文件的断言：
   ① sequence 主序（含「sequence 顺序 ≠ occurredAt 顺序」的错序夹具）；
   ② 评论经它的 comment_created 占位，回复按各自锚位出现；
   ③ comment_* 的其余六枚 kind 不另生成主条目；
   ④ Decision 经 decision_created 占位；
   ⑤ 缺锚 ⇒ link-error 条目且其他条目保留；
   ⑥ 与评论同 id 的多枚 Activity 只产生 1 条评论条目；未知 kind ⇒ 抛（不猜标签）。 */

const HUMAN = { kind: "human" as const, id: "hu-1" };

function comment(id: string, parentCommentId: string | null = null): WorkItemCommentRecord {
  return {
    id,
    workspaceKey: "ws",
    workspacePath: "/w",
    workItemId: "wi-1",
    threadId: parentCommentId ?? id,
    parentCommentId,
    author: HUMAN,
    sourceRun: null,
    initiatedBy: HUMAN,
    body: `body ${id}`,
    normalizedBody: `body ${id}`,
    mentions: [],
    command: "none",
    inline: null,
    clientRequestId: null,
    revision: 1,
    deletedAt: null,
    resolvedAt: null,
    createdAt: 1,
    updatedAt: 1,
  };
}

function decision(id: string): WorkItemDecisionRecord {
  return {
    id,
    workspaceKey: "ws",
    workspacePath: "/w",
    workItemId: "wi-1",
    threadId: null,
    parentDecisionId: null,
    author: HUMAN,
    sourceRunId: null,
    initiatedBy: HUMAN,
    kind: "accepted",
    subject: `subject ${id}`,
    selection: {},
    rationale: null,
    evidence: [],
    effectiveAt: 1,
    dedupKey: `dk-${id}`,
    createdAt: 1,
    updatedAt: 1,
  };
}

let activityCounter = 0;
function activity(
  id: string,
  kind: WorkItemActivityKind,
  options: { sequence?: number; occurredAt?: number; commentId?: string; decisionId?: string } = {},
): WorkItemActivityRecord {
  activityCounter += 1;
  return {
    id,
    workspaceKey: "ws",
    workspacePath: "/w",
    workItemId: "wi-1",
    kind,
    sequence: options.sequence ?? activityCounter,
    occurredAt: options.occurredAt ?? 1000 + activityCounter,
    actor: HUMAN,
    sourceRun: null,
    initiatedBy: HUMAN,
    commentId: options.commentId ?? null,
    decisionId: options.decisionId ?? null,
    dispatchEventId: null,
    payload: {},
    dedupKey: `dk-${id}`,
    createdAt: 1,
    updatedAt: 1,
  };
}

/** 条目摘要（断言只看形状与次序，不看 payload）。 */
function summary(entry: ReturnType<typeof buildWorkItemTimelineEntries>[number]) {
  switch (entry.kind) {
    case "comment":
      return `comment:${entry.comment.id}`;
    case "decision":
      return `decision:${entry.decision.id}`;
    case "system":
      return `system:${entry.activity.kind}:${entry.activity.id}`;
    case "link-error":
      return `link-error:${entry.subject}:${entry.id}`;
  }
}

test("时间线：空输入 ⇒ 空条目（不造任何占位）", () => {
  assert.deepEqual(
    buildWorkItemTimelineEntries({ comments: [], activities: [], decisions: [] }),
    [],
  );
});

test("时间线：主序 = 输入（repo 的 sequence 口径）——不按 occurredAt 重排", () => {
  // 三条系统的 occurredAt 与 sequence 反序（补偿事件形态）；按 occurredAt 排会得到 a2/a3/a1。
  const entries = buildWorkItemTimelineEntries({
    comments: [],
    decisions: [],
    activities: [
      activity("a1", "run_started", { sequence: 1, occurredAt: 900 }),
      activity("a2", "run_completed", { sequence: 2, occurredAt: 100 }),
      activity("a3", "status_changed", { sequence: 3, occurredAt: 500 }),
    ],
  });
  assert.deepEqual(entries.map(summary), [
    "system:run_started:a1",
    "system:run_completed:a2",
    "system:status_changed:a3",
  ]);
  assert.deepEqual(
    entries.map((entry) => entry.sequence),
    [1, 2, 3],
  );
});

test("时间线：评论经 comment_created 占位；同评论的其余六枚 kind 不另生成主条目", () => {
  const entries = buildWorkItemTimelineEntries({
    comments: [comment("c-1", null), comment("c-2", "c-1")],
    decisions: [],
    activities: [
      activity("a1", "comment_created", { sequence: 1, commentId: "c-1" }),
      activity("a2", "comment_mention_parsed", { sequence: 2, commentId: "c-1" }),
      activity("a3", "comment_dispatch_requested", { sequence: 3, commentId: "c-1" }),
      activity("a4", "comment_created", { sequence: 4, commentId: "c-2" }),
      activity("a5", "comment_reaction_added", { sequence: 5, commentId: "c-2" }),
      activity("a6", "comment_resolved", { sequence: 6, commentId: "c-1" }),
      activity("a7", "comment_deleted", { sequence: 7, commentId: "c-2" }),
      activity("a8", "comment_dispatch_suppressed", { sequence: 8, commentId: "c-1" }),
    ],
  });
  assert.deepEqual(
    entries.map(summary),
    ["comment:c-1", "comment:c-2"],
    "一条 @agent 评论不是三条相同的视觉事件：附属 kind 只投影到该评论的状态/注记",
  );
  assert.deepEqual(
    entries.map((entry) => entry.sequence),
    [1, 4],
    "评论条目占各自 comment_created 的位置",
  );
});

test("时间线：Decision 经 decision_created 占位，与评论/系统事实混排在一条列表里", () => {
  const entries = buildWorkItemTimelineEntries({
    comments: [comment("c-1")],
    decisions: [decision("d-1")],
    activities: [
      activity("a1", "comment_created", { sequence: 1, commentId: "c-1" }),
      activity("a2", "decision_created", { sequence: 2, decisionId: "d-1" }),
      activity("a3", "wake_rule_fired", { sequence: 3 }),
    ],
  });
  assert.deepEqual(entries.map(summary), [
    "comment:c-1",
    "decision:d-1",
    "system:wake_rule_fired:a3",
  ]);
});

test("时间线：锚定 Activity 指向不存在的评论 ⇒ 该位置一条 link-error，其他条目保留", () => {
  const entries = buildWorkItemTimelineEntries({
    comments: [comment("c-1")],
    decisions: [],
    activities: [
      activity("a1", "comment_created", { sequence: 1, commentId: "c-1" }),
      activity("a2", "comment_created", { sequence: 2, commentId: "c-missing" }),
      activity("a3", "run_failed", { sequence: 3 }),
    ],
  });
  assert.deepEqual(entries.map(summary), [
    "comment:c-1",
    "link-error:comment:c-missing",
    "system:run_failed:a3",
  ]);
});

test("时间线：评论没有任何锚定 Activity ⇒ 尾部 link-error（不用本地时间强插主序）", () => {
  const entries = buildWorkItemTimelineEntries({
    comments: [comment("c-orphan")],
    decisions: [decision("d-orphan")],
    activities: [activity("a1", "run_started", { sequence: 1 })],
  });
  assert.deepEqual(entries.map(summary), [
    "system:run_started:a1",
    "link-error:comment:c-orphan",
    "link-error:decision:d-orphan",
  ]);
  assert.deepEqual(
    entries.slice(1).map((entry) => entry.sequence),
    [null, null],
    "无锚实体没有 sequence 可占用（sequence=null 明说「位置不可知」）",
  );
});

test("时间线：闭集外的 kind ⇒ 抛（不猜标签、不静默当系统事实）", () => {
  const bogus = {
    ...activity("a1", "run_started"),
    kind: "inbox_item_raised" as WorkItemActivityKind,
  };
  assert.throws(
    () => buildWorkItemTimelineEntries({ comments: [], decisions: [], activities: [bogus] }),
    /inbox_item_raised/,
  );
});

/* ---------- commentDisplayBody / commentIndentLevel / groupCommentReactions ---------- */

function reaction(
  id: string,
  commentId: string,
  emoji: string,
  createdAt: number,
  author: AuthorRef = HUMAN,
) {
  return { id, workspaceKey: "ws", commentId, author, emoji, createdAt };
}

test("正文投影：normalizedBody 非空 ⇒ 优先（不把 /note 前缀当正文）；为空才回落 body", () => {
  const noted = { ...comment("c-1"), body: "/note 原文", normalizedBody: "原文" };
  assert.deepEqual(commentDisplayBody(noted), { kind: "text", text: "原文" });
  const blankNormalized = { ...comment("c-2"), body: "只有原文", normalizedBody: "   " };
  assert.deepEqual(
    commentDisplayBody(blankNormalized),
    { kind: "text", text: "只有原文" },
    "normalized 为空（含全空白）才回落 raw —— 展示永远不重解析 /note",
  );
});

test("正文投影：墓碑 ⇒ deleted 标记且**不返回任何正文**（正文一字不漏）", () => {
  const deleted = {
    ...comment("c-1"),
    body: "原文",
    normalizedBody: "正文",
    deletedAt: 123,
  };
  assert.deepEqual(
    commentDisplayBody(deleted),
    { kind: "deleted" },
    "墓碑分支只给标记：normalized/raw/mentions/reactions 都不渲染（设计案 §3.3）",
  );
});

test("线程缩进：按「根→父」链解析深度（不是按相邻项推断），0..3、≥3 封顶 3", () => {
  const root = comment("c-root");
  const reply1 = comment("c-r1", "c-root");
  const reply2 = comment("c-r2", "c-r1");
  const reply3 = comment("c-r3", "c-r2");
  const reply4 = comment("c-r4", "c-r3");
  const map = indexWorkItemComments([root, reply1, reply2, reply3, reply4]);
  assert.equal(commentIndentLevel(root, map), 0);
  assert.equal(commentIndentLevel(reply1, map), 1);
  assert.equal(commentIndentLevel(reply2, map), 2);
  assert.equal(commentIndentLevel(reply3, map), 3);
  assert.equal(commentIndentLevel(reply4, map), 3, "深度 ≥3 统一呈现为 3（封顶）");
  assert.equal(
    commentIndentLevel(reply3, map),
    3,
    "深度由「根→父」链解析：即使列表里相邻的是别的层，深度也不变",
  );
});

test("线程缩进：父链不可解析 / 自成环 ⇒ 不猜深度、不死循环", () => {
  const orphan = comment("c-orphan", "c-missing");
  assert.equal(commentIndentLevel(orphan, indexWorkItemComments([orphan])), 0);
  const a = comment("a", "b");
  const b = comment("b", "a");
  const cycles = indexWorkItemComments([a, b]);
  assert.equal(commentIndentLevel(a, cycles), 1, "环在第二次遇到时停（不无限深）");
});

test("reaction 汇总：按 emoji 聚合、按首次回应时间稳定排序、count 正确", () => {
  const reactions = [
    reaction("r-3", "c-1", "🎉", 50),
    reaction("r-1", "c-1", "👍", 10),
    reaction("r-2", "c-1", "👍", 30, { kind: "agent", id: "ag-1" }),
  ];
  assert.deepEqual(
    groupCommentReactions(reactions, null).map((group) => [
      group.emoji,
      group.count,
      group.firstAt,
    ]),
    [
      ["👍", 2, 10],
      ["🎉", 1, 50],
    ],
    "排序按首次回应时间（输入乱序也稳定），不是按 emoji 字典序",
  );
  assert.deepEqual(groupCommentReactions([], null), []);
});

test("reaction 汇总：viewer 为 null ⇒ mine 不可判定（null，界面不得渲染 aria-pressed）", () => {
  const reactions = [reaction("r-1", "c-1", "👍", 10)];
  assert.equal(groupCommentReactions(reactions, null)[0]?.mine, null);
  assert.equal(
    groupCommentReactions(reactions, { kind: "human", id: "hu-9" })[0]?.mine,
    false,
    "名册/本地人类身份缺席时不得假装「不是我」——只有给了 viewer 才判 false",
  );
  assert.equal(groupCommentReactions(reactions, { kind: "human", id: "hu-1" })[0]?.mine, true);
});

/* ---------- projectMention / 指派文案 / Activity kind 穷尽映射 ---------- */

function agent(id: string, name: string, color?: "red" | "blue"): TeamAgent {
  return {
    id,
    name,
    ...(color === undefined ? {} : { color }),
    systemPrompt: "",
    skills: [],
    memoryScope: "user",
    enabled: true,
  };
}

function squad(id: string, name: string, leaderAgentId: string): Squad {
  return {
    id,
    name,
    leaderAgentId,
    members: [{ agentId: leaderAgentId }],
    instructions: {},
    enabled: true,
  };
}

const ROSTER = {
  agents: [agent("ag-1", "阿尔法", "blue"), agent("ag-2", "贝塔")],
  squads: [squad("sq-1", "侦察队", "ag-1")],
};

test("mention 投影：agent 命中名册 ⇒ 名字 + 身份色点 + 可链接（色点是身份，不编码状态）", () => {
  const presentation = projectMention({ type: "agent", id: "ag-1" }, ROSTER);
  assert.deepEqual(presentation, {
    kind: "agent",
    id: "ag-1",
    name: "阿尔法",
    colorClass: SUBAGENT_COLOR_CLASS.blue,
    linkable: true,
  });
});

test("mention 投影：名册缺席的 agent ⇒ unresolved 普通文本（不补造颜色/目标）；human 不链接不着色", () => {
  assert.deepEqual(projectMention({ type: "agent", id: "ag-gone" }, ROSTER), {
    kind: "unresolved",
    type: "agent",
    id: "ag-gone",
  });
  // human：类型允许、写者当前不产出 —— 只作**类型完备的防御分支**（普通文本、不链接、不着色）。
  assert.deepEqual(projectMention({ type: "human", id: "someone" }, ROSTER), {
    kind: "human",
    id: "someone",
  });
});

test("mention 投影：squad ⇒ 名字 + 队长后缀来源；@all ⇒ 中性徽标（不映射任何派发状态）", () => {
  assert.deepEqual(projectMention({ type: "squad", id: "sq-1" }, ROSTER), {
    kind: "squad",
    id: "sq-1",
    name: "侦察队",
    leaderName: "阿尔法",
    linkable: true,
  });
  assert.deepEqual(projectMention({ type: "squad", id: "sq-gone" }, ROSTER), {
    kind: "unresolved",
    type: "squad",
    id: "sq-gone",
  });
  const all = projectMention({ type: "all", id: "all" }, ROSTER);
  assert.deepEqual(all, { kind: "all" });
  assert.ok(
    !("outcome" in all) && !("status" in all),
    "@all 是「仅抑制自动路由」的中性徽标，不得携带任何 receipt 状态字段（§3.2 末段）",
  );
});

test("指派文案：复用 resolveAssigneeName 的唯一判据（详情页不写第二份）", () => {
  const item = (assignee: WorkItem["assignee"]): WorkItem => ({
    id: "wi-1",
    workspaceIdentity: "ws",
    workspacePath: "/w",
    title: "t",
    body: "",
    status: "todo",
    assignee,
    labels: [],
    properties: {},
    position: 0,
  });
  const snapshot = { teamAgents: ROSTER.agents, squads: ROSTER.squads } as unknown as SquadSnapshot;
  assert.equal(workItemDetailAssigneeLabel(item({ type: "agent", id: "ag-2" }), snapshot), "贝塔");
  assert.equal(
    workItemDetailAssigneeLabel(item({ type: "squad", id: "sq-1" }), snapshot),
    "侦察队",
  );
  assert.equal(
    workItemDetailAssigneeLabel(item({ type: "user", id: "u" }), snapshot),
    null,
    "user 型返回 null（文案由界面用 squad.common.assignee.user 补）",
  );
  assert.equal(
    workItemDetailAssigneeLabel(item({ type: "squad", id: "sq-gone" }), snapshot),
    "sq-gone",
    "名册查不到 ⇒ 回落 id（与看板同一口径）",
  );
});

test("Activity kind 映射：key 集合 == 服务面运行时闭集（deepEqual，不硬编码 18）", () => {
  assert.deepEqual(
    Object.keys(WORK_ITEM_ACTIVITY_KIND_MESSAGE_IDS).sort(),
    [...WORK_ITEM_ACTIVITY_KINDS].sort(),
  );
  for (const [kind, messageId] of Object.entries(WORK_ITEM_ACTIVITY_KIND_MESSAGE_IDS)) {
    assert.ok(
      messageId.startsWith("squad.workItemDetail.activity.kind."),
      `${kind} 的文案键必须落在详情页命名空间`,
    );
  }
});

/* ---------- @ 补全菜单（workItemMentionViewModel） ---------- */

function expectAllOption() {
  return {
    key: "all",
    type: "all" as const,
    id: "all",
    name: "@all",
    insertText: "@all",
    ambiguous: false,
    hintMessageId: "squad.workItemDetail.mention.allHint",
  };
}

const MENU_ROSTER = {
  agents: [agent("ag-1", "阿尔法", "blue"), agent("ag-2", "贝塔"), agent("ag-3", "贝塔")],
  squads: [squad("sq-1", "侦察队", "ag-1")],
};

test("@ 菜单：名册不可用 ⇒ rosterUnavailable（不得静默不出菜单）", () => {
  assert.deepEqual(buildMentionMenu({ roster: null, query: "" }), { kind: "rosterUnavailable" });
});

test("@ 菜单：候选 = 名册快照（agent 先、squad 后），@all 恒定置底并带「仅抑制自动路由」说明", () => {
  const model = buildMentionMenu({ roster: MENU_ROSTER, query: "" });
  assert.equal(model.kind, "ready");
  assert.deepEqual(
    model.kind === "ready"
      ? model.options.map((option) => [option.key, option.type, option.ambiguous])
      : [],
    [
      ["agent:ag-1", "agent", false],
      ["agent:ag-2", "agent", true],
      ["agent:ag-3", "agent", true],
      ["squad:sq-1", "squad", false],
      ["all", "all", false],
    ],
    "重名 agent 各自成项且标 ambiguous（不自动选取）；@all 永远最后",
  );
  const all = model.kind === "ready" ? model.options.at(-1) : undefined;
  assert.equal(all?.hintMessageId, "squad.workItemDetail.mention.allHint");
});

test("@ 菜单：query 按名称前缀过滤（大小写不敏感）；过滤后 @all 仍在底部", () => {
  const model = buildMentionMenu({ roster: MENU_ROSTER, query: "侦察" });
  assert.deepEqual(model.kind === "ready" ? model.options.map((option) => option.key) : [], [
    "squad:sq-1",
    "all",
  ]);
  assert.deepEqual(
    buildMentionMenu({ roster: MENU_ROSTER, query: "zzz" }).kind === "ready"
      ? buildMentionMenu({ roster: MENU_ROSTER, query: "zzz" })
      : null,
    { kind: "ready", options: [expectAllOption()] },
    "没有任何名字命中时只留 @all（它是恒定项，不是搜索命中）",
  );
});

test("@ 菜单：重名项不可插入（返回 null），其余插入 `@名称`", () => {
  const model = buildMentionMenu({ roster: MENU_ROSTER, query: "" });
  const options = model.kind === "ready" ? model.options : [];
  const ambiguous = options.find((option) => option.key === "agent:ag-2")!;
  assert.equal(mentionOptionInsertText(ambiguous), null, "重名 ⇒ 不插入会触发的 mention");
  assert.equal(ambiguous.ambiguous, true);
  assert.equal(
    mentionOptionInsertText(options.find((option) => option.key === "agent:ag-1")!),
    "@阿尔法",
  );
  assert.equal(mentionOptionInsertText(options.find((option) => option.key === "all")!), "@all");
});

test("@ 菜单：↑↓ 选择在候选内环绕（Escape/Enter 的语义由组件承担，索引算术在这里）", () => {
  assert.equal(moveMentionSelection(0, 1, 3), 1);
  assert.equal(moveMentionSelection(2, 1, 3), 0, "到底再按 ↓ 回到第一条（环绕）");
  assert.equal(moveMentionSelection(0, -1, 3), 2, "在第一条按 ↑ 到末尾");
  assert.equal(moveMentionSelection(1, 1, 0), -1, "空候选 ⇒ -1（没有可选项，界面不选中任何项）");
});

test("@ 菜单：激活查询串 = 末尾未闭合的 `@token`（含空格/换行即不激活；`@` 在词中出现不激活）", () => {
  assert.deepEqual(activeMentionQuery(""), null);
  assert.deepEqual(activeMentionQuery("普通正文"), null);
  assert.deepEqual(activeMentionQuery("请看 @"), { query: "" });
  assert.deepEqual(activeMentionQuery("请看 @阿尔"), { query: "阿尔" });
  assert.deepEqual(activeMentionQuery("第一行\n第二行 @beta"), { query: "beta" });
  assert.deepEqual(
    activeMentionQuery("mail@example.com"),
    null,
    "邮箱里的 @ 不是提及入口（前面是词字符）",
  );
  assert.deepEqual(activeMentionQuery("@a b"), null, "空格已结束这个 token");
  assert.deepEqual(activeMentionQuery("@a\nb"), null, "换行同理");
});

/* ---------- /note 显式模式（设计案 §4.3）---------- */

test("/note 模式：开启在草稿开头插入 `/note `，关闭只移除**自己插入的**开头前缀", () => {
  assert.equal(draftHasNotePrefix("/note 原文"), true);
  assert.equal(draftHasNotePrefix("/notes 不是命令"), false);
  assert.equal(toggleNotePrefix("原文", true), "/note 原文");
  assert.equal(toggleNotePrefix("/note 原文", false), "原文");
  assert.equal(toggleNotePrefix("原文", false), "原文", "关闭一个本来没有前缀的草稿 ⇒ 一字不动");
  assert.equal(toggleNotePrefix("/note", false), "", "只有裸前缀 ⇒ 清空前缀");
});

test("/note 模式：手工输入 /note 与开关同步（前缀为准，不依赖开关自己记住）", () => {
  assert.equal(draftHasNotePrefix("/note"), true, "裸 `/note` 也算开启（用户手打的）");
  assert.equal(
    toggleNotePrefix("/note", true),
    "/note ",
    "已是开启态再点开启 ⇒ 只补一个空格，不重复插入前缀",
  );
});
