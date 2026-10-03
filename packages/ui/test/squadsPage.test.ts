import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import type { Squad, TeamAgent } from "@zcode/shared";
import type { SquadSnapshot } from "@zcode/services";
import enUS from "../src/i18n/locales/en-US.js";
import zhCN from "../src/i18n/locales/zh-CN.js";
import { dispatchableTeamAgents } from "../src/squad/squadEntryViewModel.js";
import {
  rosterRowActions,
  squadSurfaceViewState,
  type SquadSurfaceViewModelInput,
} from "../src/squad/squadSurfaceViewModel.js";
import {
  canCreateSquad,
  squadCreateEnabled,
  squadEditLeaderCandidates,
  squadEditMemberCandidates,
} from "../src/squad/squadsViewModel.js";

/* 「小队」一级入口（SquadsPage / SquadsList）的用例：**纯逻辑 + 结构守卫**（ui 包没有渲染测试
   设施，这是本项目既定做法，见 squadEntryView.test.ts）。分工：
   ① 状态机 16 格已在 squadAgentsPage.test.ts 逐格覆盖（**同一份共享实现**）⇒ 这里只补
      小队面的**投影格**（`snapshot.squads` 原样透出）与**空候选格**（canCreateSquad 判据）；
   ② 行动作：小队对象走共享 rosterRowActions（一条用例证明"同一函数"）；
   ③ i18n：squad. 前缀双向齐平 + workspace.openSquads 两语 + 归档确认文案必须含「转交」；
   ④ 结构守卫：侧栏入口、shell 接线、页面服务接线与归档确认、设置卡不留拷贝、
      共享状态机**单实现**。每条都写明变异方式，并在交付报告里逐条实测。 */

const SRC_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "../src");
const readSource = (relativePath: string) => readFileSync(resolve(SRC_DIR, relativePath), "utf8");

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
  members: [{ agentId: "a1", role: "leader" }],
  instructions: { stopCondition: "s", maxRounds: "1" },
  enabled: true,
} as Squad;

function snapshotWith(
  parts: Partial<Pick<SquadSnapshot, "teamAgents" | "squads">> & { enabled?: boolean } = {},
): SquadSnapshot {
  return {
    enabled: parts.enabled ?? true,
    teamAgents: parts.teamAgents ?? [],
    squads: parts.squads ?? [],
    workItems: [],
    runs: [],
  };
}

// ---------- ① 小队面的投影格（状态机本体已在智能体页逐格覆盖） ----------

test("投影：ready 暴露整个快照，小队面取 snapshot.squads（原样透出）", () => {
  const input: SquadSurfaceViewModelInput = {
    hasTarget: true,
    snapshot: snapshotWith({ squads: [aSquad], teamAgents: [anAgent] }),
    loading: false,
    failure: null,
  };
  const state = squadSurfaceViewState(input);
  assert.equal(state.mode, "ready");
  assert.ok(state.mode === "ready");
  assert.deepEqual(
    state.snapshot.squads,
    [aSquad],
    "小队面自己投影 snapshot.squads（共享机器不替它投影）",
  );
  assert.equal(state.experimentDisabled, false);
  // 刷新失败 ⇒ ready 之上挂横幅，数据不丢（与智能体面同一条共享语义，这里顺带钉一次）。
  const failed = squadSurfaceViewState({
    ...input,
    failure: {
      tone: "error",
      messageId: "squad.common.operationFailed",
      detail: "x",
    },
  });
  assert.ok(failed.mode === "ready");
  assert.deepEqual(failed.snapshot.squads, [aSquad]);
});

