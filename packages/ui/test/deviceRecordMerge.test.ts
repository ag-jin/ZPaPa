import assert from "node:assert/strict";
import test from "node:test";
import {
  findDeviceRecord,
  findProjectionTabsForDevice,
  markProjectHidden,
  mergeDeviceRecord,
  removeDeviceRecord,
  setProjectVisibility,
} from "../src/lib/remoteDeviceProjection.js";

/**
 * 设备记录合并写的不变量（2026-09-30 实测缺陷）。
 *
 * 缺陷经过：两处设备写入都是**整体覆盖** —— 登记设备时
 * `save([{ target, lastConnectionStatus }])`、状态更新时 `save([next])`。
 * 任何一次写入都会把用户先前的 `visibleProjects`（项目显示偏好）抹掉，
 * 设备记录最终退化成只剩 SSH 目标。用户实测表现：
 * 「远程设备的项目如果全部关闭会变成 ssh 端口，再次就无法连接上」。
 *
 * 本测试锁定「合并写不丢字段」这条不变量。
 */

const target = { kind: "ssh", host: "100.66.1.2", username: "linguojin" };

/** 测试用的设备记录形状（与 RemoteDeviceConfigRecord 对齐，含可选字段）。 */
interface DeviceRecord {
  target: { kind: string; host?: string; username?: string; port?: number };
  lastConnectedAt?: number;
  lastConnectionStatus: "connected" | "failed" | "never";
  lastConnectionError?: string;
  visibleProjects?: Record<string, boolean>;
}

test("合并写：目标相同的设备保留既有 visibleProjects", () => {
  const existing = [
    {
      target,
      lastConnectionStatus: "connected" as const,
      visibleProjects: { "/vol/新赛马": false, "/vol/中转站": true },
    },
  ];
  // 模拟一次「连接状态更新」——patch 里不带 visibleProjects
  const merged = mergeDeviceRecord<DeviceRecord>(existing, {
    target,
    lastConnectionStatus: "failed" as const,
    lastConnectionError: "SSH 连接握手超时",
  });

  assert.equal(merged.length, 1, "同一台设备不应变成两条记录");
  assert.deepEqual(
    merged[0]?.visibleProjects,
    { "/vol/新赛马": false, "/vol/中转站": true },
    "项目显示偏好必须原样保留 —— 被抹掉正是本次缺陷",
  );
  assert.equal(merged[0]?.lastConnectionStatus, "failed", "patch 给出的字段要生效");
  assert.equal(merged[0]?.lastConnectionError, "SSH 连接握手超时");
});

test("合并写：登记设备时不抹掉先前的项目显示偏好", () => {
  // 对应 Root.tsx 的 `handleConnectRemoteAsDevice`：登记时只带 target + 状态
  const existing = [
    {
      target,
      lastConnectionStatus: "connected" as const,
      visibleProjects: { "/vol/电商技能": false },
    },
  ];
  const merged = mergeDeviceRecord<DeviceRecord>(existing, {
    target,
    lastConnectedAt: 1_790_000_000_000,
    lastConnectionStatus: "connected" as const,
  });

  assert.deepEqual(
    merged[0]?.visibleProjects,
    { "/vol/电商技能": false },
    "登记动作不能把用户关掉的项目又打开",
  );
  assert.equal(merged[0]?.lastConnectedAt, 1_790_000_000_000);
});

test("合并写：目标不同的设备作为新记录追加，不覆盖既有设备", () => {
  const existing = [{ target, lastConnectionStatus: "connected" as const }];
  const other = { kind: "ssh", host: "100.66.1.9", username: "linguojin" };
  const merged = mergeDeviceRecord<DeviceRecord>(existing, {
    target: other,
    lastConnectionStatus: "never" as const,
  });

  assert.equal(merged.length, 2, "不同设备应各自保留一条");
  assert.equal(merged[0]?.target.host, "100.66.1.2", "既有设备不被替换");
  assert.equal(merged[1]?.target.host, "100.66.1.9");
});

