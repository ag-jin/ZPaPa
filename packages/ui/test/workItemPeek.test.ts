import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import type {
  AuthorRef,
  SquadSnapshot,
  WorkItemActivityKind,
  WorkItemActivityRecord,
  WorkItemCollaborationRead,
  WorkItemCommentRecord,
  WorkItemDecisionRecord,
} from "@zcode/services";
import type { WorkItem } from "@zcode/shared";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ZCodeIntlProvider } from "../src/i18n/IntlProvider.js";
import zhCN from "../src/i18n/locales/zh-CN.js";
import enUS from "../src/i18n/locales/en-US.js";
import { ServiceProvider } from "../src/hooks/useServices.js";
import type { IServiceAccessor } from "@zcode/services";
import {
  WORK_ITEM_COLLABORATION_IDLE,
  collaborationLoadFailed,
  collaborationLoadStarted,
  collaborationLoadSucceeded,
  type WorkItemCollaborationState,
} from "../src/squad/useWorkItemCollaboration.js";
import { WorkItemPeek, WorkItemPeekContent } from "../src/squad/WorkItemPeek.js";
import { WorkItemsSurface } from "../src/squad/WorkItemsSurface.js";
import { workItemSurfaceDefaultState } from "../src/squad/workItemSurfaceViewModel.js";
import type { WorkItemSurfaceViewport } from "../src/squad/workItemResponsiveViewModel.js";
import { WORK_ITEM_ACTIVITY_KIND_MESSAGE_IDS } from "../src/squad/workItemCollaborationViewModel.js";
import {
  WORK_ITEM_PEEK_ACTIVITY_LIMIT,
  workItemPeekActivityLines,
  workItemPeekKeyIntent,
  workItemPeekView,
} from "../src/squad/workItemPeekViewModel.js";

/* 「侧边 peek」（阶段三 · T-P3-R2）的**判据 + 呈现 + 结构守卫**。

   期望值的独立真源：任务卡 T-P3-R2 的验收 1-4（同一读模型 / 无写调用 / Esc·点击外部关闭 + 焦点回到
   触发行 / 桌面分栏形态）+ UI Events 规范的键值（`Escape`，不是 `Esc`）+ 既有的协作读模型状态机
   （`useWorkItemCollaboration` 的四态：idle/loading/ready(±null)/failed）。断言里的字面量**不按
   实现重算**：每条结构守卫都写明变异方式，交付报告里逐条实测。

   peek 的**内容**来自协作读模型 `WorkItemCollaborationRead`（与详情页**同一份**取数实现
   `useWorkItemCollaboration`，见 ⑦ 的单源守卫）——peek 只做投影与呈现，不做第二份取数、不做任何写。

   2026-10-09 口径变更（用户裁定「点击进详情页，预览先下线」）：面板组件**保留**（后续升级完整
   可编辑面板的底子），但**挂载整体摘除**（宿主不再持有打开态 / 分栏壳 / Esc 键盘层 / 焦点归还，
   行环境也不再接受 peek 预览意图）。因此本文件 ①-⑦ 的组件级判据照旧，⑧ 改成**下线口径**：
   宿主两档都零 peek 节点、点击一律走详情页导航、全树无 peek 预览意图通道（变异 M1/M2 逐条实测）。 */

const SRC_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "../src");
const readSource = (relativePath: string) => readFileSync(resolve(SRC_DIR, relativePath), "utf8");
/** 去掉注释再扫：注释里提到写方法名 / 取数函数是**说明**，不是代码本身。 */
const stripComments = (source: string) =>
  source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

/** 取某个 testid 所在元素的**开标签**（`<... data-testid="x" ...>`）：用来断言属性而不是全文。 */
function openTag(markup: string, testId: string): string {
  const marker = markup.indexOf(`data-testid="${testId}"`);
  assert.ok(marker >= 0, `markup 里必须有 ${testId}`);
  return markup.slice(markup.lastIndexOf("<", marker), markup.indexOf(">", marker) + 1);
}

/** 取本语词条（缺键 ⇒ 响亮失败）：`locale[key]` 在 `noUncheckedIndexedAccess` 下是 `string | undefined`。 */
function zhText(key: string): string {
  const value = zhCN[key];
  assert.ok(value, `zh-CN 缺键 ${key}`);
  return value;
}

function enText(key: string): string {
  const value = enUS[key];
  assert.ok(value, `en-US 缺键 ${key}`);
  return value;
}

// ---------- ① 键位判据（验收 3：Esc 关闭） ----------

/* 变异：把判据写成 `key === "Esc"`（旧 IE/自造词，现代浏览器事件里永远不等于）⇒ 第一条必红；
   顺手把别的键也吃成关闭（例如 `key.length === 1`）⇒ 后两条必红。 */
test("键位：Escape ⇒ 关闭；其余键一律不吃（判据只此一处）", () => {
  assert.equal(workItemPeekKeyIntent("Escape"), "close", "UI Events 规范的键值就是 Escape");
  for (const key of ["Esc", "Enter", " ", "j", "k", "ArrowDown", "Tab"]) {
    assert.equal(workItemPeekKeyIntent(key), "none", `「${key}」不得关闭 peek`);
  }
});

