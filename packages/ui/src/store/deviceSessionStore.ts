import { create } from "zustand";
import type { RemoteTarget } from "@zcode/shared";
import type { IServiceAccessor } from "@zcode/services";

/**
 * 设备级远程会话的持有者。
 *
 * ## 为什么需要这个 store（2026-09-30 根因）
 *
 * 修复前，设备的连接被**投射 tab** 间接持有：一台设备的所有项目投射 tab 共享同一个
 * `remoteSessionId`，而 `useRemoteWorkspaceTabLifecycle` 在 tab 消失时无条件
 * `disposeRemoteSession`。于是用户**关掉最后一个项目就断掉整条 SSH 连接**，
 * 设备条目随之退化成裸 `user@host:port`，再次点击无法恢复
 * （用户原话：「远程设备的项目如果全部关闭会变成 ssh 端口，再次就无法连接上」）。
 *
 * 连接在语义上是**设备级**的（CONTEXT.md「连设备」而非「连项目」），
 * 因此必须由设备身份持有，而不是由视图（tab）持有。
 *
 * ## 为什么不放在组件里
 *
 * 修复前由 `SettingsPage` 的 `useRef` 持有连接，组件一卸载引用即丢（该处注释已自承），
 * 而设置页在连接成功后会切走一次。模块级 store 跨挂载存活，且侧栏、设置页、
 * 重连入口可以共享同一份事实，不必各自维护。
 *
 * ## 与 ADR 0001 / CONTEXT.md 的关系
 *
 * 这里只持有**连接**（sessionId + services + dispose），不持有项目清单 ——
 * 项目清单仍按「Disconnected Retention」在连接后从设备实时获取。
 * 断开后本 store 不留设备条目（设备条目由 remote-devices.json 承担）。
 */

export interface DeviceSession {
  readonly target: RemoteTarget;
  readonly sessionId: string;
  readonly services: IServiceAccessor;
  /** 由创建方提供；store 只负责在替换/移除时调用它。 */
  readonly dispose?: (reason?: Error) => void;
}

interface DeviceSessionState {
  /** 按设备身份索引（SSH 为 host+username，见 isSameDeviceTarget）。 */
  sessionsByDeviceKey: Record<string, DeviceSession>;
  setDeviceSession: (session: DeviceSession) => void;
  removeDeviceSession: (target: RemoteTarget) => void;
  clearDeviceSessions: () => void;
}

/**
 * 设备身份键。
 *
 * 口径与 `remoteDeviceProjection.ts` 的 `isSameDeviceTarget` / `findDeviceSessionId`
 * 保持一致（SSH 比 host + username）—— 两套「同机」规则不一致会让同一台设备在不同
 * 代码路径下得出不同结论（历史上 findDeviceSessionId 与投射清理各判一次，已踩过）。
 * 这里额外带上 port：同一 host 的不同端口是不同接入点。
 */
export function deviceKey(target: RemoteTarget | null | undefined): string | null {
  if (!target) return null;
  if (target.kind !== "ssh") return `${target.kind}:default`;
  const port = target.port ?? 22;
  return `ssh:${target.username}@${target.host}:${port}`;
}

export const useDeviceSessionStore = create<DeviceSessionState>()((set) => ({
  sessionsByDeviceKey: {},

  setDeviceSession: (session) =>
    set((state) => {
      const key = deviceKey(session.target);
      if (!key) return state;
      const previous = state.sessionsByDeviceKey[key];
      // 同一设备重连会换新的 sessionId：先终结旧会话，避免旧 MessagePort 上的
      // 挂起 RPC 永久悬置（与 remoteWorkspaceSessionStore 的换代处理同因）。
      if (previous && previous.sessionId !== session.sessionId) {
        previous.dispose?.(new Error("设备会话已被新一代连接替代"));
      }
      return { sessionsByDeviceKey: { ...state.sessionsByDeviceKey, [key]: session } };
    }),

  removeDeviceSession: (target) =>
    set((state) => {
      const key = deviceKey(target);
      if (!key || !(key in state.sessionsByDeviceKey)) return state;
      const next = { ...state.sessionsByDeviceKey };
      delete next[key];
      return { sessionsByDeviceKey: next };
    }),

  clearDeviceSessions: () =>
    set((state) =>
      Object.keys(state.sessionsByDeviceKey).length === 0
        ? state
        : { sessionsByDeviceKey: {} },
    ),
}));

/** 读取某台设备的会话（未连接返回 null）。 */
export function getDeviceSession(target: RemoteTarget | null | undefined): DeviceSession | null {
  const key = deviceKey(target);
  if (!key) return null;
  return useDeviceSessionStore.getState().sessionsByDeviceKey[key] ?? null;
}

/**
 * 关闭并移除某台设备的会话。
 *
 * 断开是**显式动作**（用户点断开、或设备被移除）：与「关 tab」彻底分开 ——
 * 这正是本次重设计的核心不变量。
 */
export function closeDeviceSession(target: RemoteTarget): void {
  const session = getDeviceSession(target);
  useDeviceSessionStore.getState().removeDeviceSession(target);
  session?.dispose?.();
}