// 空候选格：没有可派发的协作智能体 ⇒ 不能新建（判据是纯函数，页面「新建」按钮与列表空态提示
// 都问它）。变异：把判据改成恒真 ⇒ 本用例红。
test("空候选：没有可派发的协作智能体 ⇒ canCreateSquad 为 false（新建置灰）", () => {
  assert.equal(canCreateSquad(snapshotWith({})), false, "一个智能体都没有 ⇒ 不能建小队");
  assert.equal(
    canCreateSquad(
      snapshotWith({
        teamAgents: [
          { ...anAgent, id: "a2", enabled: false },
          { ...anAgent, id: "a3", archivedAt: 1 },
        ],
      }),
    ),
    false,
    "停用 / 已归档的智能体不算候选（与建小队的队员候选同一条规则）",
  );
  assert.equal(canCreateSquad(snapshotWith({ teamAgents: [anAgent] })), true);
  // 与既有候选判据同源：canCreateSquad 就是「可派发候选非空」。
  const snapshot = snapshotWith({
    teamAgents: [anAgent, { ...anAgent, id: "a2", enabled: false }],
  });
  assert.equal(canCreateSquad(snapshot), dispatchableTeamAgents(snapshot).length > 0);
});

// 新建按钮可点性（四格穷举）：取数失败/加载中（快照为 null）时**置灰** —— 对话框的队长候选
// 来自快照，读不到就开不出可提交的表单（「点得开但通往死路」比置灰更糟）；按钮始终渲染。
// 变异：把 `snapshot !== null` 从 squadCreateEnabled 里去掉 ⇒ 第二格必红。
test("新建可点性：无目标 / 快照未取到 / 无候选 / 有候选 —— 四格逐条断言", () => {
  const withCandidate = snapshotWith({ teamAgents: [anAgent] });
  const withoutCandidate = snapshotWith({ teamAgents: [] });
  assert.deepEqual(
    [
      squadCreateEnabled({ hasTarget: false, snapshot: withCandidate }),
      squadCreateEnabled({ hasTarget: true, snapshot: null }),
      squadCreateEnabled({ hasTarget: true, snapshot: withoutCandidate }),
      squadCreateEnabled({ hasTarget: true, snapshot: withCandidate }),
    ],
    [false, false, false, true],
    "只有「有目标 + 已取到快照 + 有可派发候选」才可点（快照为 null ⇒ 置灰，不给自己一条死路）",
  );
  // 与候选判据同源：squadCreateEnabled 的最后一格就是 canCreateSquad。
  assert.equal(
    squadCreateEnabled({ hasTarget: true, snapshot: withCandidate }),
    canCreateSquad(withCandidate),
  );
});

// ---------- ②b 编辑模式候选：当前队长 / 当前成员即使不可派发也必须在列 ----------
// 审查（controller）发现的缺口：编辑一支"队长已被停用"或"成员已被归档"的小队时，
// 若候选只给可派发集合 —— 队长名会显示成空白（表单像是没队长）、被归档的成员**永远无法移除**
// （归档没有"取消归档"）。修法：编辑模式候选 = 可派发 ∪ 当前成员/队长；**新增**仍只限可派发。
// 变异：把两个 helper 换成裸 `dispatchableTeamAgents` ⇒ 下面两条用例必红。
test("编辑候选：当前队长已停用 ⇒ 仍在队长候选里（名字显示得出来），但非成员的停用智能体不进", () => {
  const disabledLeader = { ...anAgent, id: "a2", enabled: false };
  const disabledNonMember = { ...anAgent, id: "a3", enabled: false };
  const snapshot = snapshotWith({ teamAgents: [anAgent, disabledLeader, disabledNonMember] });
  const squad = { ...aSquad, leaderAgentId: "a2", members: [{ agentId: "a2" }] } as Squad;

  assert.deepEqual(
    squadEditLeaderCandidates(snapshot, squad).map((agent) => agent.id),
    ["a2", "a1"],
    "当前队长在首（可显示/可重选），其余按可派发顺序；非成员的停用智能体不得混进来",
  );
});

