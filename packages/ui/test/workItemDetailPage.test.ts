import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  COMMENT_DISPATCH_OUTCOMES,
  WORK_ITEM_ACTIVITY_KINDS,
  type IServiceAccessor,
  type WorkItemCollaborationRead,
} from "@zcode/services";
import enUS from "../src/i18n/locales/en-US.js";
import zhCN from "../src/i18n/locales/zh-CN.js";
import {
  WORK_ITEM_COLLABORATION_SERVICE_UNAVAILABLE_CODE,
  resolveWorkItemCollaborationService,
} from "../src/squad/workItemCollaborationAccess.js";
import {
  collaborationLoadFailed,
  collaborationLoadStarted,
  collaborationLoadSucceeded,
  WORK_ITEM_COLLABORATION_IDLE,
} from "../src/squad/useWorkItemCollaboration.js";
import { COMMENT_DISPATCH_OUTCOME_MESSAGE_IDS } from "../src/squad/workItemCollaborationViewModel.js";

/** 详情页命名空间的全键（任务卡 §6.1 的 53 键 + §6.3 的 9 条差额；手抄自设计案表，独立真源）。 */
const WORK_ITEM_DETAIL_MESSAGE_IDS = [
  "squad.workItemDetail.back",
  "squad.workItemDetail.notFound",
  "squad.workItemDetail.loading",
  "squad.workItemDetail.loadFailed",
  "squad.workItemDetail.retry",
  "squad.workItemDetail.activity.title",
  "squad.workItemDetail.activity.empty",
  "squad.workItemDetail.activity.jumpToLatest",
  "squad.workItemDetail.activity.linkUnavailable",
  "squad.workItemDetail.comment.add",
  "squad.workItemDetail.comment.placeholder",
  "squad.workItemDetail.comment.replyingTo",
  "squad.workItemDetail.comment.cancelReply",
  "squad.workItemDetail.comment.sending",
  "squad.workItemDetail.comment.sendFailed",
  "squad.workItemDetail.comment.retrySend",
  "squad.workItemDetail.comment.deleted",
  "squad.workItemDetail.comment.delete",
  "squad.workItemDetail.comment.deleteTitle",
  "squad.workItemDetail.comment.deleteDescription",
  "squad.workItemDetail.comment.note",
  "squad.workItemDetail.comment.noteHint",
  "squad.workItemDetail.comment.resolved",
  "squad.workItemDetail.comment.resolve",
  "squad.workItemDetail.comment.reopen",
  "squad.workItemDetail.comment.reply",
  "squad.workItemDetail.comment.react",
  "squad.workItemDetail.comment.reacted",
  "squad.workItemDetail.comment.author.human",
  "squad.workItemDetail.comment.author.agent",
  "squad.workItemDetail.comment.sourceRole.leader",
  "squad.workItemDetail.comment.sourceRole.member",
  "squad.workItemDetail.comment.sourceRole.standalone",
  "squad.workItemDetail.mention.all",
  "squad.workItemDetail.mention.allHint",
  "squad.workItemDetail.mention.unresolved",
  "squad.workItemDetail.mention.ambiguous",
  "squad.workItemDetail.inline.unavailable",
  "squad.workItemDetail.decision.label",
  "squad.workItemDetail.decision.proposal",
  "squad.workItemDetail.decision.accepted",
  "squad.workItemDetail.decision.rejected",
  "squad.workItemDetail.decision.superseded",
  "squad.workItemDetail.decision.reopened",
  "squad.workItemDetail.dispatch.pending",
  "squad.workItemDetail.dispatch.opened",
  "squad.workItemDetail.dispatch.queued",
  "squad.workItemDetail.dispatch.coalesced",
  "squad.workItemDetail.dispatch.deferred",
  "squad.workItemDetail.dispatch.blocked",
  "squad.workItemDetail.dispatch.failed",
  "squad.workItemDetail.dispatch.suppressed",
  "squad.workItemDetail.dispatch.moreTargets",
  // §6.3 差额 9 键（设计案 §7 未列、但被设计案自身的必需状态逼出）。
  "squad.workItemDetail.activity.loadFailed",
  "squad.workItemDetail.activity.open",
  "squad.workItemDetail.overview.bodyShow",
  "squad.workItemDetail.overview.bodyHide",
  "squad.workItemDetail.comment.disabled.archived",
  "squad.workItemDetail.comment.disabled.readFailed",
  "squad.workItemDetail.comment.submitDisabled.empty",
  "squad.workItemDetail.mention.rosterUnavailable",
] as const;

