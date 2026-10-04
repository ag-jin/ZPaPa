import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import type { Squad, TeamAgent, WorkItem } from "@zcode/shared";
import {
  SQUAD_DISPATCH_DISABLED_CODE,
  SquadDispatchDisabledError,
  type ISquadRuntimeServiceShape,
  type SquadRunRecord,
  type SquadSnapshot,
  type SquadWorkspaceTarget,
} from "@zcode/services";
import type { IServiceAccessor } from "@zcode/services";
import {
  SQUAD_RUNTIME_SERVICE_UNAVAILABLE_CODE,
  resolveSquadRuntimeService,
  squadWorkspaceTarget,
} from "../src/squad/squadRuntimeAccess.js";
import {
  SQUAD_DISCARD_CONFIRM_IDLE,
  SQUAD_RUN_STATUS_MESSAGE_IDS,
  cancelSquadDiscard,
  confirmSquadDiscard,
  executeSquadDiscard,
  parseAssigneeValue,
  requestSquadDiscard,
  resolveAssigneeName,
  resolveTeamAgentName,
  reviewOutcomeFeedback,
  squadDiscardableWorkItemIds,
  squadEntryErrorFeedback,
  workItemAssigneeOptions,
} from "../src/squad/squadEntryViewModel.js";

/* 这些用例全部是**纯逻辑**：不渲染 React（ui 包没有渲染测试设施），
   所以「指派候选 / 审查动作 / 关闭实验 / 响亮失败 / 放弃整批」五类矩阵格子都落在这里的纯函数上。
   组件（WorkItemsPage / WorkItemsBoard / SquadRunsReview）只负责把这些纯结论画出来 + 调服务。

   2026-10-03 工作项面落地：`squadEntrySectionState` 随 SquadMinimalView 退役删除（零消费者），
   对应的四条「数据面」用例一并删除；四段列表的呈现由新组件 + 各自的纯函数承接。 */

// ---------- 取数通路（accessor 侧）----------

/** 只提供 `squadRuntimeService` 的替身；读其它任何属性都抛，用来证明解析器**没有**顺手读别的服务。 */
function accessorWithOnlySquadRuntime(service: ISquadRuntimeServiceShape): IServiceAccessor {
  const target = { squadRuntimeService: service } as Record<string, unknown>;
  return new Proxy(target, {
    get(obj, key) {
      if (typeof key === "string" && key in obj) return obj[key];
      throw new Error(`不该读取 accessor 的其它属性：${String(key)}`);
    },
  }) as unknown as IServiceAccessor;
}

const runtimeStub = { getSnapshot: async () => null } as unknown as ISquadRuntimeServiceShape;

test("accessor 上有小队运行时服务时按原样返回", () => {
  assert.equal(resolveSquadRuntimeService(accessorWithOnlySquadRuntime(runtimeStub)), runtimeStub);
});

// 响亮失败优于静默跳过：缺服务时若返回 undefined，界面会一片空白，
// 用户分不清"没有数据"和"服务没接上"。
test("accessor 上没有小队运行时服务时响亮报错", () => {
  const bareAccessor = {} as IServiceAccessor;
  assert.throws(
    () => resolveSquadRuntimeService(bareAccessor),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.ok(
        error.message.includes(SQUAD_RUNTIME_SERVICE_UNAVAILABLE_CODE),
        `错误文本应带稳定码，实际：${error.message}`,
      );
      assert.ok(error.message.includes("squadRuntimeService"), error.message);
      return true;
    },
  );
});

// ---------- 目标 workspace（必须显式）----------

test("没有激活 workspace 时给不出目标", () => {
  assert.equal(squadWorkspaceTarget(null, null), null);
  assert.equal(squadWorkspaceTarget(undefined, "identity"), null);
  assert.equal(squadWorkspaceTarget("   ", "identity"), null);
});

test("目标 workspace 的 identity 缺省为空串（服务内按 path 回落）", () => {
  assert.deepEqual(squadWorkspaceTarget("/w/a", null), { path: "/w/a", identity: "" });
  assert.deepEqual(squadWorkspaceTarget("/w/a", "  "), { path: "/w/a", identity: "" });
});

test("目标 workspace 去掉两侧空白", () => {
  assert.deepEqual(squadWorkspaceTarget("  /w/a  ", "  ssh://host/root  "), {
    path: "/w/a",
    identity: "ssh://host/root",
  });
});

// ---------- 数据面（快照四种形状）----------

