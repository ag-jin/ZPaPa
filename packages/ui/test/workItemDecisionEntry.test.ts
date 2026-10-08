import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  WORK_ITEM_DECISION_KINDS,
  createWorkItemCollaborationService,
  type WorkItemActivityRecord,
  type WorkItemDecisionKind,
  type WorkItemDecisionRecord,
} from "@zcode/services";
/* 时间线激活一块用真库真服务：node 侧工厂只能按相对路径取（services 的 node 入口不导出它们；
   与 desktop 的接线测试同款做法，仅在测试里使用 —— UI 源码侧由 R1 守卫禁止）。 */
import { runTasksDatabaseMigrations } from "../../services/src/session/tasksDatabase/migrations.js";
import { createCommentDispatchReceiptRepo } from "../../services/src/workitem/commentDispatchReceiptRepo.js";
import { createWorkItemActivityRepo } from "../../services/src/workitem/workItemActivityRepo.js";
import { createWorkItemCommentReactionRepo } from "../../services/src/workitem/workItemCommentReactionRepo.js";
import { createWorkItemCommentRepo } from "../../services/src/workitem/workItemCommentRepo.js";
import { createWorkItemDecisionRepo } from "../../services/src/workitem/workItemDecisionRepo.js";
import { createWorkItemDeliverableRepo } from "../../services/src/workitem/workItemDeliverableRepo.js";
/* #8 D2：读模型新增「PR 关联清单 + 读数面可用性」两格 —— 夹具按 runtime 契约补齐。 */
import { createWorkItemPullRequestRepo } from "../../services/src/workitem/workItemPullRequestRepo.js";
import { createNullPullRequestProvider } from "../../services/src/workitem/pullRequestProvider.js";
import { createWorkItemDecisionService } from "../../services/src/workitem/workItemDecisionService.js";
import { createWorkItemRepo } from "../../services/src/workitem/workItemRepo.js";
/* SUB.1：读模型新增「本工作项的订阅行」一格 —— 夹具按 runtime 契约补 `subscriberRepo`
   （缺它的表现就是时间线激活链在 `subscriberRepo.listByWorkItem` 处抛 undefined）。 */
import { createWorkItemSubscriberRepo } from "../../services/src/workitem/workItemSubscriberRepo.js";
import type { SquadRuntime } from "../../services/src/workitem/squadContracts.js";
import enUS from "../src/i18n/locales/en-US.js";
import zhCN from "../src/i18n/locales/zh-CN.js";
import { buildWorkItemTimelineEntries } from "../src/squad/workItemCollaborationViewModel.js";
import {
  DECISION_KIND_MESSAGE_IDS,
  DECISION_PARENT_PREFIX_MESSAGE_IDS,
  canSubmitDecision,
  decisionKindMessageId,
  decisionNeedsParent,
  decisionParentCandidates,
  decisionParentReference,
  decisionSubmitParentId,
  newDecisionRequestId,
} from "../src/squad/workItemDecisionViewModel.js";
import { writeDisabledReason } from "../src/squad/workItemCollaborationViewModel.js";

/* C3.2：详情页「记录决定」入口的**纯函数 + 结构守卫 + 时间线激活**验收（任务卡 §5.2-§5.4）。

   为什么先钉纯函数：ui 包没有渲染测试设施（node:test 的纯函数逐格 + 源码结构守卫是本项目的
   既定做法，见 workItemsPage.test.ts 的文件头）。决定面有三格一旦漂移就「看起来都正常」：
   ① kind 标签（B5.1 的 if/else 链最后一个 else 会把未知 kind 说成「已重新审议」）；
   ② 父候选集（比服务面宽 ⇒ 用户能选中一个必然被拒的父）；
   ③ 父引用不可解析时（编一个名字 = 时间线说错话）。

   期望值全部是手写字面量（独立真源：规格 §3.4 / 任务卡 §2.2 的父规则表 / §5.2 的逐步断言），
   不是「拿实现再算一遍」。 */

/* ---------- kind 闭集穷尽（任务卡 §5.2-1、§5.4 N1；修掉 B5.1 的静默兜底） ---------- */

test("kind 映射：key 集合 == 服务面运行时闭集（deepEqual，不硬编码 5）", () => {
  assert.deepEqual(
    Object.keys(DECISION_KIND_MESSAGE_IDS).sort(),
    [...WORK_ITEM_DECISION_KINDS].sort(),
    "kind 文案映射必须与 WORK_ITEM_DECISION_KINDS 同集（少一个值 ⇒ 界面上少一句话而仍显示）",
  );
});