/* B5.1 轮 1：详情页**取数通路**的用例。

   ① 解析器（`workItemCollaborationAccess`）：缺服务**响亮抛**（稳定码），不返回 undefined ——
      静默兜底会把「服务没接上」伪装成「这条工作项没有活动」；
   ② 装载态机（`useWorkItemCollaboration` 的纯分支）：首次 loading / 失败 / **刷新失败保留旧值**，
      这三格是设计案 §3.4「刷新失败不清空正文」的可测面。 */

function read(): WorkItemCollaborationRead {
  return {
    workItem: {
      id: "wi-1",
      workspaceIdentity: "ws",
      workspacePath: "/w",
      title: "标题",
      body: "",
      status: "todo",
      assignee: { type: "user", id: "u" },
      labels: [],
      properties: {},
      position: 0,
    },
    comments: [],
    activities: [],
    decisions: [],
    /* #7 D1b：读模型多了交付物清单（详情页的交付物区读它）。 */
    deliverables: [],
    /* #8 D2：读模型多了「PR 关联清单 + 读数面可用性」（详情页的 PR 区读它们）。 */
    pullRequests: [],
    pullRequestProvider: { available: false, reason: "未配置 token" },
    reactions: [],
    receipts: [],
    viewerActor: { kind: "human", id: "local-user" },
  };
}

test("取数通路：accessor 上没有该服务 ⇒ 抛稳定码错误（不返回 undefined）", () => {
  assert.throws(
    () => resolveWorkItemCollaborationService({} as IServiceAccessor),
    (error: unknown) =>
      (error as { code?: string }).code === WORK_ITEM_COLLABORATION_SERVICE_UNAVAILABLE_CODE,
  );
});

test("取数通路：有该服务 ⇒ 原样返回同一个对象（只读这一个属性，不顺手读别的服务）", () => {
  const service = { getWorkItemCollaboration: async () => null };
  const resolved = resolveWorkItemCollaborationService({
    workItemCollaborationService: service,
  } as unknown as IServiceAccessor);
  assert.equal(resolved, service);
});

test("装载态机：空闲 → 首次加载 ⇒ loading（骨架只属于首次加载）", () => {
  assert.deepEqual(WORK_ITEM_COLLABORATION_IDLE, { status: "idle" });
  assert.deepEqual(collaborationLoadStarted(WORK_ITEM_COLLABORATION_IDLE), { status: "loading" });
});

test("装载态机：加载成功 ⇒ ready（无刷新标记、无刷新失败）", () => {
  const state = collaborationLoadSucceeded({ status: "loading" }, read());
  assert.deepEqual(state, {
    status: "ready",
    read: read(),
    refreshing: false,
    refreshFailure: null,
  });
});

test("装载态机：读回 null（本条工作项不存在）也是 ready —— not-found 不是故障", () => {
  assert.deepEqual(collaborationLoadSucceeded({ status: "loading" }, null), {
    status: "ready",
    read: null,
    refreshing: false,
    refreshFailure: null,
  });
});

test("装载态机：无数据时失败 ⇒ failed（带原因）；重试 ⇒ 回到 loading", () => {
  const failed = collaborationLoadFailed({ status: "loading" }, "boom");
  assert.deepEqual(failed, { status: "failed", error: "boom" });
  assert.deepEqual(collaborationLoadStarted(failed), { status: "loading" });
});