// ---------- ② 读模型状态 → 面板视图（验收 1 的呈现侧：同一读模型、三格失败域分开） ----------

/** 协作读模型的最小夹具：这些用例只判「走哪一支」，故只给分支会读到的字段。 */
function readOf(id: string): WorkItemCollaborationRead {
  return {
    workItem: { id, title: `标题 ${id}` },
  } as unknown as WorkItemCollaborationRead;
}

/* 变异（承重）：换条目时把**上一条**的读结果也当成当前条目渲染（去掉 id 比对）⇒ 第五条必红 ——
   旧数据出现在新条目名下是静默错位（界面上没有任何错误可看）。 */
test("视图映射：idle/loading ⇒ 加载中；failed ⇒ 失败；ready(null) ⇒ 不存在；ready ⇒ 内容", () => {
  const requested = "wi-1";
  assert.deepEqual(
    workItemPeekView(WORK_ITEM_COLLABORATION_IDLE, requested),
    { kind: "loading" },
    "还没选中/取数中 ⇒ 加载态",
  );
  assert.deepEqual(
    workItemPeekView(collaborationLoadStarted(WORK_ITEM_COLLABORATION_IDLE), requested),
    { kind: "loading" },
  );
  assert.deepEqual(
    workItemPeekView(collaborationLoadFailed(WORK_ITEM_COLLABORATION_IDLE, "读失败"), requested),
    { kind: "failed", error: "读失败" },
    "整体读失败 ⇒ 失败态（原因原样带出，不吞）",
  );
  assert.deepEqual(
    workItemPeekView(
      collaborationLoadSucceeded(collaborationLoadStarted(WORK_ITEM_COLLABORATION_IDLE), null),
      requested,
    ),
    { kind: "missing" },
    "读回 null = 本条不存在（与「读失败」是两件事：not-found 不是故障）",
  );
  const read = readOf(requested);
  assert.deepEqual(
    workItemPeekView(
      collaborationLoadSucceeded(collaborationLoadStarted(WORK_ITEM_COLLABORATION_IDLE), read),
      requested,
    ),
    { kind: "ready", read },
  );
});

test("视图映射：换条目时上一条的读结果不得当成当前条目（按加载中呈现）", () => {
  const previous = readOf("wi-old");
  const state: WorkItemCollaborationState = collaborationLoadStarted(
    collaborationLoadSucceeded(collaborationLoadStarted(WORK_ITEM_COLLABORATION_IDLE), previous),
  );
  assert.equal(state.status, "ready", "夹具前提：刷新态的读模型里仍是上一条的数据");
  assert.deepEqual(
    workItemPeekView(state, "wi-new"),
    { kind: "loading" },
    "上一条的标题/标签画在新条目名下是静默错位（不报错，只显示错东西）",
  );
  assert.deepEqual(
    workItemPeekView(state, "wi-old"),
    { kind: "ready", read: previous },
    "同一条目的刷新态照常可读（旧数据不清空 —— 状态机既有纪律）",
  );
});

// ---------- ③ 最近活动摘要（卡面：概览 + 属性 + 标签 + **最近活动摘要**） ----------

const HUMAN: AuthorRef = { kind: "human", id: "hu-1" };
const AGENT: AuthorRef = { kind: "agent", id: "ta-1", displayName: "队员" };

let activityCounter = 0;
function activity(
  id: string,
  kind: WorkItemActivityKind,
  over: { commentId?: string; decisionId?: string; actor?: AuthorRef } = {},
): WorkItemActivityRecord {
  activityCounter += 1;
  return {
    id,
    workspaceKey: "ws",
    workspacePath: "/w",
    workItemId: "wi-1",
    kind,
    sequence: activityCounter,
    occurredAt: 1000 + activityCounter,
    actor: over.actor ?? HUMAN,
    sourceRun: null,
    initiatedBy: HUMAN,
    commentId: over.commentId ?? null,
    decisionId: over.decisionId ?? null,
    dispatchEventId: null,
    payload: {},
    dedupKey: `dk-${id}`,
    createdAt: 1,
    updatedAt: 1,
  } as WorkItemActivityRecord;
}

function comment(id: string, bodyLine: string, deleted = false): WorkItemCommentRecord {
  return {
    id,
    workspaceKey: "ws",
    workspacePath: "/w",
    workItemId: "wi-1",
    threadId: id,
    parentCommentId: null,
    author: AGENT,
    sourceRun: null,
    initiatedBy: HUMAN,
    body: `原文 ${bodyLine}`,
    normalizedBody: `${bodyLine}\n第二行不该进摘要`,
    mentions: [],
    command: "none",
    inline: null,
    clientRequestId: null,
    revision: 1,
    deletedAt: deleted ? 9 : null,
    resolvedAt: null,
    createdAt: 1,
    updatedAt: 1,
  } as WorkItemCommentRecord;
}

