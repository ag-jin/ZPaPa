import assert from "node:assert/strict";
import test from "node:test";
import {
  collectClosedRemoteWorkspaceKeys,
  collectClosedRemoteWorkspaceSessionIds,
  collectSessionsToDisposeOnTabRemoval,
  filterWorkspaceTabs,
} from "../src/root/remoteWorkspaceTabLifecycleDecision.js";

/**
 * 远程 tab 生命周期判定：**设备级会话不随投射 tab 释放**。
 *
 * 这是 2026-09-30 重设计的核心不变量。缺陷经过：
 * 一台设备的所有项目投射 tab 共享同一个 remoteSessionId，而原实现按
 * 「tab 消失即释放其 session」处理，于是用户**关掉最后一个项目就断掉整条 SSH 连接**，
 * 设备条目退化成裸 user@host:port 且无法重连（用户实测原话：
 * 「远程设备的项目如果全部关闭会变成 ssh 端口，再次就无法连接上」）。
 *
 * 修复后：连接归设备所有，只有显式断开/移除设备才释放。
 */

const DEVICE_SESSION = "device-session-1";
const PROJECT_SESSION = "project-session-9";

const isDeviceOwned = (sessionId: string) => sessionId === DEVICE_SESSION;

/** 投射 tab：一台设备的所有项目共享同一 deviceSessionId。 */
function projectedTab(id: string, path: string, sessionId = DEVICE_SESSION) {
  return {
    kind: "workspace" as const,
    id,
    label: path.split("/").pop() ?? path,
    workspacePath: path,
    remoteSessionId: sessionId,
    projection: { deviceSessionId: sessionId },
  };
}

/** 普通远程 workspace tab（单项目连接，非设备投射）。 */
function projectTab(id: string, path: string, sessionId = PROJECT_SESSION) {
  return {
    kind: "workspace" as const,
    id,
    label: path.split("/").pop() ?? path,
    workspacePath: path,
    workspaceIdentity: `remote:ssh:host:22:user:${path}`,
    remoteSessionId: sessionId,
  };
}

test("核心不变量：关掉最后一个设备投射 tab 不释放设备会话", () => {
  // 用户关光所有项目：next 为空
  const previous = [projectedTab("t1", "/vol/新赛马"), projectedTab("t2", "/vol/中转站")];
  const toDispose = collectSessionsToDisposeOnTabRemoval(previous, [], isDeviceOwned);
  assert.deepEqual(toDispose, [], "设备会话必须保留 —— 否则关光项目就断连（本次修的缺陷）");
});

test("核心不变量：关光项目也不上报「远程 workspace 已关闭」", () => {
  const previous = [projectedTab("t1", "/vol/新赛马"), projectedTab("t2", "/vol/中转站")];
  const closedKeys = collectClosedRemoteWorkspaceKeys(previous, [], isDeviceOwned);
  assert.deepEqual(closedKeys, [], "设备投射条目的关闭不是 workspace 关闭事件");
});

test("核心不变量：补释放路径也不碰设备会话", () => {
  // 模拟「先断连、后清 tab 字段」：tab 已无 remoteSessionId，但记忆里有 sessionId
  const previous = [
    {
      kind: "workspace" as const,
      id: "t1",
      label: "新赛马",
      workspacePath: "/vol/新赛马",
      projection: { deviceSessionId: DEVICE_SESSION },
    },
  ];
  const remembered = new Map([["/vol/新赛马", DEVICE_SESSION]]);
  const toDispose = collectClosedRemoteWorkspaceSessionIds(
    previous,
    [],
    remembered,
    isDeviceOwned,
  );
  assert.deepEqual(toDispose, [], "记忆路径同样不能释放设备会话");
});

test("回归保护：普通远程 workspace 关掉最后一个 tab 仍然释放会话", () => {
  // 设备解耦不能把「普通远程项目的正常回收」也一起改掉
  const previous = [projectTab("t1", "/remote/proj")];
  const toDispose = collectSessionsToDisposeOnTabRemoval(previous, [], isDeviceOwned);
  assert.deepEqual(toDispose, [PROJECT_SESSION], "普通远程 tab 关闭仍应释放其 session");

  const closedKeys = collectClosedRemoteWorkspaceKeys(previous, [], isDeviceOwned);
  assert.equal(closedKeys.length, 1, "普通远程 workspace 关闭仍应上报");
});

test("回归保护：仍有投射 tab 存活时不释放任何会话", () => {
  const previous = [projectedTab("t1", "/vol/新赛马"), projectedTab("t2", "/vol/中转站")];
  const next = [projectedTab("t2", "/vol/中转站")];
  assert.deepEqual(
    collectSessionsToDisposeOnTabRemoval(previous, next, isDeviceOwned),
    [],
    "同一设备会话仍被其它项目 tab 使用",
  );
});

test("同会话多 tab 同时关闭只释放一次", () => {
  const previous = [projectTab("t1", "/remote/a"), projectTab("t2", "/remote/a")];
  const toDispose = collectSessionsToDisposeOnTabRemoval(previous, [], isDeviceOwned);
  assert.deepEqual(toDispose, [PROJECT_SESSION], "去重：同一 session 只释放一次");
});

test("设备会话与普通会话混合：只释放普通会话", () => {
  const previous = [projectedTab("t1", "/vol/新赛马"), projectTab("t2", "/remote/proj")];
  const toDispose = collectSessionsToDisposeOnTabRemoval(previous, [], isDeviceOwned);
  assert.deepEqual(toDispose, [PROJECT_SESSION], "设备会话保留，普通会话照常释放");
});

test("filterWorkspaceTabs 只保留 workspace 条目", () => {
  const tabs = [
    projectedTab("t1", "/vol/新赛马"),
    { kind: "settings" as const, id: "s1", label: "settings" },
  ];
  const filtered = filterWorkspaceTabs(tabs as never);
  assert.equal(filtered.length, 1);
  assert.equal(filtered[0]?.id, "t1");
});