test("合并写：空列表时新增一条", () => {
  const merged = mergeDeviceRecord<DeviceRecord>([], {
    target,
    lastConnectionStatus: "connected",
  });
  assert.equal(merged.length, 1);
  assert.equal(merged[0]?.target.host, "100.66.1.2");
});

test("合并写：同 host 不同 username 视为不同设备（与同机判定同口径）", () => {
  // 口径必须与 isSameDeviceTarget / findDeviceSessionId 一致，
  // 否则「同一台设备」在不同路径下会得出不同结论。
  const existing = [{ target, lastConnectionStatus: "connected" as const }];
  const merged = mergeDeviceRecord<DeviceRecord>(existing, {
    target: { kind: "ssh", host: "100.66.1.2", username: "someone-else" },
    lastConnectionStatus: "never" as const,
  });
  assert.equal(merged.length, 2, "不同用户是不同设备条目");
});

/**
 * markProjectHidden：用户关掉投射条目 → 持久为「不显示」。
 *
 * 缺陷经过（实测）：侧栏直接关掉投射条目时只关 tab、不回写显示偏好，
 * 下次重连 syncProjection 又按旧偏好把它投回来 —— 用户看到"关不掉的条目"。
 * 设置页开关本就写这份偏好，两条路径必须一致。
 */

test("markProjectHidden：关掉的项目持久为不显示，其它项目与字段不受影响", () => {
  const existing = [
    {
      target,
      lastConnectionStatus: "connected" as const,
      visibleProjects: { "/vol/新赛马": true },
    },
  ];
  const next = markProjectHidden<DeviceRecord>(existing, target, "/vol/中转站");

  assert.deepEqual(
    next[0]?.visibleProjects,
    { "/vol/新赛马": true, "/vol/中转站": false },
    "只新增被关掉的项目为 false，既有偏好不动",
  );
  assert.equal(next[0]?.lastConnectionStatus, "connected", "其它字段保留");
  assert.equal(next.length, 1, "不新增设备条目");
});

test("markProjectHidden：已有偏好时覆盖该项为 false", () => {
  const existing = [
    {
      target,
      lastConnectionStatus: "connected" as const,
      visibleProjects: { "/vol/新赛马": true, "/vol/中转站": true } as Record<string, boolean>,
    },
  ];
  const next = markProjectHidden<DeviceRecord>(existing, target, "/vol/新赛马");
  assert.deepEqual(
    next[0]?.visibleProjects,
    { "/vol/新赛马": false, "/vol/中转站": true },
    "只改目标项目",
  );
});

test("markProjectHidden：设备不在记录里时不伪造条目", () => {
  // 找不到设备就别写 —— 凭空造一条只有 visibleProjects 的记录会让设备卡片
  // 出现一个没有 target 的幽灵条目。
  const existing: DeviceRecord[] = [];
  const next = markProjectHidden<DeviceRecord>(existing, target, "/vol/新赛马");
  assert.equal(next.length, 0, "不改动记录");
});

/**
 * removeDeviceRecord：移除只作用于目标设备。
 *
 * 缺陷经过（穷举场景 S9）：移除设备走 `save([])` —— 那是"清空列表"语义。
 * 设备记录按列表存（CONTEXT.md「Single Device Scope」明确"数据结构按列表存，
 * 将来增设备不需重构"），列表可能有别台；清空会把别台的连接入口与显示偏好一并删掉。
 */

test("移除设备：只删目标台，保留其它台", () => {
  const other = { kind: "ssh", host: "100.66.1.9", username: "linguojin" };
  const existing: DeviceRecord[] = [
    { target, lastConnectionStatus: "connected", visibleProjects: { "/vol/新赛马": false } },
    { target: other, lastConnectionStatus: "never" },
  ];
  const next = removeDeviceRecord(existing, target);

  assert.equal(next.length, 1, "只删一台");
  assert.equal(next[0]?.target.host, "100.66.1.9", "保留的是另一台");
  assert.deepEqual(next[0]?.visibleProjects, undefined, "别台的偏好不受影响（本例别台本就为空）");
});

