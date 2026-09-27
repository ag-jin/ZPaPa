/**
 * 远程设备投射的生命周期管理。
 *
 * 职责（见 ADR 0001）：把「设备上的项目」反映为投射端的投射条目 ——
 * 连接建立时按显示偏好创建，断开时全部移除，应用重启后不恢复。
 *
 * 为什么不放进 tab 持久化：投射端不留存会话数据（CONTEXT.md「Retained State」），
 * 投射条目是内存态。若走持久化，就必须在断开/重连/异常退出时维护清理，
 * 状态一致性成本高且容易残留过期项目。
 */
import type { WindowTabState, WorkspaceTabState } from "@/store/tabStore.js";

/** tab 是否为 workspace 条目（与 store 的 isWorkspaceTab 同义）。
 * 本地内联而不从 store 引入运行时值：本模块是纯函数、被单测直接 import，
 * 引入 store 会连带整套 store 依赖，单测环境解析不了 "@/..." 别名。 */
function isWorkspaceTab(tab: WindowTabState): tab is WorkspaceTabState {
  return tab.kind === "workspace";
}

export interface ProjectedProject {
  readonly path: string;
  readonly sessionCount: number;
}

export interface SyncProjectionResult {
  /** 应创建的投射项目（未在投射端存在，且显示偏好允许）。 */
  readonly toCreate: ProjectedProject[];
  /** 应移除的投射条目 id（设备上已不存在，或显示偏好关闭）。 */
  readonly toRemoveTabIds: string[];
}

/**
 * 计算投射同步的差异。
 *
 * 纯函数：把「设备当前项目」与「投射端现有投射条目」做差集，避免每次全量重建
 * —— 全量重建会让用户正在查看的条目被销毁重建（丢失展开状态与滚动位置）。
 */
export function computeProjectionSync(params: {
  /** 设备上的项目（已按显示偏好过滤：不可见的项目不进入此列表）。 */
  deviceProjects: readonly ProjectedProject[];
  /** 投射端现有的投射条目（同一设备的）。 */
  existingTabs: readonly Pick<WorkspaceTabState, "id" | "workspacePath" | "projection">[];
  deviceSessionId: string;
}): SyncProjectionResult {
  const existingByPath = new Map<string, string>();
  const deviceProjectPaths = new Set<string>();
  for (const project of params.deviceProjects) {
    deviceProjectPaths.add(project.path);
  }

  const toRemoveTabIds: string[] = [];
  for (const tab of params.existingTabs) {
    // 只处理属于本设备的投射条目；设备已无该项目或已不可见 → 移除。
    if (tab.projection?.deviceSessionId !== params.deviceSessionId) continue;
    if (!deviceProjectPaths.has(tab.workspacePath)) {
      toRemoveTabIds.push(tab.id);
      continue;
    }
    existingByPath.set(tab.workspacePath, tab.id);
  }

  const toCreate = params.deviceProjects.filter(
    (project) => !existingByPath.has(project.path),
  );

  return { toCreate, toRemoveTabIds };
}

/**
 * 找出「孤儿投射条目」：其所属设备 session 已不在册的投射 tab。
 *
 * 为什么需要：同一台设备重连会换新的 deviceSessionId，而旧条目的 session 已注销。
 * 只按「是否等于当前 session」过滤时，这些旧条目既不会被复用、也不会被移除，
 * 且 dispose 按 session 回收也够不到它们 —— 每重连一次就多留一组孤儿 tab
 * （实测：连接 2 次 → 同一批项目出现两份，共 20 个投射项）。
 *
 * 判据用「session 是否仍在册」而不是「sessionId 不等」：后者会误删同时连接的
 * 另一台设备的投射（那台的 session 仍有效）。
 */
