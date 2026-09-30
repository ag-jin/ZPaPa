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

/** 判定两台设备是否同一台（与 findDeviceSessionId 同口径：SSH 比 host+username）。 */
export function isSameDeviceTarget(
  left: { kind: string; host?: string; username?: string } | undefined,
  right: { kind: string; host?: string; username?: string } | undefined,
): boolean {
  if (!left || !right || left.kind !== right.kind) return false;
  if (left.kind !== "ssh") return true;
  return left.host === right.host && left.username === right.username;
}

/**
 * 找出「应关闭的投射条目」—— 一台设备只保留一代。
 *
 * 为什么不变量是「一台设备一代」：投射条目的生命周期严格跟随连接（ADR 0001），
 * 每次连接产生一个新的 deviceSessionId。若旧代不被清掉，用户每连一次侧边栏就
 * 多出一整套项目（实测：正式版出现 3 代共存 —— 同一台设备的 `6aba478d`、
 * `97bc8b6e`、`9f9c3f17` 各带「新赛马 + 中转站」，共 6 条 + 1 条陈旧断开态）。
 *
 * 为什么不能只按 deviceSessionId 去重：那是"同一代内的重复"。跨代残留的每一条
 * 都属于**另一个** deviceSessionId，在本代视角里根本看不见（实测第一版修复就
 * 栽在这里：只解决了同代同路径重复，用户那边仍在"每连接一次就增加"）。
 *
 * 判据（按 tab 自带的 remoteTarget 分组，不依赖 session 注册表 —— 旧代的 session
 * 可能仍被登记着，靠"session 是否注销"判不出过期）：
 *   1. 属于本设备、但 deviceSessionId 不是当前代 → 关掉（跨代残留）；
 *   2. 当前代内同路径多条 → 留一条，其余关掉（认领按路径建 Map 只取到一个，
 *      另一条会落进"既不被认领也不被孤儿清理"的空隙）。
 *
 * 保留规则：同路径优先留「活跃条目」（有 remoteSessionId）；全是断开态时留一条 ——
 * 断开态是规格 US 4/5/17 要求的重连入口，不能全清掉。
 *
 * 缺少 remoteTarget 的条目（更早版本创建的）不参与本设备的判定，回退给
 * findOrphanProjectionTabs 按 session 注销与否处理：保守，不会误删。
 */