function snapshotWith(
  parts: Partial<Pick<SquadSnapshot, "teamAgents" | "squads" | "workItems" | "runs">>,
): SquadSnapshot {
  return {
    enabled: true,
    teamAgents: parts.teamAgents ?? [],
    squads: parts.squads ?? [],
    workItems: parts.workItems ?? [],
    runs: parts.runs ?? [],
  };
}

const anAgent = {
  id: "a1",
  name: "张三",
  systemPrompt: "",
  memoryScope: "project",
  enabled: true,
} as TeamAgent;
const aSquad = {
  id: "s1",
  name: "第 1 小队",
  leaderAgentId: "a1",
  members: [{ agentId: "a1" }],
  instructions: {},
  enabled: true,
} as Squad;
const aWorkItem = {
  id: "w1",
  workspaceIdentity: "id",
  workspacePath: "/w/a",
  title: "父项",
  body: "",
  status: "todo",
  assignee: { type: "squad", id: "s1" },
  labels: [],
  properties: {},
  position: 0,
} as WorkItem;
const aRun = {
  runId: "r1",
  workspaceKey: "id",
  workspacePath: "/w/a",
  workItemId: "w1",
  parentWorkItemId: "w1",
  agentId: "a1",
  isLeaderTask: false,
  branch: "squad/member/r1",
  dirName: "r1",
  status: "produced",
  sessionId: null,
  createdAt: 1,
  updatedAt: 1,
} as SquadRunRecord;

// ---------- 建工作项时的指派选项 ----------

test("指派选项：用户恒在首位，其次是可派发的智能体与小队", () => {
  const options = workItemAssigneeOptions(
    snapshotWith({ teamAgents: [anAgent], squads: [aSquad] }),
  );
  assert.deepEqual(
    options.map((option) => option.value),
    ["user", "agent:a1", "squad:s1"],
  );
  assert.equal(options[0]?.name, "");
});

// 指派取值解析：三种合法形状 + 拼错就抛（不静默造一个空 id 的指派）。
test("指派取值解析：三种形状可用，拼错响亮抛错", () => {
  assert.deepEqual(parseAssigneeValue("user"), { type: "user", id: "user" });
  assert.deepEqual(parseAssigneeValue("agent:a1"), { type: "agent", id: "a1" });
  assert.deepEqual(parseAssigneeValue("squad:s1"), { type: "squad", id: "s1" });
  assert.throws(() => parseAssigneeValue("teamAgent:a1"), /未知的指派取值/);
  assert.throws(() => parseAssigneeValue("agent:"), /未知的指派取值/);
});

// spec §16 S10：归档的智能体在派发时被 skip（不是失败）⇒ 根本不该出现在可派发选项里；
// 停用（enabled === false）同理：给了选项再被拒，等于替用户制造一次失败。
test("指派选项：归档或停用的智能体/小队不进候选", () => {
  const options = workItemAssigneeOptions(
    snapshotWith({
      teamAgents: [
        anAgent,
        { ...anAgent, id: "a2", name: "已归档", archivedAt: 1 },
        { ...anAgent, id: "a3", name: "已停用", enabled: false },
      ],
      squads: [
        aSquad,
        { ...aSquad, id: "s2", archivedAt: 1 },
        { ...aSquad, id: "s3", enabled: false },
      ],
    }),
  );
  assert.deepEqual(
    options.map((option) => option.value),
    ["user", "agent:a1", "squad:s1"],
  );
});

// ---------- 审查动作（四种结果）----------

test("审查：合并成功给成功提示", () => {
  assert.deepEqual(reviewOutcomeFeedback({ ok: true, merged: true }), {
    tone: "success",
    messageId: "squad.runs.merged",
  });
});

// spec §6.2 / §16 S5：打回**不删**工作树，要如实告诉用户「还在」。
test("审查：打回后工作树保留，提示必须是「保留」而不是「完成」", () => {
  assert.deepEqual(reviewOutcomeFeedback({ ok: true, merged: false, kept: true }), {
    tone: "warning",
    messageId: "squad.runs.rejectedKept",
  });
});

// spec §5.7 第 4 项 / §16 S17：冲突解不了 ⇒ 不提前合主分支，且必须让用户看到失败。
test("审查：冲突与分支缺失都是失败提示（不静默）", () => {
  assert.deepEqual(reviewOutcomeFeedback({ ok: false, reason: "conflict", detail: "x" }), {
    tone: "error",
    messageId: "squad.runs.conflict",
  });
  assert.deepEqual(reviewOutcomeFeedback({ ok: false, reason: "branch_missing", detail: "x" }), {
    tone: "error",
    messageId: "squad.runs.branchMissing",
  });
});