test("kind 映射：五键各自一句话且两两互异（不许两个 kind 共用一句）", () => {
  const messageIds = WORK_ITEM_DECISION_KINDS.map((kind) => DECISION_KIND_MESSAGE_IDS[kind]);
  for (const messageId of messageIds) {
    assert.ok(messageId.startsWith("squad.workItemDetail.decision."), `${messageId} 属决定文案族`);
  }
  assert.equal(
    new Set(messageIds).size,
    WORK_ITEM_DECISION_KINDS.length,
    "五键不得共用一句话（「已接受」与「已拒绝」是两件事）",
  );
});

test("kind 标签：闭集外的值 ⇒ 响亮抛（B5.1 的 else 兜底会把未知 kind 说成「已重新审议」）", () => {
  for (const kind of WORK_ITEM_DECISION_KINDS) {
    assert.equal(decisionKindMessageId(kind), DECISION_KIND_MESSAGE_IDS[kind]);
  }
  assert.throws(
    () => decisionKindMessageId("whatever"),
    /whatever/,
    "闭集外的 kind 不猜标签：猜的下场是界面说错话而没有任何错误",
  );
});

/* ---------- 表单与呈现的夹具（形状取自 WorkItemDecisionRecord；值全部写字面量） ---------- */

const FIVE_KINDS: WorkItemDecisionKind[] = [
  "proposal",
  "accepted",
  "rejected",
  "superseded",
  "reopened",
];

function decision(
  id: string,
  kind: WorkItemDecisionKind,
  options: {
    effectiveAt?: number;
    parentDecisionId?: string;
    subject?: string;
    authorId?: string;
  } = {},
): WorkItemDecisionRecord {
  return {
    id,
    workspaceKey: "ws",
    workspacePath: "/w",
    workItemId: "wi-1",
    threadId: null,
    parentDecisionId: options.parentDecisionId ?? null,
    author: { kind: "human", id: options.authorId ?? "local-user" },
    sourceRunId: null,
    initiatedBy: { kind: "human", id: "local-user" },
    kind,
    subject: options.subject ?? `事项 ${id}`,
    selection: {},
    rationale: null,
    evidence: [],
    effectiveAt: options.effectiveAt ?? 1,
    dedupKey: `k-${id}`,
    createdAt: 1,
    updatedAt: 1,
  };
}

/** 锚定活动（形状取自 WorkItemActivityRecord：`decision_created` + `decisionId` 锚）。 */
function decisionActivity(
  id: string,
  sequence: number,
  decisionId: string,
): WorkItemActivityRecord {
  return {
    id,
    workspaceKey: "ws",
    workspacePath: "/w",
    workItemId: "wi-1",
    kind: "decision_created",
    sequence,
    occurredAt: 1000 + sequence,
    actor: { kind: "human", id: "local-user" },
    sourceRun: null,
    initiatedBy: { kind: "human", id: "local-user" },
    commentId: null,
    decisionId,
    dispatchEventId: null,
    payload: {},
    dedupKey: `k-${id}`,
    createdAt: 1,
    updatedAt: 1,
  };
}

/* ---------- 父候选集（任务卡 §5.2-1；§5.4 N2） ---------- */

test("父候选：superseded ⇒ 全部；reopened ⇒ 仅 {accepted,rejected,superseded}；其余三键 ⇒ 空（不渲染父选择）", () => {
  const all = FIVE_KINDS.map((kind, index) =>
    decision(`d-${kind}`, kind, { effectiveAt: index + 1 }),
  );
  assert.deepEqual(
    decisionParentCandidates("superseded", all).map((row) => row.id),
    ["d-proposal", "d-accepted", "d-rejected", "d-superseded", "d-reopened"],
    "取代一条决定：任何既有决定都可被取代（父 kind 不限）",
  );
  assert.deepEqual(
    decisionParentCandidates("reopened", all).map((row) => row.id),
    ["d-accepted", "d-rejected", "d-superseded"],
    "重审只对已结的决定有意义：proposal 是服务面的死格，候选集不得放它进来（N2）",
  );
  for (const kind of ["proposal", "accepted", "rejected"] as const) {
    assert.deepEqual(
      decisionParentCandidates(kind, all),
      [],
      `${kind} 不需要父 ⇒ 空候选（选择器不渲染）`,
    );
  }
});

test("父候选：顺序原样来自输入（repo 的 effectiveAt ASC），不重排", () => {
  const rows = [
    decision("d-late", "accepted", { effectiveAt: 30 }),
    decision("d-early", "accepted", { effectiveAt: 10 }),
  ];
  assert.deepEqual(
    decisionParentCandidates("superseded", rows).map((row) => row.id),
    ["d-late", "d-early"],
    "第二份排序判据与 repo 漂移时不报错，时间线的父链会静默换序",
  );
});

