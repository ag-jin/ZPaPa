import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import type { TeamAgent } from "@zcode/shared";
import type { SquadSnapshot } from "@zcode/services";
import enUS from "../src/i18n/locales/en-US.js";
import zhCN from "../src/i18n/locales/zh-CN.js";
import {
  rosterRowActions,
  squadSurfaceViewState,
  type SquadSurfaceViewModelInput,
} from "../src/squad/squadSurfaceViewModel.js";
import type { SquadEntryFeedback } from "../src/squad/squadEntryViewModel.js";

/* 「智能体」一级入口页面（SquadAgentsPage）的用例：**纯逻辑 + 结构守卫**（ui 包没有渲染测试设施，
   这是本项目既定做法，见 squadEntryView.test.ts）。三部分：
   ① 状态机逐格穷举（16 种组合全覆盖，特别是四条边界：无 workspace 优先 / loading 吃掉旧失败 /
      error 必须带原因 / ready 刷新失败不清空数据）；
   ② 行动作判据三格（未归档启用中 / 未归档停用 / 已归档）；
   ③ 结构守卫：入口显隐、shell 接线、页面服务接线与"归档必须二次确认"、设置卡不留拷贝。
   每条结构守卫都写明**变异方式**（改哪一行会红），并在交付报告里逐条实测。

   状态机与行动作都已抽到 **squadSurfaceViewModel**（小队页共用同一份实现）：本文件的断言
   逐条保留，只把 import / 函数名换成共享模块的（`ready` 现在暴露整个 `snapshot`，
   本面自己投影 `snapshot.teamAgents`——与页面里的投影同一条式子）。 */

const SRC_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "../src");
const readSource = (relativePath: string) => readFileSync(resolve(SRC_DIR, relativePath), "utf8");

const anAgent = {
  id: "a1",
  name: "张三",
  systemPrompt: "你是张三",
  memoryScope: "project",
  enabled: true,
} as TeamAgent;

function snapshotWith(enabled: boolean, teamAgents: TeamAgent[] = []): SquadSnapshot {
  return { enabled, teamAgents, squads: [], workItems: [], runs: [], queuedRuns: [] };
}

const failure: SquadEntryFeedback = {
  tone: "error",
  messageId: "squad.common.operationFailed",
  detail: "ECONNREFUSED",
};

const base: SquadSurfaceViewModelInput = {
  hasTarget: true,
  snapshot: null,
  loading: false,
  failure: null,
};

// ---------- ① 状态机：逐格穷举 ----------

// 无 workspace **优先于一切**：连"加载中"都不说（没有目标就无从加载，spinner 会让人等一个
// 永远不会来的结果）。四格全打：带快照 / 带失败 / 加载中 / 空。
test("状态机：无 workspace 优先于一切（快照 / 失败 / 加载中都不改变结论）", () => {
  for (const input of [
    { ...base, hasTarget: false },
    { ...base, hasTarget: false, snapshot: snapshotWith(true, [anAgent]) },
    { ...base, hasTarget: false, failure },
    { ...base, hasTarget: false, loading: true, failure },
  ]) {
    assert.deepEqual(squadSurfaceViewState(input), { mode: "no-workspace" });
  }
});

// 首帧（effect 未跑：无数据、无失败、非加载）也必须是 loading，而不是空列表 ——
// 空列表会短暂说出"这里什么都没有"这句假话。
test("状态机：有 workspace 无快照 ⇒ loading（首帧 / 加载中 / 重试中）", () => {
  assert.deepEqual(squadSurfaceViewState(base), { mode: "loading" });
  assert.deepEqual(squadSurfaceViewState({ ...base, loading: true }), { mode: "loading" });
  // 重试进行中：旧失败仍在状态里，但"正在读取"优先（照 SquadMinimalView 的 !loading 口径）。
  assert.deepEqual(
    squadSurfaceViewState({ ...base, loading: true, failure }),
    { mode: "loading" },
    "点重试后界面必须真的进入 loading，而不是停在上一次的失败上",
  );
});