export function findOrphanProjectionTabs(params: {
  /** 投射端当前全部 workspace tab。 */
  tabs: readonly Pick<WorkspaceTabState, "id" | "projection" | "remoteSessionId">[];
  /** 本次同步对应的 session（它自己的条目不算孤儿）。 */
  currentSessionId: string;
  /** 判定某个 session 是否仍在册。 */
  isSessionRegistered: (sessionId: string) => boolean;
}): string[] {
  const orphans: string[] = [];
  for (const tab of params.tabs) {
    const owner = tab.projection?.deviceSessionId;
    if (!owner || owner === params.currentSessionId) continue;
    // 断开态条目不是孤儿：它已被降级为侧边栏的重连入口（规格 US 4/5/17），
    // 其 owner session 当然已注销 —— 正是靠这一条与"上一代活跃条目"区分开。
    // 不认识这点会把重连入口连同旧代一起清掉（实测：点重连后条目全没了）。
    if (!tab.remoteSessionId) continue;
    if (!params.isSessionRegistered(owner)) orphans.push(tab.id);
  }
  return orphans;
}

/**
 * 按显示偏好过滤设备项目。
 *
 * 缺省显示：未在偏好中显式关闭的项目都投射（与设置页勾选的缺省语义一致）——
 * 否则用户连上设备后侧边栏空无一物，会以为功能没生效。
 */
export function filterProjectsByVisibility(
  projects: readonly ProjectedProject[],
  visibleProjects: Readonly<Record<string, boolean>> | undefined,
): ProjectedProject[] {
  if (!visibleProjects) return [...projects];
  return projects.filter((project) => visibleProjects[project.path] !== false);
}

/**
 * 在在册 session 里找出属于指定设备的那个（设备卡片据此显示真实连接状态）。
 *
 * 为什么不能只看组件内 state：连接成功后设置页会被卸载（连接流程切到工作区），
 * 组件内 state 随之丢失，重开设置页会错误显示「未连接」并隐藏「断开」入口，
 * 而连接其实还活着。因此状态必须从 session 注册表反推。
 *
 * 判据用 target 相等（kind + host + username），不做字符串 identity 拼接
 * （AGENTS.md 禁止业务代码手写 identity）。
 */
export function findDeviceSessionId(
  sessionsById: Readonly<
    Record<string, { sessionId: string; target?: { kind: string; host?: string; username?: string } }>
  >,
  target: { kind: string; host?: string; username?: string } | null | undefined,
): string | undefined {
  if (!target) return undefined;
  for (const session of Object.values(sessionsById)) {
    const candidate = session.target;
    if (!candidate || candidate.kind !== target.kind) continue;
    // SSH 是设备级连接的主要形态：同 kind 且同 host+username 即认作同一台设备。
    // WSL/Docker 没有 host，退回按 kind 匹配（首版设备仅支持 SSH）。
    if (target.kind === "ssh") {
      if (candidate.host === target.host && candidate.username === target.username) {
        return session.sessionId;
      }
      continue;
    }
    return session.sessionId;
  }
  return undefined;
}

/**
 * 断开时把设备投射条目降级为「断开态」，而不是删除。
 *
 * 规格 User Story 4/5/17：断开后仍要能看到设备条目（灰显）并**点击重连**，
 * 不必回设置页翻找。产品既有的断连态渲染以「是 remote workspace 但
 * remoteSessionId 为空」判定（见 WorkspaceSidebarItem），因此降级 = 清掉
 * remoteSessionId，保留 projection 标记（重连时靠它找回这批条目）。
 *
 * 注意：不删除也不新建 tab —— 保留条目让用户的展开态与位置不变。
 */
export function markProjectionTabsDisconnected(
  store: TabStoreApiLike,
  deviceSessionId: string,
): number {
  const matched = store.getState().tabs.filter(
    (tab) => isWorkspaceTab(tab) && tab.projection?.deviceSessionId === deviceSessionId,
  );
  if (matched.length === 0) return 0;
  const ids = new Set(matched.map((tab) => tab.id));
  store.setState((state) => ({
    tabs: state.tabs.map((tab) =>
      ids.has(tab.id) && isWorkspaceTab(tab) ? { ...tab, remoteSessionId: undefined } : tab,
    ),
  }));
  return matched.length;
}

/**
 * 只取本模块需要的 store 面，便于纯函数测试替身。
 *
 * 结构类型而非 import TabStore：避免 lib 层依赖 store 的完整实现面。
 */
interface TabStoreApiLike {
  getState(): { tabs: WindowTabState[] };
  setState(updater: (state: { tabs: WindowTabState[] }) => { tabs: WindowTabState[] }): void;
}