test("父必填判据：与 C3.1 服务面的「必填 kind」同集（superseded / reopened）", () => {
  assert.equal(decisionNeedsParent("superseded"), true);
  assert.equal(decisionNeedsParent("reopened"), true);
  for (const kind of ["proposal", "accepted", "rejected"] as const) {
    assert.equal(decisionNeedsParent(kind), false, `${kind} 的父是可选的`);
  }
});

/* ---------- 父引用（任务卡 §5.2-1；§5.4 N4） ---------- */

test("父引用：父在集合内 ⇒ resolved 原样带出父行；不在 ⇒ unresolved 只给 id（不编名字、不取第一条）", () => {
  const parent = decision("d-parent", "accepted", { subject: "采用方案 B" });
  const child = decision("d-child", "superseded", { parentDecisionId: "d-parent" });
  const byId = new Map([[parent.id, parent]]);
  assert.deepEqual(decisionParentReference(child, byId), { kind: "resolved", parent });
  assert.deepEqual(
    decisionParentReference(decision("d-2", "superseded", { parentDecisionId: "d-ghost" }), byId),
    { kind: "unresolved", id: "d-ghost" },
    "父不在读面里 ⇒ 只显示 id：编一个名字 = 时间线说一句确定的假话（N4）",
  );
  assert.equal(
    decisionParentReference(decision("d-3", "proposal"), byId),
    null,
    "没有父 ⇒ null（父引用行整行不渲染）",
  );
});

/* ---------- 提交判据（任务卡 §5.2-1） ---------- */

test("提交判据：subject 空白 ⇒ false（trim 判据与 C3.1 同义）；superseded/reopened 未选父 ⇒ false；其余 ⇒ true", () => {
  assert.equal(
    canSubmitDecision({ kind: "proposal", subject: "   ", parentDecisionId: null }),
    false,
  );
  assert.equal(
    canSubmitDecision({ kind: "proposal", subject: "采用方案 B", parentDecisionId: null }),
    true,
  );
  assert.equal(
    canSubmitDecision({ kind: "accepted", subject: " 接受 ", parentDecisionId: null }),
    true,
  );
  assert.equal(
    canSubmitDecision({ kind: "superseded", subject: "换一条", parentDecisionId: null }),
    false,
    "取代不指出父 ⇒ 服务面必然拒（界面先挡住，别让用户撞一次必然失败）",
  );
  assert.equal(
    canSubmitDecision({ kind: "superseded", subject: "换一条", parentDecisionId: "d-1" }),
    true,
  );
  assert.equal(
    canSubmitDecision({ kind: "reopened", subject: "再看", parentDecisionId: null }),
    false,
  );
  assert.equal(
    canSubmitDecision({ kind: "reopened", subject: "再看", parentDecisionId: "d-1" }),
    true,
  );
});

test("提交载荷：只有必填 kind 才带父（切过 kind 留下的隐藏选择不得混进审计事实）", () => {
  assert.equal(decisionSubmitParentId("superseded", "d-1"), "d-1");
  assert.equal(decisionSubmitParentId("reopened", "d-2"), "d-2");
  assert.equal(decisionSubmitParentId("superseded", null), null);
  for (const kind of ["proposal", "accepted", "rejected"] as const) {
    assert.equal(
      decisionSubmitParentId(kind, "d-1"),
      null,
      `${kind} 的父是可选的、v1 表单不给选择器：残留的选中值不得写进决定行`,
    );
  }
});

/* ---------- 写面禁用原因（设计案 §4.1；任务卡 §5.4 N6 的「归档项不静默消失」判据本体） ---------- */

test("写面禁用原因：归档 > 刷新失败 > 可写（null）；评论与决定共用同一判据，只换文案族", () => {
  assert.equal(
    writeDisabledReason("comment", { archivedAt: 1 }, "boom"),
    "squad.workItemDetail.comment.disabled.archived",
    "归档压过刷新失败（两件事同时成立时说更根本的那件）",
  );
  assert.equal(
    writeDisabledReason("comment", {}, "boom"),
    "squad.workItemDetail.comment.disabled.readFailed",
  );
  assert.equal(writeDisabledReason("comment", {}, null), null, "都可写 ⇒ 无理由（null）");
  assert.equal(
    writeDisabledReason("decision", { archivedAt: 1 }, null),
    "squad.workItemDetail.decision.disabled.archived",
  );
  assert.equal(
    writeDisabledReason("decision", {}, "boom"),
    "squad.workItemDetail.decision.disabled.readFailed",
  );
  assert.equal(writeDisabledReason("decision", {}, null), null);
});