function decision(id: string, subject: string): WorkItemDecisionRecord {
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
    subject: `${subject}\n第二行不该进摘要`,
    selection: {},
    rationale: null,
    evidence: [],
    effectiveAt: 1,
    dedupKey: `dk-${id}`,
    createdAt: 1,
    updatedAt: 1,
  } as WorkItemDecisionRecord;
}

/* 变异：摘要取**头部** N 条（而不是主序尾部 —— 最近的活动在尾部）⇒ 第一条必红；把上限去掉
   （整条时间线搬进 peek）⇒ 第二条必红。 */
test("摘要：取主序**尾部** N 条（最近几条），次序与时间线同序（不另造序）", () => {
  const activities = [
    activity("a1", "run_started"),
    activity("a2", "run_completed"),
    activity("a3", "status_changed"),
    activity("a4", "assignee_changed"),
    activity("a5", "worktree_created"),
    activity("a6", "worktree_merged"),
    activity("a7", "run_failed"),
  ];
  const lines = workItemPeekActivityLines({ comments: [], activities, decisions: [] });
  assert.equal(WORK_ITEM_PEEK_ACTIVITY_LIMIT, 5, "摘要条数（轻量速览 ≠ 完整时间线；卡面最小口径）");
  assert.deepEqual(
    lines.map((line) => line.key),
    ["activity:a3", "activity:a4", "activity:a5", "activity:a6", "activity:a7"],
    "主序的最后 5 条，且保持升序（与详情页时间线同一份投影、同一种次序）",
  );
  assert.deepEqual(
    lines.map((line) => line.messageId),
    ["a3", "a4", "a5", "a6", "a7"].map(
      (id) => WORK_ITEM_ACTIVITY_KIND_MESSAGE_IDS[activities[Number(id.slice(1)) - 1]!.kind],
    ),
    "每条用**既有**的活动 kind 文案（不新造一套摘要词汇）",
  );
});

test("摘要：空输入 ⇒ 空（不造占位条目）", () => {
  assert.deepEqual(workItemPeekActivityLines({ comments: [], activities: [], decisions: [] }), []);
});

/* 变异：评论摘要直接用 `comment.body`（绕过墓碑判据）⇒ 第二条必红（墓碑正文泄漏）；
   取整段正文而不是首行 ⇒ 第一/三条必红。 */
test("摘要：评论 = 作者 + 「创建了评论」+ 首行正文；墓碑只给标记（不漏正文）", () => {
  const lines = workItemPeekActivityLines({
    comments: [comment("c1", "第一行正文"), comment("c2", "删掉的正文", true)],
    activities: [
      activity("a1", "comment_created", { commentId: "c1" }),
      activity("a2", "comment_created", { commentId: "c2" }),
    ],
    decisions: [],
  });
  assert.deepEqual(lines[0], {
    key: "comment:c1",
    messageId: WORK_ITEM_ACTIVITY_KIND_MESSAGE_IDS.comment_created,
    text: "第一行正文",
    actorLabel: "队员",
  });
  assert.equal(lines[1]!.text, null, "墓碑评论不得把正文带进摘要（commentDisplayBody 的既有纪律）");
  assert.equal(lines[1]!.actorLabel, "队员", "墓碑仍显示作者（是谁说的这件事是公开事实）");
});

test("摘要：决定 = 作者 + 「记录了决定」+ 事项首行；缺锚（不可用关联）如实标出", () => {
  const lines = workItemPeekActivityLines({
    comments: [],
    activities: [activity("a1", "decision_created", { decisionId: "d1" })],
    decisions: [decision("d1", "用方案甲")],
  });
  assert.deepEqual(lines, [
    {
      key: "decision:d1",
      messageId: WORK_ITEM_ACTIVITY_KIND_MESSAGE_IDS.decision_created,
      text: "用方案甲",
      actorLabel: "hu-1",
    },
  ]);
  const orphan = workItemPeekActivityLines({
    comments: [comment("c-orphan", "没有锚")],
    activities: [],
    decisions: [],
  });
  assert.deepEqual(orphan, [
    {
      key: "link-error:comment:c-orphan",
      messageId: "squad.workItemDetail.activity.linkUnavailable",
      text: null,
      actorLabel: null,
    },
  ]);
});

// ---------- ④ 面板呈现（概览 + 属性 + 标签 + 最近活动摘要 + 打开完整详情页） ----------

function wi(over: Partial<WorkItem> = {}): WorkItem {
  return {
    id: "wi-1",
    workspaceIdentity: "ws",
    workspacePath: "/w/a",
    title: "批根标题",
    body: "",
    status: "in_progress",
    assignee: { type: "user", id: "user" },
    labels: [],
    properties: {},
    position: 0,
    ...over,
  };
}