// ---------- 显示名与运行状态 ----------

// 查不到对象时回落到 id：显示空会让「队长是谁 / 指给了谁」变成未知，比显示 id 更糟。
test("显示名解析：查不到对象时回落到 id，用户指派由视图本地化", () => {
  const snapshot = snapshotWith({ teamAgents: [anAgent], squads: [aSquad] });
  assert.equal(resolveTeamAgentName(snapshot, "a1"), "张三");
  assert.equal(resolveTeamAgentName(snapshot, "missing"), "missing");
  assert.equal(resolveAssigneeName(snapshot, { type: "user", id: "user" }), null);
  assert.equal(resolveAssigneeName(snapshot, { type: "agent", id: "a1" }), "张三");
  assert.equal(resolveAssigneeName(snapshot, { type: "squad", id: "s1" }), "第 1 小队");
  assert.equal(resolveAssigneeName(snapshot, { type: "squad", id: "s9" }), "s9");
});

// 运行状态文案必须**穷尽**：`Record<SquadRunStatus, string>` 让漏一个状态变成编译错误；
// 这条用例再把「键集 = 服务层五个状态」钉住，防止有人把 Record 改成 Partial 而没被发现。
test("运行状态文案覆盖五个状态", () => {
  assert.deepEqual(Object.keys(SQUAD_RUN_STATUS_MESSAGE_IDS).sort(), [
    "discarded",
    "merged",
    "open",
    "produced",
    "rejected",
  ]);
  for (const messageId of Object.values(SQUAD_RUN_STATUS_MESSAGE_IDS)) {
    assert.ok(messageId.startsWith("squad.runs.status."), messageId);
  }
});

// ---------- 失败提示（含门禁拒绝）----------

// 确认 2：门禁是服务层单点。UI 侧**不判**门禁，只把服务层抛出的稳定码翻译成可读提示 ——
// 既不吞掉它（吞掉就等于用户以为派发成功），也不在这里自己判一遍（那就是第二份判据）。
test("错误提示：门禁拒绝按稳定码翻译成「实验已关闭」", () => {
  assert.deepEqual(squadEntryErrorFeedback(new SquadDispatchDisabledError()), {
    tone: "warning",
    messageId: "squad.common.dispatchDisabled",
  });
  const codeOnly = Object.assign(new Error("boom"), { code: SQUAD_DISPATCH_DISABLED_CODE });
  assert.equal(squadEntryErrorFeedback(codeOnly).messageId, "squad.common.dispatchDisabled");
});

// 网络失败 / 未知错误：一律响亮，且**带上原始细节**，不吞错。
test("错误提示：未知失败带原始细节，不吞错", () => {
  assert.deepEqual(squadEntryErrorFeedback(new Error("ECONNREFUSED")), {
    tone: "error",
    messageId: "squad.common.operationFailed",
    detail: "ECONNREFUSED",
  });
  assert.equal(squadEntryErrorFeedback("plain failure").detail, "plain failure");
});

// ---------- 整批放弃（§6.3「整批可整体放弃」）：入口判据 + 二次确认 ----------

/** 只实现 `discardBatch` 的替身：调用次数与入参都留痕 —— 「未确认 ⇒ 零调用」这条只能靠它证明。 */
function discardSpy(outcome: "ok" | "boom" = "ok") {
  const calls: Array<{ target: SquadWorkspaceTarget; parentWorkItemId: string }> = [];
  const service: Pick<ISquadRuntimeServiceShape, "discardBatch"> = {
    async discardBatch(target, input) {
      calls.push({ target, parentWorkItemId: input.parentWorkItemId });
      if (outcome === "boom") throw new Error("git 炸了");
    },
  };
  return { calls, service };
}

const DISCARD_TARGET: SquadWorkspaceTarget = { path: "/w/a", identity: "id" };