/* ---------- 幂等键的生成（§8.1；提交动作内的稳定性由 resolveSubmitId 保证） ---------- */

test("幂等键生成：非空且不重复（两个不同的提交动作必须是两个键）", () => {
  const ids = new Set(Array.from({ length: 100 }, () => newDecisionRequestId()));
  assert.equal(ids.size, 100, "生成器必须每次都给出新键（复用旧键会把两条决定并成一条）");
  for (const id of ids) assert.ok(id.length > 0);
});

/* ---------- i18n：决定面新键两语成对（任务卡 §5.1 的键清单是独立真源） ---------- */

/** 本轮新增的决定面文案键（手抄自任务卡 §5.1 的 i18n 要求：入口/标题/字段/空态/禁用/失败/父引用）。 */
const DECISION_MESSAGE_IDS = [
  "squad.workItemDetail.decision.record",
  "squad.workItemDetail.decision.dialogTitle",
  "squad.workItemDetail.decision.field.kind",
  "squad.workItemDetail.decision.field.subject",
  "squad.workItemDetail.decision.field.rationale",
  "squad.workItemDetail.decision.field.parent",
  "squad.workItemDetail.decision.parentEmpty",
  "squad.workItemDetail.decision.parentRequired",
  "squad.workItemDetail.decision.subjectRequired",
  "squad.workItemDetail.decision.submit",
  "squad.workItemDetail.decision.sending",
  "squad.workItemDetail.decision.failed",
  "squad.workItemDetail.decision.retry",
  "squad.workItemDetail.decision.disabled.archived",
  "squad.workItemDetail.decision.disabled.readFailed",
  "squad.workItemDetail.decision.parentSuperseded",
  "squad.workItemDetail.decision.parentReopened",
  "squad.workItemDetail.decision.parentRelated",
  "squad.workItemDetail.decision.parentUnresolved",
];

const placeholders = (value: string) =>
  [...value.matchAll(/\{(\w+)\}/g)]
    .map((match) => match[1])
    .sort()
    .join(",");

test("i18n：决定面新键两语齐备且占位符成对", () => {
  for (const key of DECISION_MESSAGE_IDS) {
    assert.ok(zhCN[key], `zh-CN 缺键 ${key}`);
    assert.ok(enUS[key], `en-US 缺键 ${key}`);
    assert.equal(
      placeholders(zhCN[key] ?? ""),
      placeholders(enUS[key] ?? ""),
      `${key} 占位符不成对`,
    );
  }
});

test("i18n：decision.* 子树整体两语成对（将来加键也不会只加半边）", () => {
  const prefix = "squad.workItemDetail.decision.";
  const zhKeys = Object.keys(zhCN).filter((key) => key.startsWith(prefix));
  const enKeys = Object.keys(enUS).filter((key) => key.startsWith(prefix));
  assert.deepEqual(zhKeys.sort(), enKeys.sort(), "decision.* 子树的两语键集必须相等");
  assert.ok(
    zhKeys.length > DECISION_MESSAGE_IDS.length,
    "子树包含本轮新键之外的既有键（label / 五键文案）",
  );
});

/* ---------- 源码结构守卫（任务卡 §5.3 U1–U7、§5.4 N3/N5/N6） ---------- */

const SRC_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "../src");
const readSource = (relativePath: string) => readFileSync(resolve(SRC_DIR, relativePath), "utf8");

/** C3.2 新增/改动的 UI 源码（反向断言的扫描面；`workItemDetailWrite.test.ts` 的名单必须含新文件）。 */
const DECISION_SOURCES = [
  "squad/WorkItemDetailPage.tsx",
  "squad/WorkItemCollaborationTimeline.tsx",
  "squad/WorkItemDecisionDialog.tsx",
  "squad/workItemDecisionViewModel.ts",
];

test("入口｜「记录决定」在协作区标题行，提交经唯一执行器 runCollaborationAction(null, …)", () => {
  const page = readSource("squad/WorkItemDetailPage.tsx");
  for (const required of [
    "<WorkItemDecisionRecorder",
    "decisions={read.decisions}",
    'writeDisabledReason("decision", workItem, state.refreshFailure)',
    "await runCollaborationAction(null, (service, currentTarget) =>",
    "service.createWorkItemDecision(currentTarget, {",
  ]) {
    assert.ok(page.includes(required), `页面必须包含 ${required}`);
  }
  assert.ok(
    page.split(".getSnapshot(").length - 1 === 1,
    "取快照只允许名册那一处；写入路径不得再取一次（U4）",
  );
  assert.ok(!page.includes("setOptimistic"), "不做乐观插入（U4）");
});

