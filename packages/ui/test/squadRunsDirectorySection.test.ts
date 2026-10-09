import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import type { TeamAgent } from "@zcode/shared";
import type { SquadRunRecord, SquadSnapshot } from "@zcode/services";
import enUS from "../src/i18n/locales/en-US.js";
import zhCN from "../src/i18n/locales/zh-CN.js";
import { resolveSubagentColorFromName } from "../src/lib/subagentColors.js";
import {
  resolveAgentSectionRenderable,
  RUNNING_AGENT_AVATAR_MAX_DOTS,
  runningAgentAvatarColors,
  mergeRunningSubagentsWithSquadRuns,
} from "../src/v4/conversationStatusPanelModel.js";
import {
  squadDirectorySectionVisible,
  squadRunDirectoryRows,
} from "../src/squad/squadRunsDirectoryViewModel.js";

/* 会话「智能体目录」侧栏的「小队运行（本项目）」分区（spec §11.1 决策 C11 的合并入口）
   与会话状态面板头像簇：**纯逻辑 + 结构守卫**（ui 包没有渲染测试设施，本项目既定做法，
   见 squadAgentsPage.test.ts / squadEntryView.test.ts）。每条结构守卫都写明**变异方式**，
   并在交付报告里逐条实测咬红。 */

const SRC_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "../src");
const readSource = (relativePath: string) => readFileSync(resolve(SRC_DIR, relativePath), "utf8");

const anAgent = {
  id: "a1",
  name: "张三",
  systemPrompt: "",
  memoryScope: "project",
  enabled: true,
} as TeamAgent;

/** 队长 run：`branch` 为 null（队长在主工作树上干活，没有队员分支）。 */
const aLeaderRun = {
  runId: "r1",
  workspaceKey: "wk",
  workspacePath: "/w/a",
  workItemId: "w1",
  parentWorkItemId: "w1",
  agentId: "a1",
  isLeaderTask: true,
  branch: null,
  dirName: null,
  status: "open",
  sessionId: "s-1",
  createdAt: 1,
  updatedAt: 1,
} as SquadRunRecord;

/** 队员 run：有自己的分支与会话。 */
const aMemberRun = {
  ...aLeaderRun,
  runId: "r2",
  isLeaderTask: false,
  branch: "squad/member/r2",
  dirName: "r2",
  status: "produced",
  sessionId: "s-2",
  createdAt: 2,
} as SquadRunRecord;

function snapshotWith(parts: { teamAgents?: TeamAgent[]; runs?: SquadRunRecord[] }): SquadSnapshot {
  return {
    enabled: true,
    teamAgents: parts.teamAgents ?? [],
    squads: [],
    workItems: [],
    runs: parts.runs ?? [],
    queuedRuns: [],
  };
}

test("守卫｜会话面板按 taskListVersion 刷新，失败不清空既有快照", () => {
  const panel = readSource("v4/ConversationStatusPanel.tsx");
  assert.match(panel, /taskListVersion/);
  assert.ok(panel.includes("[services, squadTarget, settings, taskListVersion]"));
  assert.ok(panel.includes("// 失败保留旧快照，避免把已有会话 subagent 簇误报为 0。"));
});

test("头像簇合并：活跃 run 去重、排除当前会话、无 sessionId 可计数", () => {
  const base = [
    {
      agentId: "a0",
      childSessionId: "session-existing",
      subagentType: "subagent",
      title: "已有",
      status: "running",
    },
  ] as never[];
  const snapshot = snapshotWith({
    teamAgents: [anAgent],
    runs: [
      { ...aMemberRun, runId: "same-run", sessionId: "session-existing" },
      { ...aMemberRun, runId: "current", sessionId: "current-session" },
      { ...aMemberRun, runId: "no-session", sessionId: null },
      { ...aMemberRun, runId: "merged", status: "merged" },
    ],
  });
  const result = mergeRunningSubagentsWithSquadRuns(base, snapshot, "current-session");
  assert.deepEqual(
    result.map((item) => item.childSessionId),
    ["session-existing", "no-session"],
  );
  assert.equal(result.length, 2);
});

