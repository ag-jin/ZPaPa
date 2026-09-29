import assert from "node:assert/strict";
import test from "node:test";
import type { WikiSettings } from "@zcode/shared";
import {
  hasWikiProjectSettings,
  listWikiAutoUpdateProjects,
  patchWikiProjectSettings,
  resolveWikiProjectSettings,
  resolveWikiWorkspaceKey,
} from "../src/wiki/wikiProjectSettings.js";

const KEY_A = "/repo/a";
const KEY_B = "/repo/b";

test("workspaceKey 用 identity 优先、否则用 path", () => {
  assert.equal(resolveWikiWorkspaceKey("/repo/a"), "/repo/a");
  assert.equal(resolveWikiWorkspaceKey("/repo/a", "  remote:host  "), "remote:host");
  assert.equal(resolveWikiWorkspaceKey("/repo/a", "   "), "/repo/a");
});

test("未配置的项目拿到默认值：关闭定时、跟随默认模型、图表开启", () => {
  const resolved = resolveWikiProjectSettings({}, KEY_A);
  assert.equal(resolved.autoUpdateEnabled, false);
  assert.equal(resolved.autoUpdateFrequency, "daily");
  assert.equal(resolved.autoUpdateHour, 3);
  assert.equal(resolved.autoUpdateMinute, 0);
  assert.equal(resolved.autoUpdateModelSelection, undefined);
  assert.equal(resolved.modelSelection, undefined);
  assert.equal(resolved.generateDiagrams, true);
  assert.equal(resolved.language, "zh-CN");
});

test("每个项目各存各的配置，互不影响", () => {
  let settings: WikiSettings = {};
  settings = patchWikiProjectSettings(settings, KEY_A, {
    autoUpdateEnabled: true,
    autoUpdateFrequency: "weekly",
    autoUpdateHour: 21,
    autoUpdateMinute: 30,
  });
  settings = patchWikiProjectSettings(settings, KEY_B, {
    autoUpdateEnabled: true,
    autoUpdateFrequency: "every2days",
    autoUpdateHour: 6,
  });

  const a = resolveWikiProjectSettings(settings, KEY_A);
  const b = resolveWikiProjectSettings(settings, KEY_B);
  assert.equal(a.autoUpdateFrequency, "weekly");
  assert.equal(a.autoUpdateHour, 21);
  assert.equal(a.autoUpdateMinute, 30);
  // B 的改动不应被 A 影响 —— 这正是「只能选一个项目配置」要修的问题
  assert.equal(b.autoUpdateFrequency, "every2days");
  assert.equal(b.autoUpdateHour, 6);
  assert.equal(b.autoUpdateMinute, 0, "未设置的分钟应落到默认而不是沿用 A 的 30");
});

test("改一个项目不改变另一个项目的对象引用（React 引用比较依赖这一点）", () => {
  const base = patchWikiProjectSettings({}, KEY_A, { autoUpdateEnabled: true });
  const next = patchWikiProjectSettings(base, KEY_B, { autoUpdateEnabled: true });
  assert.notEqual(base, next, "应返回新对象");
  assert.deepEqual(base.projects?.[KEY_A], { autoUpdateEnabled: true }, "原对象不被改动");
});

test("patch 值为 undefined 时删除该键，而不是留一个显式 undefined", () => {
  let settings = patchWikiProjectSettings({}, KEY_A, { autoUpdateEnabled: true });
  settings = patchWikiProjectSettings(settings, KEY_A, { autoUpdateEnabled: undefined });
  // 全部键都被清掉后，该项目不应再留在表里
  assert.equal(settings.projects?.[KEY_A], undefined);
});

test("patch 保留未触及的字段", () => {
  let settings = patchWikiProjectSettings({}, KEY_A, {
    autoUpdateEnabled: true,
    language: "en-US",
    modelSelection: { providerId: "p", modelId: "m" },
  });
  settings = patchWikiProjectSettings(settings, KEY_A, { autoUpdateHour: 8 });
  const resolved = resolveWikiProjectSettings(settings, KEY_A);
  assert.equal(resolved.autoUpdateHour, 8);
  assert.equal(resolved.language, "en-US", "未触及的字段应保留");
  assert.deepEqual(resolved.modelSelection, { providerId: "p", modelId: "m" });
});

test("hasWikiProjectSettings 区分「配过」与「还在吃默认值」", () => {
  const settings = patchWikiProjectSettings({}, KEY_A, { autoUpdateEnabled: true });
  assert.equal(hasWikiProjectSettings(settings, KEY_A), true);
  assert.equal(hasWikiProjectSettings(settings, KEY_B), false);
});

test("旧全局配置仍可读：项目没配置时回退全局值（迁移期）", () => {
  const legacy: WikiSettings = {
    autoUpdateEnabled: true,
    autoUpdateFrequency: "weekly",
    autoUpdateHour: 22,
    autoUpdateMinute: 15,
  };
  const resolved = resolveWikiProjectSettings(legacy, KEY_A);
  assert.equal(resolved.autoUpdateFrequency, "weekly");
  assert.equal(resolved.autoUpdateHour, 22);
  assert.equal(resolved.autoUpdateMinute, 15);
  // 但全局的 autoUpdateEnabled 不再决定单个项目是否启用 ——
  // 否则升级后所有项目都会突然开始定时生成
  assert.equal(resolved.autoUpdateEnabled, false);
});

test("项目自己的配置优先于旧全局配置", () => {
  const settings: WikiSettings = {
    autoUpdateFrequency: "weekly",
    autoUpdateHour: 22,
    projects: { [KEY_A]: { autoUpdateFrequency: "daily", autoUpdateHour: 5 } },
  };
  const a = resolveWikiProjectSettings(settings, KEY_A);
  assert.equal(a.autoUpdateFrequency, "daily");
  assert.equal(a.autoUpdateHour, 5);
  // 未配的 B 回退全局
  const b = resolveWikiProjectSettings(settings, KEY_B);
  assert.equal(b.autoUpdateFrequency, "weekly");
  assert.equal(b.autoUpdateHour, 22);
});

test("越界时刻被收敛", () => {
  const settings = patchWikiProjectSettings({}, KEY_A, {
    autoUpdateEnabled: true,
    autoUpdateHour: 99,
    autoUpdateMinute: -5,
  });
  const resolved = resolveWikiProjectSettings(settings, KEY_A);
  assert.equal(resolved.autoUpdateHour, 23);
  assert.equal(resolved.autoUpdateMinute, 0);
});

test("listWikiAutoUpdateProjects 只列出开启了定时的项目", () => {
  let settings = patchWikiProjectSettings({}, KEY_A, { autoUpdateEnabled: true });
  settings = patchWikiProjectSettings(settings, KEY_B, { autoUpdateEnabled: false });
  settings = patchWikiProjectSettings(settings, "/repo/c", { language: "en-US" });

  const listed = listWikiAutoUpdateProjects(settings);
  assert.equal(listed.length, 1);
  assert.equal(listed[0]?.workspaceKey, KEY_A);
});

test("没有配置时 listWikiAutoUpdateProjects 返回空（调度器据此低频复查）", () => {
  assert.deepEqual(listWikiAutoUpdateProjects(undefined), []);
  assert.deepEqual(listWikiAutoUpdateProjects({}), []);
});

test("空 patch 不产生空对象条目", () => {
  const settings = patchWikiProjectSettings({}, KEY_A, {});
  assert.equal(settings.projects?.[KEY_A], undefined);
});