test("U3｜决定写入调用在 UI 全域恰一处（模板与对话框只拿到回调）", () => {
  const occurrences = DECISION_SOURCES.map(
    (file) => readSource(file).split("service.createWorkItemDecision(currentTarget, {").length - 1,
  ).reduce((sum, count) => sum + count, 0);
  assert.equal(occurrences, 1, "决定写入只允许一处调用点（N5：对话框直接调服务即越界）");
});

test("U2｜UI 不在决定面上创建 Run / 派发 / 写状态（R2 名单 + 状态写两词）", () => {
  for (const file of DECISION_SOURCES) {
    const source = readSource(file);
    for (const forbidden of [
      "openMemberRun",
      "recordLeaderRun",
      "planDispatch",
      "settleCommentDispatchReceipt",
      "transition(",
      "updateStatus",
    ]) {
      assert.ok(!source.includes(forbidden), `${file} 不得出现 ${forbidden}`);
    }
  }
});

test("U5｜selection / evidence 不出现在决定面（v1 不开放编辑：出现即说明悄悄扩了形状）", () => {
  for (const file of ["squad/WorkItemDecisionDialog.tsx", "squad/workItemDecisionViewModel.ts"]) {
    const source = readSource(file);
    for (const forbidden of ["selection", "evidence"]) {
      assert.ok(!source.includes(forbidden), `${file} 不得出现 ${forbidden}`);
    }
  }
});

test("U1｜新文件进两份扫描名单：R1/R2 身份与图标扫描自动覆盖", () => {
  const testDir = dirname(fileURLToPath(import.meta.url));
  const writeGuard = readFileSync(resolve(testDir, "workItemDetailWrite.test.ts"), "utf8");
  const pageGuard = readFileSync(resolve(testDir, "workItemDetailPage.test.ts"), "utf8");
  for (const file of ["squad/WorkItemDecisionDialog.tsx", "squad/workItemDecisionViewModel.ts"]) {
    assert.ok(
      writeGuard.includes(`"${file}"`),
      `COLLABORATION_SOURCES 必须含 ${file}（身份/图标扫描）`,
    );
    assert.ok(
      pageGuard.includes(`"${file}"`),
      `ROUND_ONE_SOURCES 必须含 ${file}（R1/R2 反向断言）`,
    );
  }
  for (const forbidden of ["@zcode/services/node", "node:sqlite", "workItemDecisionRepo"]) {
    assert.ok(pageGuard.includes(`"${forbidden}"`), `R1 禁用面缺 ${forbidden}`);
  }
  // 两个新文件本身也不碰存储面（与 R1 同一份禁用词，直接在本地核一遍）。
  for (const file of ["squad/WorkItemDecisionDialog.tsx", "squad/workItemDecisionViewModel.ts"]) {
    const source = readSource(file);
    for (const forbidden of ["@zcode/services/node", "node:sqlite", "Repo"]) {
      assert.ok(!source.includes(forbidden), `${file} 不得出现 ${forbidden}`);
    }
  }
});

test("对话框结构｜testid 全表与「父选择仅在必填 kind 下渲染」", () => {
  const dialog = readSource("squad/WorkItemDecisionDialog.tsx");
  for (const testId of [
    "work-item-decision-dialog",
    "work-item-decision-kind",
    "work-item-decision-subject",
    "work-item-decision-rationale",
    "work-item-decision-parent",
    "work-item-decision-submit",
    "work-item-decision-failure",
  ]) {
    assert.ok(dialog.includes(`data-testid="${testId}"`), `对话框缺 ${testId}`);
  }
  assert.ok(
    dialog.includes("decisionNeedsParent(kind)") && dialog.includes("needsParent ? ("),
    "父选择只在 superseded / reopened 渲染（判据来自纯函数，不是组件里的一次比较）",
  );
  assert.ok(
    dialog.includes("decisionParentCandidates(kind, decisions)"),
    "父候选必须经纯函数过滤（N2：把 proposal 放进 reopened 候选 = 制造必然失败的选择）",
  );
  assert.ok(
    dialog.includes("decisionKindMessageId("),
    "kind 文案经闭集映射表（U6：不写把某 kind 映射到他人文案的分支）",
  );
  for (const kind of WORK_ITEM_DECISION_KINDS) {
    assert.ok(
      !dialog.includes(`"squad.workItemDetail.decision.${kind}"`),
      `对话框不得写死 ${kind} 的文案键（标签只经映射表）`,
    );
  }
  assert.ok(
    dialog.includes("WORK_ITEM_DECISION_KINDS.map"),
    "五键选项来自服务面闭集本身（不手抄第二份清单）",
  );
  assert.ok(
    dialog.includes("canSubmitDecision(form)"),
    "提交判据经纯函数（不在组件里重写一遍 trim/父规则）",
  );
  assert.ok(
    dialog.includes("decisionSubmitParentId(kind, parentDecisionId)") &&
      dialog.includes("{ parentDecisionId: parentForSubmit }") &&
      !dialog.includes("{ parentDecisionId }"),
    "提交载荷的父经纯函数裁剪（切过 kind 的残留选择不得混进审计事实）",
  );
});