function snapshotWith(workItems: WorkItem[]): SquadSnapshot {
  return {
    enabled: true,
    teamAgents: [
      {
        id: "ta-1",
        name: "队员",
        systemPrompt: "s",
        skills: [],
        memoryScope: "project",
        enabled: true,
      },
    ] as SquadSnapshot["teamAgents"],
    squads: [],
    workItems,
    runs: [],
    queuedRuns: [],
  };
}

function readFixture(over: {
  workItem?: Partial<WorkItem>;
  comments?: WorkItemCommentRecord[];
  activities?: WorkItemActivityRecord[];
  decisions?: WorkItemDecisionRecord[];
}): WorkItemCollaborationRead {
  const workItem = wi(over.workItem);
  return {
    workItem,
    viewerActor: HUMAN,
    comments: over.comments ?? [],
    activities: over.activities ?? [],
    decisions: over.decisions ?? [],
    reactions: [],
    receipts: [],
    subscribers: [],
    deliverables: [],
    pullRequests: [],
    pullRequestProvider: { available: false, reason: null },
    mergeMode: "local",
  } as unknown as WorkItemCollaborationRead;
}

function renderContent(read: WorkItemCollaborationRead): string {
  return renderToStaticMarkup(
    createElement(ZCodeIntlProvider, {
      initialLocale: "zh-CN" as const,
      children: createElement(WorkItemPeekContent, {
        read,
        snapshot: snapshotWith([read.workItem]),
      }),
    }),
  );
}

/* 变异：概览里自己拼 identifier 文本（第二份 `#${seq}`）/ 自己判优先级文案 / 用 `new Date(` 换算
   起止日期 ⇒ 下面第一、二、三条各自必红（单源纪律：identifier 前缀、优先级文案、日期逐字）。 */
test("呈现｜概览：标题 + identifier + 状态 + 优先级 + 指派（全部走既有单源）", () => {
  const markup = renderContent(
    readFixture({
      workItem: {
        identifierSeq: 12,
        priority: "high",
        assignee: { type: "agent", id: "ta-1" },
        title: "批根标题",
      },
    }),
  );
  assert.ok(markup.includes(`data-testid="work-item-peek-title">批根标题<`), "标题是面板的主信息");
  assert.ok(
    markup.includes(`data-testid="work-item-peek-identifier"`) && markup.includes("#12"),
    "identifier 走 workItemIdentifierText（单源拼接 `#12`）",
  );
  assert.ok(markup.includes(zhText("squad.workItems.status.in_progress")), "状态走既有文案");
  assert.ok(
    markup.includes(`data-testid="work-item-peek-priority"`) &&
      markup.includes(zhText("squad.workItems.priority.high")),
    "优先级复用行/概览同一枚徽标组件与穷尽文案",
  );
  assert.ok(
    markup.includes(`data-testid="work-item-peek-assignee"`) &&
      markup.includes("队员") &&
      !markup.includes(zhText("squad.common.assignee.user")),
    "指派走 resolveAssigneeName 单源（智能体 ⇒ 名字，不是「我」）",
  );
});

test("呈现｜属性与标签：有值才画（无值不造空行）、日期逐字、标签全量", () => {
  const full = renderContent(
    readFixture({
      workItem: {
        startDate: "2026-10-08",
        dueDate: "2026-10-20",
        creator: { kind: "human", id: "hu-1", displayName: "小九" },
        labels: ["甲", "乙"],
      },
    }),
  );
  assert.ok(full.includes(`data-testid="work-item-peek-start-date"`), "起始日期有自己的锚点");
  assert.ok(
    full.includes("2026-10-08") && full.includes("2026-10-20"),
    "日历日期逐字呈现（零时刻换算：任何换算都会静默差一天）",
  );
  assert.ok(
    full.includes(`data-testid="work-item-peek-creator"`) &&
      full.includes(zhText("squad.workItems.creator.human")) &&
      full.includes("小九"),
    "创建人 = 种类文案 + 留痕名（workItemCreatorText 单源）",
  );
  assert.equal(
    (full.match(/data-testid="work-item-label"/g) ?? []).length,
    2,
    "标签全量渲染（peek 是速览，不借用行的 3 枚截断）",
  );
  assert.ok(
    full.includes(`data-testid="work-item-peek-labels"`),
    "标签区有自己的锚点（空态在下一段用例里）",
  );

  const bare = renderContent(readFixture({}));
  for (const anchor of [
    "work-item-peek-attributes",
    "work-item-peek-start-date",
    "work-item-peek-due-date",
    "work-item-peek-creator",
    "work-item-peek-properties",
  ]) {
    assert.ok(!bare.includes(anchor), `${anchor} 在无值时整块不渲染（空行是噪音）`);
  }
  assert.ok(
    bare.includes(`data-testid="work-item-peek-labels"`) &&
      bare.includes(zhText("squad.workItemDetail.overview.labelsEmpty")),
    "标签区留一句「无标签」（字段存在但没有值 ≠ 这一块坏了）",
  );
});