test("编辑候选：成员已停用 / 已归档 ⇒ 仍在勾选源里（能被移除），非成员的归档智能体不进", () => {
  const disabledMember = { ...anAgent, id: "a2", enabled: false };
  const archivedMember = { ...anAgent, id: "a3", archivedAt: 1 };
  const archivedNonMember = { ...anAgent, id: "a4", archivedAt: 1 };
  const snapshot = snapshotWith({
    teamAgents: [anAgent, disabledMember, archivedMember, archivedNonMember],
  });
  const squad = {
    ...aSquad,
    leaderAgentId: "a1",
    members: [{ agentId: "a1", role: "leader" }, { agentId: "a2" }, { agentId: "a3" }],
  } as Squad;

  assert.deepEqual(
    squadEditMemberCandidates(snapshot, squad).map((agent) => agent.id),
    ["a1", "a2", "a3"],
    "当前成员全在列（a1 是队长，由对话框按当前选择过滤）；非成员的归档智能体不得混进来",
  );
  // 去重：同一成员只出现一次（可派发集合里已有的不重复追加）。
  const withDup = squadEditMemberCandidates(snapshot, {
    ...squad,
    members: [{ agentId: "a1" }, { agentId: "a1" }, { agentId: "a2" }],
  } as Squad);
  assert.equal(new Set(withDup.map((agent) => agent.id)).size, withDup.length);
});

// ---------- ② 行动作：小队对象走共享的同一函数 ----------

test("行动作：小队对象走共享 rosterRowActions（未归档三 true / 已归档三 false）", () => {
  assert.deepEqual(rosterRowActions(aSquad), {
    canEdit: true,
    canToggle: true,
    canArchive: true,
  });
  assert.deepEqual(rosterRowActions({ ...aSquad, enabled: false }), {
    canEdit: true,
    canToggle: true,
    canArchive: true,
  });
  assert.deepEqual(rosterRowActions({ ...aSquad, archivedAt: 1 }), {
    canEdit: false,
    canToggle: false,
    canArchive: false,
  });
});

// ---------- ③ i18n ----------

test("i18n：squad. 前缀在 zh-CN / en-US 两侧键集完全一致", () => {
  const prefix = "squad.";
  const keysWithPrefix = (locale: Record<string, string>) =>
    Object.keys(locale).filter((key) => key.startsWith(prefix));
  const zhKeys = new Set(keysWithPrefix(zhCN));
  const enKeys = new Set(keysWithPrefix(enUS));

  for (const key of zhKeys) assert.ok(enKeys.has(key), `en-US 缺少 ${key}`);
  for (const key of enKeys) assert.ok(zhKeys.has(key), `zh-CN 缺少 ${key}`);
  // 前缀写错时上面两条会退化成空断言（0 == 0 也算通过）。下限钉住「一条都没比到」。
  assert.ok(zhKeys.size > 25, `squad.* 只比到 ${zhKeys.size} 条，前缀可能写错了`);

  // 旧键不得留孤儿（改名成 squad.common.* 的那批）。
  for (const dropped of [
    "squad.agents.save",
    "squad.agents.edit",
    "squad.agents.enable",
    "squad.agents.disable",
    "squad.agents.archive",
    "squad.agents.experimentOff",
    "squad.agents.settingsMovedHint",
  ]) {
    assert.ok(!zhKeys.has(dropped), `旧键 ${dropped} 应已删除（改名后不留孤儿）`);
    assert.ok(!enKeys.has(dropped), `旧键 ${dropped} 应已删除（改名后不留孤儿）`);
  }
});

test("i18n：小队入口与小队面文案两语都在", () => {
  for (const key of [
    "workspace.openSquads",
    "squad.squads.editTitle",
    "squad.squads.archiveSucceeded",
    "squad.squads.updated",
    "squad.squads.enabledToast",
    "squad.squads.disabledToast",
    "squad.squads.loading",
    "squad.squads.loadFailed",
    "squad.squads.empty",
    "squad.squads.emptyHint",
    "squad.squads.leaderLabel",
    "squad.squads.membersLabel",
    "squad.squads.noDispatchableAgentsHint",
  ]) {
    assert.ok(zhCN[key], `zh-CN 缺少 ${key}`);
    assert.ok(enUS[key], `en-US 缺少 ${key}`);
  }
});