// 空快照 ⇒ 没有行（空态文案由组件画；这里只证明投影本身不出假行）。
test("行投影：空快照 ⇒ 空数组", () => {
  assert.deepEqual(squadRunDirectoryRows(snapshotWith({})), []);
});

// 队长 run（徽标=队长 / 分支回落 runId / 状态文案复用 squad.runs.status.* / 色按名字稳定取）。
test("行投影：队长 run —— 徽标「队长」、无分支回落 runId、状态文案复用、色按名字稳定", () => {
  const rows = squadRunDirectoryRows(snapshotWith({ teamAgents: [anAgent], runs: [aLeaderRun] }));
  assert.deepEqual(rows, [
    {
      runId: "r1",
      agentName: "张三",
      color: resolveSubagentColorFromName("张三"),
      roleMessageId: "squad.runs.leader",
      statusMessageId: "squad.runs.status.open",
      branchLabel: "r1",
      sessionId: "s-1",
    },
  ]);
});

// 队员 run（徽标=队员；有分支就显示分支）+ `sessionId` 为空的格子（既有的「打开会话」判据靠它）。
test("行投影：队员 run —— 徽标「队员」、显示分支；sessionId 空 ⇒ null（可否打开的唯一判据）", () => {
  const memberRows = squadRunDirectoryRows(
    snapshotWith({ teamAgents: [anAgent], runs: [aMemberRun] }),
  );
  assert.equal(memberRows[0]?.roleMessageId, "squad.runs.member");
  assert.equal(memberRows[0]?.branchLabel, "squad/member/r2");
  assert.equal(memberRows[0]?.statusMessageId, "squad.runs.status.produced");
  assert.equal(memberRows[0]?.sessionId, "s-2");

  const noSession = squadRunDirectoryRows(
    snapshotWith({ teamAgents: [anAgent], runs: [{ ...aLeaderRun, sessionId: null }] }),
  );
  assert.equal(noSession[0]?.sessionId, null, "台账里没有会话就必须是 null（组件据此不给按钮）");
});

// agent 不在名册（定义被删/归档）也照常成行：名字回落 id、色按名字稳定取 —— 目录是运行历史的
// 窗口，不该因为定义没了就让历史运行从目录里消失。
test("行投影：agent 不在 teamAgents ⇒ 名字回落 id、色按名字稳定取", () => {
  const rows = squadRunDirectoryRows(
    snapshotWith({ runs: [{ ...aMemberRun, agentId: "ghost-agent" }] }),
  );
  assert.equal(rows[0]?.agentName, "ghost-agent");
  assert.equal(rows[0]?.color, resolveSubagentColorFromName("ghost-agent"));
});

// 定义里设了色（teamAgent.color）⇒ 用定义的色，不按名字另取。
test("行投影：agent 定义设了色 ⇒ 用定义的色", () => {
  const rows = squadRunDirectoryRows(
    snapshotWith({
      teamAgents: [{ ...anAgent, color: "purple" }],
      runs: [aMemberRun],
    }),
  );
  assert.equal(rows[0]?.color, "purple");
});

// 两条同 agent 的运行**不合并**（每行是一次独立 run），且顺序 = 快照给定顺序（不重排）。
test("行投影：两条同 agent 的运行不合并；顺序 = 快照给定顺序", () => {
  const rows = squadRunDirectoryRows(
    snapshotWith({
      teamAgents: [anAgent],
      runs: [aMemberRun, { ...aLeaderRun, runId: "r0", createdAt: 0 }],
    }),
  );
  assert.deepEqual(
    rows.map((row) => row.runId),
    ["r2", "r0"],
    "顺序不得重排（重排会让行在每次刷新时跳位）",
  );
  assert.equal(
    rows.filter((row) => row.agentName === "张三").length,
    2,
    "同 agent 的两条运行各成一行",
  );
});

