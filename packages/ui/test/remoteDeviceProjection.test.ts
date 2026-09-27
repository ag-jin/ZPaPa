import assert from "node:assert/strict";
import test from "node:test";
import {
  computeProjectionSync,
  filterProjectsByVisibility,
  findDeviceSessionId,
  findOrphanProjectionTabs,
  findProjectionTabsToClose,
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


// ── 一台设备一代：跨代残留与当代重复（实测缺陷：正式版 3 代共存）────────────
//
// 每连接一次产生新的 deviceSessionId。旧代不被清掉时，用户每连一次侧边栏就多
// 一整套项目 —— 实测正式版同一设备有 3 代（6aba478d / 97bc8b6e / 9f9c3f17），
// 各带「新赛马 + 中转站」。旧代的每一条都属于**另一个** deviceSessionId，
// 在本代视角里根本看不见，所以只做"当代内去重"不足以修复。

const deviceTarget = { kind: "ssh" as const, host: "100.66.1.2", username: "linguojin" };
const otherDeviceTarget = { kind: "ssh" as const, host: "10.0.0.9", username: "linguojin" };

/** 带 remoteTarget 的投射条目（跨代判定靠它，不靠 session 注册表）。 */
function targetedProjectionTab(
  id: string,
  path: string,
  gen: string,
  target: { kind: "ssh"; host: string; username: string },
  live = true,
) {
  return {
    id,
    workspacePath: path,
    remoteTarget: target,
    projection: { deviceSessionId: gen },
    ...(live ? { remoteSessionId: gen } : {}),
  };
}

test("跨代残留被清掉：只保留当前代", () => {
  const toClose = findProjectionTabsToClose({
    tabs: [
      targetedProjectionTab("tab-old-1", "/p/one", "gen-old", deviceTarget),
      targetedProjectionTab("tab-old-2", "/p/two", "gen-old", deviceTarget),
      targetedProjectionTab("tab-cur-1", "/p/one", "gen-cur", deviceTarget),
      targetedProjectionTab("tab-cur-2", "/p/two", "gen-cur", deviceTarget),
    ],
    deviceSessionId: "gen-cur",
    target: deviceTarget,
  });
  assert.deepEqual(
    toClose.sort(),
    ["tab-old-1", "tab-old-2"],
    "旧代的两条必须清掉 —— 否则用户每连一次就多一整套项目",
  );
});

test("当代内同路径重复只留活跃的那条", () => {
  const toClose = findProjectionTabsToClose({
    tabs: [
      targetedProjectionTab("tab-live", "/p/one", "gen-cur", deviceTarget, true),
      targetedProjectionTab("tab-stale", "/p/one", "gen-cur", deviceTarget, false),
    ],
    deviceSessionId: "gen-cur",
    target: deviceTarget,
  });
  assert.deepEqual(toClose, ["tab-stale"], "活跃条目本身就是项目入口，断开态残件清掉");
});

test("当代内全是断开态时留一条（重连入口不能全清）", () => {
  const toClose = findProjectionTabsToClose({
    tabs: [
      targetedProjectionTab("tab-a", "/p/one", "gen-cur", deviceTarget, false),
      targetedProjectionTab("tab-b", "/p/one", "gen-cur", deviceTarget, false),
    ],
    deviceSessionId: "gen-cur",
    target: deviceTarget,
  });
  assert.equal(toClose.length, 1, "断开态必须留一条作为重连入口");
});

test("另一台设备的一代不受影响", () => {
  const toClose = findProjectionTabsToClose({
    tabs: [
      targetedProjectionTab("tab-mine", "/p/one", "gen-cur", deviceTarget),
      targetedProjectionTab("tab-other", "/p/one", "gen-other", otherDeviceTarget),
      targetedProjectionTab("tab-other2", "/p/two", "gen-other", otherDeviceTarget),
    ],
    deviceSessionId: "gen-cur",
    target: deviceTarget,
  });
  assert.deepEqual(toClose, [], "不同 host 是不同的设备，各自保留一代");
});

test("常规项目与无 projection 标记的 tab 不参与", () => {
  const toClose = findProjectionTabsToClose({
    tabs: [
      { id: "tab-local", workspacePath: "/p/one" },
      { id: "tab-local2", workspacePath: "/p/one", remoteTarget: deviceTarget },
      targetedProjectionTab("tab-proj", "/p/one", "gen-cur", deviceTarget),
    ],
    deviceSessionId: "gen-cur",
    target: deviceTarget,
  });
  assert.deepEqual(toClose, [], "没有 projection 标记的都不是投射条目");
});

test("无 target 时退化为只处理当代（保守，不误删）", () => {
  const toClose = findProjectionTabsToClose({
    tabs: [
      targetedProjectionTab("tab-old", "/p/one", "gen-old", deviceTarget),
      targetedProjectionTab("tab-cur", "/p/one", "gen-cur", deviceTarget),
    ],
    deviceSessionId: "gen-cur",
  });
  assert.deepEqual(toClose, [], "判定不出设备归属时不跨代清理，交给孤儿逻辑兜底");
});

test("设备全断开、多代残留时每项目仍留一条重连入口", () => {
  // 关键边界：不能把旧代一律清光 —— 断开时旧代条目是用户唯一的重连入口
  // （规格 US 4/5/17），清光会让侧边栏彻底空掉。
  const toClose = findProjectionTabsToClose({
    tabs: [
      targetedProjectionTab("d1", "/p/one", "g1", deviceTarget, false),
      targetedProjectionTab("d2", "/p/one", "g2", deviceTarget, false),
      targetedProjectionTab("d3", "/p/two", "g1", deviceTarget, false),
      targetedProjectionTab("d4", "/p/two", "g2", deviceTarget, false),
    ],
    deviceSessionId: "gen-none",
    target: deviceTarget,
  });
  assert.deepEqual(toClose.sort(), ["d2", "d4"], "每个项目各留一条；多余代清掉");
});

test("实测数据：同一设备 3 代共存收敛为每项目一条", () => {
  // 这组是 2026-09-27 从用户正式版用 CDP 抓到的真实数据。
  const live = [
    targetedProjectionTab("70985380", "/vol/新赛马", "9f9c3f17", deviceTarget),
    targetedProjectionTab("fcb35eff", "/vol/中转站", "9f9c3f17", deviceTarget),
    targetedProjectionTab("e8480b6c", "/vol/中转站", "97bc8b6e", deviceTarget),
    targetedProjectionTab("af709838", "/vol/新赛马", "97bc8b6e", deviceTarget),
    targetedProjectionTab("36f60a2f", "/vol/新赛马", "6aba478d", deviceTarget),
    targetedProjectionTab("9fe571da", "/vol/中转站", "6aba478d", deviceTarget),
    targetedProjectionTab("aaa66c56", "/vol/电商技能", "83b40811", deviceTarget, false),
  ];
  const toClose = findProjectionTabsToClose({
    tabs: live,
    deviceSessionId: "9f9c3f17",
    target: deviceTarget,
  });
  const keep = live.filter((t) => !toClose.includes(t.id));
  assert.deepEqual(
    keep.map((t) => t.id).sort(),
    ["70985380", "aaa66c56", "fcb35eff"],
    "当前代两条 + 未覆盖项目的入口一条",
  );
});
