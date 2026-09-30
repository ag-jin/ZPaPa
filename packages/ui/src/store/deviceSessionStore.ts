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
}

/**
 * 设备身份键。
 *
 * **必须与 `remoteDeviceProjection.ts` 的 `isSameDeviceTarget` 完全同口径**
 * （SSH 比 host + username，不比较 port）。
 *
 * 曾经这里额外带上 port，与记录层的 `isSameDeviceTarget`（不比较 port）不一致：
 * 同一 host 换端口接入时，记录层按"同一台设备"合并、会话层却按两台各存一份，
 * 旧会话条目从此无人回收（`setDeviceSession` 只在同键时才终结旧会话）。
 * 「同机」判定必须全仓一套规则，否则两条路径必然对同一事实得出不同结论。
 */
export function deviceKey(target: RemoteTarget | null | undefined): string | null {
  if (!target) return null;
  if (target.kind !== "ssh") return `${target.kind}:default`;
  return `ssh:${target.username}@${target.host}`;
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

/**
 * 按 sessionId 移除登记（不调用 dispose）。
 *
 * 用于**远端自行断开**：会话已经死了，此时只能按 sessionId 定位 ——
 * 而事件里没有 target，无法走 removeDeviceSession。
 *
 * 不在这里 dispose：调用方（会话关闭处理器）已在走自己的降级与清理流程，
 * 再 dispose 一次会对同一 session 重复释放。
 *
 * 不清理的后果（实测确认）：设备 store 里留着死会话 → 设置页按
 * `liveDeviceSessionId` 判断连接态，会一直显示「已连接」并给出「断开」按钮，
 * 而实际连接早已不存在；用户点断开只是对一条死会话再释放一次。
 */
export function removeDeviceSessionBySessionId(sessionId: string): void {
  useDeviceSessionStore.setState((state) => {
    const entry = Object.entries(state.sessionsByDeviceKey).find(
      ([, session]) => session.sessionId === sessionId,
    );
    if (!entry) return state;
    const next = { ...state.sessionsByDeviceKey };
    delete next[entry[0]];
    return { sessionsByDeviceKey: next };
  });
}