// 归档确认文案必须说清「工作项会转交给队长」—— 那是 archiveSquadAndTransfer 的真实后果，
// 漏了它用户看到的后果与文案不符（破坏性动作的文案失实是最不该的一种）。
test("i18n：归档确认文案含「工作项转交队长」这一后果", () => {
  assert.ok(
    (zhCN["squad.squads.archiveConfirmDescription"] ?? "").includes("转交"),
    "zh 文案必须提到工作项转交（archiveSquadAndTransfer 的真实后果）",
  );
  assert.ok(
    (enUS["squad.squads.archiveConfirmDescription"] ?? "").toLowerCase().includes("transfer"),
    "en copy must mention the transfer to the leader",
  );
  // 占位符成对：{name} 只译一侧会让用户看到原始的 {name}。
  const placeholdersOf = (value: string) =>
    [...value.matchAll(/\{(\w+)\}/g)].map((match) => match[1]).sort();
  for (const key of ["squad.squads.archiveConfirmTitle"]) {
    assert.deepEqual(
      placeholdersOf(enUS[key] ?? ""),
      placeholdersOf(zhCN[key] ?? ""),
      `${key} 的占位符不一致`,
    );
  }
});

// ---------- ④ 结构守卫（逐条可变异） ----------

/* 守卫 a：侧栏「小队」入口。
   变异：① 去掉入口外的 `{showSquadEntries ? (… ) : null}` ⇒ 红（最后一个断言：
   条件块中途闭合 = 入口裸露）；② 为小队另造一个判据变量 ⇒ 红（计数 ≠ 1）；
   ③ 把入口整个删掉 ⇒ 红（找不到 testid）。 */