test("对话框提交｜幂等键经 resolveSubmitId 三事件（N3：每次生成新键 = 重试长两条决定）", () => {
  const dialog = readSource("squad/WorkItemDecisionDialog.tsx");
  for (const call of [
    'resolveSubmitId(sourceRequestId, "send", newDecisionRequestId)',
    'resolveSubmitId(requestId, "failed", newDecisionRequestId)',
    'resolveSubmitId(requestId, "sent", newDecisionRequestId)',
  ]) {
    assert.ok(
      dialog.includes(call),
      `提交必须经 ${call}（同一提交动作内稳定、失败沿用、成功后换新）`,
    );
  }
  assert.ok(dialog.includes('data-testid="work-item-decision-failure"'), "失败提示锚点");
  assert.ok(dialog.includes("decision.failed"), "失败要说清「决定未记录」");
  assert.ok(dialog.includes("decision.retry"), "失败要给「重试」");
  assert.ok(
    dialog.includes("disabled={!canSubmit}") && dialog.includes("aria-describedby="),
    "提交禁用必须可禁用 + 有理由（不得只靠颜色）",
  );
  assert.ok(dialog.includes("decision.sending"), "发送中要有在途文案");
});

test("N6｜归档项入口存在但禁用并给原因（不静默消失）", () => {
  const recorder = readSource("squad/WorkItemDecisionDialog.tsx");
  assert.ok(
    recorder.includes('data-testid="work-item-decision-record"'),
    "入口按钮 testid（卡片冻结名）",
  );
  assert.ok(
    recorder.includes("disabled={disabledReasonMessageId !== null}"),
    "入口的 disabled 绑定到唯一判据（writeDisabledReason 的返回值）",
  );
  assert.ok(
    recorder.includes('data-testid="work-item-decision-record-reason"'),
    "原因文案锚点：禁用必须说清为什么（N6 的变异形态是「静默消失」）",
  );
  assert.ok(
    recorder.includes("intl.formatMessage({ id: disabledReasonMessageId })"),
    "原因文案来自禁用判据本身（不写第二份判断）",
  );
});

/* ---------- 时间线呈现：作者 + 父链（任务卡 §5.1、§5.2-4） ---------- */

test("父引用前缀：闭集穷尽；取代与重审各有专门前缀，其余三键共用「关于」（可选父但仍然要说得出来）", () => {
  assert.deepEqual(
    Object.keys(DECISION_PARENT_PREFIX_MESSAGE_IDS).sort(),
    [...WORK_ITEM_DECISION_KINDS].sort(),
    "前缀映射必须与 kind 闭集同集（少一个键 ⇒ 父链静默渲染成半句话）",
  );
  assert.notEqual(
    DECISION_PARENT_PREFIX_MESSAGE_IDS.superseded,
    DECISION_PARENT_PREFIX_MESSAGE_IDS.reopened,
    "「取代了」与「重新审议」是两件事，不得共用一句",
  );
  for (const kind of ["proposal", "accepted", "rejected"] as const) {
    assert.equal(
      DECISION_PARENT_PREFIX_MESSAGE_IDS[kind],
      "squad.workItemDetail.decision.parentRelated",
    );
  }
  for (const messageId of Object.values(DECISION_PARENT_PREFIX_MESSAGE_IDS)) {
    assert.ok(messageId.startsWith("squad.workItemDetail.decision.parent"), messageId);
    assert.ok(zhCN[messageId] && enUS[messageId], `${messageId} 缺两语文案`);
  }
});

