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
  return { enabled, teamAgents, squads: [], workItems: [], runs: [] };
}

const failure: SquadEntryFeedback = {
  tone: "error",
  messageId: "settings.experiments.squad.operationFailed",
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
  assert.equal(state.feedback.messageId, "settings.experiments.squad.operationFailed");
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

test("行动作：未归档（启用中 / 停用）⇒ 三个都可用", () => {
  assert.deepEqual(rosterRowActions(anAgent), {
    canEdit: true,
    canToggle: true,
    canArchive: true,
  });
  // canToggle 同时覆盖两个方向：停用中的行也要给"启用"（不许按方向拆成两个字段）。
  assert.deepEqual(rosterRowActions({ ...anAgent, enabled: false }), {
    canEdit: true,
    canToggle: true,
    canArchive: true,
  });
});

// 归档是**终态**：仓库里没有"取消归档"（teamAgentService 只有 archive 一个方向），
// 给了按钮也解决不了用户想解决的问题（把智能体弄回来）—— 比不给按钮更糟。
test("行动作：已归档 ⇒ 三个都 false（归档行只显示徽标）", () => {
  assert.deepEqual(rosterRowActions({ ...anAgent, archivedAt: 1 }), {
    canEdit: false,
    canToggle: false,
    canArchive: false,
  });
  // 已归档 + 已停用（两个都叠上）同样是三个 false：归档压过 enabled。
  assert.deepEqual(rosterRowActions({ ...anAgent, archivedAt: 1, enabled: false }), {
    canEdit: false,
    canToggle: false,
    canArchive: false,
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

/* 守卫 a：侧栏一级入口。变异：把 `{showSquadEntries ? (…) : null}` 的显隐去掉
   （入口无条件渲染）⇒ 本用例必红。 */
test("守卫｜侧栏「智能体」入口恰一处、且被 squadEntryVisible 的判据包着", () => {
  const sidebar = readSource("WorkspaceSidebar.tsx");
  assert.equal(
    (sidebar.match(/squad-agents-sidebar-open/g) ?? []).length,
    1,
    "入口按钮只该有一处（为别的形态另抄一份 = 同一语义两处实现）",
  );
  assert.match(
    sidebar,
    /showSquadEntries = squadEntryVisible\(settings\)/,
    "显隐必须只由既有纯函数 squadEntryVisible 给出（它是呈现判据，不是门禁）；" +
      "两个实验入口共用这一个判据变量（别给小队再造一个）",
  );
  assert.equal(
    (sidebar.match(/onOpenSquadAgents\?\.\(\)/g) ?? []).length,
    1,
    "点入口只该有一处回调调用（转发给 shell 切主视图）",
  );
  const gated = sliceBetween(sidebar, "{showSquadEntries ? (", "squad-agents-sidebar-open");
  assert.ok(gated.length > 0, "入口按钮必须在 showSquadEntries 的条件里（关实验 ⇒ 入口整体消失）");
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
// 那条读 SquadMinimalView 的"内容"，这条读"它引用了谁"——两条都红才算真的搬干净）。
test("守卫｜设置卡不再引用智能体表单 / 列表 / 新建分支", () => {
  const view = readSource("squad/SquadMinimalView.tsx");
  assert.ok(!view.includes("TeamAgentDialog"), "设置卡不得引用智能体表单");
  assert.ok(!view.includes("SquadTeamAgentList"), "设置卡不得引用智能体列表");
  assert.ok(!view.includes('setDialog("teamAgent")'), "设置卡不得再有智能体的新建分支");
});