// §6.3 只承诺「整批可整体放弃」，而入口是**破坏性**的 ⇒ 判据必须严：
// ① 批次根（与服务面重驱**同一份定义** `isSquadBatchRoot`）；② 未终态（已结算的批没有可弃之物）；
// ③ 本批确实开过队员 run（否则「会删掉队员分支与集成分支」这句确认文案本身是假话）。
test("放弃整批入口：只给「未终态 + 批次根 + 有队员 run」的工作项", () => {
  const runForW1 = aRun; // parentWorkItemId === "w1"
  const runForW3 = { ...aRun, runId: "r3", parentWorkItemId: "w3" };
  const snapshot = snapshotWith({
    workItems: [
      aWorkItem, // w1：指派给小队 + 有 run + 未终态 ⇒ 给
      { ...aWorkItem, id: "w3", status: "done" }, // 已终态（已结算）⇒ 不给
      { ...aWorkItem, id: "w4" }, // 空批（指派给小队但没有任何 run）⇒ 界面不给（无分支/工作树可删）
      {
        ...aWorkItem,
        id: "w5",
        assignee: { type: "user", id: "user" }, // 非批次根（既没指派给小队、也没 run）⇒ 不给
      },
    ],
    runs: [runForW1, runForW3],
  });
  assert.deepEqual([...squadDiscardableWorkItemIds(snapshot)], ["w1"]);
});

// UI：**未确认时不得执行**（不得一键即毁）。这条用替身证明「一次调用都没有」，
// 而不是读 JSX 相信它 —— 破坏性动作的「没发生」必须是可断言的。
test("放弃整批：未确认 ⇒ 一次都不执行（零调用），并给一条「没有删除任何东西」的提示", async () => {
  const spy = discardSpy();
  const feedback = await executeSquadDiscard({
    service: spy.service,
    target: DISCARD_TARGET,
    decision: confirmSquadDiscard(SQUAD_DISCARD_CONFIRM_IDLE),
  });
  assert.equal(spy.calls.length, 0, "未确认 ⇒ 不得调用 discardBatch（不得一键即毁）");
  assert.deepEqual(feedback, {
    tone: "warning",
    messageId: "squad.discard.notConfirmed",
  });
});

// UI：确认后 ⇒ 执行，且结果可见。
test("放弃整批：确认后执行一次（带显式目标），成功有成功提示", async () => {
  const spy = discardSpy();
  const pending = requestSquadDiscard("w1");
  assert.equal(pending.pendingWorkItemId, "w1", "点按钮只进入待确认态");
  const decision = confirmSquadDiscard(pending);
  assert.deepEqual(decision, { next: SQUAD_DISCARD_CONFIRM_IDLE, workItemId: "w1" });
  // 重复确认：第二次的输入已是空闲态 ⇒ 目标为 null（不会执行第二次）。
  assert.equal(confirmSquadDiscard(decision.next).workItemId, null);

  const feedback = await executeSquadDiscard({
    service: spy.service,
    target: DISCARD_TARGET,
    decision,
  });
  assert.deepEqual(spy.calls, [{ target: DISCARD_TARGET, parentWorkItemId: "w1" }]);
  assert.deepEqual(feedback, {
    tone: "success",
    messageId: "squad.discard.succeeded",
  });
});

test("放弃整批：取消 ⇒ 回到空闲，取消之后（即使再确认）也不执行", async () => {
  const spy = discardSpy();
  const cancelled = cancelSquadDiscard();
  assert.equal(cancelled.pendingWorkItemId, null);
  const feedback = await executeSquadDiscard({
    service: spy.service,
    target: DISCARD_TARGET,
    decision: confirmSquadDiscard(cancelled),
  });
  assert.equal(spy.calls.length, 0);
  assert.equal(feedback.messageId, "squad.discard.notConfirmed");
});

// 失败必须**能读出来**：不稳定码翻译 + 未知失败带原始细节（不吞错）。
test("放弃整批：失败可见（带原始细节，不吞错）", async () => {
  const spy = discardSpy("boom");
  const feedback = await executeSquadDiscard({
    service: spy.service,
    target: DISCARD_TARGET,
    decision: confirmSquadDiscard(requestSquadDiscard("w1")),
  });
  assert.equal(spy.calls.length, 1, "确认后的失败也要真的调过一次服务");
  assert.deepEqual(feedback, {
    tone: "error",
    messageId: "squad.common.operationFailed",
    detail: "git 炸了",
  });
});

/* 组件层的**结构守卫**：ui 包没有渲染测试设施，而「二次确认」这条正确性要求必须被钉住 ——
   于是用几条**结构**断言（这个仓已有先例：上面 renderer accessor 那条就是读源码）：
   ① 页面里**不出现** `discardBatch(` —— 执行只能经 `executeSquadDiscard`（唯一入口），
      于是「点按钮直接执行」这种改法连写都写不出来（写出来本用例红）；
   ② 「点按钮」只能进入待确认态（`requestSquadDiscard`），且必须渲染确认对话框。
   2026-10-03 工作项面落地：这几条守卫**原判据搬到新页面**
   （`src/squad/WorkItemsPage.tsx`）—— SquadMinimalView 已退役，同一判据不许削弱
   （workItemsPage.test.ts 里有一条同名守卫读同一文件，两条一起红才算真的搬干净）。 */
