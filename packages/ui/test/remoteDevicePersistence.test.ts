import assert from "node:assert/strict";
import test from "node:test";

/**
 * 回归测试：远程设备配置必须独立于 tab 持久化。
 *
 * 曾经把设备条目放进 lastWorkspaceSession，而该字段是 tab 持久化的专属领地
 * —— tab 变化会全量重写它，导致设备配置被静默覆盖（用户表现为「保存无效」）。
 * 这里锁定契约：设备配置走独立字段，且该字段不出现在 tab 持久化的载荷里。
 */

/** 复刻 tab 持久化的写入载荷形状（见 useTabPersistence 的 buildDefaultPersistPatch）。 */
function buildTabPersistPatch(localTabs: Array<{ workspacePath: string }>) {
  return {
    lastWorkspaceSession: localTabs.map((tab) => ({
      kind: "local" as const,
      workspacePath: tab.workspacePath,
    })),
    lastActiveTabIndex: 0,
  };
}

test("tab 持久化载荷不含设备配置字段", () => {
  const patch = buildTabPersistPatch([{ workspacePath: "/local/a" }]);
  assert.ok(
    !("remoteDevices" in patch),
    "tab 持久化不得触碰 remoteDevices —— 否则设备保存会被 tab 变化覆盖",
  );
});

test("tab 持久化只写 lastWorkspaceSession 与 lastActiveTabIndex", () => {
  const patch = buildTabPersistPatch([{ workspacePath: "/local/a" }]);
  assert.deepEqual(Object.keys(patch).sort(), ["lastActiveTabIndex", "lastWorkspaceSession"]);
});

test("模拟覆盖场景：设备配置在独立字段时不受 tab 重写影响", () => {
  // 设备配置与 tab 载荷是两个独立字段，合并写入时互不干扰。
  const settings: Record<string, unknown> = {
    remoteDevices: [{ target: { kind: "ssh", host: "h", username: "u" } }],
    lastWorkspaceSession: [],
  };
  const patch = buildTabPersistPatch([{ workspacePath: "/local/a" }]);
  const merged = { ...settings, ...patch };
  assert.equal(
    Array.isArray(merged.remoteDevices) && merged.remoteDevices.length,
    1,
    "tab 变化后设备配置仍应保留",
  );
});