// 错误态**必须带原因**（detail）：没有原因的错误等于没有错误态。
test("状态机：有 workspace 无快照 + 失败落定 ⇒ error（带 failure 的 detail）", () => {
  const state = squadSurfaceViewState({ ...base, failure });
  assert.equal(state.mode, "error");
  assert.ok(state.mode === "error");
  assert.equal(state.feedback.messageId, "squad.common.operationFailed");
  assert.equal(state.feedback.detail, "ECONNREFUSED", "错误态必须把原始原因带给用户");
});

test("状态机：有快照 ⇒ ready（数据原样透出，无横幅）", () => {
  const state = squadSurfaceViewState({
    ...base,
    snapshot: snapshotWith(true, [anAgent]),
  });
  assert.equal(state.mode, "ready");
  assert.ok(state.mode === "ready");
  assert.deepEqual(state.snapshot.teamAgents, [anAgent]);
  assert.equal(state.loadFailure, null);
  assert.equal(state.experimentDisabled, false);
});

// 刷新失败**不清空已有数据**：数据仍是它的，失败转为横幅 ——
// 清空等于把一次网络抖动变成"你的智能体都没了"。
test("状态机：有快照 + 刷新失败 ⇒ ready + loadFailure 横幅（数据不丢）", () => {
  const state = squadSurfaceViewState({
    ...base,
    snapshot: snapshotWith(true, [anAgent]),
    failure,
  });
  assert.equal(state.mode, "ready");
  assert.ok(state.mode === "ready");
  assert.deepEqual(state.snapshot.teamAgents, [anAgent], "刷新失败不得清空已有数据");
  assert.equal(state.loadFailure?.detail, "ECONNREFUSED");
});

// `snapshot.enabled === false`（实验关闭）只挂横幅：这是**呈现**，不是门禁
// （门禁是服务层单点 assertDispatchEnabled），名册管理此时仍可用。
test("状态机：快照 enabled=false ⇒ ready + experimentDisabled 横幅", () => {
  const state = squadSurfaceViewState({
    ...base,
    snapshot: snapshotWith(false, [anAgent]),
  });
  assert.equal(state.mode, "ready");
  assert.ok(state.mode === "ready");
  assert.equal(state.experimentDisabled, true);
  assert.deepEqual(
    state.snapshot.teamAgents,
    [anAgent],
    "实验关闭只影响派发，名册仍要列出来（管理可用）",
  );
  // 两个横幅可以同时出现（实验关了 + 刷新失败）：互不遮蔽。
  const both = squadSurfaceViewState({
    ...base,
    snapshot: snapshotWith(false, [anAgent]),
    failure,
  });
  assert.ok(both.mode === "ready");
  assert.equal(both.experimentDisabled, true);
  assert.equal(both.loadFailure?.detail, "ECONNREFUSED");
});

// ---------- ② 行动作判据（归档是终态）----------

test("行动作：未归档（启用中 / 停用）⇒ 编辑/启停/归档可用，恢复不给", () => {
  assert.deepEqual(rosterRowActions(anAgent), {
    canEdit: true,
    canToggle: true,
    canArchive: true,
    canRestore: false,
  });
  // canToggle 同时覆盖两个方向：停用中的行也要给"启用"（不许按方向拆成两个字段）。
  assert.deepEqual(rosterRowActions({ ...anAgent, enabled: false }), {
    canEdit: true,
    canToggle: true,
    canArchive: true,
    canRestore: false,
  });
});

// ⑤刀（矩阵裁定#2）：归档**可恢复**——归档行的唯一动作是「恢复」，其余三个不给。
test("行动作：已归档 ⇒ 编辑/启停/归档不给，恢复给（归档非终态）", () => {
  assert.deepEqual(rosterRowActions({ ...anAgent, archivedAt: 1 }), {
    canEdit: false,
    canToggle: false,
    canArchive: false,
    canRestore: true,
  });
  // 已归档 + 已停用（两个都叠上）同样：归档压过 enabled，恢复仍是唯一动作。
  assert.deepEqual(rosterRowActions({ ...anAgent, archivedAt: 1, enabled: false }), {
    canEdit: false,
    canToggle: false,
    canArchive: false,
    canRestore: true,
  });
});

// ---------- ③a i18n：两语齐全 ----------