test("装载态机：刷新失败 ⇒ **保留上次数据** + 区域告警，不清空已读到的正文（设计案 §3.4）", () => {
  const ready = collaborationLoadSucceeded({ status: "loading" }, read());
  const refreshing = collaborationLoadStarted(ready);
  assert.deepEqual(refreshing, {
    status: "ready",
    read: read(),
    refreshing: true,
    refreshFailure: null,
  });
  const failedRefresh = collaborationLoadFailed(refreshing, "network");
  assert.equal(failedRefresh.status, "ready", "有数据时不退回 failed（那会把正文整片抹掉）");
  assert.deepEqual(failedRefresh, {
    status: "ready",
    read: read(),
    refreshing: false,
    refreshFailure: "network",
  });
});

/* ---------- 组件结构守卫（设计案 §8 / 任务卡 §7） ---------- */

const SRC_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "../src");
const readSource = (relativePath: string) => readFileSync(resolve(SRC_DIR, relativePath), "utf8");

/** B-5 线两个轮次的 UI 源码文件（反向断言的扫描面；轮 2 追加两个新组件；
    C3.2 再追加决定面的两个文件 —— R1/R2 的禁用词对它同样生效）。 */
const ROUND_ONE_SOURCES = [
  "squad/WorkItemDetailPage.tsx",
  "squad/WorkItemCollaborationTimeline.tsx",
  "squad/WorkItemCommentEntry.tsx",
  "squad/WorkItemCommentComposer.tsx",
  "squad/WorkItemCommentDeleteDialog.tsx",
  "squad/WorkItemCommentDispatchSummary.tsx",
  "squad/WorkItemMentionMenu.tsx",
  "squad/workItemCollaborationViewModel.ts",
  "squad/workItemMentionViewModel.ts",
  "squad/workItemDecisionViewModel.ts",
  "squad/workItemCollaborationAccess.ts",
  "squad/useWorkItemCollaboration.ts",
  "squad/WorkItemDecisionDialog.tsx",
];

test("守卫｜详情页四态与协作区 testid 齐备（页根 / 返回 / 概览 / 加载 / 失败 / 不存在 / 协作区）", () => {
  const page = readSource("squad/WorkItemDetailPage.tsx");
  for (const testId of [
    "work-item-detail-page",
    "work-item-detail-back",
    "work-item-detail-overview",
    "work-item-detail-body-toggle",
    "work-item-detail-not-found",
    "work-item-detail-loading",
    "work-item-detail-load-failure",
    "work-item-collaboration",
    "work-item-collaboration-failure",
  ]) {
    assert.ok(page.includes(`data-testid="${testId}"`), `详情页缺 testid ${testId}`);
  }
  assert.ok(
    page.includes("workItemId === null ? (") ||
      page.includes("workItemId === null ||") ||
      page.includes("state.read === null"),
    "不存在 / 未选中必须走同一个 not-found 分支（不是两套说辞）",
  );
});

test("守卫｜时间线：唯一混排列表 + 四类条目 + 空态 + 跳到最新（不存在评论/活动双分区）", () => {
  const timeline = readSource("squad/WorkItemCollaborationTimeline.tsx");
  for (const testId of [
    "work-item-activity-timeline",
    "work-item-activity-empty",
    "work-item-activity-jump-latest",
    "timeline-entry-comment",
    "timeline-entry-decision",
    "timeline-entry-system",
    "timeline-entry-link-error",
  ]) {
    assert.ok(
      timeline.includes(`data-testid="${testId}"`) || timeline.includes(`"${testId}"`),
      `时间线缺 ${testId}`,
    );
  }
  assert.ok(timeline.includes("<ol"), "时间线用语义 <ol>");
  const dispatches = ["buildWorkItemTimelineEntries("];
  for (const call of dispatches) {
    assert.ok(timeline.includes(call), `时间线必须消费投影 ${call}（不在组件里重新推导领域语义）`);
  }
});

