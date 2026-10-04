import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import enUS from "../src/i18n/locales/en-US.js";
import zhCN from "../src/i18n/locales/zh-CN.js";

/* 侧栏「小队」功能显示（SquadSidebarSection，2026-10-04 用户需求）的结构守卫：
   **纯逻辑 + 结构守卫**（ui 包既定做法，见 squadAgentsPage.test.ts）。
   用户明示的隔离边界也在这里钉住：既有任务/项目渲染路径一行不得改。 */

const SRC_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "../src");
const readSource = (relativePath: string) => readFileSync(resolve(SRC_DIR, relativePath), "utf8");

// ---------- i18n：两语齐全 ----------

test("i18n：squad.sidebar.* 两语都在", () => {
  for (const key of [
    "squad.sidebar.noProjects",
    "squad.sidebar.loadFailed",
    "squad.sidebar.agentsEntry",
    "squad.sidebar.squadsEntry",
  ]) {
    assert.ok(zhCN[key], `zh-CN 缺少 ${key}`);
    assert.ok(enUS[key], `en-US 缺少 ${key}`);
  }
});

// ---------- 结构守卫（逐条可变异）----------

test("守卫｜组件是独立文件且不 import 侧栏既有渲染路径（隔离边界）", () => {
  const section = readSource("squad/SquadSidebarSection.tsx");
  // 只依赖：服务取数 + 呈现组件 —— 不得拉侧栏的任务行/项目区实现（那会建立耦合，改坏风险回流）。
  // 只查 import 语句（注释里提到侧栏文件名不构成依赖）。
  const imports = [...section.matchAll(/^import[^;]+;/gm)].map((m) => m[0]).join("\n");
  for (const forbidden of ["WorkspaceSidebar", "WorkspacePurposeSection", "TaskRow"]) {
    assert.ok(
      !imports.includes(forbidden),
      `SquadSidebarSection 不得 import ${forbidden}（隔离：全新独立文件）`,
    );
  }
  // 数据只读：不给写动作（新建/编辑仍在一级页，本层是导航面）。
  assert.ok(!section.includes("createTeamAgent"), "侧栏小队区只读，不给新建动作");
  assert.ok(!section.includes("updateTeamAgent"), "侧栏小队区只读，不给编辑动作");
});

test("守卫｜按项目分组 + 可折叠 + 入口两枚 + 计数", () => {
  const section = readSource("squad/SquadSidebarSection.tsx");
  assert.match(section, /aria-expanded/, "分组头必须带折叠语义（aria-expanded）");
  // testid 由 kind 遍历生成（squad-sidebar-agents / squad-sidebar-squads）：
  // 同时钉住模板与两枚值，缺一个入口即红。
  assert.match(
    section,
    /squad-sidebar-\$\{kind\}/,
    "入口 testid 必须由 kind 模板生成（squad-sidebar-agents/squad-sidebar-squads）",
  );
  assert.match(
    section,
    /\(\["agents", "squads"\] as const\)/,
    "入口必须恰好两枚：agents 与 squads",
  );
  assert.match(
    section,
    /teamAgents\.filter\(\(a\) => a\.archivedAt === undefined\)\.length/,
    "智能体计数必须排除已归档（归档项不是候选，数出来会误导）",
  );
  assert.match(
    section,
    /snap\?\.state === "error"/,
    "读取失败必须逐项目可见（不静默成 0 —— 0 与读不到必须分得开）",
  );
});

test("守卫｜跨项目入口 = 先激活再打开；无激活通路时置灰而非猜", () => {
  const section = readSource("squad/SquadSidebarSection.tsx");
  assert.match(
    section,
    /await activateProject\(project\.workspacePath\)/,
    "非当前项目的入口必须先激活该项目（激活语义由调用方注入，本层不猜）",
  );
  assert.match(
    section,
    /project\.workspacePath !== activeWorkspacePath && !activateProject/,
    "没有激活通路时非当前项目入口必须置灰（而不是点击后落到错误的项目上）",
  );
});