test("i18n：squad. 前缀在 zh-CN / en-US 两侧键集完全一致", () => {
  const prefix = "squad.";
  const keysWithPrefix = (locale: Record<string, string>) =>
    Object.keys(locale).filter((key) => key.startsWith(prefix));
  const zhKeys = new Set(keysWithPrefix(zhCN));
  const enKeys = new Set(keysWithPrefix(enUS));

  for (const key of zhKeys) assert.ok(enKeys.has(key), `en-US 缺少 ${key}`);
  for (const key of enKeys) assert.ok(zhKeys.has(key), `zh-CN 缺少 ${key}`);

  // 前缀写错时上面两条会退化成空断言（0 == 0 也算通过）。钉一个下限，让「一条都没比到」变红。
  assert.ok(zhKeys.size > 15, `squad.* 只比到 ${zhKeys.size} 条，前缀可能写错了`);
});

test("i18n：一级入口文案两语都在", () => {
  assert.ok(zhCN["workspace.openSquadAgents"], "zh-CN 缺少 workspace.openSquadAgents");
  assert.ok(enUS["workspace.openSquadAgents"], "en-US 缺少 workspace.openSquadAgents");
});

// 占位符也要成对：`{name}` 只译一侧会让用户看到原始的 `{name}`。
test("i18n：归档确认标题的占位符两语一致", () => {
  const placeholdersOf = (value: string) =>
    [...value.matchAll(/\{(\w+)\}/g)].map((match) => match[1]).sort();
  for (const key of ["squad.agents.archiveConfirmTitle"]) {
    assert.deepEqual(
      placeholdersOf(enUS[key] ?? ""),
      placeholdersOf(zhCN[key] ?? ""),
      `${key} 的占位符不一致`,
    );
  }
});

// ---------- ③b 结构守卫（逐条可变异）----------

/** 取两个标记之间的源码片段（结构守卫用；标记找不到即抛，避免断言悄悄退化）。 */
function sliceBetween(source: string, startMarker: string, endMarker: string): string {
  const start = source.indexOf(startMarker);
  assert.ok(start >= 0, `源码里找不到起点标记：${startMarker}`);
  const end = source.indexOf(endMarker, start);
  assert.ok(end >= 0, `源码里找不到终点标记：${endMarker}`);
  return source.slice(start, end);
}

/* 守卫 a：侧栏一级入口（T2 起位于 AI Team 分组内）。变异：把分组外层
   `{showSquadEntries ? (…) : null}` 的显隐去掉（入口无条件渲染）⇒ 本用例必红。 */
test("守卫｜侧栏「智能体」入口恰一处、在 AI Team 分组内、被 squadEntryVisible 的判据包着", () => {
  const sidebar = readSource("WorkspaceSidebar.tsx");
  assert.equal(
    (sidebar.match(/ai-team-sidebar-agents/g) ?? []).length,
    1,
    "入口按钮只该有一处（为别的形态另抄一份 = 同一语义两处实现）",
  );
  assert.match(
    sidebar,
    /showSquadEntries = squadEntryVisible\(settings\)/,
    "显隐必须只由既有纯函数 squadEntryVisible 给出（它是呈现判据，不是门禁）；" +
      "实验入口共用这一个判据变量（别给小队再造一个）",
  );
  assert.equal(
    (sidebar.match(/onOpenSquadAgents\?\.\(\)/g) ?? []).length,
    1,
    "点入口只该有一处回调调用（转发给 shell 切主视图）",
  );
  const agentsIndex = sidebar.indexOf("ai-team-sidebar-agents");
  assert.ok(
    sidebar.indexOf("ai-team-sidebar-section") < agentsIndex,
    "入口必须位于 AI Team 分组内（multica 纯导航形态）",
  );
  const gate = sidebar.lastIndexOf("{showSquadEntries ? (", agentsIndex);
  assert.ok(gate >= 0, "入口必须挂在 showSquadEntries 的条件里（关实验 ⇒ 分组整体消失）");
  assert.ok(
    !sidebar.slice(gate, agentsIndex).includes(") : null}"),
    "入口必须在条件块内（条件中途闭合 = 入口裸奔）",
  );
});