test("移除设备：目标不存在时列表不变", () => {
  const existing: DeviceRecord[] = [{ target, lastConnectionStatus: "connected" }];
  const next = removeDeviceRecord(existing, { kind: "ssh", host: "10.0.0.1", username: "x" });
  assert.equal(next.length, 1, "没有匹配项就不删任何东西");
});

/**
 * findProjectionTabsForDevice：按 remoteTarget 找条目，覆盖**断开态**。
 *
 * 缺陷经过（穷举场景 S8）：移除设备时按 `projection.deviceSessionId === 当前 sessionId`
 * 找条目，但断开态的条目 `remoteSessionId` 已被清空、会话也早没了 ——
 * 按 sessionId 找不到它们。残留的灰显条目其 remoteTarget 指向一台已被移除的设备，
 * 点重连会把设备又连回来。
 */

function projectionTab(
  id: string,
  path: string,
  remoteTarget?: { kind: string; host?: string; username?: string },
  sessionId?: string,
) {
  return {
    kind: "workspace" as const,
    id,
    label: path,
    workspacePath: path,
    ...(sessionId ? { remoteSessionId: sessionId } : {}),
    ...(remoteTarget ? { remoteTarget } : {}),
    projection: { deviceSessionId: sessionId ?? "stale-session" },
  };
}

test("找设备条目：覆盖连接态与断开态", () => {
  const tabs = [
    // 连接态：有 remoteSessionId
    projectionTab("t1", "/vol/新赛马", target, "sess-A"),
    // 断开态：remoteSessionId 已清（降级），但仍带 remoteTarget
    projectionTab("t2", "/vol/中转站", target),
    // 另一台设备
    projectionTab("t3", "/vol/别的", { kind: "ssh", host: "100.66.1.9", username: "linguojin" }),
    // 本机项目：无 projection，不该被清
    { kind: "workspace" as const, id: "t4", label: "local", workspacePath: "/Users/me/code" },
  ];
  const found = findProjectionTabsForDevice(tabs as never, target);

  assert.deepEqual(
    found.map((tab) => tab.id).sort(),
    ["t1", "t2"],
    "连接态与断开态都要找到；别台与本机项目不动",
  );
});

test("找设备条目：target 缺失时返回空（不做危险的全量匹配）", () => {
  const tabs = [projectionTab("t1", "/vol/新赛马", target, "sess-A")];
  assert.deepEqual(findProjectionTabsForDevice(tabs as never, undefined), []);
});

/**
 * findDeviceRecord：按台定位，而不是取 devices[0]。
 *
 * 缺陷经过（穷举场景 S15）：侧栏重连读显示偏好时写死 `devices[0]?.visibleProjects`。
 * 记录按列表存，从侧栏重连的可能是列表里的**第二台** —— 取首条会读到别台的偏好，
 * 于是本台该隐藏的项目被投出来、该显示的被过滤掉。
 */

test("找设备记录：列表有多台时按 target 命中目标台", () => {
  const other = { kind: "ssh", host: "100.66.1.9", username: "linguojin" };
  const devices: DeviceRecord[] = [
    { target, lastConnectionStatus: "connected", visibleProjects: { "/vol/A": false } },
    { target: other, lastConnectionStatus: "connected", visibleProjects: { "/vol/B": false } },
  ];

  assert.deepEqual(
    findDeviceRecord(devices, other)?.visibleProjects,
    { "/vol/B": false },
    "命中第二台的偏好，而不是首台",
  );
  assert.deepEqual(
    findDeviceRecord(devices, target)?.visibleProjects,
    { "/vol/A": false },
    "命中第一台",
  );
});

test("找设备记录：目标不在列表时返回 undefined（不误取他台）", () => {
  const devices: DeviceRecord[] = [{ target, lastConnectionStatus: "connected" }];
  assert.equal(
    findDeviceRecord(devices, { kind: "ssh", host: "10.0.0.1", username: "x" }),
    undefined,
  );
  assert.equal(findDeviceRecord(devices, undefined), undefined);
});

