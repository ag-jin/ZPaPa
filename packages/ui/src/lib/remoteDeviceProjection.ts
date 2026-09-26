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
import type { WorkspaceTabState } from "@/store/tabStore.js";

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