export function findProjectionTabsToClose(params: {
  tabs: readonly Pick<
    WorkspaceTabState,
    "id" | "workspacePath" | "projection" | "remoteSessionId" | "remoteTarget"
  >[];
  /** 当前代（本次连接 / 同步对应的 session）。 */
  deviceSessionId: string;
  /** 当前设备目标；缺省时退化为只处理当前代内部的重复。 */
  target?: { kind: string; host?: string; username?: string };
}): string[] {
  const mine = params.tabs.filter(
    (tab) =>
      tab.projection != null &&
      (params.target
        ? isSameDeviceTarget(tab.remoteTarget, params.target)
        : tab.projection.deviceSessionId === params.deviceSessionId),
  );
  const currentGeneration: typeof mine = [];
  const staleGenerations: typeof mine = [];
  for (const tab of mine) {
    if (tab.projection?.deviceSessionId !== params.deviceSessionId) staleGenerations.push(tab);
    else currentGeneration.push(tab);
  }

  // 当前代内同路径去重：有活跃条目时断开态是残件；全是断开态时留一条。
  const toClose: string[] = [];
  const currentByPath = new Map<string, typeof currentGeneration>();
  for (const tab of currentGeneration) {
    const group = currentByPath.get(tab.workspacePath);
    if (group) group.push(tab);
    else currentByPath.set(tab.workspacePath, [tab]);
  }
  for (const group of currentByPath.values()) {
    if (group.length < 2) continue;
    const live = group.filter((tab) => Boolean(tab.remoteSessionId));
    if (live.length > 0) {
      for (const tab of group) {
        if (!tab.remoteSessionId) toClose.push(tab.id);
      }
      continue;
    }
    // 全是断开态：留第一个，其余是重复。
    for (const tab of group.slice(1)) toClose.push(tab.id);
  }

  // 跨代残留：关掉 —— 但要保证**每个项目仍留一个入口**。
  //
  // 不能一律清光旧代：设备当前完全断开时（当前代没有条目），旧代条目是用户
  // 唯一的重连入口，清光会让侧边栏彻底空掉（规格 US 4/5/17 要求断开后仍能点
  // 条目重连）。因此按路径保留"当前代没有覆盖到的"那个路径的第一条旧代条目。
  const coveredPaths = new Set(currentGeneration.map((tab) => tab.workspacePath));
  const staleByPath = new Map<string, typeof staleGenerations>();
  for (const tab of staleGenerations) {
    const group = staleByPath.get(tab.workspacePath);
    if (group) group.push(tab);
    else staleByPath.set(tab.workspacePath, [tab]);
  }
  for (const [path, group] of staleByPath) {
    // 当前代已覆盖该项目 → 旧代全是残留，全关。
    if (coveredPaths.has(path)) {
      for (const tab of group) toClose.push(tab.id);
      continue;
    }
    // 当前代没有该项目 → 留一条作入口，其余是重复代。
    for (const tab of group.slice(1)) toClose.push(tab.id);
  }
  return toClose;
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

/** 设备记录里与本模块相关的字段（结构类型，避免 lib 依赖 services 包）。 */
export interface DeviceRecordPatch {
  readonly target: { kind: string; host?: string; username?: string; port?: number };
  readonly lastConnectedAt?: number;
  readonly lastConnectionStatus?: "connected" | "failed" | "never";
  readonly lastConnectionError?: string;
  readonly visibleProjects?: Record<string, boolean>;
}

/**
 * 把一次设备状态更新**合并**进已有设备记录，而不是整体覆盖。
 *
 * 为什么必须合并（2026-09-30 实测缺陷）：原先两处写入都是整体覆盖 ——
 * 登记设备时 `save([{ target, lastConnectionStatus }])`、状态更新时
 * `save([next])`。任何一次写入都会把用户先前设置的 `visibleProjects`
 * （哪些项目在投射端显示）抹掉，最终设备记录退化成只剩 SSH 目标，
 * 用户"关掉项目后设备条目变成一个 ssh 端口"。
 *
 * 合并规则：
 * - 目标相同（同 kind，SSH 比 host + username）视为同一台设备，保留其既有字段；
 * - patch 显式给出的字段覆盖旧值，未给出的保持不动；
 * - 目标不同则视为新增设备（首版单设备，但数据结构按列表存）。
 *
 * 纯函数：不读文件、不碰 store，便于单测锁定「合并不丢字段」这条不变量。
 */
export function mergeDeviceRecord<T extends DeviceRecordPatch>(
  devices: readonly T[],
  patch: DeviceRecordPatch,
): T[] {
  const index = devices.findIndex((device) => isSameDeviceTarget(device.target, patch.target));
  if (index < 0) {
    return [...devices, patch as T];
  }
  const merged = { ...devices[index], ...patch } as T;
  return devices.map((device, i) => (i === index ? merged : device));
}

/**
 * 按 target 找出那台设备的记录。
 *
 * **不要用 `devices[0]` 代替**：记录按列表存（CONTEXT.md「Single Device Scope」
 * 明确"数据结构按列表存，将来增设备不需重构"），取首条会命中**别台** ——
 * 例如侧栏重连列表里的第二台时读到第一台的显示偏好，于是本台该隐藏的被投出来、
 * 该显示的被过滤掉。
 *
 * 纯函数，便于单测锁定「按台定位而不是取首条」。
 */
export function findDeviceRecord<T extends DeviceRecordPatch>(
  devices: readonly T[],
  target: DeviceRecordPatch["target"] | undefined,
): T | undefined {
  if (!target) return undefined;
  return devices.find((device) => isSameDeviceTarget(device.target, target));
}

/**
 * 计算「把某项目标记为不显示」后的设备记录。
 *
 * 场景：用户在侧栏直接关掉一个投射条目。若不回写偏好，下次重连时
 * syncProjection 仍按旧偏好把它投回来 —— 用户关掉的条目自己又出现了。
 * 设置页的开关本来就会写这个偏好，侧栏关闭走同一份事实，两条路径才一致。
 *
 * 只在**用户手势**上调用（侧栏移除菜单）：程序化关闭（换连接的旧代清理、
 * 同步投射的移除）不代表用户不想看，写进去会把项目永久隐藏。
 *
 * 纯函数，便于单测锁定「关掉即持久不显示」。
 */
export function markProjectHidden<T extends DeviceRecordPatch>(
  devices: readonly T[],
  target: DeviceRecordPatch["target"],
  projectPath: string,
): T[] {
  const index = devices.findIndex((device) => isSameDeviceTarget(device.target, target));
  if (index < 0) return [...devices];
  const current = devices[index] as DeviceRecordPatch;
  return mergeDeviceRecord(devices, {
    target,
    // 展开 undefined 本就是空操作，无需 `?? {}` 兜底（oxlint 会拒绝多余兜底）。
    visibleProjects: { ...current.visibleProjects, [projectPath]: false },
  });
}

/**
 * 只移除目标设备的记录，保留其它设备。
 *
 * 为什么不能用 `save([])`：那是"清空列表"语义。设备记录按列表存（CONTEXT.md
 * 「Single Device Scope」明确「数据结构按列表存，将来增设备不需重构」），
 * 列表里可能不止一条；移除一台时清空会把别台的连接入口与显示偏好一并删掉。
 *
 * 纯函数，便于单测锁定「移除只作用于目标台」。
 */
export function removeDeviceRecord<T extends DeviceRecordPatch>(
  devices: readonly T[],
  target: DeviceRecordPatch["target"],
): T[] {
  return devices.filter((device) => !isSameDeviceTarget(device.target, target));
}

/**
 * 找出属于某台设备的**全部**投射条目（含断开态），用于"移除设备"时清场。
 *
 * 为什么不能只按 `projection.deviceSessionId === 当前 sessionId` 找：
 * 断开后条目被降级（remoteSessionId 已清），此时关闭事件里的 sessionId 已失效，
 * 按 sessionId 找不到它们 —— 残留的灰显条目其 remoteTarget 指向一台已被移除的设备，
 * 点击重连把一个不存在的设备又连回来。
 *
 * 判据用 remoteTarget（断开态仍保留），覆盖连接态与断开态两种条目。
 */
export function findProjectionTabsForDevice(
  tabs: readonly WindowTabState[],
  target: { kind: string; host?: string; username?: string } | undefined,
): WorkspaceTabState[] {
  if (!target) return [];
  return tabs.filter(
    (tab): tab is WorkspaceTabState =>
      isWorkspaceTab(tab) &&
      tab.projection != null &&
      isSameDeviceTarget(tab.remoteTarget, target),
  );
}