/* 变异：把摘要换成整条时间线（不取尾部/不设上限）、或把墓碑正文也放进摘要 ⇒ 第二条必红。 */
test("呈现｜最近活动摘要：标题 + 尾部 N 条 + 墓碑不漏正文；空活动给一句空态", () => {
  const markup = renderContent(
    readFixture({
      comments: [comment("c1", "看完再决定"), comment("c2", "删掉的正文", true)],
      activities: [
        activity("a3", "run_started"),
        activity("a4", "run_completed"),
        activity("a5", "status_changed"),
        activity("a6", "assignee_changed"),
        activity("a1", "comment_created", { commentId: "c1" }),
        activity("a2", "comment_created", { commentId: "c2" }),
      ],
      decisions: [],
    }),
  );
  assert.ok(markup.includes(zhText("squad.workItems.peek.activity")), "活动区标题");
  assert.equal(
    (markup.match(/data-testid="work-item-peek-activity-line"/g) ?? []).length,
    WORK_ITEM_PEEK_ACTIVITY_LIMIT,
    "只画最近 N 条（完整时间线在详情页）",
  );
  assert.ok(markup.includes("看完再决定"), "评论摘要带正文首行");
  assert.ok(!markup.includes("第二行不该进摘要"), "多行正文只取首行（摘要不是整段搬运）");
  assert.ok(!markup.includes("删掉的正文"), "墓碑评论的正文不得出现在摘要里");
  assert.ok(markup.includes("队员"), "摘要行带作者名（谁做的）");

  const empty = renderContent(readFixture({}));
  assert.ok(
    empty.includes(`data-testid="work-item-peek-activity-empty"`) &&
      empty.includes(zhText("squad.workItemDetail.activity.empty")),
    "没有活动 ⇒ 一句空态（复用既有文案，不新造词）",
  );
});

// ---------- ⑥ 文案键（本轮新增恰 4 枚；其余复用既有键，两语成对） ----------

/* 变异：只改一语 / 多新增一枚键（越过卡面「最小集 ≤6」的裁定）/ 复用一枚不存在的键 ⇒ 本用例红。
   复用不是"假设它存在"：复用键也在这里逐枚断言两语齐全（缺一枚 = 界面上出现裸 key）。 */
test("键：本轮新增恰 4 枚且两语成对；复用的既有键两语齐全（无裸 key）", () => {
  const added = [
    "squad.workItems.peek.title",
    "squad.workItems.peek.openDetail",
    "squad.workItems.peek.close",
    "squad.workItems.peek.activity",
  ];
  assert.equal(added.length, 4, "新增键规模（加键 ⇒ 这里必须显式改；卡面上限 6 枚）");
  for (const key of added) {
    const zh = zhText(key);
    const en = enText(key);
    assert.ok(zh.length > 0 && en.length > 0, `${key} 两语都不得为空`);
    assert.equal(
      (zh.match(/\{(\w+)\}/g) ?? []).sort().join(","),
      (en.match(/\{(\w+)\}/g) ?? []).sort().join(","),
      `${key} 的占位符两语必须一致`,
    );
  }
  /* 命名空间集合锁（对齐 R3/R5u 的 deepEqual 形态）：`squad.workItems.peek.*` 下的键集必须逐枚
     等于本轮清单 —— 多 = 越界加键（有测试没跟上的新文案），少 = 用了裸 key。 */
  for (const [name, locale] of [
    ["zh-CN", zhCN],
    ["en-US", enUS],
  ] as const) {
    assert.deepEqual(
      Object.keys(locale)
        .filter((key) => key.startsWith("squad.workItems.peek."))
        .sort(),
      [...added].sort(),
      `${name} 的 peek.* 键集必须与清单逐枚一致（多 = 越界加键，少 = 用了裸 key）`,
    );
  }
  for (const key of [
    "squad.workItemDetail.loading",
    "squad.workItemDetail.loadFailed",
    "squad.workItemDetail.retry",
    "squad.workItemDetail.notFound",
    "squad.workItemDetail.activity.empty",
    "squad.workItemDetail.activity.linkUnavailable",
    "squad.workItemDetail.overview.labels",
    "squad.workItemDetail.overview.labelsEmpty",
    "squad.workItemDetail.overview.properties",
    "squad.workItems.startDate",
    "squad.workItems.dueDate",
    "squad.workItems.creator",
    "squad.workItems.creator.human",
    "squad.workItems.status.in_progress",
    "squad.workItems.priority.high",
    "squad.common.assignee.user",
    "squad.common.archived",
  ]) {
    assert.ok(zhText(key) && enText(key), `复用键 ${key} 必须两语齐全`);
  }
});

// ---------- ⑦ 结构守卫：同一读模型 / 零写调用 / 关闭路径（变异逐条实测） ----------

