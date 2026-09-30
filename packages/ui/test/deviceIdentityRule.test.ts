import assert from "node:assert/strict";
import test from "node:test";
import { isSameDeviceTarget } from "../src/lib/remoteDeviceProjection.js";
import { deviceKey, useDeviceSessionStore } from "../src/store/deviceSessionStore.js";

/**
 * 「同一台设备」判定必须全仓一套规则（2026-09-30 复查发现的缺陷）。
 *
 * 缺陷经过：`deviceKey`（会话层）曾把 port 计入身份，而 `isSameDeviceTarget`
 * （记录层）只比 host + username。于是同一 host 换端口接入时，
 * 记录层按"同一台设备"合并、会话层却按两台各存一份 —— 旧会话条目从此无人回收
 * （`setDeviceSession` 只在同键时才终结旧会话），设置页还会因查不到而显示「未连接」。
 *
 * 本测试锁定「deviceKey 与 isSameDeviceTarget 对同一对目标给出相同结论」。
 */

// `as const` 让 kind 保持字面量类型 "ssh"；否则会被推宽成 string，
// 无法赋给 RemoteTarget 的判别联合。
const target = { kind: "ssh", host: "100.66.1.2", username: "linguojin" } as const;
/** 另一台设备，用于验证「切换设备」与「同一设备重连」的区别。 */
const otherDevice = { kind: "ssh", host: "100.66.1.9", username: "linguojin" } as const;

test("deviceKey：同 host + 同 username 即同一台设备（与 isSameDeviceTarget 同口径）", () => {
  assert.equal(deviceKey(target), "ssh:linguojin@100.66.1.2");
});

test("deviceKey：port 不参与身份（记录层也不比较 port）", () => {
  // 这是本次修的缺陷：曾把 port 计入，导致会话层与记录层对同一事实得出相反结论。
  const withPort22 = { ...target, port: 22 };
  const withPort2222 = { ...target, port: 2222 };
  assert.equal(
    deviceKey(withPort22),
    deviceKey(withPort2222),
    "换端口接入仍是同一台设备 —— 记录层就是这么判的",
  );
  assert.ok(
    isSameDeviceTarget(withPort22, withPort2222),
    "同名口径的前提：isSameDeviceTarget 也认为它们是同一台",
  );
});

test("deviceKey：不同 username 是不同设备", () => {
  const other = { ...target, username: "someone-else" };
  assert.notEqual(deviceKey(target), deviceKey(other));
  assert.equal(isSameDeviceTarget(target, other), false, "两层判定一致");
});

test("deviceKey：不同 host 是不同设备", () => {
  const other = { ...target, host: "100.66.1.9" };
  assert.notEqual(deviceKey(target), deviceKey(other));
  assert.equal(isSameDeviceTarget(target, other), false, "两层判定一致");
});

test("deviceKey：非 ssh 目标按 kind 归并（首版设备仅支持 SSH）", () => {
  assert.equal(deviceKey({ kind: "docker", container: "c1" } as never), "docker:default");
  assert.equal(deviceKey({ kind: "wsl" } as never), "wsl:default");
  assert.equal(deviceKey(null), null);
  assert.equal(deviceKey(undefined), null);
});

/**
 * 单设备范围（CONTEXT.md「Single Device Scope」）：同时只连一台被投射设备。
 *
 * 缺陷经过（穷举场景 S10）：连上 A 后连 B，`setDeviceSession` 只是按 key 追加，
 * A 的会话既不断开也无处管理（设置页只暴露一台设备）—— 成为无人回收的泄漏连接。
 */

test("连第二台设备时终结第一台的会话（单设备范围）", () => {
  const store = useDeviceSessionStore;
  const disposedA: string[] = [];
  store.setState({ sessionsByDeviceKey: {} });

  store.getState().setDeviceSession({
    target,
    sessionId: "sess-A",
    services: {} as never,
    dispose: () => disposedA.push("A"),
  });
  assert.deepEqual(Object.keys(store.getState().sessionsByDeviceKey), ["ssh:linguojin@100.66.1.2"]);

  store.getState().setDeviceSession({
    target: otherDevice,
    sessionId: "sess-B",
    services: {} as never,
    dispose: () => disposedA.push("B"),
  });

  assert.deepEqual(disposedA, ["A"], "切到 B 时先终结 A —— 否则泄漏一条无人管理的连接");
  assert.deepEqual(
    Object.keys(store.getState().sessionsByDeviceKey),
    ["ssh:linguojin@100.66.1.9"],
    "只保留当前设备",
  );
  store.setState({ sessionsByDeviceKey: {} });
});

test("同一设备重连：终结旧代，保留新代（不误判为切设备）", () => {
  const store = useDeviceSessionStore;
  const disposed: string[] = [];
  store.setState({ sessionsByDeviceKey: {} });

  store.getState().setDeviceSession({
    target,
    sessionId: "sess-old",
    services: {} as never,
    dispose: () => disposed.push("old"),
  });
  store.getState().setDeviceSession({
    target,
    sessionId: "sess-new",
    services: {} as never,
    dispose: () => disposed.push("new"),
  });

  assert.deepEqual(disposed, ["old"], "旧代被终结，新代保留");
  assert.equal(
    store.getState().sessionsByDeviceKey["ssh:linguojin@100.66.1.2"]?.sessionId,
    "sess-new",
  );
  store.setState({ sessionsByDeviceKey: {} });
});