// ---------- ② 整段显隐（四格：远端恒 false）----------

const settingsOn = { experimentalAgentSquadsEnabled: true };
const settingsOff = { experimentalAgentSquadsEnabled: false };

// 远端会话（投射端）**恒不渲染**：这是投射边界（spec §16 S9），不是「显示服务不可用」——
// 投射端连小队运行时服务都没有，挂一个必然读不到东西的分区等于让用户以为功能坏了。
// 变异（M2）：把 remoteSessionId 的判断从 squadDirectorySectionVisible 里去掉 ⇒ 前两格必红。
test("显隐：远端会话恒 false（实验开 / 关都不渲染 —— 投射边界）", () => {
  assert.equal(
    squadDirectorySectionVisible({ remoteSessionId: "remote-1", settings: settingsOn }),
    false,
    "远端 workspace 上小队的取数通路取不到（renderer 有意不映射），恒不渲染",
  );
  assert.equal(
    squadDirectorySectionVisible({ remoteSessionId: "remote-1", settings: settingsOff }),
    false,
    "远端 + 实验关闭同样不渲染",
  );
});

// 本机 workspace：显隐只随实验开关（复用 squadEntryVisible 语义：未加载 / 未设置 ⇒ 不可见）。
test("显隐：本机 workspace 随实验开关（设置未加载 ⇒ 不可见）", () => {
  assert.equal(squadDirectorySectionVisible({ settings: settingsOn }), true);
  assert.equal(squadDirectorySectionVisible({ settings: settingsOff }), false);
  assert.equal(
    squadDirectorySectionVisible({ settings: null }),
    false,
    "设置加载中 ⇒ 不可见（不闪现未授权的 UI）",
  );
  assert.equal(squadDirectorySectionVisible({ settings: undefined }), false);
  // remoteSessionId 是空串 / 空白 ⇒ 不是远端会话，跟随开关。
  assert.equal(squadDirectorySectionVisible({ remoteSessionId: "", settings: settingsOn }), true);
});

// ---------- ③ 头像簇色点（数量 + 溢出 + 稳定）----------

type AvatarInput = { agentId: string; title: string; childSessionId: string };
const avatarInputs = (count: number): AvatarInput[] =>
  Array.from({ length: count }, (_, index) => ({
    agentId: `a${index}`,
    title: `t${index}`,
    childSessionId: `c${index}`,
  }));

// 四格：0 / 1 / 恰好 maxDots / 超过 maxDots（溢出计数）。上限定数 4（模型层常量）。
test("头像簇：0 / 1 / 恰好上限 / 超过上限 —— 四格逐条断言", () => {
  assert.equal(RUNNING_AGENT_AVATAR_MAX_DOTS, 4, "上限定数 4（两处渲染共用这一个常量）");
  assert.deepEqual(runningAgentAvatarColors([], RUNNING_AGENT_AVATAR_MAX_DOTS), {
    colors: [],
    overflowCount: 0,
  });
  const one = runningAgentAvatarColors(avatarInputs(1), RUNNING_AGENT_AVATAR_MAX_DOTS);
  assert.equal(one.colors.length, 1);
  assert.equal(one.overflowCount, 0);
  const exact = runningAgentAvatarColors(avatarInputs(4), RUNNING_AGENT_AVATAR_MAX_DOTS);
  assert.equal(exact.colors.length, 4);
  assert.equal(exact.overflowCount, 0);
  const over = runningAgentAvatarColors(avatarInputs(6), RUNNING_AGENT_AVATAR_MAX_DOTS);
  assert.equal(over.colors.length, 4, "超过上限只画 maxDots 个点");
  assert.equal(over.overflowCount, 2, "其余计数（+K）");
});

