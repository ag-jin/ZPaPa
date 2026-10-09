import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  COMMENT_DISPATCH_OUTCOMES,
  type CommentDispatchReceiptRecord,
  type WorkItemActivityRecord,
} from "@zcode/services";
import {
  COMMENT_DELETE_CONFIRM_IDLE,
  COMMENT_DISPATCH_INLINE_LIMIT,
  COMMENT_DISPATCH_OUTCOME_MESSAGE_IDS,
  commentDispatchNote,
  confirmCommentDelete,
  draftHasContent,
  executeCommentDelete,
  resolveSubmitId,
  summarizeCommentDispatches,
} from "../src/squad/workItemCollaborationViewModel.js";

/* B5.2 轮 2：详情页写路径的**纯函数**验收（任务卡 §5.3-2/§5.3-3）。

   为什么先钉纯函数：ui 包没有渲染测试设施（node:test 的源码结构守卫 + 纯函数逐格是本项目的
   既定做法）。提交幂等键的稳定性、receipt 七值穷尽、抑制注记与 receipt 的互斥 —— 这三格
   一旦漂移，界面上都表现为「看起来正常的一句话」，没有任何地方会报错。

   期望值全部是手写字面量（独立真源），不是「用实现再算一遍」。 */

function receipt(
  dispatchKey: string,
  outcome: CommentDispatchReceiptRecord["outcome"],
  overrides: Partial<CommentDispatchReceiptRecord> = {},
): CommentDispatchReceiptRecord {
  return {
    dispatchKey,
    workspaceKey: "ws",
    workItemId: "wi-1",
    targetAgentId: "ag-1",
    commentId: "c-1",
    threadId: "c-1",
    source: "issue_assignee",
    outcome,
    detail: {},
    attemptCount: 1,
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

function suppressedActivity(
  id: string,
  commentId: string,
  reason: unknown,
): WorkItemActivityRecord {
  return {
    id,
    workspaceKey: "ws",
    workspacePath: "/w",
    workItemId: "wi-1",
    kind: "comment_dispatch_suppressed",
    sequence: 1,
    occurredAt: 1,
    actor: { kind: "human", id: "local-user" },
    initiatedBy: { kind: "human", id: "local-user" },
    commentId,
    payload: { reason },
    dedupKey: `k-${id}`,
    createdAt: 1,
  } as unknown as WorkItemActivityRecord;
}

/* ---------- 派发 receipt 的七值穷尽（设计案 §5 / R7） ---------- */

test("receipt 映射：key 集合 == 服务面闭集（运行时 deepEqual，不硬编码 7）", () => {
  assert.deepEqual(
    Object.keys(COMMENT_DISPATCH_OUTCOME_MESSAGE_IDS).sort(),
    [...COMMENT_DISPATCH_OUTCOMES].sort(),
    "receipt 文案映射必须与 COMMENT_DISPATCH_OUTCOMES 同集（少一个值 ⇒ 界面上少一句话而仍显示）",
  );
});

test("receipt 映射：七值各自一句话，且 blocked 与 failed 不合并（「未派发」≠「派发失败」）", () => {
  const messageIds = COMMENT_DISPATCH_OUTCOMES.map(
    (outcome) => COMMENT_DISPATCH_OUTCOME_MESSAGE_IDS[outcome],
  );
  for (const messageId of messageIds) {
    assert.ok(messageId.startsWith("squad.workItemDetail.dispatch."), `${messageId} 属派发文案族`);
  }
  assert.equal(new Set(messageIds).size, COMMENT_DISPATCH_OUTCOMES.length, "七值不得共用一句话");
  assert.notEqual(
    COMMENT_DISPATCH_OUTCOME_MESSAGE_IDS.blocked,
    COMMENT_DISPATCH_OUTCOME_MESSAGE_IDS.failed,
    "blocked 与 failed 是两件事（被拦下 vs 尝试后失败）",
  );
  assert.ok(
    !Object.values(COMMENT_DISPATCH_OUTCOME_MESSAGE_IDS).includes(
      "squad.workItemDetail.dispatch.suppressed",
    ),
    "suppressed（未请求派发）不是 receipt 的第八个值 —— 它与七值是两族，不得并进插槽",
  );
});

/* ---------- 插槽内容（设计案 §5：最多两项 inline，超出收「另 N 个目标」） ---------- */

test("receipt 插槽：一项就一项、三项收成「另 N 个目标」，且不动输入顺序（repo 口径 createdAt ASC）", () => {
  const single = summarizeCommentDispatches([receipt("k1", "pending")]);
  assert.equal(single.inline.length, 1);
  assert.equal(single.moreCount, 0);
  assert.equal(single.inline[0]!.outcome, "pending");
  assert.equal(single.inline[0]!.messageId, "squad.workItemDetail.dispatch.pending");

  const three = summarizeCommentDispatches([
    receipt("k1", "pending"),
    receipt("k2", "queued"),
    receipt("k3", "coalesced"),
  ]);
  assert.equal(COMMENT_DISPATCH_INLINE_LIMIT, 2);
  assert.deepEqual(
    three.inline.map((entry) => [entry.dispatchKey, entry.outcome]),
    [
      ["k1", "pending"],
      ["k2", "queued"],
    ],
    "inline 取前两项且保持输入顺序（不重排）",
  );
  assert.equal(three.moreCount, 1, "第三项收进「另 N 个目标」");
});

test("receipt 插槽：无 receipt ⇒ 空插槽（组件据此不渲染容器）", () => {
  const empty = summarizeCommentDispatches([]);
  assert.deepEqual(empty, { inline: [], moreCount: 0 });
});

/* ---------- 抑制注记与 receipt 插槽**互斥**（设计案 §5 末段；任务卡 §5.3-3） ---------- */

test("抑制注记：/note、@all、@人名 ⇒ 「未请求派发」；且**有 receipt 时一律不渲染注记**", () => {
  const note = suppressedActivity("a1", "c-1", "note");
  assert.equal(
    commentDispatchNote({ commentId: "c-1", activities: [note], receipts: [] }),
    "squad.workItemDetail.dispatch.suppressed",
  );
  for (const reason of ["all_mention", "human_mention"]) {
    assert.equal(
      commentDispatchNote({
        commentId: "c-1",
        activities: [suppressedActivity("a1", "c-1", reason)],
        receipts: [],
      }),
      "squad.workItemDetail.dispatch.suppressed",
      `${reason} 也不请求派发`,
    );
  }
  // 互斥：同一条评论已经有 receipt 插槽时，抑制注记不得再渲染（同一条事实说两遍，且其中一句是错的）。
  assert.equal(
    commentDispatchNote({
      commentId: "c-1",
      activities: [note],
      receipts: [receipt("k1", "blocked")],
    }),
    null,
  );
});

test("抑制注记：blocked 原因不冒充「未请求派发」（它由 receipt 插槽如实承接）", () => {
  assert.equal(
    commentDispatchNote({
      commentId: "c-1",
      activities: [suppressedActivity("a1", "c-1", "blocked")],
      receipts: [],
    }),
    null,
    "blocked（门禁关闭 / 归档 / 名册缺席）不是「未请求派发」",
  );
});

test("抑制注记：只认本条评论的活动；闭集外的 reason ⇒ 响亮抛（不猜）", () => {
  assert.equal(
    commentDispatchNote({
      commentId: "c-2",
      activities: [suppressedActivity("a1", "c-1", "note")],
      receipts: [],
    }),
    null,
    "别的评论的抑制活动不得串到本条",
  );
  assert.throws(
    () =>
      commentDispatchNote({
        commentId: "c-1",
        activities: [suppressedActivity("a1", "c-1", "whatever")],
        receipts: [],
      }),
    /reason/,
    "读回非法 reason 一律抛（猜一个「大概没派发」的下场是界面说错话且不报错）",
  );
});

/* ---------- 提交幂等键的稳定性（设计案 §3.4 / R9；任务卡 §5.3-2） ---------- */

test("提交幂等键：首次提交生成、失败重试沿用、成功后才换新", () => {
  let generated = 0;
  const generate = () => `id-${(generated += 1)}`;

  const first = resolveSubmitId(null, "send", generate);
  assert.equal(first, "id-1");
  assert.equal(generated, 1, "首次提交才生成键");

  const retryPutThrough = resolveSubmitId(first, "send", generate);
  assert.equal(retryPutThrough, "id-1", "同一次提交动作（重试）沿用同一个键");
  assert.equal(generated, 1, "重试不得再生成一个新键（换键 = 库里长成两条评论）");

  const failed = resolveSubmitId(retryPutThrough, "failed", generate);
  assert.equal(failed, "id-1", "失败后键留着（重试还得用它）");

  const retryAfterFailure = resolveSubmitId(failed, "send", generate);
  assert.equal(retryAfterFailure, "id-1", "失败后的重试沿用");

  const afterSuccess = resolveSubmitId(retryAfterFailure, "sent", generate);
  assert.equal(afterSuccess, null, "提交成功 ⇒ 清空（下一条评论是一次新的提交动作）");
  assert.equal(resolveSubmitId(afterSuccess, "send", generate), "id-2", "下一条用新键");
});

/* ---------- 提交判据（§6.3 的 comment.submitDisabled.empty） ---------- */

test("提交判据：空草稿与只有 /note 前缀的草稿都不可提交（说了等于没说）", () => {
  assert.equal(draftHasContent(""), false);
  assert.equal(draftHasContent("   \n "), false);
  assert.equal(draftHasContent("/note"), false, "只有前缀没有正文");
  assert.equal(draftHasContent("/note   "), false, "/note 前缀后的空白不算内容");
  assert.equal(draftHasContent("正文"), true);
  assert.equal(draftHasContent("/note 正文"), true);
  assert.equal(draftHasContent("/notes 正文"), true, "/notes 不是 /note 前缀（词边界）");
});

/* ---------- 组件结构与接线（任务卡 §5.3-2/§5.3-3、§7.1 的轮 2 行） ---------- */

const SRC_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "../src");
const readSource = (relativePath: string) => readFileSync(resolve(SRC_DIR, relativePath), "utf8");

/** B-5 线的全部 UI 源码（反向断言的扫描面，与轮 1 文件保持同一份名单）。
    C3.2 追加决定面的两个文件：新文件**自动**进入 D1-A 身份扫描与 lucide 图标扫描。
    T-P1-R2 追加概览模块（从页面搬出的呈现区照样要过同一张网）。 */
const COLLABORATION_SOURCES = [
  "squad/WorkItemDetailPage.tsx",
  "squad/WorkItemDetailOverview.tsx",
  "squad/WorkItemCollaborationTimeline.tsx",
  "squad/WorkItemCommentEntry.tsx",
  "squad/WorkItemCommentComposer.tsx",
  "squad/WorkItemCommentDeleteDialog.tsx",
  "squad/WorkItemCommentDispatchSummary.tsx",
  "squad/WorkItemMentionMenu.tsx",
  "squad/workItemCollaborationViewModel.ts",
  "squad/workItemMentionViewModel.ts",
  "squad/workItemCollaborationAccess.ts",
  "squad/useWorkItemCollaboration.ts",
  "squad/WorkItemDecisionDialog.tsx",
  "squad/workItemDecisionViewModel.ts",
];

test("四入口接线｜页面执行三个非破坏性写、视图模型执行软删（各自唯一入口）", () => {
  const page = readSource("squad/WorkItemDetailPage.tsx");
  for (const call of [
    "service.createWorkItemComment(currentTarget, {",
    "service.setWorkItemCommentResolved(currentTarget, {",
    "service.addWorkItemCommentReaction(currentTarget, {",
  ]) {
    assert.ok(page.includes(call), `页面必须接通 ${call}`);
  }
  assert.ok(
    page.includes("executeCommentDelete({ service, target: currentTarget, decision })"),
    "软删必须经 executeCommentDelete（只有确认态能产出可执行目标）",
  );
  assert.ok(
    !page.includes("service.softDeleteWorkItemComment"),
    "页面不得直接调 softDeleteWorkItemComment（绕过确认态 = M5 变异形态）",
  );
  const vm = readSource("squad/workItemCollaborationViewModel.ts");
  assert.ok(
    vm.includes("await input.service.softDeleteWorkItemComment(input.target, { commentId })"),
    "唯一的软删调用点在 executeCommentDelete 里",
  );
});

test("五入口接线｜决定写经同一执行器且恰一处（C3.2；形状对齐 CreateWorkItemDecisionRequest）", () => {
  const page = readSource("squad/WorkItemDetailPage.tsx");
  assert.ok(
    page.includes("await runCollaborationAction(null, (service, currentTarget) =>") &&
      page.includes("service.createWorkItemDecision(currentTarget, {"),
    "决定提交必须走唯一执行器 runCollaborationAction（写 → 只刷新协作读模型）",
  );
  assert.equal(
    page.split("service.createWorkItemDecision(currentTarget, {").length - 1,
    1,
    "决定写入调用恰一处（对话框只拿回调：N5 的变异形态是对话框自己调服务）",
  );
  assert.ok(
    page.includes("decisions={read.decisions}"),
    "父候选来自读面的 decisions（零新读调用）",
  );
  assert.ok(
    !page.includes("actor") && !page.includes("workspaceKey") && !page.includes("initiatedBy"),
    "页面不得出现身份 / workspace 字段（D1-A：由服务面派生）",
  );
});

test("行为｜executeCommentDelete：未确认 ⇒ 一级都不执行；已确认 ⇒ 恰好调一次", async () => {
  const calls: Array<{ commentId: string }> = [];
  const service = {
    softDeleteWorkItemComment: async (_target: unknown, input: { commentId: string }) => {
      calls.push(input);
      return {} as never;
    },
  };
  const target = { path: "/w", identity: "ws" } as never;

  const idle = await executeCommentDelete({
    service,
    target,
    decision: confirmCommentDelete(COMMENT_DELETE_CONFIRM_IDLE),
  });
  assert.deepEqual(idle, { deleted: false });
  assert.equal(calls.length, 0, "没确认过 ⇒ 一次都不执行（不可撤销的动作不接受「大概的那条」）");

  const confirmed = await executeCommentDelete({
    service,
    target,
    decision: confirmCommentDelete({ pendingCommentId: "c-1" }),
  });
  assert.deepEqual(confirmed, { deleted: true });
  assert.deepEqual(calls, [{ commentId: "c-1" }]);
});

test("守卫｜确认态：确认后回到空闲（重复点确认不执行第二次）", () => {
  const decision = confirmCommentDelete({ pendingCommentId: "c-1" });
  assert.deepEqual(decision.next, COMMENT_DELETE_CONFIRM_IDLE);
  assert.equal(decision.commentId, "c-1");
});

test("守卫｜删除入口在条目里只进入确认态（本层不执行写入），确认弹窗是 destructive", () => {
  const entry = readSource("squad/WorkItemCommentEntry.tsx");
  assert.ok(entry.includes('data-testid="work-item-comment-delete"'), "删除入口 testid");
  assert.ok(entry.includes("onDelete(comment)"), "删除入口只把意图交回页面（进入确认态）");
  assert.ok(
    !entry.includes("softDeleteWorkItemComment") && !entry.includes("executeCommentDelete"),
    "条目组件不得执行删除",
  );
  const dialog = readSource("squad/WorkItemCommentDeleteDialog.tsx");
  assert.ok(dialog.includes('data-testid="work-item-comment-delete-confirm"'), "确认对话框锚点");
  assert.ok(dialog.includes('variant="destructive"'), "确认动作必须是 destructive 变体");
  for (const key of ["comment.deleteTitle", "comment.deleteDescription", "comment.delete"]) {
    assert.ok(dialog.includes(key), `确认弹窗必须用 ${key}（说清后果，而不是「确定吗」）`);
  }
});

test("守卫｜解决/重开：仅线程根渲染入口，且提交的是**目标态**（根专属动作）", () => {
  const entry = readSource("squad/WorkItemCommentEntry.tsx");
  assert.ok(entry.includes("comment.threadId === comment.id"), "根专属判据必须在条目里（R5）");
  assert.ok(
    entry.includes("onResolve(comment, comment.resolvedAt === null)"),
    "解决/重开必须提交目标态（不是「切换」这种含糊意图）",
  );
  assert.ok(entry.includes('data-testid="work-item-comment-resolve"'));
});

test("守卫｜回应：viewer 身份来自读面、已回应禁用、无 toggle/remove 语义（C5 / §3.3）", () => {
  const entry = readSource("squad/WorkItemCommentEntry.tsx");
  assert.ok(
    entry.includes("groupCommentReactions(reactions, viewerActor)"),
    "mine 的判据必须用读面带回的身份（UI 不自己造身份）",
  );
  assert.ok(
    entry.includes("aria-pressed={group.mine === null ? undefined : group.mine}"),
    "aria-pressed 只在 mine 可判定时给出（身份缺席时不假装「不是我」）",
  );
  assert.ok(
    entry.includes("disabled={group.mine === true || pending}"),
    "已回应 = 禁用（服务面没有移除接口，不做 toggle 的假动作）",
  );
  assert.ok(
    entry.includes("COMMENT_REACTION_EMOJIS.map"),
    "回应选项来自固定五项（任意 emoji 会让同一意思长出多个码位）",
  );
  assert.ok(entry.includes('data-testid="work-item-comment-react-menu"'), "回应菜单锚点");
  for (const forbidden of ["removeReaction", "toggleReaction", "deleteWorkItemCommentReaction"]) {
    assert.ok(!entry.includes(forbidden), `不得出现 ${forbidden}（本轮没有移除回应）`);
  }
});

test("反向断言｜D1-A：UI 源码零身份拼装（不写出带 id 字面量的人类身份，也不知道注入值）", () => {
  for (const file of COLLABORATION_SOURCES) {
    const source = readSource(file);
    // 「构造身份」= 写出 `{ kind: "human", id: "<字面量>" }`。mention 呈现里的
    // `{ kind: "human", id: mention.id }` 是**被展示的数据的形状**，不是身份构造，故只盯 id 字面量。
    assert.ok(
      !/\{\s*kind:\s*"human",\s*id:\s*"/.test(source),
      `${file} 不得构造人类身份（身份由组合根注入，UI 只转发读面带回的 viewerActor）`,
    );
    assert.ok(
      !source.includes('"local-user"') && !source.includes("LOCAL_HUMAN_ACTOR"),
      `${file} 不得引用注入值本身（UI 不该知道那个常量长什么样）`,
    );
  }
  // 正向证据：身份**只能**来自读面（转发，不造）。
  const page = readSource("squad/WorkItemDetailPage.tsx");
  assert.ok(
    page.includes("viewerActor={read.viewerActor}"),
    "页面必须转发读面带回的 viewerActor（而不是自己给一个值）",
  );
});

test("守卫｜提交：幂等键由纯函数产出、失败保留草稿与键、成功后清空（§3.4 / §8.1）", () => {
  const composer = readSource("squad/WorkItemCommentComposer.tsx");
  assert.ok(
    composer.includes('resolveSubmitId(clientRequestId, "send", newSubmitRequestId)'),
    "提交必须经 resolveSubmitId 生成/沿用幂等键",
  );
  assert.ok(
    composer.includes('resolveSubmitId(requestId, "sent", newSubmitRequestId)'),
    "成功后换新键（复用旧键会把两条评论并成一条）",
  );
  assert.ok(
    composer.includes('resolveSubmitId(requestId, "failed", newSubmitRequestId)'),
    "失败后保留同一把键（重试沿用 = 幂等）",
  );
  assert.ok(composer.includes('data-testid="work-item-comment-send-failure"'), "失败提示锚点");
  assert.ok(composer.includes("comment.retrySend"), "失败要给「重试发送」");
  assert.ok(
    composer.includes("comment.sending") && composer.includes("disabled={!canSubmit}"),
    "发送中禁用重复提交并显示「正在发送」",
  );
  assert.ok(!composer.includes("setOptimistic"), "不做乐观插入（失败时那条假评论没有归宿）");
});

test("守卫｜receipt 插槽挂在评论条目下方，且条目把 receipt/活动原样交给插槽（不在条目里重新判定）", () => {
  const entry = readSource("squad/WorkItemCommentEntry.tsx");
  assert.ok(entry.includes("<WorkItemCommentDispatchSummary"), "插槽挂在条目里");
  assert.ok(
    entry.includes("receipts={receipts}") && entry.includes("activities={activities}"),
    "插槽拿到的是**事实**（receipts/activities），不是先算好的结论",
  );
  const summary = readSource("squad/WorkItemCommentDispatchSummary.tsx");
  for (const pure of [
    "summarizeCommentDispatches(receipts)",
    "commentDispatchNote({ commentId, activities, receipts })",
  ]) {
    assert.ok(summary.includes(pure), `插槽必须用纯函数投影：${pure}`);
  }
});

test("守卫｜图标名在本仓 lucide-react 版本里都存在（C7：不存在 = undefined 组件 = 渲染即崩）", async () => {
  const lucide = (await import("lucide-react")) as Record<string, unknown>;
  for (const file of COLLABORATION_SOURCES) {
    const source = readSource(file);
    const importBlocks = source.matchAll(/import\s*\{([^{}]*)\}\s*from\s*"lucide-react"/g);
    for (const block of importBlocks) {
      for (const rawName of block[1]!.split(",")) {
        // 内联 `type X`（如 `type LucideIcon`）是编译擦除的类型，运行时不导出 —— 跳过。
        if (/^\s*type\s/.test(rawName)) continue;
        const name = rawName.replace(/\btype\b/, "").trim();
        if (name === "" || name.startsWith("//")) continue;
        assert.ok(name in lucide, `${file} 引用了 lucide-react 里不存在的图标 ${name}`);
      }
    }
    // C7 的三个改名项：旧名在 1.17 不存在，出现旧名一定是没照改名名单改。
    for (const renamed of ["FileCode2", "CheckCircle2", "MoreHorizontal"]) {
      assert.ok(!source.includes(renamed), `${file} 不得再用旧图标名 ${renamed}`);
    }
  }
});
