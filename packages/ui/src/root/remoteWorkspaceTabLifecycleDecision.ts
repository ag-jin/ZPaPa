import type { WindowTabState, WorkspaceTabState } from "@/store/tabStore.js";

/**
 * 远程 tab 生命周期里**纯判定**部分。
 *
 * 为什么单独成模块：`useRemoteWorkspaceTabLifecycle` 顶层 import react，
 * 纯 Node 测试环境无法加载它，导致「关掉最后一个投射 tab 会不会断连」这条
 * 核心不变量无法被单测锁定。而它正是本次重设计的关键行为
 * （2026-09-30 用户实测：关光项目后设备条目退化成裸 SSH 端口、再也连不上）。
 *
 * 本模块只做判定，不做副作用（不 dispose、不碰 store），由 hook 消费结果。
 */

/** 与 store 的 isWorkspaceTab 同义；本地内联避免 lib 层依赖 store 运行时。 */
function isWorkspaceTab(tab: WindowTabState): tab is WorkspaceTabState {
  return tab.kind === "workspace";
}

/** 该 tab 是否代表一个远程 workspace（用于判定「关闭」）。 */
export function remoteWorkspaceKey(tab: WorkspaceTabState): string | null {
  if (!tab.workspaceIdentity?.trim() && !tab.remoteSessionId && !tab.remoteTarget) {
    return null;
  }
  return tab.workspaceIdentity?.trim() || tab.workspacePath;
}

/**
 * 关闭判定中要跳过该 tab 吗？
 *
 * 设备级会话（连接归设备所有）**不参与** tab 生命周期：关掉投射 tab 只是关视图，
 * 不代表「远程 workspace 已关闭」。若不跳过，用户关掉最后一个项目就会触发
 * 设备会话的释放 —— 这正是本次要修的缺陷。
 */
function shouldSkipDeviceOwnedTab(
  tab: WorkspaceTabState,
  isDeviceOwnedSessionId: (sessionId: string) => boolean,
): boolean {
  return Boolean(tab.remoteSessionId && isDeviceOwnedSessionId(tab.remoteSessionId));
}

/** 本次变更中「已关闭的远程 workspace key」。 */
export function collectClosedRemoteWorkspaceKeys(
  previousWorkspaceTabs: readonly WorkspaceTabState[],
  nextWorkspaceTabs: readonly WorkspaceTabState[],
  isDeviceOwnedSessionId: (sessionId: string) => boolean = () => false,
): string[] {
  const nextRemoteWorkspaceKeys = new Set(
    nextWorkspaceTabs.flatMap((tab) => {
      const workspaceKey = remoteWorkspaceKey(tab);
      return workspaceKey ? [workspaceKey] : [];
    }),
  );
  const closedRemoteWorkspaceKeys = new Set<string>();

  for (const previousTab of previousWorkspaceTabs) {
    if (shouldSkipDeviceOwnedTab(previousTab, isDeviceOwnedSessionId)) continue;
    const workspaceKey = remoteWorkspaceKey(previousTab);
    if (!workspaceKey || nextRemoteWorkspaceKeys.has(workspaceKey)) {
      continue;
    }
    closedRemoteWorkspaceKeys.add(workspaceKey);
  }

  return [...closedRemoteWorkspaceKeys];
}

/**
 * 本次变更中需要补释放的 session id（「先断连、后清掉 tab 字段」的那批）。
 *
 * 设备级会话永不在此列：它们的释放只归设备（显式断开/移除设备）。
 */
export function collectClosedRemoteWorkspaceSessionIds(
  previousWorkspaceTabs: readonly WorkspaceTabState[],
  nextWorkspaceTabs: readonly WorkspaceTabState[],
  rememberedSessionIdsByWorkspaceKey: ReadonlyMap<string, string>,
  isDeviceOwnedSessionId: (sessionId: string) => boolean = () => false,
): string[] {
  const previousLiveSessionIds = new Set(
    previousWorkspaceTabs
      .map((tab) => tab.remoteSessionId)
      .filter((sessionId): sessionId is string => Boolean(sessionId)),
  );

  return collectClosedRemoteWorkspaceKeys(
    previousWorkspaceTabs,
    nextWorkspaceTabs,
    isDeviceOwnedSessionId,
  ).flatMap((workspaceKey) => {
    const sessionId = rememberedSessionIdsByWorkspaceKey.get(workspaceKey);
    // 仍带 remoteSessionId 的 tab 会由正常移除流程释放，这里只补释放
    // “先断连、后清掉 tab 字段”的 session，避免重复 dispose。
    if (!sessionId || previousLiveSessionIds.has(sessionId)) return [];
    if (isDeviceOwnedSessionId(sessionId)) return [];
    return [sessionId];
  });
}

/**
 * 本次变更中应被自动释放的 session id（普通远程 workspace 的 tab 全部关掉）。
 *
 * 这是「关 tab 断连」的唯一入口判定；设备级会话在此被排除。
 */
export function collectSessionsToDisposeOnTabRemoval(
  previousWorkspaceTabs: readonly WorkspaceTabState[],
  nextWorkspaceTabs: readonly WorkspaceTabState[],
  isDeviceOwnedSessionId: (sessionId: string) => boolean = () => false,
): string[] {
  const nextRemoteSessionIds = new Set(
    nextWorkspaceTabs
      .map((tab) => tab.remoteSessionId)
      .filter((sessionId): sessionId is string => Boolean(sessionId)),
  );

  const disposed = new Set<string>();
  for (const previousTab of previousWorkspaceTabs) {
    const sessionId = previousTab.remoteSessionId;
    if (!sessionId || nextRemoteSessionIds.has(sessionId) || disposed.has(sessionId)) continue;
    // 设备级会话不因 tab 消失而释放：一台设备的所有项目投射 tab 共享同一个
    // remoteSessionId，若照旧 dispose，关掉最后一个项目就会断掉整条 SSH 连接。
    if (isDeviceOwnedSessionId(sessionId)) continue;
    disposed.add(sessionId);
  }
  return [...disposed];
}

/** 只保留 workspace tab（供 hook 调用方与测试复用）。 */
export function filterWorkspaceTabs(tabs: readonly WindowTabState[]): WorkspaceTabState[] {
  return tabs.filter(isWorkspaceTab);
}