/* 守卫 b：主视图接线。变异：① 删掉 `workspaceMainView === "agents"` 分支 ⇒ 红；
   ② 全页视图判据里漏掉 agents ⇒ 红（那会让 agents 页多出一层 header / 终端面板）。 */
test("守卫｜shell 有 agents 分支且渲染 SquadAgentsPage；全页判据四处齐全", () => {
  const layout = readSource("app-shell/WorkspaceShellLayout.tsx");
  assert.ok(layout.includes('workspaceMainView === "agents" ?'), "装饰视图必须有 agents 分支");
  assert.ok(layout.includes("<SquadAgentsPage"), "agents 分支必须渲染 SquadAgentsPage");
  assert.match(
    layout,
    /<SquadAgentsPage\s+workspacePath=\{workspaceAbsPath\}\s+workspaceIdentity=\{workspaceIdentity\}/,
    "目标 workspace 由 shell 传入（照 PluginStorePage 的 props 形态）",
  );
  const predicate = sliceBetween(layout, "const isFullPageMainView =", ";");
  for (const view of ["automations", "plugin-store", "agents", "squads"]) {
    assert.ok(
      predicate.includes(`workspaceMainView === "${view}"`),
      `全页视图判据漏了 ${view}（漏一个 = 该入口多一层 header 或终端面板，且不报错）`,
    );
  }
  // 那两处旧的字面量判断必须已收敛（不得再有第二份判据）。
  assert.ok(
    !layout.includes('workspaceMainView !== "automations" && workspaceMainView !== "plugin-store"'),
    "旧的双字面量判断必须已收敛到 isFullPageMainView",
  );
});

/* 守卫 c：页面服务接线 + 归档必须二次确认。变异：把 requestConfirmation 那一段删掉
   （改成点了就归档）⇒ 本用例必红。 */
test("守卫｜SquadAgentsPage 走响亮取数通路，三个写动作齐全，归档经二次确认", () => {
  const page = readSource("squad/SquadAgentsPage.tsx");
  assert.ok(page.includes("resolveSquadRuntimeService("), "取数必须经 resolveSquadRuntimeService");
  assert.ok(
    !page.includes("services.squadRuntimeService"),
    "页面不得直接读 services.squadRuntimeService（那条路会把「服务没接上」静默成 undefined）",
  );
  for (const call of [
    "createTeamAgent(",
    "updateTeamAgent(",
    "setTeamAgentEnabled(",
    "archiveTeamAgent(",
  ]) {
    assert.ok(page.includes(call), `页面必须接上 ${call}（缺一个就是缺一件功能）`);
  }
  assert.ok(page.includes("requestConfirmation("), "归档必须经确认对话框（破坏性且不可撤销）");
  // 「问了但不管答案」= 确认戏法：结果必须被消费，未确认时**一个服务调用都不发**。
  // 变异：把 `!confirmed` 从提前返回里去掉（问了照做）⇒ 本断言红。
  assert.match(
    page,
    /if \(!confirmed \|\| !target\) return;/,
    "确认结果必须真的被消费（未确认 ⇒ 提前返回，不执行任何服务调用）",
  );
  assert.ok(
    page.includes('confirmVariant: "destructive"'),
    "归档确认必须是 destructive 变体（文案要说清后果）",
  );
  assert.ok(
    page.includes("squad.agents.archiveConfirmDescription"),
    "确认文案必须说清后果（不再派发候选 / 定义与记忆保留 / 不可撤销）",
  );
});

// 守卫 d：设置卡不留拷贝（与 squadEntryView.test.ts 的同名守卫**同一判据的第二种读法**：
// 那条读"设置卡引用了哪些实体"，这条读"它有没有把视图带回来"——都红才算真的搬干净）。
// 2026-10-03 工作项面落地后 SquadMinimalView 已删：设置卡主体是 ExperimentsSection。
test("守卫｜设置卡不再引用智能体表单 / 列表 / 新建分支", () => {
  const section = readSource("settings/ExperimentsSection.tsx");
  assert.ok(!section.includes("TeamAgentDialog"), "设置卡不得引用智能体表单");
  assert.ok(!section.includes("SquadMinimalView"), "设置卡不得再渲染 SquadMinimalView（已退役）");
  assert.ok(!section.includes("SquadTeamAgentList"), "设置卡不得引用智能体列表");
  assert.ok(!section.includes('setDialog("teamAgent")'), "设置卡不得再有智能体的新建分支");
});