test("守卫｜评论条目：锚点/墓碑/解决态/回复入口/回应容器/根专属解决入口", () => {
  const entry = readSource("squad/WorkItemCommentEntry.tsx");
  assert.ok(entry.includes("work-item-comment-${comment.id}"), "单条评论稳定锚点 testid");
  for (const testId of [
    "work-item-comment-deleted",
    "work-item-comment-resolved",
    "work-item-comment-reply",
    "work-item-comment-resolve",
    "work-item-comment-reactions",
  ]) {
    assert.ok(entry.includes(`data-testid="${testId}"`), `评论条目缺 testid ${testId}`);
  }
  // R5：解决入口只在线程根（结构上的判据，不是一个大概的判断）。
  assert.ok(
    entry.includes("comment.threadId === comment.id"),
    "解决/重开入口的条件必须是 comment.threadId === comment.id（根专属）",
  );
  // R3：正文只经 commentDisplayBody 投影（墓碑分支结构上拿不到正文）。
  assert.ok(entry.includes("commentDisplayBody(comment)"), "正文必须经 commentDisplayBody 投影");
  assert.ok(
    !/comment\.(normalizedBody|body)\b/.test(entry),
    "条目组件不得直接引用 normalizedBody/body（墓碑分支结构上漏不出正文）",
  );
});

test("守卫｜composer：外壳齐备 + Note mode + 回复上下文 + 提交真的可点（轮 2 写面已接通）", () => {
  const composer = readSource("squad/WorkItemCommentComposer.tsx");
  for (const testId of [
    "work-item-comment-composer",
    "work-item-comment-input",
    "work-item-comment-submit",
    "work-item-comment-note-toggle",
    "work-item-comment-reply-context",
    "work-item-comment-mention-unavailable",
  ]) {
    assert.ok(composer.includes(`data-testid="${testId}"`), `composer 缺 testid ${testId}`);
  }
  /* 轮 2：写面接通 ⇒ 唯一开关位打开；禁用理由改由「归档 / 读取失败 / 内容为空」三格给出
     （不再有「当前版本暂不支持」这个死键 —— 它已在两个 locale 删除）。 */
  assert.ok(
    composer.includes("export const WORK_ITEM_COMMENT_SUBMIT_ENABLED = true;"),
    "轮 2 的写面开关位必须是打开的常量（回退整条写入面时只改这一处）",
  );
  assert.ok(
    !composer.includes("comment.disabled.writeUnavailable"),
    "死键（轮 1 专用的「暂不支持」原因）不得残留",
  );
  const submitMarker = composer.indexOf('data-testid="work-item-comment-submit"');
  const submitCall = composer.slice(submitMarker - 400, submitMarker);
  assert.ok(
    submitCall.includes("disabled={!canSubmit}"),
    "提交按钮的 disabled 绑定到唯一判据 canSubmit",
  );
  assert.ok(
    composer.includes("WORK_ITEM_COMMENT_SUBMIT_ENABLED &&") &&
      composer.includes("comment.submitDisabled.empty"),
    "canSubmit 由写面开关 + 内容非空 + 非发送中共同决定，且空内容有理由文案",
  );
});

test("守卫｜@ 菜单：role=listbox + 候选稳定 id + ↑↓/Enter/Escape 键盘路径", () => {
  const menu = readSource("squad/WorkItemMentionMenu.tsx");
  assert.ok(menu.includes('data-testid="work-item-mention-menu"'), "菜单根 testid");
  assert.ok(menu.includes('role="listbox"'), "@ 菜单必须是 listbox");
  assert.ok(menu.includes('role="option"'), "候选项必须是 option");
  assert.ok(menu.includes("work-item-mention-option-${option.id}"), "候选稳定 id testid");
  const composer = readSource("squad/WorkItemCommentComposer.tsx");
  assert.ok(composer.includes("moveMentionSelection("), "键盘选择复用纯函数（索引算术可测）");
  assert.ok(
    composer.includes('"Escape"') && composer.includes('"Enter"'),
    "键盘路径必须落在实现里",
  );
});

test("反向断言｜R1：详情页/时间线/composer/view model/取数模块不 import 任何 repo、node:sqlite、@zcode/services/node", () => {
  for (const file of ROUND_ONE_SOURCES) {
    const source = readSource(file);
    for (const forbidden of [
      "workItemCommentRepo",
      "workItemActivityRepo",
      "workItemDecisionRepo",
      "workItemCommentReactionRepo",
      "commentDispatchReceiptRepo",
      "node:sqlite",
      "@zcode/services/node",
    ]) {
      assert.ok(
        !source.includes(forbidden),
        `${file} 不得出现 ${forbidden}（UI 不碰 repo/存储面）`,
      );
    }
  }
});