/**
 * 显示偏好开关的丢更新缺陷（2026-09-30 代码级确认，未在 dev 实测复现）。
 *
 * 缺陷经过：设置页开关交回的是**一整份** `Record<path, boolean>`，而那份 map 由
 * `{ ...visibleProjects, [path]: visible }` 用**渲染期快照**拼出。连拨两个开关时，
 * 前一次点击的 setState 还没重渲染，第二次点击仍以旧快照为底 —— 前一次被整份覆盖丢掉。
 * 父组件写入时又用渲染期快照的 `remoteDeviceEntry` 整份回写，是同一类错的第二处。
 *
 * 修法是把契约从「交一份整 map」改成「交意图」：写入方以**仓里最新的一份**为底做
 * 读-改-写。下面第一条锁定修好的行为，第二条反证旧写法为什么必丢（保留它，
 * 是为了让"为什么契约是 (path, visible) 而不是 (map)"这件事留在代码里）。
 */
test("显示偏好：连拨两个开关都留存（读-改-写基于最新一份）", () => {
  let stored: DeviceRecord[] = [{ target, lastConnectionStatus: "connected" }];
  const toggle = (projectPath: string, visible: boolean) => {
    // 每次都重新读当前值作底 —— 与父组件 list() → setProjectVisibility → save 同构。
    stored = setProjectVisibility(stored, target, projectPath, visible);
  };

  toggle("/vol/新赛马", false);
  toggle("/vol/中转站", false);

  assert.deepEqual(
    findDeviceRecord(stored, target)?.visibleProjects,
    { "/vol/新赛马": false, "/vol/中转站": false },
    "第一次拨动不能被第二次的底稿覆盖掉 —— 被丢掉的正是这一条",
  );
});

test("反证：拿渲染期快照整份回写会丢掉前一次拨动", () => {
  let stored: DeviceRecord[] = [{ target, lastConnectionStatus: "connected" }];
  /** 旧写法：用渲染期快照拼整份 map 再整份写入。 */
  const writeFromSnapshot = (snapshot: Record<string, boolean>, patch: Record<string, boolean>) => {
    stored = mergeDeviceRecord(stored, {
      target,
      visibleProjects: { ...snapshot, ...patch },
    });
  };

  const snapshot: Record<string, boolean> = {}; // 组件手里那份还没更新的快照
  writeFromSnapshot(snapshot, { "/vol/新赛马": false });
  writeFromSnapshot(snapshot, { "/vol/中转站": false });

  assert.deepEqual(
    findDeviceRecord(stored, target)?.visibleProjects,
    { "/vol/中转站": false },
    "快照式整份回写把第一次拨动丢了；此断言存在是为了说明契约为何改成「交意图」",
  );
});

test("显示偏好：只改目标台，列表里其它设备的记录不动", () => {
  const other = { kind: "ssh", host: "100.66.1.9", username: "linguojin" };
  const devices: DeviceRecord[] = [
    { target, lastConnectionStatus: "connected", visibleProjects: { "/vol/A": false } },
    { target: other, lastConnectionStatus: "connected", visibleProjects: { "/vol/B": false } },
  ];

  const next = setProjectVisibility(devices, other, "/vol/B", true);

  assert.deepEqual(
    findDeviceRecord(next, other)?.visibleProjects,
    { "/vol/B": true },
    "目标台按意图写入",
  );
  assert.deepEqual(
    findDeviceRecord(next, target)?.visibleProjects,
    { "/vol/A": false },
    "别台的显示偏好必须原样保留",
  );
});

test("显示偏好：目标台不在列表时不改动列表", () => {
  const other = { kind: "ssh", host: "100.66.1.9", username: "linguojin" };
  const devices: DeviceRecord[] = [{ target, lastConnectionStatus: "connected" }];
  assert.deepEqual(setProjectVisibility(devices, other, "/vol/A", false), devices);
});
