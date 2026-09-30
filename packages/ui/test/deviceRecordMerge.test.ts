import assert from "node:assert/strict";
import test from "node:test";
import { mergeDeviceRecord } from "../src/lib/remoteDeviceProjection.js";

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