// 守卫 e（2026-10-04 第 52 轮）：列表卡片的信息密度 —— 模型徽标与描述必须在场。
// 背景：对照 multica 的 Agents 面（「名字/提供商/runtime」），此前我们的列表只有名字 +
// 记忆范围，模型（modelSelection）与描述（description）在数据模型里有、UI 不可见。
// 变异：删掉 SquadAgentsList 里的模型徽标 / 描述分支 ⇒ 本组红。

test("守卫｜智能体列表呈现模型徽标（有配置显示型号，无配置显示默认）", () => {
  const list = readSource("squad/SquadAgentsList.tsx");
  assert.match(
    list,
    /modelSelection/,
    "列表必须读 agent.modelSelection（模型是配置面的一等公民，缺它就是缺一件）",
  );
  assert.match(
    list,
    /squad\.agents\.modelDefault/,
    "无 modelSelection 时必须显示「跟随默认模型」（缺席要可见，不是空白）",
  );
  assert.match(
    list,
    /squad-agent-model-badge/,
    "模型徽标必须有稳定 testid（供后续 e2e / 回归定位）",
  );
});

test("守卫｜智能体列表呈现描述（有则一行截断，无则不渲染）", () => {
  const list = readSource("squad/SquadAgentsList.tsx");
  assert.match(
    list,
    /agent\.description \?/,
    "描述必须条件渲染：有才画（空占位会让卡片看起来坏了一半）",
  );
  assert.match(list, /squad-agent-description/, "描述必须有稳定 testid");
  assert.match(
    list,
    /truncate/,
    "描述必须单行截断（长描述撑破卡片 = 布局缺陷，不是信息密度）",
  );
});

/* ---------- T5：presence 密度的结构守卫（判定矩阵见 squadPresenceViewModel.test.ts） ---------- */

test("守卫｜presence 接线：列表消费 runs/queuedRuns 契约字段，计数 testid 齐全且不裸数字", () => {
  const page = readSource("squad/SquadAgentsPage.tsx");
  assert.ok(
    page.includes("runs={state.snapshot.runs}") && page.includes("queuedRuns={state.snapshot.queuedRuns}"),
    "页面必须把 snapshot 的 runs/queuedRuns 传进列表（排队的唯一合法数据源 = queuedRuns 契约字段）",
  );
  const list = readSource("squad/SquadAgentsList.tsx");
  assert.ok(list.includes("buildAgentPresence("), "presence 判定必须走唯一实现（view model 纯函数）");
  assert.ok(list.includes('data-testid="squad-presence"'), "presence 行须有 squad-presence testid");
  assert.ok(list.includes('data-testid="squad-running-count"'), "运行计数 testid");
  assert.ok(list.includes('data-testid="squad-queued-count"'), "排队计数 testid");
  assert.ok(
    list.includes('t("squad.sidebar.working", { count: presence.runningCount })'),
    "计数必须走带 {count} 占位符的 i18n 键（不裸数字、不字符串拼接）",
  );
  assert.ok(
    list.includes("presence.queuedCount > 0 ?"),
    "runningCount=0 不渲染「运行中·0」；queued>0 才追加 +M 排队（双值条件渲染）",
  );
  assert.ok(list.includes("aria-hidden"), "状态点 aria-hidden（语义在文案，不裸色）");
});

/* ---------- T7 收口：presence 计数键的占位符两语成对（沿归档确认标题先例） ---------- */