test("反向断言｜R2：UI 源码不出现 Run 创建 / 派发写入调用（不创建 Run、不写派发）", () => {
  for (const file of ROUND_ONE_SOURCES) {
    const source = readSource(file);
    for (const forbidden of [
      "openMemberRun",
      "recordLeaderRun",
      "planDispatch",
      "discardBatch",
      "settleCommentDispatchReceipt",
    ]) {
      assert.ok(!source.includes(forbidden), `${file} 不得出现 ${forbidden}`);
    }
  }
});

test("反向断言｜R6：@all 不映射为任何 receipt outcome；mention.all 与 dispatch.* 两组键不交叉", () => {
  /* 轮 2 起 receipt 映射就在 view model 里（R7 要求它穷尽），故这一条不再用「文件里不出现闭集名」
     这种粗代理，而是直接钉**映射的值**：七值全部属派发族，且没有任何一条是 mention 族。 */
  const values = Object.values(COMMENT_DISPATCH_OUTCOME_MESSAGE_IDS);
  assert.equal(new Set(values).size, COMMENT_DISPATCH_OUTCOMES.length);
  for (const value of values) {
    assert.ok(value.startsWith("squad.workItemDetail.dispatch."), `${value} 必须是派发族文案`);
    assert.ok(!value.includes("mention."), `${value} 不得是 mention 族文案（@all 不是派发状态）`);
  }
  assert.ok(
    !values.includes("squad.workItemDetail.mention.all"),
    "@all 的文案键不得出现在任何 receipt outcome 上",
  );
  for (const file of [...ROUND_ONE_SOURCES, "squad/WorkItemMentionMenu.tsx"]) {
    const source = readSource(file);
    for (const outcome of COMMENT_DISPATCH_OUTCOMES) {
      assert.ok(
        !new RegExp(`mention\\.all[\\s\\S]{0,120}dispatch\\.${outcome}`).test(source),
        `${file}：mention.all 与 dispatch.${outcome} 不得交叉赋值`,
      );
    }
  }
});

test("反向断言｜R8：receipt 插槽只在**有 receipt** 时渲染，且没有任何「重试派发」入口", () => {
  const summary = readSource("squad/WorkItemCommentDispatchSummary.tsx");
  assert.ok(
    summary.includes('data-testid="work-item-comment-dispatch-summary"'),
    "插槽容器由 receipt 投影驱动",
  );
  assert.ok(
    summary.includes("data-testid={`work-item-comment-dispatch-${item.outcome}`}"),
    "七值各自的锚点由 outcome 生成（穷尽由纯函数映射保证）",
  );
  assert.ok(
    summary.includes('data-testid="work-item-comment-suppressed"'),
    "抑制注记与 receipt 分离，各有自己的锚点",
  );
  // 空插槽不渲染：组件在投影为空时直接返回 null（不留空卡片）。
  assert.ok(
    /summary\.inline\.length === 0 && noteMessageId === null[\s\S]{0,120}return null/.test(summary),
    "没有 receipt 也没有抑制事实 ⇒ 不渲染（连空壳都不留）",
  );
  // 只读：UI 里没有任何派发写入/推进调用（重试派发归 host 的补投通道）。
  for (const file of ROUND_ONE_SOURCES) {
    const source = readSource(file);
    for (const forbidden of ["settleCommentDispatchReceipt", "settleIfUnsettled"]) {
      assert.ok(!source.includes(forbidden), `${file} 不得出现 ${forbidden}（插槽是只读的）`);
    }
  }
});