test("时间线：superseded 两条（旧 + 新）都在、次序 = sequence；父引用解析到旧条目", () => {
  const accepted = decision("d-1", "accepted", { subject: "采用方案 B", effectiveAt: 10 });
  const superseding = decision("d-2", "superseded", {
    subject: "改用方案 C",
    parentDecisionId: "d-1",
    effectiveAt: 20,
  });
  const entries = buildWorkItemTimelineEntries({
    comments: [],
    decisions: [accepted, superseding],
    activities: [decisionActivity("a-1", 1, "d-1"), decisionActivity("a-2", 2, "d-2")],
  });
  assert.deepEqual(
    entries.map((entry) => entry.kind),
    ["decision", "decision"],
    "取代是**新行**：老条目仍留在时间线上（只增不改）",
  );
  assert.deepEqual(
    entries.map((entry) => entry.key),
    ["decision:d-1", "decision:d-2"],
    "次序 = 锚定 Activity 的 sequence（不按 effectiveAt 重排）",
  );
  const byId = new Map([
    [accepted.id, accepted],
    [superseding.id, superseding],
  ]);
  assert.deepEqual(decisionParentReference(superseding, byId), {
    kind: "resolved",
    parent: accepted,
  });
  assert.equal(decisionParentReference(accepted, byId), null, "老条目没有被取代：它仍是「已接受」");
});

test("时间线结构｜DecisionEntry 显示作者与父引用；kind 标签只经映射表（U6）", () => {
  const timeline = readSource("squad/WorkItemCollaborationTimeline.tsx");
  assert.ok(
    timeline.includes("decisionKindMessageId(decision.kind)"),
    "kind 标签必须经闭集映射表（B5.1 的 if/else 链最后一个 else 会说错话）",
  );
  assert.ok(
    !timeline.includes("decision.kind ==="),
    "不得按 kind 分支决定文案（U6：把某 kind 映射到他人文案的形态）",
  );
  for (const kind of WORK_ITEM_DECISION_KINDS) {
    assert.ok(
      !timeline.includes(`"squad.workItemDetail.decision.${kind}"`),
      `时间线不得写死 ${kind} 的文案键（标签只经映射表）`,
    );
  }
  assert.ok(
    timeline.includes("decisionParentReference(decision, decisionsById)"),
    "父引用经纯函数解析（不编名字、不取第一条）",
  );
  assert.ok(
    timeline.includes("DECISION_PARENT_PREFIX_MESSAGE_IDS[decision.kind]"),
    "父引用前缀由 kind 闭集映射决定（取代/重审/关于）",
  );
  assert.ok(
    timeline.includes("decision.parentUnresolved"),
    "父不可解析 ⇒ 显示 id 的那句文案（与 link-error 的「关联活动不可用」是两件事）",
  );
  assert.ok(
    timeline.includes("decision.author.displayName ?? decision.author.id"),
    "作者按既有 byline 口径呈现（displayName 优先，退回 id）",
  );
  assert.ok(
    timeline.includes('t("squad.workItemDetail.comment.author.human")') &&
      timeline.includes('t("squad.workItemDetail.comment.author.agent")'),
    "作者徽标复用既有 comment.author.* 文案键（不新造一套身份词）",
  );
});

/* ---------- 时间线激活（交付 2）：经门面写入 → 读面读回 → B5.1 只读时间线条目 ----------

   这一块用**真库 + 真 repo + 真服务 + 真门面**（`:memory:` + 真迁移）：两半各自有测试
   （C3.1 的 services 用例证明「写入带 decisionId 锚」，B5.1 的用例证明「带锚活动 ⇒ 决定条目」），
   这里把两半接起来跑一遍 —— 接线断了（例如活动漏锚、门面读面漏 decisions）它就会红。
   node 侧实现只能按相对路径取（services 的 node 入口不导出这些工厂，见 C3.1 的测试同款做法）。 */

const TIMELINE_WORKSPACE = { path: "/tmp/c32-timeline-ws", identity: "c32-timeline-ws" };
const TIMELINE_HUMAN = { kind: "human" as const, id: "local-user" };
const TIMELINE_CLOCK = 1_700_000_000_000;

function workItemRow(id: string) {
  return {
    id,
    workspaceIdentity: TIMELINE_WORKSPACE.identity,
    workspacePath: TIMELINE_WORKSPACE.path,
    title: `标题 ${id}`,
    body: "",
    status: "todo" as const,
    assignee: { type: "agent" as const, id: "ag-1" },
    labels: [],
    properties: {},
    position: 0,
  };
}

