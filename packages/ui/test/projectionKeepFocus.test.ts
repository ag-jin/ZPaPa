#!/usr/bin/env node
/**
 * 回归（层 1 · 纯函数，无设备）：从设置页发起设备连接**不能把用户甩出设置页**。
 *
 * ## 为什么要有这条
 *
 * 设置页是窗口内的一个 tab。连接完成后 `syncProjection` 把设备项目建成投射条目，
 * 原先一律用 `addTab` —— 而 `addTab` 会把 `activeTabId` 指到新条目上，设置页随即被
 * 卸载。用户实测：每连一次设备就被甩进某个项目，想连着调试这台设备
 * （连 → 看侧栏 → 拨显示开关 → 断开 → 再连）根本连不成串。
 *
 * 修法是给 `syncProjection` 加 `keepFocus`：为真时改用 `ensureWorkspaceTab`
 * （同一套匹配/插入逻辑，**不设 `activeTabId`**）。
 *
 * 这条测试锁住那个被依赖的性质本身：`ensureWorkspaceTab` 不抢焦点、`addTab` 抢。
 * 哪天有人把 `ensureWorkspaceTab` 改成会激活，这条会红 —— 而不是让「连接后被甩走」
 * 这个症状悄悄回来（那时只能靠再点一次设置页才发现）。
 *
 * 跑法：node --import tsx test/projectionKeepFocus.test.ts
 */
import assert from "node:assert/strict";
import test from "node:test";
import type { RemoteTarget } from "@zcode/shared";
import { createTabStore, isSettingsTab, isWorkspaceTab } from "../src/store/tabStore.js";

const target: RemoteTarget = { kind: "ssh", host: "100.66.1.2", username: "linguojin" };

/** 内存 storage：store 只在展开偏好持久化时用到它，测试不关心内容。 */
function createMemoryTabStore() {
  const map = new Map<string, string>();
  return createTabStore({
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => void map.set(key, value),
  });
}

/** 与 `syncProjection` 建立投射条目时传入的选项一致。 */
function projectionOptions(sessionId: string) {
  return {
    remoteSessionId: sessionId,
    remoteTarget: target,
    projection: { deviceSessionId: sessionId },
  };
}

test("keepFocus：ensureWorkspaceTab 不抢焦点，设置页仍在最前（addTab 会抢）", () => {
  const store = createMemoryTabStore();
  store.getState().openSettingsTab();
  const settingsTabId = store.getState().activeTabId;

  const activeTab = store.getState().tabs.find((tab) => tab.id === settingsTabId);
  assert.ok(activeTab, "前提：应有一个激活的 tab");
  assert.ok(isSettingsTab(activeTab), "前提：设置页已是当前 tab");

  // 修复所走的路径：条目进侧边栏，但不改 activeTabId。
  store.getState().ensureWorkspaceTab("/Volumes/数据盘/网站/AI2API", projectionOptions("sess-1"));
  assert.equal(
    store.getState().activeTabId,
    settingsTabId,
    "ensureWorkspaceTab 不得改 activeTabId —— 改了设置页就被卸载，用户被甩出连接界面",
  );

  // 反证：被替换掉的 addTab 一定抢焦点，所以 keepFocus 不能走它。
  store.getState().addTab("/Volumes/数据盘/网站/中转站", projectionOptions("sess-1"));
  assert.notEqual(
    store.getState().activeTabId,
    settingsTabId,
    "addTab 会激活新条目 —— 这正是「连接后被甩进某个项目」的机制",
  );

  assert.deepEqual(
    store
      .getState()
      .tabs.filter(isWorkspaceTab)
      .map((tab) => tab.workspacePath)
      .sort(),
    ["/Volumes/数据盘/网站/AI2API", "/Volumes/数据盘/网站/中转站"],
    "两条路径都要真的把条目建出来，区别只在要不要激活",
  );
});

test("keepFocus：投射条目仍带全 remoteTarget / projection（断开降级与重连靠它）", () => {
  const store = createMemoryTabStore();
  store.getState().openSettingsTab();
  store.getState().ensureWorkspaceTab("/remote/proj", projectionOptions("sess-1"));

  const tab = store
    .getState()
    .tabs.filter(isWorkspaceTab)
    .find((candidate) => candidate.workspacePath === "/remote/proj");
  assert.ok(tab, "条目应已建立");
  assert.equal(tab.remoteSessionId, "sess-1");
  assert.deepEqual(tab.remoteTarget, target, "缺 remoteTarget 会让断开降级后认不出这是远程条目");
  assert.deepEqual(tab.projection, { deviceSessionId: "sess-1" });
  assert.equal(tab.workspaceIdentity, undefined, "投射条目是 transient、不绑工作目录（ADR 0001）");
});