/* 承重（卡面变异 2）：peek 自建取数（自己调服务、自己拼一次读）⇒ 下面两条都红。 */
test("守卫｜同一读模型：取数只经 useWorkItemCollaboration（全树恰一处取数实现）", () => {
  const peek = stripComments(readSource("squad/WorkItemPeek.tsx"));
  assert.ok(
    peek.includes("useWorkItemCollaboration({"),
    "取数走详情页那一枚 hook（同一状态机 / 同一失败域）",
  );
  for (const forbidden of [
    "resolveWorkItemCollaborationService",
    "useServices",
    "getWorkItemCollaboration(",
  ]) {
    assert.ok(
      !peek.includes(forbidden),
      `peek 不得出现 ${forbidden}（第二份取数 = 两个读模型迟早说不一样的话）`,
    );
  }
  /* 服务包只允许**类型**导入（`import type … from "@zcode/services"`）——值导入意味着拿到了
     服务访问面或服务实现，那是取数/写入的入口。 */
  for (const line of peek.split("\n")) {
    if (!line.includes('"@zcode/services"')) continue;
    assert.ok(
      line.trimStart().startsWith("import type "),
      `peek 只允许类型导入 @zcode/services：${line.trim()}`,
    );
  }
  /* 全树扫描：取数**实现**（`getWorkItemCollaboration(` 调用）只允许在 hook 模块里一处。
     变异：在 peek（或任何新面）里再写一次 `service.getWorkItemCollaboration(...)` ⇒ 必红。 */
  const hook = stripComments(readSource("squad/useWorkItemCollaboration.ts"));
  assert.equal(
    (hook.match(/getWorkItemCollaboration\(/g) ?? []).length,
    1,
    "唯一取数实现仍在 hook 里恰一处",
  );
});

/* 承重（卡面变异 1）：peek 内加评论提交（或任何写入口/写组件）⇒ 下面每一条都能咬住。
   T-P3-R5u 追加：工作项级表情回应的**写**半边（方法 / 可写 hook / 写组件）同样一个都不许出现
   —— 面板里的回应是只读 chip（读 hook 是允许的那一条，见下一条正向断言）。 */
test("守卫｜零写调用：不 import 写方法、不挂任何写组件（peek 只读）", () => {
  const peek = stripComments(readSource("squad/WorkItemPeek.tsx"));
  for (const forbidden of [
    "createWorkItemComment",
    "softDeleteWorkItemComment",
    "setWorkItemCommentResolved",
    "addWorkItemCommentReaction",
    "createWorkItemDecision",
    "setWorkItemSubscription",
    "registerWorkItemDeliverableLink",
    "linkWorkItemPullRequest",
    "unlinkWorkItemPullRequest",
    "refreshWorkItemPullRequests",
    "updateWorkItem",
    "createWorkItem",
    "setWorkItemReaction",
    "runCollaborationAction",
    "WorkItemCommentComposer",
    "WorkItemDecisionRecorder",
    "WorkItemSubscriptionControl",
    "useWorkItemReactions(",
    "WorkItemReactionPicker",
    "<WorkItemReactions",
  ]) {
    assert.ok(
      !peek.includes(forbidden),
      `peek 不得出现 ${forbidden}（写入只在详情页那条唯一执行器）`,
    );
  }
  assert.ok(
    !/onSubmit|onClick=\{[^}]*service/.test(peek),
    "面板里不得有接服务的提交回调（写入入口一个都不给）",
  );
  /* 正向（否则上表可以被「干脆不画回应」空跑通过）：回应经**读** hook 取、以只读 chip 呈现，
     且 chip 组**不传** `onToggle`（传了就丢掉无按钮形态）。 */
  assert.ok(
    peek.includes("useWorkItemReactionRows({") &&
      peek.includes("<WorkItemReactionChips") &&
      !peek.includes("onToggle"),
    "回应的读挂载 = 读 hook + 无 toggle 的 chip 组",
  );
});

test("守卫｜关闭路径三条：Esc 走纯判据、点击外部用 contains 判内外、关闭钮在头部", () => {
  const peek = stripComments(readSource("squad/WorkItemPeek.tsx"));
  assert.ok(
    peek.includes("document.addEventListener(") && peek.includes("removeEventListener("),
    "点击外部：挂 document 级监听，并在卸载时摘掉（不留孤儿监听）",
  );
  assert.ok(
    peek.includes("panelRef.current?.contains(event.target as Node)"),
    "内外判据用 contains（不拼选择器、不比坐标）",
  );
  assert.ok(peek.includes('data-testid="work-item-peek-close"'), "头部有关闭钮");
  /* 口径变更（2026-10-09 用户裁定「点击进详情页，预览先下线」）：宿主不再挂载 peek，也不再接
     那条 Esc 键盘层 —— 关闭路径此后**只在组件级**成立（上面三条 + `workItemPeekKeyIntent` 这一枚
     纯判据随组件保留，后续升级完整面板时复用）。变异：宿主恢复 peek 键盘层（面板没挂却留着
     键盘层 = 死代码）⇒ 下面的否定断言必红。 */
  const host = stripComments(readSource("squad/WorkItemsSurface.tsx"));
  assert.ok(
    !host.includes("workItemPeekKeyIntent("),
    "宿主不再持有 peek 的 Esc 键盘层（面板未挂载 ⇒ 没有可关的面板）",
  );
});

/* 打开 peek 的唯一路径是「行点击 → 宿主开面板」；静态渲染只能看到**首帧**（idle ⇒ 加载中）
   —— 各分支的判据已在 ② 里逐格钉住，这里判的是「壳与两个动作都在」。 */
// ---------- ⑤ 面板容器：头部两个动作 + 打开即加载态 ----------

test("容器：面板锚点 + 头部（打开完整详情页 / 关闭）+ 首帧加载态", () => {
  const markup = renderToStaticMarkup(
    createElement(ZCodeIntlProvider, {
      initialLocale: "zh-CN" as const,
      children: createElement(ServiceProvider, {
        /* 静态渲染不进 effect ⇒ 读模型停在 idle：只需要一个能通过 useServices() 的访问器。 */
        services: {} as IServiceAccessor,
        children: createElement(WorkItemPeek, {
          workItemId: "wi-1",
          workspacePath: "/w/a",
          snapshot: snapshotWith([]),
          onClose: () => {},
          onOpenDetail: () => {},
        }),
      }),
    }),
  );
  const aside = openTag(markup, "work-item-peek");
  assert.ok(
    aside.includes(`aria-label="${zhText("squad.workItems.peek.title")}"`),
    "面板有可及名称（读屏听到的是「工作项预览」）",
  );
  assert.ok(
    markup.includes(zhText("squad.workItems.peek.openDetail")),
    "「打开完整详情页」是面板里的稳定入口（保留「完整面在独立详情页」的既有裁定）",
  );
  assert.ok(
    openTag(markup, "work-item-peek-close").includes(
      `aria-label="${zhText("squad.workItems.peek.close")}"`,
    ),
    "关闭钮只有图标 ⇒ 必须带可及名称",
  );
  assert.ok(
    markup.includes(`data-testid="work-item-peek-loading"`) &&
      markup.includes(zhText("squad.workItemDetail.loading")),
    "首帧 = 加载态（复用详情页的加载文案）",
  );
});

// ---------- ⑧ 宿主接线（2026-10-09 用户裁定「点击进详情页，预览先下线」） ----------

function renderSurface(input: {
  workItems: WorkItem[];
  withWriter?: boolean;
  viewport?: WorkItemSurfaceViewport;
}): string {
  const { workItems, withWriter = false, viewport } = input;
  return renderToStaticMarkup(
    createElement(ZCodeIntlProvider, {
      initialLocale: "zh-CN" as const,
      children: createElement(WorkItemsSurface, {
        workItems,
        snapshot: snapshotWith(workItems),
        discardableIds: new Set<string>(),
        busyWorkItemId: null,
        timelineExpandedWorkItemId: null,
        laneDimension: "none",
        surface: workItemSurfaceDefaultState(),
        onSurfaceIntent: () => {},
        onEdit: () => {},
        onInlineEdit: async () => null,
        onReassign: () => {},
        onDiscard: () => {},
        onToggleTimeline: () => {},
        onOpenWorkItemDetail: () => {},
        workspacePath: "/w/a",
        ...(withWriter ? { onQuickCreate: async () => null } : {}),
        ...(viewport === undefined ? {} : { viewport }),
      }),
    }),
  );
}

/** 递归收集 `src` 下的全部源码（.ts/.tsx）——「全树无 onOpenPeek」的 grep 验收用。 */
function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const fullPath = resolve(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(fullPath);
    return /\.(ts|tsx)$/.test(entry.name) ? [fullPath] : [];
  });
}

