import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import enUS from "../src/i18n/locales/en-US.js";
import zhCN from "../src/i18n/locales/zh-CN.js";

/* 侧栏「AI Team 分组」结构守卫（T2，2026-10-05 侧栏小队重做·multica 纯导航形态）：
   分组标题（静态不可折叠）+ 智能体/小队两个一击直达入口；不按项目/工作区分组、
   不取数（旧按项目内嵌面板形态已退役，见 squadSidebarSectionRetired.test.ts）。 */

const SRC_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "../src");
const readSource = (relativePath: string) => readFileSync(resolve(SRC_DIR, relativePath), "utf8");

// ---------- i18n：分组标题两语齐全（入口文案复用 workspace.open*，禁止同义重复键） ----------

test("i18n：squad.sidebar.aiTeam 两语都在", () => {
  assert.ok(zhCN["squad.sidebar.aiTeam"], "zh-CN 缺少 squad.sidebar.aiTeam");
  assert.ok(enUS["squad.sidebar.aiTeam"], "en-US 缺少 squad.sidebar.aiTeam");
});

// ---------- 结构守卫（逐条可变异）----------

test("守卫｜AI Team 分组恰一处，智能体/小队入口各恰一处且都在分组内", () => {
  const sidebar = readSource("WorkspaceSidebar.tsx");
  assert.equal(
    (sidebar.match(/ai-team-sidebar-section/g) ?? []).length,
    1,
    "AI Team 分组只该有一处（另抄一份 = 同一语义两处实现）",
  );
  assert.equal(
    (sidebar.match(/ai-team-sidebar-agents/g) ?? []).length,
    1,
    "「智能体」入口在分组内只该有一处",
  );
  assert.equal(
    (sidebar.match(/ai-team-sidebar-squads/g) ?? []).length,
    1,
    "「小队」入口在分组内只该有一处",
  );
  const sectionIndex = sidebar.indexOf("ai-team-sidebar-section");
  const agentsIndex = sidebar.indexOf("ai-team-sidebar-agents");
  const squadsIndex = sidebar.indexOf("ai-team-sidebar-squads");
  assert.ok(
    sectionIndex >= 0 && sectionIndex < agentsIndex,
    "「智能体」入口必须在分组起点之后（分组内）",
  );
  assert.ok(
    agentsIndex < squadsIndex,
    "「小队」入口必须在「智能体」之后（multica 顺序：Agents → Squads）",
  );
  // 分组起点到两入口之间不得出现条件闭合（中途闭合 = 入口游离在分组外裸奔）。
  assert.ok(
    !sidebar.slice(sectionIndex, squadsIndex).includes(") : null}"),
    "两入口必须都在分组条件块内（条件中途闭合 = 入口裸奔）",
  );
});

test("守卫｜分组挂 squadEntryVisible 唯一判据、分组切片内不按项目/工作区渲染、标题引用 aiTeam 键", () => {
  const sidebar = readSource("WorkspaceSidebar.tsx");
  assert.match(
    sidebar,
    /showSquadEntries = squadEntryVisible\(settings\)/,
    "显隐必须只由既有纯函数 squadEntryVisible 给出（呈现判据，不是门禁）",
  );
  assert.equal(
    (sidebar.match(/showSquadEntries = squadEntryVisible\(settings\)/g) ?? []).length,
    1,
    "判据变量只此一处（给 AI Team 再造一个判据变量 = 同一语义两处实现）",
  );
  const sectionIndex = sidebar.indexOf("ai-team-sidebar-section");
  const squadsIndex = sidebar.indexOf("ai-team-sidebar-squads");
  const sectionSlice = sidebar.slice(sectionIndex, squadsIndex);
  assert.ok(
    !sectionSlice.includes(".map("),
    "分组内不得按项目/工作区循环渲染入口（multica 纯导航；按项目分组的旧面板形态已废弃）",
  );
  assert.ok(
    sidebar.includes('intl.formatMessage({ id: "squad.sidebar.aiTeam" })'),
    "分组标题文案必须引用 squad.sidebar.aiTeam（两语键，两处：aria-label 与可见文字）",
  );
});

test("守卫｜入口 active 语义带 aria-current=\"page\"（不只靠颜色/aria-pressed）", () => {
  const sidebar = readSource("WorkspaceSidebar.tsx");
  const agentsIndex = sidebar.indexOf("ai-team-sidebar-agents");
  const squadsIndex = sidebar.indexOf("ai-team-sidebar-squads");
  const workItemsIndex = sidebar.indexOf("work-items-sidebar-open");
  assert.match(
    sidebar.slice(agentsIndex, squadsIndex),
    /aria-current=\{squadAgentsActive \? "page" : undefined\}/,
    "「智能体」入口 active 时必须带 aria-current=\"page\"",
  );
  assert.match(
    sidebar.slice(squadsIndex, workItemsIndex),
    /aria-current=\{squadsActive \? "page" : undefined\}/,
    "「小队」入口 active 时必须带 aria-current=\"page\"",
  );
});

test("守卫｜DOM 顺序不重排：收件箱 → AI Team 分组 → 工作项；显隐条件恰 3 处", () => {
  const sidebar = readSource("WorkspaceSidebar.tsx");
  const inboxIndex = sidebar.indexOf("inbox-sidebar-open");
  const sectionIndex = sidebar.indexOf("ai-team-sidebar-section");
  const workItemsIndex = sidebar.indexOf("work-items-sidebar-open");
  assert.ok(
    inboxIndex >= 0 && inboxIndex < sectionIndex,
    "「收件箱」在 AI Team 分组之前（multica 顺序：收件箱 → AI 团队）",
  );
  assert.ok(
    sectionIndex < workItemsIndex,
    "「工作项」在 AI Team 分组之后（既有 Work 语义位置不重排；移进分组 = 破坏既有归组）",
  );
  assert.equal(
    (sidebar.match(/\{showSquadEntries \? \(/g) ?? []).length,
    3,
    "三个显隐条件（收件箱 / AI Team 分组 / 工作项）共用同一判据变量",
  );
});