const SRC_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "../src");
const SQUAD_ENTRY_DIR = resolve(SRC_DIR, "squad");

/* ── 接线守卫：**取数失败时「新建」入口仍在（置灰），不是整块消失** ──

   2026-10-03 用户实测：开了实验开关、打开这张卡，只看到「操作失败 + 刷新」，
   第一反应是「**前端没有 UI 承接操作吗？**」——因为入口原本包在 `snapshot && sections` 里，
   读失败就把入口一起藏掉了。**「被错误挡住」看起来和「产品没做入口」一模一样**。
   判据：入口的可见性**不得依赖取数成功**；取数失败时由状态行说明原因、按钮置灰即可。
   工作项面的承接页是 `WorkItemsPage`（侧栏一级入口），置灰判据收敛在纯函数
   `workItemCreateEnabled`（有目标 + 已取到快照）。 */
test("接线守卫｜「新建工作项」入口常驻（无快照⇒置灰），不随取数失败消失", () => {
  const page = readFileSync(resolve(SQUAD_ENTRY_DIR, "WorkItemsPage.tsx"), "utf8");
  assert.equal(
    (page.match(/data-testid="work-items-create"/g) ?? []).length,
    1,
    "工作项入口只该有一处：为错误态另抄一份入口 = 同一语义两处实现",
  );
  assert.equal(
    (page.match(/disabled=\{createDisabled\}/g) ?? []).length,
    1,
    "入口要以「无快照 ⇒ 置灰」的形态常驻（按钮本身始终渲染，可见性不依赖取数成功）",
  );
  assert.ok(
    page.includes("workItemCreateEnabled("),
    "置灰判据必须走纯函数 workItemCreateEnabled（有目标 + 已取到快照）",
  );
  // 入口必须在状态分支**之前**（动作行常驻）——包进 `state.mode === "ready"` 就等于
  // 被错误态连坐藏掉，正是要修的形态。
  const createIndex = page.indexOf('data-testid="work-items-create"');
  const firstModeCheck = page.indexOf("state.mode ===");
  assert.ok(
    createIndex >= 0 && firstModeCheck > createIndex,
    "入口不得整体包在状态条件里（那正是要修的形态）",
  );
});

/* ── 搬家守卫：**设置卡不留任何小队视图拷贝**（2026-10-03 用户裁定：入口是一级导航，不藏设置）──

   设置卡（`ExperimentsSection`）不得再出现智能体 / 小队 / 工作项的新建分支、表单或列表 ——
   只要回来一个，就会出现"设置卡里也能建"的第二份入口，而两份入口迟早分叉
   （改了这处没改那处，且不报错）。本轮收尾后设置区**只留总开关 + 一行指引**。
   变异验证：把 SquadMinimalView 或任一入口加回设置卡 ⇒ 本用例必红。 */
test("搬家守卫｜设置卡不再持有智能体 / 小队 / 工作项视图（不留拷贝），只留一行指引", () => {
  const section = readFileSync(resolve(SRC_DIR, "settings/ExperimentsSection.tsx"), "utf8");
  for (const forbidden of [
    "SquadMinimalView",
    "TeamAgentDialog",
    "SquadDialog",
    "WorkItemDialog",
    "SquadWorkItemList",
    "SquadRunList",
  ]) {
    assert.ok(
      !section.includes(forbidden),
      `设置卡不得再引用 ${forbidden}（视图都在侧栏一级入口）`,
    );
  }
  assert.ok(
    section.includes("squad.common.settingsMovedHint"),
    "必须留一行指引：原处找不到入口会看起来像「功能没了」",
  );
  // 新家：工作项入口的唯一实现在 WorkItemsPage；编辑复用**同一份**表单（mode=edit）。
  const page = readFileSync(resolve(SQUAD_ENTRY_DIR, "WorkItemsPage.tsx"), "utf8");
  const dialogs = readFileSync(resolve(SQUAD_ENTRY_DIR, "WorkItemsPageDialogs.tsx"), "utf8");
  assert.ok(dialogs.includes('mode="edit"'), "编辑复用同一份 WorkItemDialog（mode=edit）");
});

