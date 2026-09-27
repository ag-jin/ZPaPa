import assert from "node:assert/strict";
import test from "node:test";
import {
  computeProjectionSync,
  filterProjectsByVisibility,
  findDeviceSessionId,
  findOrphanProjectionTabs,
} from "../src/lib/remoteDeviceProjection.js";

/**
 * 投射生命周期的契约测试（ADR 0001）。
 *
 * 关键行为：投射条目跟随连接 —— 设备有而投射端无则创建，投射端有而设备无
 * （或显示偏好已关）则移除；避免全量重建以保留用户当前的查看状态。
 */

const deviceSessionId = "device-session-1";

function projectionTab(id: string, path: string, deviceId = deviceSessionId) {
  // remoteSessionId 非空 = 「上一代活跃条目」（会被回收）；
  // 为空 = 「断开态条目」（保留作重连入口，规格 US 4/5/17）。
  return {
    id,
    workspacePath: path,
    remoteSessionId: deviceId,
    projection: { deviceSessionId: deviceId },
  };
}

/** 断开态条目：已降级为侧边栏的重连入口。 */
function disconnectedProjectionTab(id: string, path: string, deviceId = deviceSessionId) {
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

/**
 * 孤儿投射条目：设备重连后，上一代 session 的投射必须被清掉。
 *
 * 实测事故：连续连接 2 次后，store 里出现 20 个投射项 —— 同一批 10 个项目
 * 按两个 deviceSessionId 各存一份。旧条目的 session 已注销，按当前 session
 * 过滤看不见、dispose 也够不到，于是每次重连都多留一组。
 */
test("设备重连后，上一代**活跃**（session 已注销）的投射条目被识别为孤儿", () => {
  const orphans = findOrphanProjectionTabs({
    tabs: [
      projectionTab("tab-old-1", "/p/one", "dead-session"),
      projectionTab("tab-old-2", "/p/two", "dead-session"),
      projectionTab("tab-current", "/p/one", deviceSessionId),
    ],
    currentSessionId: deviceSessionId,
    isSessionRegistered: (id) => id === deviceSessionId,
  });
  assert.deepEqual(
    orphans,
    ["tab-old-1", "tab-old-2"],
    "只清掉 session 已注销的旧投射，当前 session 的条目保留",
  );
});

test("同时连接的另一台设备的投射不算孤儿", () => {
  const orphans = findOrphanProjectionTabs({
    tabs: [
      projectionTab("tab-other", "/p/x", "device-session-2"),
      projectionTab("tab-current", "/p/one", deviceSessionId),
    ],
    currentSessionId: deviceSessionId,
    // 另一台设备仍在线，其 session 在册。
    isSessionRegistered: (id) => id === deviceSessionId || id === "device-session-2",
  });
  assert.deepEqual(orphans, [], "在册的其他设备投射不能被误删");
});

test("常规 workspace tab 永远不算孤儿", () => {
  const orphans = findOrphanProjectionTabs({
    tabs: [
      { id: "tab-local", workspacePath: "/local/project" } as never,
      projectionTab("tab-current", "/p/one", deviceSessionId),
    ],
    currentSessionId: deviceSessionId,
    isSessionRegistered: () => false,
  });
  assert.deepEqual(orphans, [], "没有 projection 标记的 tab 不参与孤儿判定");
});

/**
 * 设备卡片的状态必须从在册 session 反推。
 *
 * 事故背景：连接成功后设置页会被卸载（连接流程切到工作区），组件内 state 随之丢失。
 * 若只读 state，重开设置页会显示「未连接」并藏掉「断开」入口，而连接其实还活着。
 */
test("按 target 找到在册的设备 session", () => {
  const sessions = {
    "sess-a": { sessionId: "sess-a", target: { kind: "ssh", host: "1.1.1.1", username: "u" } },
    "sess-b": { sessionId: "sess-b", target: { kind: "ssh", host: "100.66.1.2", username: "linguojin" } },
  };
  assert.equal(
    findDeviceSessionId(sessions, { kind: "ssh", host: "100.66.1.2", username: "linguojin" }),
    "sess-b",
    "同 host+username 的设备被认作同一台",
  );
  assert.equal(
    findDeviceSessionId(sessions, { kind: "ssh", host: "9.9.9.9", username: "u" }),
    undefined,
    "不同主机不匹配",
  );
  assert.equal(
    findDeviceSessionId(sessions, { kind: "ssh", host: "100.66.1.2", username: "other" }),
    undefined,
    "同主机不同用户不匹配（是不同账户的设备）",
  );
  assert.equal(findDeviceSessionId(sessions, null), undefined, "未配置设备时不匹配");
});


/**
 * 断开态条目必须被保留 —— 它们是侧边栏的重连入口（规格 US 4/5/17）。
 *
 * 事故背景：点重连后侧边栏条目全没了。原因是孤儿判定只看 deviceSessionId
 * 是否在册，而断开态条目的 session 必然已注销 —— 于是重连时把它们当旧代清掉，
 * 新代又还没建，出现"重连后空无一物"。
 */
test("断开态投射条目不算孤儿（它们是重连入口）", () => {
  const orphans = findOrphanProjectionTabs({
    tabs: [
      disconnectedProjectionTab("tab-disconnected-1", "/p/one", "dead-session"),
      disconnectedProjectionTab("tab-disconnected-2", "/p/two", "dead-session"),
    ],
    currentSessionId: deviceSessionId,
    // 两个旧 session 都不在册 —— 但断开态条目不该因此被清掉。
    isSessionRegistered: (id) => id === deviceSessionId,
  });
  assert.deepEqual(orphans, [], "断开态条目必须保留供用户点击重连");
});

test("同一批里断开态保留、旧代活跃条目回收", () => {
  const orphans = findOrphanProjectionTabs({
    tabs: [
      projectionTab("tab-stale-active", "/p/one", "dead-session"),
      disconnectedProjectionTab("tab-disconnected", "/p/two", "dead-session"),
    ],
    currentSessionId: deviceSessionId,
    isSessionRegistered: (id) => id === deviceSessionId,
  });
  assert.deepEqual(orphans, ["tab-stale-active"], "只回收旧代活跃条目，保留重连入口");
});