function setupTimeline() {
  const db = new DatabaseSync(":memory:");
  runTasksDatabaseMigrations(db);
  const workItems = createWorkItemRepo(db);
  const decisions = createWorkItemDecisionRepo(db);
  const activities = createWorkItemActivityRepo(db);
  workItems.insert(workItemRow("wi-1"));
  let generated = 0;
  const decisionService = createWorkItemDecisionService({
    decisions,
    activities,
    workItems,
    now: () => TIMELINE_CLOCK,
    newId: () => `dec-${++generated}`,
  });
  const collaboration = createWorkItemCollaborationService({
    createRuntime: async () =>
      ({
        workItemRepo: workItems,
        deliverableRepo: createWorkItemDeliverableRepo(db),
        pullRequestRepo: createWorkItemPullRequestRepo(db),
        pullRequestProvider: createNullPullRequestProvider(),
        /* #8 D3：读面带出整批收尾模式（详情页 PR 区的 pr-gate 提示读它）。 */
        readSquadMergeMode: () => "local",
        /* SUB.1：本工作项的订阅行随聚合读返回（空表即可 —— 本文件的用例不驱动订阅面）。 */
        subscriberRepo: createWorkItemSubscriberRepo(db),
        boundWorkspace: TIMELINE_WORKSPACE,
      }) as unknown as SquadRuntime,
    getRepos: () => ({
      comments: createWorkItemCommentRepo(db),
      activities,
      decisions,
      reactions: createWorkItemCommentReactionRepo(db),
      receipts: createCommentDispatchReceiptRepo(db),
    }),
    localHumanActor: () => TIMELINE_HUMAN,
    createDecisionService: () => decisionService,
  });
  return { collaboration };
}

test("时间线激活｜经门面写入一条决定 ⇒ 读面带回 decisions + 锚 Activity ⇒ B5.1 时间线就地出现只读条目", async () => {
  const f = setupTimeline();
  const written = await f.collaboration.createWorkItemDecision(TIMELINE_WORKSPACE, {
    workItemId: "wi-1",
    kind: "accepted",
    subject: "采用方案 B",
    rationale: "成本更低",
    sourceRequestId: "req-c32-1",
  });
  const read = await f.collaboration.getWorkItemCollaboration(TIMELINE_WORKSPACE, "wi-1");
  assert.ok(read !== null);
  assert.deepEqual(
    read.decisions.map((row) => row.id),
    [written.id],
    "读面 decisions 含刚写入的那一行（零新读调用：父候选与时间线都吃这一份）",
  );
  assert.deepEqual(
    read.activities
      .filter((activity) => activity.kind === "decision_created")
      .map((activity) => activity.decisionId),
    [written.id],
    "decision_created 带 decisionId 锚（缺锚 ⇒ UI 静默降级成「关联活动不可用」）",
  );

  // B5.1 的只读时间线条目（同一份纯投影函数；ui 包没有渲染设施，这就是既定手段）。
  const entries = buildWorkItemTimelineEntries({
    comments: read.comments,
    activities: read.activities,
    decisions: read.decisions,
  });
  assert.deepEqual(
    entries.map((entry) => entry.kind),
    ["decision"],
    "写入后时间线上出现决定条目（而不是 link-error）",
  );
  const entry = entries[0];
  assert.equal(entry?.kind === "decision" ? entry.decision.id : null, written.id);
  assert.equal(
    entry?.kind === "decision"
      ? decisionParentReference(entry.decision, new Map(read.decisions.map((row) => [row.id, row])))
      : "n/a",
    null,
    "首次记录没有父 ⇒ 父引用行不渲染（不是 unresolved）",
  );
});

test("时间线激活｜再写一条 superseded 指向第一条 ⇒ 两条都在、新条目父引用解析到旧条目", async () => {
  const f = setupTimeline();
  const first = await f.collaboration.createWorkItemDecision(TIMELINE_WORKSPACE, {
    workItemId: "wi-1",
    kind: "accepted",
    subject: "采用方案 B",
    sourceRequestId: "req-c32-a",
  });
  const second = await f.collaboration.createWorkItemDecision(TIMELINE_WORKSPACE, {
    workItemId: "wi-1",
    kind: "superseded",
    subject: "改用方案 C",
    parentDecisionId: first.id,
    sourceRequestId: "req-c32-b",
  });
  const read = await f.collaboration.getWorkItemCollaboration(TIMELINE_WORKSPACE, "wi-1");
  assert.ok(read !== null);
  const entries = buildWorkItemTimelineEntries({
    comments: read.comments,
    activities: read.activities,
    decisions: read.decisions,
  }).filter((entry) => entry.kind === "decision");
  assert.deepEqual(
    entries.map((entry) => (entry.kind === "decision" ? entry.decision.id : null)),
    [first.id, second.id],
    "取代是**新行**：老条目仍在且仍在前面（只增不改）",
  );
  const rows = entries.map((entry) => (entry.kind === "decision" ? entry.decision : null));
  assert.equal(rows[0]?.kind, "accepted", "老条目一字未改（仍是「已接受」）");
  assert.deepEqual(
    decisionParentReference(rows[1]!, new Map(read.decisions.map((row) => [row.id, row]))),
    { kind: "resolved", parent: rows[0] },
    "「取代了：已接受 · 采用方案 B」所需的父引用在 UI 侧解析得出来",
  );
});