test("守卫｜侧栏「小队」入口恰一处、紧跟「智能体」之后、挂同一个显隐判据", () => {
  const sidebar = readSource("WorkspaceSidebar.tsx");
  assert.equal(
    (sidebar.match(/squad-squads-sidebar-open/g) ?? []).length,
    1,
    "小队入口按钮只该有一处（为别的形态另抄一份 = 同一语义两处实现）",
  );
  const squadsIndex = sidebar.indexOf("squad-squads-sidebar-open");
  assert.ok(
    squadsIndex > sidebar.indexOf("squad-agents-sidebar-open"),
    "「小队」入口在「智能体」之后（用户入口清单的次序）",
  );
  assert.equal(
    (sidebar.match(/showSquadEntries = squadEntryVisible\(settings\)/g) ?? []).length,
    1,
    "显隐判据变量只此一处：给小队再造一个判据变量 = 同一语义两处实现",
  );
  assert.equal(
    (sidebar.match(/\{showSquadEntries \? \(/g) ?? []).length,
    4,
    "四个实验入口（收件箱 / 智能体 / 小队 / 工作项）都要挂同一个显隐条件",
  );
  // 入口必须真的在**自己的**条件块内：从最近一个条件起点到入口之间不得出现条件闭合。
  const gate = sidebar.lastIndexOf("{showSquadEntries ? (", squadsIndex);
  assert.ok(gate >= 0, "小队入口必须挂在 showSquadEntries 的条件里");
  assert.ok(
    !sidebar.slice(gate, squadsIndex).includes(") : null}"),
    "小队入口必须在 showSquadEntries 条件块内（条件中途就闭合了 = 入口裸奔）",
  );
});

/* 守卫 b：主视图接线。
   变异：① 删掉 `workspaceMainView === "squads"` 分支 ⇒ 红；② 全页判据漏 squads ⇒ 红
   （那会让小队页多出一层 header / 终端面板）。 */
test("守卫｜shell 有 squads 分支且渲染 SquadsPage；全页判据含 squads", () => {
  const layout = readSource("app-shell/WorkspaceShellLayout.tsx");
  assert.ok(layout.includes('workspaceMainView === "squads" ?'), "装饰视图必须有 squads 分支");
  assert.ok(layout.includes("<SquadsPage"), "squads 分支必须渲染 SquadsPage");
  assert.match(
    layout,
    /<SquadsPage\s+workspacePath=\{workspaceAbsPath\}\s+workspaceIdentity=\{workspaceIdentity\}/,
    "目标 workspace 由 shell 传入（与 SquadAgentsPage 同款 props 形态）",
  );
  assert.ok(layout.includes('scope="squads-page"'), "小队页要有独立的 ScopedErrorBoundary scope");
  const predicate = layout.slice(
    layout.indexOf("const isFullPageMainView ="),
    layout.indexOf("const shouldRenderMainViewHeader ="),
  );
  assert.ok(
    predicate.includes('workspaceMainView === "squads"'),
    "全页视图判据漏了 squads（漏一个 = 该入口多一层 header 或终端面板，且不报错）",
  );
  assert.ok(
    layout.includes('squadsActive={workspaceMainView === "squads"}'),
    "侧栏入口的高亮态由同一个主视图判据给出",
  );
});

/* 守卫 c：页面服务接线 + 归档确认必须消费结果 + 新建置灰判据。
   变异各一条：漏一个服务调用 / 去掉 `!confirmed` 提前返回 / 把 canCreateSquad 换成恒真 ⇒ 红。 */
test("守卫｜SquadsPage 走响亮取数通路，四个服务调用齐全，归档经二次确认", () => {
  const page = readSource("squad/SquadsPage.tsx");
  assert.ok(page.includes("resolveSquadRuntimeService("), "取数必须经 resolveSquadRuntimeService");
  assert.ok(
    !page.includes("services.squadRuntimeService"),
    "页面不得直接读 services.squadRuntimeService（那条路会把「服务没接上」静默成 undefined）",
  );
  for (const call of [
    "createSquad(",
    "updateSquad(",
    "setSquadEnabled(",
    // 归档**不新增服务面方法**：UI 直接调既有的 archiveSquadAndTransfer（归档 + 转交）。
    "archiveSquadAndTransfer(",
  ]) {
    assert.ok(page.includes(call), `页面必须接上 ${call}（缺一个就是缺一件功能）`);
  }
  assert.ok(page.includes("requestConfirmation("), "归档必须经确认对话框（破坏性且不可撤销）");
  // 「问了但不管答案」= 确认戏法：结果必须被消费，未确认时**一个服务调用都不发**。
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
    page.includes("squad.squads.archiveConfirmDescription"),
    "确认文案必须说清后果（工作项转交队长 / 花名册与指令保留 / 不可撤销）",
  );
  // 新建按钮的置灰判据必须走纯函数（squadCreateEnabled：有目标 + 已取到快照 + 有候选），
  // 列表空态的「为什么建不了」说明走 canCreateSquad（同一候选判据，两处不各写一遍）。
  assert.ok(
    page.includes("squadCreateEnabled("),
    "新建按钮的置灰判据必须走纯函数 squadCreateEnabled",
  );
  // 编辑模式的候选必须走两个 helper（当前队长/成员即使不可派发也在列；变异：换回裸
  // `dispatchableTeamAgents` ⇒ 本断言红，且上面的 ②b 用例也会红）。
  assert.ok(
    page.includes("squadEditLeaderCandidates(") && page.includes("squadEditMemberCandidates("),
    "编辑对话框的候选必须走 squadEditLeaderCandidates / squadEditMemberCandidates",
  );
  // 测试锚点（后续 e2e 依赖；顺手钉住防被误删）。
  assert.ok(page.includes('data-testid="squads-page"'), "页根 testid 不得改名");
  assert.ok(page.includes('data-testid="squads-create"'), "新建按钮 testid 不得改名");
  const list = readSource("squad/SquadsList.tsx");
  assert.ok(list.includes("data-squad-id"), "行上要有 data-squad-id");
  for (const testid of ["squad-row-edit", "squad-row-toggle", "squad-row-archive"]) {
    assert.ok(list.includes(testid), `行内动作 testid ${testid} 不得缺（锚点）`);
  }
  assert.ok(list.includes("rosterRowActions("), "行内动作判据必须走共享的 rosterRowActions");
});

// 守卫 d：设置卡不留拷贝（与 squadEntryView.test.ts 的同名守卫**同一判据的第二种读法**：
// 那条读"设置卡引用了哪些实体"，这条读"它有没有把视图带回来"——都红才算真的搬干净）。
// 2026-10-03 工作项面落地后 SquadMinimalView 已删：设置卡主体是 ExperimentsSection。
test("守卫｜设置卡不再引用小队表单 / 列表 / 新建分支", () => {
  const section = readSource("settings/ExperimentsSection.tsx");
  assert.ok(!section.includes("SquadDialog"), "设置卡不得引用小队表单");
  assert.ok(!section.includes("SquadMinimalView"), "设置卡不得再渲染 SquadMinimalView（已退役）");
  assert.ok(!section.includes("SquadList"), "设置卡不得引用小队列表");
  assert.ok(!section.includes('setDialog("squad")'), "设置卡不得再有小队的新建分支");
});

/* 守卫 e：共享状态机**单实现**（B0 的单一实现约定）。
   变异：把状态机抄回任一页面 —— 页面里会出现 `{ mode: "…" }` 的**构造** ⇒ 第二个断言咬红；
   旧模块删名不删实（文件还在）⇒ existsSync 那条咬红。 */
test("守卫｜状态机与行动作只有 squadSurfaceViewModel 一份实现（页面不得再构造 mode）", () => {
  const surface = readSource("squad/squadSurfaceViewModel.ts");
  for (const mode of ["no-workspace", "loading", "error", "ready"]) {
    assert.ok(surface.includes(`mode: "${mode}"`), `共享模块必须构造全部四种 mode（缺 ${mode}）`);
  }
  for (const page of ["squad/SquadAgentsPage.tsx", "squad/SquadsPage.tsx"]) {
    const source = readSource(page);
    assert.ok(
      source.includes('from "./squadSurfaceViewModel.js"'),
      `${page} 必须 import 共享模块（两个面同一份状态机）`,
    );
    assert.ok(source.includes("squadSurfaceViewState("), `${page} 必须调 squadSurfaceViewState(`);
    // 页面可以**读** `state.mode === "…"` 来分支渲染，但不得**构造** `mode: "…"`——
    // 那正是「把状态机抄回页面」的形态（抄回来的实现必然要构造 mode 结论；
    // 读法写的是 `=== "…"`，与 `mode: "…"` 这个构造模式不同形）。
    assert.equal(
      (source.match(/mode: "/g) ?? []).length,
      0,
      `${page} 不得构造 mode 结论（状态机只有 squadSurfaceViewModel 一份实现）`,
    );
  }
  // 旧模块必须已不存在（内容全被搬走）；「抄一份回来」由上面的构造守卫拦。
  assert.equal(
    existsSync(resolve(SRC_DIR, "squad/squadAgentsViewModel.ts")),
    false,
    "squadAgentsViewModel 已删（状态机在共享模块里）",
  );
  // 共享模块本身也只能有一处：squad 目录里 export 这台机器与行动作的文件各恰一个。
  const squadDir = resolve(SRC_DIR, "squad");
  const files = readdirSync(squadDir).filter(
    (name) => name.endsWith(".ts") || name.endsWith(".tsx"),
  );
  const defines = (needle: string) =>
    files.filter((name) => readSource(`squad/${name}`).includes(needle));
  assert.deepEqual(
    defines("export function squadSurfaceViewState("),
    ["squadSurfaceViewModel.ts"],
    "状态机只能有一处定义",
  );
  assert.deepEqual(
    defines("export function rosterRowActions"),
    ["squadSurfaceViewModel.ts"],
    "行动作判据只能有一处定义",
  );
  for (const list of ["squad/SquadAgentsList.tsx", "squad/SquadsList.tsx"]) {
    assert.ok(readSource(list).includes("rosterRowActions("), `${list} 必须走共享的行动作判据`);
  }
});