test("反向断言｜R9：写入只在页面的唯一执行点出现，且全 UI 无乐观插入、无第二个事实源刷新", () => {
  const page = readSource("squad/WorkItemDetailPage.tsx");
  // 三个写入口只在页面出现（组件拿到的是回调，不是服务对象）。
  for (const writeCall of [
    "createWorkItemComment",
    "setWorkItemCommentResolved",
    "addWorkItemCommentReaction",
  ]) {
    assert.ok(page.includes(writeCall), `${writeCall} 必须由页面执行（不在子组件里直接调服务）`);
    for (const file of ROUND_ONE_SOURCES.filter(
      (entry) => entry !== "squad/WorkItemDetailPage.tsx",
    )) {
      assert.ok(
        !readSource(file).includes(writeCall),
        `${file} 不得直接调 ${writeCall}（子组件只拿到回调）`,
      );
    }
  }
  // 破坏性动作**只有一个**执行点，且它只接受确认态产出的目标（形态抄 executeSquadDiscard）。
  const vm = readSource("squad/workItemCollaborationViewModel.ts");
  const occurrences = ROUND_ONE_SOURCES.flatMap((file) =>
    readSource(file).includes("softDeleteWorkItemComment") ? [file] : [],
  );
  assert.deepEqual(
    occurrences,
    ["squad/workItemCollaborationViewModel.ts"],
    "softDeleteWorkItemComment 只允许在 executeCommentDelete 里出现（组件/页面都不得直接调）",
  );
  assert.ok(
    /commentId === null\) return \{ deleted: false \}/.test(vm),
    "未确认（commentId === null）⇒ 一级都不执行",
  );
  // 无乐观插入；写入成功后只刷新协作读模型（不重取快照）。
  for (const file of ROUND_ONE_SOURCES) {
    const source = readSource(file);
    for (const forbidden of ["setOptimistic", "optimisticComment"]) {
      assert.ok(!source.includes(forbidden), `${file} 不得本地模拟落盘`);
    }
  }
  const afterLoad = page.slice(page.indexOf("const runCommentAction"));
  assert.ok(
    !afterLoad.slice(0, 1600).includes("getSnapshot("),
    "写入路径不得再取一次快照（一次动作只刷新一个事实源）",
  );
});

test("接线守卫｜R4：三处接线成对——index 导出描述符 + node 注册 + client 代理（enumerable:false）", () => {
  const servicesIndex = readFileSync(resolve(SRC_DIR, "../../services/src/index.ts"), "utf8");
  const node = readFileSync(resolve(SRC_DIR, "../../services/src/node.ts"), "utf8");
  const client = readFileSync(resolve(SRC_DIR, "../../client/src/remoteServiceAccess.ts"), "utf8");
  assert.ok(
    servicesIndex.includes("IWorkItemCollaborationService"),
    "services/index.ts 未导出描述符",
  );
  assert.ok(
    node.includes(".register(\n      IWorkItemCollaborationService,") ||
      node.includes("register(IWorkItemCollaborationService,"),
    "node.ts 未注册描述符",
  );
  assert.ok(
    node.includes("createWorkItemCollaborationService({"),
    "node.ts 未装配 createWorkItemCollaborationService",
  );
  const proxy = client.slice(
    client.indexOf('Object.defineProperty(this, "workItemCollaborationService"'),
    client.indexOf('Object.defineProperty(this, "workItemCollaborationService"') + 400,
  );
  assert.ok(
    proxy.includes("enumerable: false"),
    "client 代理必须不可枚举（防远端 workspace 泄漏）",
  );
});

/* ---------- 导航接线（§3.2 的 S1–S8 静默同步点）与两个入口 ---------- */

test("守卫｜S1+S2：work-item-detail 在枚举与全页判据中成对（漏判据 ⇒ 多一层 header/终端面板且不报错）", () => {
  const types = readSource("app-shell/types.ts");
  assert.ok(types.includes('| "work-item-detail"'), "枚举必须有 work-item-detail");
  const shell = readSource("app-shell/WorkspaceShellLayout.tsx");
  const predicate = shell.slice(
    shell.indexOf("const isFullPageMainView ="),
    shell.indexOf(";", shell.indexOf("const isFullPageMainView =")),
  );
  assert.ok(
    predicate.includes('workspaceMainView === "work-item-detail"'),
    "全页判据必须含 work-item-detail（静默点：漏掉 = header/终端面板多渲染一层）",
  );
});

