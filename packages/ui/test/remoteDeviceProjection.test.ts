import assert from "node:assert/strict";
import test from "node:test";
import {
  computeProjectionSync,
  filterProjectsByVisibility,
} from "../src/lib/remoteDeviceProjection.js";

/**
 * 投射生命周期的契约测试（ADR 0001）。
 *
 * 关键行为：投射条目跟随连接 —— 设备有而投射端无则创建，投射端有而设备无
 * （或显示偏好已关）则移除；避免全量重建以保留用户当前的查看状态。
 */

const deviceSessionId = "device-session-1";

function projectionTab(id: string, path: string, deviceId = deviceSessionId) {
  return { id, workspacePath: path, projection: { deviceSessionId: deviceId } };
}

test("设备新增项目时创建投射条目，已存在的保持不变", () => {
  const result = computeProjectionSync({
    deviceSessionId,
    deviceProjects: [
      { path: "/p/one", sessionCount: 3 },
      { path: "/p/two", sessionCount: 1 },
    ],
    existingTabs: [projectionTab("tab-1", "/p/one")],
  });

  assert.deepEqual(
    result.toCreate.map((project) => project.path),
    ["/p/two"],
    "只创建缺失的项目，已存在的不重建（避免丢失展开/滚动状态）",
  );
  assert.deepEqual(result.toRemoveTabIds, []);
});

test("设备上已消失的项目，其投射条目被移除", () => {
  const result = computeProjectionSync({
    deviceSessionId,
    deviceProjects: [{ path: "/p/one", sessionCount: 1 }],
    existingTabs: [projectionTab("tab-1", "/p/one"), projectionTab("tab-2", "/p/gone")],
  });

  assert.deepEqual(result.toRemoveTabIds, ["tab-2"]);
  assert.deepEqual(result.toCreate, []);
});

test("显示偏好关闭的项目不出现在投射列表", () => {
  const projects = [
    { path: "/p/visible", sessionCount: 1 },
    { path: "/p/hidden", sessionCount: 1 },
  ];
  const filtered = filterProjectsByVisibility(projects, { "/p/hidden": false });
  assert.deepEqual(
    filtered.map((project) => project.path),
    ["/p/visible"],
  );
});

test("缺省显示：偏好里没有的项目照样投射", () => {
  const projects = [{ path: "/p/new", sessionCount: 0 }];
  const filtered = filterProjectsByVisibility(projects, { "/p/other": false });
  assert.deepEqual(
    filtered.map((project) => project.path),
    ["/p/new"],
    "未显式关闭的项目默认投射，否则连上设备后侧边栏会是空的",
  );
});

test("显示偏好关闭后，已有的投射条目被移除", () => {
  // 偏好过滤发生在设备项目列表上，因此关闭的项目"看起来"从设备消失了
  const result = computeProjectionSync({
    deviceSessionId,
    deviceProjects: filterProjectsByVisibility(
      [{ path: "/p/one", sessionCount: 1 }],
      { "/p/one": false },
    ),
    existingTabs: [projectionTab("tab-1", "/p/one")],
  });
  assert.deepEqual(result.toRemoveTabIds, ["tab-1"]);
});

test("不触碰其他设备的投射条目", () => {
  const result = computeProjectionSync({
    deviceSessionId,
    deviceProjects: [],
    existingTabs: [
      projectionTab("tab-other", "/p/x", "device-session-2"),
      projectionTab("tab-mine", "/p/y", deviceSessionId),
    ],
  });
  assert.deepEqual(
    result.toRemoveTabIds,
    ["tab-mine"],
    "另一台设备的投射条目不受本设备断开影响",
  );
});

test("非投射条目（常规 workspace tab）不参与同步", () => {
  const result = computeProjectionSync({
    deviceSessionId,
    deviceProjects: [],
    existingTabs: [
      // 常规 tab 没有 projection 标记
      { id: "tab-local", workspacePath: "/local/project" } as never,
    ],
  });
  assert.deepEqual(result.toRemoveTabIds, [], "常规 tab 绝不能被投射清理逻辑误删");
});