/* 承重（本轮变异 M2）：宿主**不再挂载** peek —— 桌面与窄屏两档、有写入口与无写入口都不出现
   `work-item-peek` 节点与 peek 身份文案。面板组件（`WorkItemPeek.tsx`）本身保留（后续升级完整
   面板的底子，组件级判据见 ①-⑦），只是**没有任何挂载点**。
   变异：在宿主里恢复 `<WorkItemPeek ...>`（或任何 peek 挂载）⇒ 下面每一条都能咬住。 */
test("宿主｜peek 下线：两档都零 peek 节点（组件保留，挂载摘除）", () => {
  for (const markup of [
    renderSurface({ workItems: [wi()] }),
    renderSurface({ workItems: [wi()], withWriter: true }),
    renderSurface({ workItems: [wi()], withWriter: true, viewport: "compact" }),
  ]) {
    assert.ok(!markup.includes("work-item-peek"), "peek 面板一个节点都不进 DOM");
    assert.ok(!markup.includes(zhText("squad.workItems.peek.title")), "peek 身份文案也不得出现");
  }
  const host = stripComments(readSource("squad/WorkItemsSurface.tsx"));
  assert.ok(!host.includes("WorkItemPeek"), "宿主不得 import / 渲染 peek 组件（只摘挂载）");
  assert.ok(
    !host.includes("peekWorkItemId") && !host.includes("peekPanel"),
    "宿主不再持有 peek 打开态与面板节点",
  );
  assert.ok(
    !host.includes("work-items-surface-split"),
    "分栏壳随 peek 一起摘除（没有右列就没有壳）",
  );
});