test("守卫｜S3：render 链有 work-item-detail 分支且渲染详情页组件（漏 ⇒ 落 else 页面不显示）", () => {
  const shell = readSource("app-shell/WorkspaceShellLayout.tsx");
  assert.ok(
    shell.includes('workspaceMainView === "work-item-detail" ? ('),
    "render 链必须有 work-item-detail 分支",
  );
  assert.ok(shell.includes("<WorkItemDetailPage"), "分支必须渲染详情页组件");
  assert.ok(
    shell.indexOf('workspaceMainView === "work-item-detail" ? (') <
      shell.indexOf(': workspaceMainView === "squads" ? ('),
    "分支必须在 else 链中（有条件渲染，不是死代码）",
  );
  assert.ok(
    shell.includes("workItemId={workItemDetailIntent?.workItemId ?? null}"),
    "shell → 页面 id 透传",
  );
});

test("守卫｜S4：进详情时侧栏「工作项」入口保持高亮（漏 ⇒ 进详情失焦）", () => {
  const shell = readSource("app-shell/WorkspaceShellLayout.tsx");
  assert.ok(
    shell.includes(
      'workspaceMainView === "work-items" || workspaceMainView === "work-item-detail"',
    ),
    "侧栏 active 判据须覆盖 work-item-detail（详情归属工作项入口）",
  );
});

test("守卫｜S5+S6：返回判据成对——shell 顶栏与 App 键盘导航都把 work-item-detail 送回来源视图", () => {
  const shell = readSource("app-shell/WorkspaceShellLayout.tsx");
  const shellBack = shell.slice(
    shell.indexOf("const primaryNavigationBack"),
    shell.indexOf("useCallback", shell.indexOf("const primaryNavigationBack") + 10) + 300,
  );
  assert.ok(
    shellBack.includes('workspaceMainView === "work-item-detail"'),
    "shell 顶栏返回判据必须覆盖 work-item-detail（静默点）",
  );
  assert.ok(
    shellBack.includes("handleBackFromWorkItemDetail"),
    "shell 返回动作须指向详情返回 handler",
  );
  assert.ok(
    shell.includes("canPrimaryNavigationBack =") &&
      shell
        .slice(
          shell.indexOf("const canPrimaryNavigationBack ="),
          shell.indexOf(";", shell.indexOf("const canPrimaryNavigationBack =")),
        )
        .includes('workspaceMainView === "work-item-detail"'),
    "canPrimaryNavigationBack 也必须覆盖（否则返回键不亮）",
  );
  const app = readSource("App.tsx");
  const appBack = app.slice(
    app.indexOf("const handlePrimaryNavigationBack"),
    app.indexOf("useAppKeyboard({"),
  );
  assert.ok(
    appBack.includes('workspaceMainView === "work-item-detail"'),
    "App 键盘返回判据必须覆盖",
  );
  assert.ok(
    appBack.includes("handleBackFromWorkItemDetailApp"),
    "App 返回动作须指向详情返回 handler",
  );
  assert.ok(
    app
      .slice(app.indexOf("const canPrimaryNavigationBack ="))
      .includes('workspaceMainView === "work-item-detail"'),
    "App 的 canPrimaryNavigationBack 同样要覆盖（静默点：漏了键盘返回失灵）",
  );
});

test("守卫｜S7：App 意图态与 props 链完整（意图 → shell → 详情页；入口回调 → 看板/任务表）", () => {
  const app = readSource("App.tsx");
  assert.ok(
    app.includes("const [workItemDetailIntent, setWorkItemDetailIntent] = useState"),
    "App 意图态",
  );
  assert.ok(app.includes("workItemDetailIntent={workItemDetailIntent}"), "App → shell 透传");
  assert.ok(
    app.includes("onOpenWorkItemDetail={handleOpenWorkItemDetail}"),
    "App → shell 透传打开回调",
  );
  assert.ok(app.includes("returnView"), "返回语义由意图里的 returnView 决定（详情页不猜历史）");
  const shell = readSource("app-shell/WorkspaceShellLayout.tsx");
  assert.ok(shell.includes("onOpenWorkItemDetail={onOpenWorkItemDetail}"), "shell → 看板透传");
  assert.ok(
    shell.includes("onOpenWorkItem={") || shell.includes("onOpenWorkItem("),
    "shell → agent 详情任务表透传打开回调",
  );
});

