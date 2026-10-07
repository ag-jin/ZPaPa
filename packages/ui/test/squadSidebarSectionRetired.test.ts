import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import enUS from "../src/i18n/locales/en-US.js";
import zhCN from "../src/i18n/locales/zh-CN.js";

/* 旧「按项目分组内嵌面板」（SquadSidebarSection，第 61 轮交付、第 63 轮用户裁定废弃：
   位置/形态不对、信息密度太浅、交互路径太深）的负向守卫——旧形态不得回接生产。
   唯一合法的入口形态是 AI Team 纯导航分组（见 aiTeamSidebarSection.test.ts）。 */

const UI_SRC = resolve(dirname(fileURLToPath(import.meta.url)), "../src");

function listSourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...listSourceFiles(full));
    } else if (/\.(ts|tsx)$/.test(entry)) {
      out.push(full);
    }
  }
  return out;
}

test("负向守卫｜生产源码零 SquadSidebarSection（旧面板组件已退役，不得回接）", () => {
  for (const file of listSourceFiles(UI_SRC)) {
    const content = readFileSync(file, "utf8");
    assert.ok(
      !content.includes("SquadSidebarSection"),
      `${file} 出现 SquadSidebarSection：旧内嵌面板已废弃（multica 纯导航形态），不得回接生产`,
    );
  }
});

test("负向守卫｜旧接线形态的 testid 不回接（squad-sidebar- 前缀整体退役）", () => {
  for (const file of listSourceFiles(UI_SRC)) {
    const content = readFileSync(file, "utf8");
    assert.ok(
      !content.includes("squad-sidebar-"),
      `${file} 出现 squad-sidebar- 前缀 testid：旧面板测试契约已退役`,
    );
  }
  const sidebar = readFileSync(join(UI_SRC, "WorkspaceSidebar.tsx"), "utf8");
  for (const legacy of [
    "squad-sidebar-group-header",
    "squad-sidebar-empty",
    "squad-sidebar-error",
  ]) {
    assert.ok(!sidebar.includes(legacy), `WorkspaceSidebar 不得再含旧形态标记 ${legacy}`);
  }
});

test("负向守卫｜旧面板专属 i18n 四键已删除（两语）", () => {
  for (const key of [
    "squad.sidebar.noProjects",
    "squad.sidebar.loadFailed",
    "squad.sidebar.agentsEntry",
    "squad.sidebar.squadsEntry",
  ]) {
    assert.ok(!(key in zhCN), `zh-CN 仍存在已退役键 ${key}`);
    assert.ok(!(key in enUS), `en-US 仍存在已退役键 ${key}`);
  }
});

test("负向守卫｜侧栏无 activateProject 通路、AI Team 分组内无循环渲染（旧面板核心形态）", () => {
  const sidebar = readFileSync(join(UI_SRC, "WorkspaceSidebar.tsx"), "utf8");
  assert.ok(
    !sidebar.includes("activateProject"),
    "侧栏不得出现 activateProject 通路（旧面板跨项目激活形态）",
  );
  const sectionSlice = sidebar.slice(
    sidebar.indexOf("ai-team-sidebar-section"),
    sidebar.indexOf("work-items-sidebar-open"),
  );
  assert.ok(!sectionSlice.includes(".map("), "AI Team 分组内不得出现循环渲染（旧按项目分组形态）");
});