// 同一份输入两次结果一致（组件重渲染不闪色）：色是身份的稳定哈希，不是随机数。
test("头像簇：同一份输入两次结果一致（稳定）", () => {
  const inputs = avatarInputs(3);
  assert.deepEqual(
    runningAgentAvatarColors(inputs, RUNNING_AGENT_AVATAR_MAX_DOTS),
    runningAgentAvatarColors(inputs, RUNNING_AGENT_AVATAR_MAX_DOTS),
  );
});

// 身份口径：有 agentId 用 agentId（同一 agent 的两次运行同色）；缺 agentId 回落 title。
test("头像簇：色按身份稳定（agentId 优先，缺省回落 title）", () => {
  const sameAgent = runningAgentAvatarColors(
    [
      { agentId: "x", title: "t1", childSessionId: "c1" },
      { agentId: "x", title: "t2", childSessionId: "c2" },
    ],
    RUNNING_AGENT_AVATAR_MAX_DOTS,
  );
  assert.equal(
    sameAgent.colors[0],
    sameAgent.colors[1],
    "同一 agent 的两次运行同色（身份，不是状态）",
  );
  const titled = runningAgentAvatarColors(
    [{ title: "标题甲", childSessionId: "c9" }],
    RUNNING_AGENT_AVATAR_MAX_DOTS,
  );
  assert.equal(titled.colors[0], resolveSubagentColorFromName("标题甲"));
});

// ---------- ④ i18n：新增文案两语齐全 + subagentDirectory. 命名空间级齐平 ----------

test("i18n：本轮新增文案两语齐全（含 squad.runs.member）", () => {
  for (const key of [
    "subagentDirectory.squadRuns.title",
    "subagentDirectory.squadRuns.empty",
    "subagentDirectory.squadRuns.loadFailed",
    "squad.runs.member",
    // 复用的既有键也要在（组件直接用的那一批）。
    "squad.common.refresh",
    "squad.runs.leader",
    "squad.runs.openSession",
    "squad.common.experimentOff",
  ]) {
    assert.ok(zhCN[key], `zh-CN 缺少 ${key}`);
    assert.ok(enUS[key], `en-US 缺少 ${key}`);
  }
});

// 命名空间级对照（照既有写法）：`subagentDirectory.` 下的键在两侧必须完全一致。
// 下限写死 16（= 本轮改完后的确数：既有 13 条 + squadRuns.* 3 条）—— 前缀写错时双向断言会
// 退化成空断言（0 == 0 也算通过），下限让「一条都没比到」变红。
test("i18n：subagentDirectory. 前缀在两侧键集完全一致（双向 + 下限）", () => {
  const prefix = "subagentDirectory.";
  const keysWithPrefix = (locale: Record<string, string>) =>
    Object.keys(locale).filter((key) => key.startsWith(prefix));
  const zhKeys = new Set(keysWithPrefix(zhCN));
  const enKeys = new Set(keysWithPrefix(enUS));

  for (const key of zhKeys) assert.ok(enKeys.has(key), `en-US 缺少 ${key}`);
  for (const key of enKeys) assert.ok(zhKeys.has(key), `zh-CN 缺少 ${key}`);
  assert.ok(zhKeys.size >= 16, `subagentDirectory.* 只比到 ${zhKeys.size} 条，前缀可能写错了`);
});

// ---------- ⑤ 结构守卫（逐条可变异）----------

/* 守卫 a：目录宿主（SubagentDirectorySidePane）渲染小队运行分区、**被可见性判据包着**、
   位置在「正在运行」段之后、「已结束」段之前。
   变异（M2 的组件侧）：去掉 `{showSquadRuns ? (… ) : null}`（无条件渲染）⇒ 本用例必红。 */