test("守卫｜S8：两个入口——看板行覆盖按钮 + agent 任务表行标题（各自 testid）", () => {
  const board = readSource("squad/WorkItemsBoard.tsx");
  assert.ok(
    board.includes('data-testid="work-item-row-open-detail"'),
    "看板行必须有透明覆盖按钮（行内已有独立按钮，整行 button 嵌套非法）",
  );
  assert.ok(
    board.includes("absolute inset-0"),
    "覆盖按钮必须是绝对定位透明层（照 SquadAgentsList 先例）",
  );
  assert.ok(board.includes("relative z-10"), "动作区必须抬到 z-10（点击命中的硬要求）");
  const page = readSource("squad/WorkItemsPage.tsx");
  assert.ok(page.includes("onOpenWorkItemDetail"), "看板页透传打开回调");
  const agentPage = readSource("squad/SquadAgentDetailPage.tsx");
  assert.ok(
    agentPage.includes('data-testid="squad-agent-detail-task-open"'),
    "agent 任务表行标题必须是可访问入口",
  );
  assert.ok(agentPage.includes("onOpenWorkItem"), "agent 详情页接收打开回调");
});

test("守卫｜看板滚动位置恢复（§3.1；无渲染设施 ⇒ 只做源码级钉住 + 人工演示）", () => {
  const app = readSource("App.tsx");
  assert.ok(app.includes("workItemsScrollTop"), "App 持有看板滚动位置（跨视图卸载后仍有值）");
  const shell = readSource("app-shell/WorkspaceShellLayout.tsx");
  assert.ok(shell.includes("workItemsScrollTop"), "shell 接收并还原滚动位置");
  assert.ok(
    shell.includes("useLayoutEffect"),
    "还原必须在 layout 阶段（渲染后立刻，用户看不到跳动）",
  );
});

test("守卫｜R10：i18n 全键两语齐 + 占位符成对 + 两族键数 == 闭集大小", () => {
  for (const key of WORK_ITEM_DETAIL_MESSAGE_IDS) {
    assert.ok(zhCN[key], `zh-CN 缺键 ${key}`);
    assert.ok(enUS[key], `en-US 缺键 ${key}`);
  }
  const placeholders = (value: string) =>
    [...value.matchAll(/\{(\w+)\}/g)]
      .map((match) => match[1])
      .sort()
      .join(",");
  for (const key of WORK_ITEM_DETAIL_MESSAGE_IDS) {
    assert.equal(
      placeholders(zhCN[key] ?? ""),
      placeholders(enUS[key] ?? ""),
      `${key} 的占位符两语不成对`,
    );
  }
  // `activity.kind.*` 子树按服务面运行时闭集逐项展开（键数天然 == 闭集大小）。
  for (const kind of WORK_ITEM_ACTIVITY_KINDS) {
    assert.ok(
      zhCN[`squad.workItemDetail.activity.kind.${kind}`] &&
        enUS[`squad.workItemDetail.activity.kind.${kind}`],
      `activity kind ${kind} 缺两语文案`,
    );
  }
  assert.equal(
    WORK_ITEM_ACTIVITY_KINDS.map((kind) => `squad.workItemDetail.activity.kind.${kind}`).length,
    WORK_ITEM_ACTIVITY_KINDS.length,
    "activity.kind.* 键数 == Activity 闭集",
  );
  for (const outcome of COMMENT_DISPATCH_OUTCOMES) {
    assert.ok(
      zhCN[`squad.workItemDetail.dispatch.${outcome}`] &&
        enUS[`squad.workItemDetail.dispatch.${outcome}`],
      `receipt outcome ${outcome} 缺两语文案`,
    );
  }
});