test("i18n：presence 计数键占位符两语一致", () => {
  const placeholdersOf = (value: string) =>
    [...value.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join(",");
  for (const key of [
    "squad.sidebar.working",
    "squad.sidebar.queued",
    "squad.sidebar.queuedShort",
    "squad.sidebar.agentCount",
    "squad.sidebar.moreMembers",
  ]) {
    assert.ok(zhCN[key] && enUS[key], `两语缺 ${key}`);
    assert.equal(
      placeholdersOf(zhCN[key] ?? ""),
      placeholdersOf(enUS[key] ?? ""),
      `${key} 占位符不成对（{count} 只译一侧会显示原始花括号）`,
    );
    assert.equal(placeholdersOf(zhCN[key] ?? ""), "count", `${key} 只允许 {count} 一个占位符`);
  }
  // 非计数键不得带占位符（带了的渲染调用没传值会露原始花括号）。
  for (const key of ["squad.sidebar.idle", "squad.sidebar.aiTeam", "squad.sidebar.statusUnavailable"]) {
    assert.equal(placeholdersOf(zhCN[key] ?? ""), "", `${key} 不应带占位符`);
    assert.equal(placeholdersOf(enUS[key] ?? ""), "", `${key} 不应带占位符`);
  }
});

/* ---------- ②刀：表单扩 description/选色器（modelSelection 控件归②b） ---------- */

test("守卫｜表单含描述与身份色选色器：色板=TEAM_AGENT_COLORS 九色、radio 语义、提交带可选字段", () => {
  const dialog = readSource("squad/SquadCreateDialogs.tsx");
  assert.ok(dialog.includes("TEAM_AGENT_COLORS.map"), "选色器必须走 shared 单源色板常量");
  assert.ok(dialog.includes('data-testid="squad-agent-color-picker"'), "选色器 testid");
  assert.ok(dialog.includes('role="radiogroup"'), "radio 组语义（可访问）");
  assert.ok(
    dialog.includes("aria-checked={color === candidate}"),
    "单选语义（aria-checked）",
  );
  assert.ok(
    dialog.includes("setColor(color === candidate ? undefined : candidate)"),
    "再点同色可撤销回未选（undefined=不落盘）",
  );
  assert.ok(
    dialog.includes("description.trim().length > 0 ? { description: description.trim() }"),
    "描述空串不落盘（schema optional 语义）",
  );
  assert.ok(
    dialog.includes("SUBAGENT_COLOR_CLASS") && !dialog.includes("bg-success"),
    "色板只表达身份（spec §11.3），表单不得出现状态色",
  );
  // 页面编辑初值带新字段（编辑可回填描述与既有色）。
  const page = readSource("squad/SquadAgentsPage.tsx");
  assert.ok(
    page.includes("dialog.agent.description") && page.includes("dialog.agent.color"),
    "编辑初值回填 description/color",
  );
});

/* ---------- ②b：表单接模型选择（ModelPickerRow 复用） ---------- */

test("守卫｜模型选择走 ModelPickerRow 复用：受控值含推理档位、服务缺失不阻塞表单、编辑回填", () => {
  const dialog = readSource("squad/SquadCreateDialogs.tsx");
  assert.ok(dialog.includes("<ModelPickerRow"), "模型选择必须复用 ModelPickerRow（清单/生效值/推理档位规则单点）");
  assert.ok(dialog.includes('data-testid="squad-agent-model-picker"'), "选择器容器 testid");
  assert.ok(
    dialog.includes("modelView ?? { status: \"unavailable\""),
    "页面未传视图时禁用态降级，不阻塞表单其余字段",
  );
  assert.ok(
    dialog.includes("...(reasoningLevel !== undefined\n                    ? { options: { reasoningLevel } }"),
    "推理档位并入 modelSelection.options（不另立字段）",
  );
  assert.ok(
    dialog.includes("...(modelSelection !== undefined\n            ? {"),
    "未选定不落盘（undefined 不进提交）",
  );
  const page = readSource("squad/SquadAgentsPage.tsx");
  assert.ok(
    page.includes("useModelSelectionServiceView(") && page.includes("modelView={modelView}"),
    "页面持有模型视图 hook 并传入 dialog（表单不起第二份取数）",
  );
  assert.ok(page.includes("dialog.agent.modelSelection"), "编辑初值回填 modelSelection");
});

/* ---------- ③a：skills 令牌输入 + permissionMode 三态下拉 ---------- */

test("守卫｜③a 表单：skills 令牌化（去空去重、空=不提交）、permissionMode 三态含「未设置」", () => {
  const dialog = readSource("squad/SquadCreateDialogs.tsx");
  assert.ok(dialog.includes('data-testid="squad-agent-skills-input"'), "skills 输入 testid");
  assert.ok(
    dialog.includes(".split(/[,，\\s]+/)") && dialog.includes("[...new Set("),
    "令牌化：逗号/空白分隔 + 去重保序",
  );
  assert.ok(
    dialog.includes("skillsTokens !== null ? { skills: skillsTokens }"),
    "空输入不提交（保持原值），显式 [] 才是清空（服务面语义）",
  );
  assert.ok(dialog.includes('data-testid="squad-agent-permission-mode"'), "权限模式下拉 testid");
  assert.ok(
    dialog.includes('"unset"') && dialog.includes('value="plan"'),
    "三态：未设置（schema optional 合法值）/auto/plan",
  );
  const page = readSource("squad/SquadAgentsPage.tsx");
  assert.ok(
    page.includes("dialog.agent.skills") && page.includes("dialog.agent.permissionMode"),
    "编辑初值回填 skills/permissionMode",
  );
});

/* ---------- ③b：tools/disallowedTools 编辑器 ---------- */

test("守卫｜③b 工具编辑器：all/custom 两态（[]=全部）、复选清单走 TOOL_OPTIONS 单源、禁用工具令牌", () => {
  const dialog = readSource("squad/SquadCreateDialogs.tsx");
  assert.ok(dialog.includes('data-testid="squad-agent-tools-mode"'), "工具模式 testid");
  assert.ok(
    dialog.includes('data-testid="squad-agent-tools-editor"'),
    "编辑器容器 testid",
  );
  assert.ok(
    dialog.includes("TOOL_OPTIONS.map") &&
      dialog.includes('import { TOOL_OPTIONS } from "@/settings/SubagentsSection.js"'),
    "复选清单必须走 SubagentsSection 的 TOOL_OPTIONS 单源（另抄一份会漂移）",
  );
  assert.ok(
    dialog.includes('...(toolMode === "all"' + "\n" + '            ? { tools: [] }'),
    "「允许全部」显式提交 tools=[]（空数组=全部的既有口径；undefined 才是保持原值）",
  );
  assert.ok(
    dialog.includes("preservedToolsRef"),
    "未知工具名随提交原样保留（不因不在复选清单而丢失）",
  );
  assert.ok(dialog.includes('data-testid="squad-agent-disallowed-input"'), "禁用工具令牌输入 testid");
  const page = readSource("squad/SquadAgentsPage.tsx");
  assert.ok(
    page.includes("dialog.agent.tools") && page.includes("dialog.agent.disallowedTools"),
    "编辑初值回填 tools/disallowedTools",
  );
});

/* ---------- ⑤刀剩余半边：归档可恢复 ---------- */

test("守卫｜归档可恢复：canRestore 判据、恢复按钮、确认文案无「不可撤销」、服务面 restore", () => {
  const roster = readSource("squad/squadSurfaceViewModel.ts");
  assert.ok(
    roster.includes("canRestore: archived"),
    "canRestore = archived（归档行唯一动作；非归档行不给恢复）",
  );
  const agentList = readSource("squad/SquadAgentsList.tsx");
  const squadList = readSource("squad/SquadsList.tsx");
  assert.ok(agentList.includes('data-testid="squad-agent-restore"'), "智能体恢复按钮 testid");
  assert.ok(squadList.includes('data-testid="squad-row-restore"'), "小队恢复按钮 testid");
  // 确认文案不再出现「不可撤销」（两语）。
  assert.ok(!zhCN["squad.agents.archiveConfirmDescription"]?.includes("不可撤销"), "智能体文案已改可恢复");
  assert.ok(!zhCN["squad.squads.archiveConfirmDescription"]?.includes("不可撤销"), "小队文案已改可恢复");
  assert.ok(!enUS["squad.agents.archiveConfirmDescription"]?.includes("cannot be undone"), "EN 文案已改");
  assert.ok(!enUS["squad.squads.archiveConfirmDescription"]?.includes("cannot be undone"), "EN 小队文案已改");
  assert.ok(zhCN["squad.common.restore"] && enUS["squad.common.restore"], "restore 键两语齐");
});