test("守卫｜目录宿主渲染小队运行分区，且被 squadDirectorySectionVisible 的判据包着", () => {
  const pane = readSource("app-shell/SubagentDirectorySidePane.tsx");
  assert.equal(
    (pane.match(/<SquadRunsDirectorySection/g) ?? []).length,
    1,
    "分区只该渲染一处（为别的形态另抄一份 = 同一语义两处实现）",
  );
  assert.match(
    pane,
    /const showSquadRuns = squadDirectorySectionVisible\(\{/,
    "显隐必须只由纯函数 squadDirectorySectionVisible 给出（远端投射边界 + 实验开关）",
  );
  assert.equal(
    (pane.match(/\{showSquadRuns \? \(/g) ?? []).length,
    1,
    "分区必须挂在 showSquadRuns 的条件里",
  );
  const gate = pane.indexOf("{showSquadRuns ? (");
  const render = pane.indexOf("<SquadRunsDirectorySection");
  assert.ok(gate >= 0 && render > gate, "分区必须在 showSquadRuns 条件块内");
  assert.ok(
    !pane.slice(gate, render).includes(") : null}"),
    "条件中途就闭合了 = 分区裸奔（显隐判据名存实亡）",
  );
  // 位置：正在运行之后、已结束之前（三段都是本会话相关目录；活动在上、历史在下）。
  const runningIndex = pane.indexOf('"subagentDirectory.running"');
  const endedIndex = pane.indexOf('"subagentDirectory.ended"');
  assert.ok(
    render > runningIndex && render < endedIndex,
    "分区必须在 running 段之后、ended 段之前（或把移动写进注释并同步本守卫）",
  );
  // 会话穿透回调必须透传给分区；且契约必填（可选会留下点了没反应的静默路径）。
  assert.ok(pane.includes("onOpenSession={onOpenSquadRunSession}"), "分区必须拿到打开会话的回调");
  assert.ok(!/onOpenSquadRunSession\?:/.test(pane), "回调类型必须是必填（不得用 ?. 吞掉点击）");
});

/* 守卫 b：分区组件走响亮取数通路（resolveSquadRuntimeService + getSnapshot），
   且「打开会话」只在 sessionId 非空时给（照 SquadRunsReview 的 indexOf 守卫形态）。
   变异（M3）：把按钮挪出 `sessionId ?` 条件（无条件渲染）⇒ 第二 / 三断言必红。 */
test("守卫｜分区组件走响亮取数通路；「打开会话」只在 sessionId 非空时给出", () => {
  const section = readSource("squad/SquadRunsDirectorySection.tsx");
  assert.ok(
    section.includes("resolveSquadRuntimeService("),
    "取数必须经 resolveSquadRuntimeService",
  );
  assert.ok(
    section.includes("getSnapshot("),
    "取数经 getSnapshot(target)（目标来自 props 的 workspace）",
  );
  assert.ok(
    !section.includes("services.squadRuntimeService"),
    "不得直接读 services.squadRuntimeService（那条路会把「服务没接上」静默成 undefined）",
  );
  assert.ok(section.includes("squadSurfaceViewState("), "状态机必须用共享的 squadSurfaceViewState");
  assert.ok(section.includes("squadRunDirectoryRows("), "行必须来自纯函数 squadRunDirectoryRows");
  // 测试锚点（后续 e2e 依赖；顺手钉住防被误删）。
  assert.ok(section.includes('data-testid="squad-runs-directory"'), "分区根 testid 不得改名");
  assert.ok(section.includes("data-run-id={row.runId}"), "行上要有 data-run-id");
  assert.ok(
    section.includes('data-testid="squad-run-open-session"'),
    "打开会话按钮 testid 不得缺（锚点）",
  );
  const sessionGate = section.indexOf("{sessionId ? (");
  const button = section.indexOf('data-testid="squad-run-open-session"');
  assert.ok(section.includes("const sessionId = row.sessionId;"), "会话 id 必须取自 run 台账");
  assert.ok(sessionGate >= 0, "必须有 sessionId 非空的判断分支");
  assert.ok(button > sessionGate, "按钮必须在 sessionId 非空的条件下（不得无条件渲染）");
  assert.ok(
    section.indexOf("onOpenSession(sessionId)") > button,
    "按钮点击必须把 sessionId 交给 onOpenSession",
  );
});

/* 守卫 c：面板头像簇**两处**都接上（agent 分区 trailing + 摘要胶囊），且只有一份组件实现。
   变异（M4）：删掉胶囊那一处 `<RunningAgentAvatarCluster … />` ⇒ 数量断言必红。 */
test("守卫｜面板两处（agent trailing / 摘要胶囊）都带头像簇，且计数文本在簇之后", () => {
  const panel = readSource("v4/ConversationStatusPanel.tsx");
  const usages = [...panel.matchAll(/<RunningAgentAvatarCluster/g)].map((match) => match.index);
  assert.equal(
    usages.length,
    2,
    "头像簇必须在 agent 分区 trailing 与摘要胶囊两处都接上（共用同一个组件）",
  );
  assert.equal(
    (panel.match(/function RunningAgentAvatarCluster\(/g) ?? []).length,
    1,
    "组件只有一份实现（不得抄两份）",
  );
  for (const index of usages) {
    const nextCount = panel.indexOf("formatRunningSubagentCount(", index);
    assert.ok(nextCount > index, "簇必须在 formatRunningSubagentCount 文本之前渲染");
    assert.ok(nextCount - index < 400, "簇必须与它说明的计数文本相邻（同一处布局里）");
  }
  // 组件本体：装饰 + aria-hidden（计数文本已给出语义）+ 色点来自纯函数。
  const componentStart = panel.indexOf("const RunningAgentAvatarCluster = memo(");
  assert.ok(componentStart >= 0, "头像簇组件必须在 ConversationStatusPanel 里定义");
  const componentSource = panel.slice(componentStart, panel.indexOf("});", componentStart));
  assert.ok(componentSource.includes("aria-hidden"), "头像簇是装饰，必须 aria-hidden");
  assert.ok(
    componentSource.includes("runningAgentAvatarColors("),
    "色点必须来自纯函数 runningAgentAvatarColors（身份口径可被 node:test 钉住）",
  );
  assert.ok(
    componentSource.includes("RUNNING_AGENT_AVATAR_MAX_DOTS"),
    "上限定数必须用模型层常量（两处渲染同一份口径）",
  );
});

/* 守卫 d：shell 把 onOpenSquadRunSession 传给侧栏宿主的**每个渲染点**，
   宿主再把目录页的**每个渲染点**往下传。
   变异：漏掉任一处 ⇒ 那个布局下的「打开会话」静默失效（按钮在、点了没反应），本用例必红。 */
test("守卫｜shell → 侧栏宿主 → 目录页 逐处接线，一个渲染点都不漏", () => {
  const layout = readSource("app-shell/WorkspaceShellLayout.tsx");
  const shellRenderPoints = [...layout.matchAll(/<AnimatedSidePanePanel/g)];
  assert.ok(shellRenderPoints.length >= 1, "shell 里至少有一个侧栏宿主渲染点");
  for (const match of shellRenderPoints) {
    const start = match.index;
    const tag = layout.slice(start, layout.indexOf("/>", start));
    assert.ok(
      tag.includes("onOpenSquadRunSession={"),
      "每个侧栏宿主渲染点都要接上 onOpenSquadRunSession（漏一处＝那个布局下入口静默失效）",
    );
    assert.ok(
      tag.includes("handleSelectTaskInChat("),
      "会话穿透必须复用 shell 既有的 handleSelectTaskInChat（不另造导航）",
    );
    for (const needle of ["workspaceAbsPath", "sessionId", "workspaceIdentity"]) {
      assert.ok(tag.includes(needle), `onOpenSquadRunSession 接线必须带 ${needle}`);
    }
  }

  const panel = readSource("app-shell/AnimatedSidePanePanel.tsx");
  const directoryRenderPoints = [...panel.matchAll(/<SubagentDirectorySidePane/g)];
  assert.ok(directoryRenderPoints.length >= 1, "宿主里至少有一个目录页渲染点");
  for (const match of directoryRenderPoints) {
    const start = match.index;
    const tag = panel.slice(start, panel.indexOf("/>", start));
    assert.ok(
      tag.includes("onOpenSquadRunSession={onOpenSquadRunSession}"),
      "目录页的每个渲染点都要把回调往下传",
    );
  }
  // 必填契约（两侧）：可选会留下「按钮在、点了没反应」的静默路径。
  assert.ok(!/onOpenSquadRunSession\?:/.test(panel), "AnimatedSidePanePanel 的 prop 必填");
  assert.ok(
    !/onOpenSquadRunSession\?:/.test(readSource("app-shell/SubagentDirectorySidePane.tsx")),
    "SubagentDirectorySidePane 的 prop 必填",
  );
});

// ---------- ③ 会话面板的「目录门」：空分区也要把门留着（审查发现项） ----------
//
// 背景：目录（含「小队运行」段）**唯一**的入口是 agent 分区的页脚行；而分区原本只在
// 「有 subagent」时渲染 ⇒ 一个 subagent 都没用过的会话里，小队运行彻底看不见。
// 修法：小队实验开启时加一项 `squadDirectoryDoor` 把门留着（实验关闭恒 false ⇒ 旧行为不变）。
// 变异：把 `resolveAgentSectionRenderable` 里的 `squadDirectoryDoor` 项去掉 ⇒ 下面矩阵红。

test("目录门：agent 分区渲染判据三输入八格（任一项为真即渲染）", () => {
  const M = resolveAgentSectionRenderable;
  const cells: Array<[boolean, boolean, boolean]> = [
    [false, false, false],
    [true, false, false],
    [false, true, false],
    [false, false, true],
    [true, true, false],
    [true, false, true],
    [false, true, true],
    [true, true, true],
  ];
  const got = cells.map(([running, ended, door]) =>
    M({ runningSubagentCount: running ? 1 : 0, hasEndedAgents: ended, squadDirectoryDoor: door }),
  );
  assert.deepEqual(
    got,
    [false, true, true, true, true, true, true, true],
    "只有「三无」格才不渲染；小队实验开着（door）时即使没有任何 subagent 也要渲染分区",
  );
});

test("目录门：空分区 + 门开着 ⇒ 渲染一行「打开智能体目录」且在 squadDirectoryDoor 条件下", () => {
  const panel = readSource("v4/ConversationStatusPanel.tsx");
  assert.ok(
    panel.includes("resolveAgentSectionRenderable("),
    "分区渲染判据必须走纯函数（可被钉住；不得退回裸 `||` 表达式）",
  );
  assert.ok(
    panel.includes("squadDirectoryDoor") && panel.includes("squadEntryVisible(settings)"),
    "门的存在由既有呈现判据 squadEntryVisible 给出（与侧栏一级入口同一份语义）",
  );
  const gate = panel.indexOf("emptyWithDirectoryDoor && squadDirectoryDoor");
  const row = panel.indexOf('data-testid="agent-directory-door-row"');
  assert.ok(
    gate >= 0,
    "空分区 + 门开着必须有专门的渲染条件（EndedSubagentDirectoryRow 在 count<=0 时自我吞掉）",
  );
  assert.ok(row > gate, "门行必须在上述条件内（不得无条件渲染）");
  assert.ok(
    panel.includes('{ id: "chat.statusPanel.openAgentDirectory" }'),
    "门行文案走新键 chat.statusPanel.openAgentDirectory",
  );
  const zh = readSource("i18n/locales/zh-CN.ts");
  const en = readSource("i18n/locales/en-US.ts");
  assert.ok(zh.includes('"chat.statusPanel.openAgentDirectory"'), "zh-CN 缺门行文案");
  assert.ok(en.includes('"chat.statusPanel.openAgentDirectory"'), "en-US 缺门行文案");
});
