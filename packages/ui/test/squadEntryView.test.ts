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
} from "@zcode/services";
import type { IServiceAccessor } from "@zcode/services";
import {
  SQUAD_RUNTIME_SERVICE_UNAVAILABLE_CODE,
  resolveSquadRuntimeService,
  squadWorkspaceTarget,
} from "../src/settings/squadEntry/squadRuntimeAccess.js";
import {
  SQUAD_RUN_STATUS_MESSAGE_IDS,
  parseAssigneeValue,
  resolveAssigneeName,
  resolveTeamAgentName,
  reviewOutcomeFeedback,
  squadEntryErrorFeedback,
  squadEntrySectionState,
  workItemAssigneeOptions,
} from "../src/settings/squadEntry/squadEntryViewModel.js";

/* 这些用例全部是**纯逻辑**：不渲染 React（ui 包没有渲染测试设施），
   所以「数据面 / 审查动作 / 关闭实验 / 响亮失败」四类矩阵格子都落在这里的纯函数上。
   组件（SquadMinimalView.tsx）只负责把这些纯结论画出来 + 调服务。 */

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

test("数据面：一段都没有时四段全为空", () => {
  const state = squadEntrySectionState(snapshotWith({}));
  assert.equal(state.teamAgents.empty, true);
  assert.equal(state.squads.empty, true);
  assert.equal(state.workItems.empty, true);
  assert.equal(state.runs.empty, true);
});

test("数据面：只有 run 时只有该段非空", () => {
  const state = squadEntrySectionState(snapshotWith({ runs: [aRun] }));
  assert.equal(state.runs.empty, false);
  assert.deepEqual(state.runs.items, [aRun]);
  assert.equal(state.teamAgents.empty, true);
  assert.equal(state.squads.empty, true);
  assert.equal(state.workItems.empty, true);
});

test("数据面：四段都有时没有空段", () => {
  const state = squadEntrySectionState(
    snapshotWith({ teamAgents: [anAgent], squads: [aSquad], workItems: [aWorkItem], runs: [aRun] }),
  );
  assert.equal(state.teamAgents.empty, false);
  assert.equal(state.squads.empty, false);
  assert.equal(state.workItems.empty, false);
  assert.equal(state.runs.empty, false);
});

// 列表全量渲染（P2c 才虚拟化/分页）：这一段只证明「给了多少就给多少」，不在这里再做任何裁剪。
test("数据面：列表原样透出（本阶段不分页）", () => {
  const many = Array.from({ length: 120 }, (_v, index) => ({ ...aRun, runId: `r${index}` }));
  assert.equal(squadEntrySectionState(snapshotWith({ runs: many })).runs.items.length, 120);
});

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
    messageId: "settings.experiments.squad.review.merged",
  });
});

// spec §6.2 / §16 S5：打回**不删**工作树，要如实告诉用户「还在」。
test("审查：打回后工作树保留，提示必须是「保留」而不是「完成」", () => {
  assert.deepEqual(reviewOutcomeFeedback({ ok: true, merged: false, kept: true }), {
    tone: "warning",
    messageId: "settings.experiments.squad.review.rejectedKept",
  });
});

// spec §5.7 第 4 项 / §16 S17：冲突解不了 ⇒ 不提前合主分支，且必须让用户看到失败。
test("审查：冲突与分支缺失都是失败提示（不静默）", () => {
  assert.deepEqual(reviewOutcomeFeedback({ ok: false, reason: "conflict", detail: "x" }), {
    tone: "error",
    messageId: "settings.experiments.squad.review.conflict",
  });
  assert.deepEqual(reviewOutcomeFeedback({ ok: false, reason: "branch_missing", detail: "x" }), {
    tone: "error",
    messageId: "settings.experiments.squad.review.branchMissing",
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
    assert.ok(messageId.startsWith("settings.experiments.squad.runStatus."), messageId);
  }
});

// ---------- 失败提示（含门禁拒绝）----------

// 确认 2：门禁是服务层单点。UI 侧**不判**门禁，只把服务层抛出的稳定码翻译成可读提示 ——
// 既不吞掉它（吞掉就等于用户以为派发成功），也不在这里自己判一遍（那就是第二份判据）。
test("错误提示：门禁拒绝按稳定码翻译成「实验已关闭」", () => {
  assert.deepEqual(squadEntryErrorFeedback(new SquadDispatchDisabledError()), {
    tone: "warning",
    messageId: "settings.experiments.squad.dispatchDisabled",
  });
  const codeOnly = Object.assign(new Error("boom"), { code: SQUAD_DISPATCH_DISABLED_CODE });
  assert.equal(
    squadEntryErrorFeedback(codeOnly).messageId,
    "settings.experiments.squad.dispatchDisabled",
  );
});

// 网络失败 / 未知错误：一律响亮，且**带上原始细节**，不吞错。
test("错误提示：未知失败带原始细节，不吞错", () => {
  assert.deepEqual(squadEntryErrorFeedback(new Error("ECONNREFUSED")), {
    tone: "error",
    messageId: "settings.experiments.squad.operationFailed",
    detail: "ECONNREFUSED",
  });
  assert.equal(squadEntryErrorFeedback("plain failure").detail, "plain failure");
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