/* 口径变更（2026-10-09 下线）：F1/F2 的「恒定壳」判据退役 —— 当时要壳是为了「开关 peek 不换
   树根」；peek 下线后**没有开关**，桌面分支直接返回 body（恒定性由「没有第二条返回路径」
   保证：body 的父链在两次渲染之间恒等）。
   变异：给桌面分支加回条件包裹（或把 body 挪进另一条返回路径）⇒ 下面的断言必红。 */
test("宿主｜恒定 body（F1/F2 下线口径）：桌面分支无壳、无 peek 开关，直接返回 body", () => {
  const host = stripComments(readSource("squad/WorkItemsSurface.tsx"));
  assert.equal(
    (host.match(/return\s+body\s*;/g) ?? []).length,
    1,
    "桌面（含 SSR 默认）= 直接返回 body：唯一返回路径 ⇒ 没有可换的树根",
  );
  assert.ok(
    !host.includes("work-items-surface-split") && !host.includes("peekPanel"),
    "壳与右列随 peek 下线（恒定 body 不再需要分栏容器）",
  );
  for (const markup of [
    renderSurface({ workItems: [wi()], withWriter: true }),
    renderSurface({ workItems: [wi()], withWriter: true, viewport: "desktop" }),
  ]) {
    assert.ok(
      markup.includes('data-testid="work-items-quick-create"') &&
        markup.includes('data-testid="work-items-list"'),
      "body 子树照常渲染（快速创建 + 行都在）",
    );
  }
});

/* 承重（本轮变异 M1）：点击行/卡片/表格标题格一律走**详情页导航**（同一路由）—— 全树不得再有
   `onOpenPeek` 这个拦截分支（类型字段、`?? onOpenPeek` 回落、视图透传、宿主注入全部摘掉）。
   变异：恢复 `onOpenPeek?` 字段或 `onOpenPeek: onOpenRow = …` 回落 ⇒ 本用例必红。 */
test("守卫｜点击=详情页：全树无 onOpenPeek；三视图的行覆盖按钮直连 onOpenWorkItemDetail", () => {
  const offenders = sourceFiles(SRC_DIR).filter((file) =>
    stripComments(readFileSync(file, "utf8")).includes("onOpenPeek"),
  );
  assert.deepEqual(
    offenders,
    [],
    "onOpenPeek 通道必须整体下线（类型 / 回落 / 透传 / 注入一个不剩）",
  );
  /* 三个视图的「打开」入口：board/list 用行模块那一枚覆盖按钮、table 用单元格里**同一个**
     组件 —— 两处都直连详情页导航，没有第二个分支可拦。 */
  const rows = stripComments(readSource("squad/WorkItemRows.tsx"));
  assert.ok(
    rows.includes("onOpen={() => onOpenWorkItemDetail(item.id)}"),
    "行（board/list）：点击 = 详情页导航",
  );
  assert.equal(
    (rows.match(/onOpen=\{\(\) => onOpenWorkItemDetail\(item\.id\)\}/g) ?? []).length,
    1,
    "行模块只有这一枚打开入口（不新开第二条路径）",
  );
  const cells = stripComments(readSource("squad/WorkItemTableCell.tsx"));
  assert.ok(
    cells.includes("onOpen={() => onOpenWorkItemDetail(item.id)}"),
    "表格标题格（table）：同一枚覆盖按钮、同一份口径 = 详情页导航",
  );
  assert.ok(!cells.includes("onOpenPeek"), "单元格不再有 peek 参数（同一份口径，不是第二套）");
  const view = stripComments(readSource("squad/WorkItemTableView.tsx"));
  assert.ok(!view.includes("onOpenPeek"), "表格视图不再把 peek 意图投给单元格");
  const host = stripComments(readSource("squad/WorkItemsSurface.tsx"));
  assert.ok(!host.includes("onOpenPeek"), "宿主环境不再注入 peek 打开入口");
});

/* 下线口径的宿主侧结构：打开态 / Esc 键盘层 / 焦点归还三件套随面板挂载一起摘掉（面板组件的
   关闭路径仍在组件级，见 ⑦）。变异：把其中一件留成死代码（无挂载点却仍在宿主里）⇒ 必红。 */
test("守卫｜宿主不再持有 peek 三件套：打开态 / Esc 键盘层 / 焦点归还", () => {
  const host = stripComments(readSource("squad/WorkItemsSurface.tsx"));
  for (const forbidden of [
    "peekWorkItemId",
    "openPeek",
    "closePeek",
    "peekReturnFocusRef",
    "document.activeElement",
    "workItemPeekKeyIntent(",
  ]) {
    assert.ok(!host.includes(forbidden), `宿主不得残留 ${forbidden}（peek 已下线）`);
  }
  assert.ok(
    host.includes("onOpenWorkItemDetail,"),
    "行环境仍把详情页导航交给行（三视图共用的唯一打开语义）",
  );
});