test("组件层：执行只经 executeSquadDiscard（页面里不出现 discardBatch 调用）+ 必须经确认对话框", () => {
  const page = readFileSync(resolve(SQUAD_ENTRY_DIR, "WorkItemsPage.tsx"), "utf8");
  assert.ok(
    !/discardBatch\s*\(/.test(page),
    "页面不得直接调用 discardBatch：执行只能经 executeSquadDiscard（未确认就执行必须写不出来）",
  );
  assert.ok(page.includes("executeSquadDiscard("), "执行必须经视图模型的唯一入口");
  assert.ok(page.includes("requestSquadDiscard("), "点「放弃整批」只能进入待确认态");
  assert.ok(page.includes("<WorkItemsPageDialogs"), "页面必须接线对话框装配组件");
  const dialogs = readFileSync(resolve(SQUAD_ENTRY_DIR, "WorkItemsPageDialogs.tsx"), "utf8");
  assert.ok(dialogs.includes("<SquadDiscardDialog"), "必须经确认对话框");

  // 确认对话框必须**说清后果**（用到那条描述文案）并且是 destructive 变体。
  const dialog = readFileSync(resolve(SQUAD_ENTRY_DIR, "SquadDiscardDialog.tsx"), "utf8");
  assert.ok(
    dialog.includes("squad.discard.description"),
    "确认文案必须说明后果（删哪些分支、工作树会被清、该批判为放弃）",
  );
  assert.ok(dialog.includes('variant="destructive"'), "破坏性动作必须是 destructive 变体");
  assert.ok(!/discardBatch\s*\(/.test(dialog), "对话框只回意图，不执行任何服务调用");
});

// ---------- 取数通路（renderer 侧：只做加法）----------

/* 本次给 renderer accessor 补了一条映射（`ISquadRuntimeService`）。accessor 是逐字段建代理的
   具体类，任何一条既有映射被删掉/改名，对应的页面就会静默失去那个服务 —— 所以这里用**子集**守卫：
   下面这份清单是改动**之前**就有的条目，它们必须全部还在（新增服务不会让本用例误红）。 */
const PINNED_RENDERER_ACCESSOR_DESCRIPTORS = [
  "IBotsService",
  "IBroadcastService",
  "IClientConfigService",
  "IClientScenesService",
  "ICodingPlanSubscriptionService",
  "ICommandsService",
  "IConversationShareService",
  "ICredentialService",
  "ICuaPermissionService",
  "IFeedbackService",
  "IFileService",
  "IFileWatcherService",
  "IGitCheckpointService",
  "IGitService",
  "IHooksService",
  "IMcpSyncService",
  "IMediaPreviewService",
  "IMemoryService",
  "IModelSelectionService",
  "IOAuthService",
  "IOffPeakTaskService",
  "IOnboardingRecordService",
  "IPluginManagementService",
  "IPluginSyncService",
  "IPluginsService",
  "IPromptAttachmentTransferService",
  "IProviderProvisioningTargetService",
  "IProviderSettingsService",
  "IRemoteDeviceConfigService",
  "IRemoteDeviceProjectsService",
  "ISettingService",
  "ISettingsSyncService",
  "ISkillSyncService",
  "ISkillsService",
  "ISubagentsService",
  "ISystemService",
  "ITerminalService",
  "IUsageStatsService",
  "IWikiService",
  "IWindowControllerService",
  "IZCodeAgentService",
  "IZCodeSessionService",
  "IZCodeTaskService",
];

const CLIENT_ACCESSOR_SOURCE_PATH = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../../packages/client/src/remoteServiceAccess.ts",
);

test("renderer accessor 的既有服务映射一条都没少（只做加法）", () => {
  const source = readFileSync(CLIENT_ACCESSOR_SOURCE_PATH, "utf8");
  for (const descriptor of PINNED_RENDERER_ACCESSOR_DESCRIPTORS) {
    assert.ok(
      source.includes(`${descriptor}.channelName`),
      `renderer accessor 丢了 ${descriptor} 的映射`,
    );
  }
  // 本次新增的那条：小队运行时。
  assert.ok(source.includes("ISquadRuntimeService.channelName"));
  // 且必须**不可枚举**：远端 workspace 的 accessor 是 `{...baseServices, …}` 展开组装的，
  // 可枚举的话本机 host 的小队服务会被带进远端 scope（拿远端路径问本机 host）。
  assert.match(
    source,
    /Object\.defineProperty\(this, "squadRuntimeService"[\s\S]*?enumerable: false/,
  );
});
