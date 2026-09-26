/**
 * 设备访问：对远程设备做「不指定项目」的设备级查询。
 *
 * 为什么需要探测而不是直接调用：
 * 设备级枚举（不传 workspacePath）是较新的能力，较早构建的对端会把缺省参数
 * 解引用为空而报错。而产品约束是「投射端不强制对端升级」，因此这里必须先探测
 * 能力、再决定用哪种方式，而不是假设对端一定支持。
 *
 * 探测依据是**行为**而非版本号：能力是否可用，直接试一次即可知道，且对端的
 * 版本号不保证与实际能力一一对应（同一版本可能因构建差异缺能力）。
 */

export interface DeviceTaskMeta {
  readonly taskId: string;
  readonly title?: string;
  readonly status?: string;
  readonly workspacePath?: string;
  readonly updatedAt?: number;
}

export interface DeviceTaskQuery {
  /**
   * 枚举该设备的全部会话（不指定项目）。用于构建设备的项目清单。
   *
   * 内部会先尝试「不带项目参数的枚举」，若对端不支持则退化为「按已登记项目逐个查询」。
   */
  listAllTasks(): Promise<DeviceTaskMeta[]>;
  /** 读取设备已登记的项目路径（来自其设置）。 */
  listRegisteredProjects(): Promise<string[]>;
  /** 某个项目下的会话（排除已归档）。 */
  listProjectTasks(projectPath: string): Promise<DeviceTaskMeta[]>;
}

/** 设备服务访问面的最小依赖（便于测试替身）。 */
export interface DeviceServiceAccess {
  readonly zcodeTaskService: {
    listTasks(params?: { workspacePath?: string; workspaceIdentity?: string }): Promise<
      readonly unknown[]
    >;
  };
  readonly settingService: {
    get(): Promise<{ recentProjects?: string[] }>;
  };
}

export interface DeviceAccessResult {
  readonly access: DeviceTaskQuery;
  /**
   * 对端是否支持设备级全量枚举；false 表示已退化为按项目查询。
   *
   * 首次调用 `access.listAllTasks()` 之前该值恒为 false（尚未探测）。
   */
  readonly supportsDeviceWideEnumeration: boolean;
}

function asTaskMeta(value: unknown): DeviceTaskMeta | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const taskId = typeof record.taskId === "string" ? record.taskId : undefined;
  if (!taskId) return null;
  return {
    taskId,
    ...(typeof record.title === "string" ? { title: record.title } : {}),
    ...(typeof record.status === "string" ? { status: record.status } : {}),
    ...(typeof record.workspacePath === "string" ? { workspacePath: record.workspacePath } : {}),
    ...(typeof record.updatedAt === "number" ? { updatedAt: record.updatedAt } : {}),
  };
}

/**
 * 创建设备访问面。
 *
 * 能力探测只做一次并缓存结论：探测本身要在对端跑一次查询，重复探测没有意义；
 * 一旦确认不支持，后续全部走按项目查询的退化路径。
 */
export async function createDeviceAccess(
  services: DeviceServiceAccess,
): Promise<DeviceAccessResult> {
  let supportsDeviceWideEnumeration = false;
  let enumerationProbed = false;

  const listRegisteredProjects = async (): Promise<string[]> => {
    const settings = await services.settingService.get();
    const recent = settings.recentProjects ?? [];
    return recent.filter((item): item is string => typeof item === "string" && item.length > 0);
  };

  const listProjectTasks = async (projectPath: string): Promise<DeviceTaskMeta[]> => {
    const raw = await services.zcodeTaskService.listTasks({ workspacePath: projectPath });
    return raw.map(asTaskMeta).filter((item): item is DeviceTaskMeta => item !== null);
  };

  const probeDeviceWideEnumeration = async (): Promise<boolean> => {
    try {
      // 不传参数即"所有项目"；旧构建会在这里报错，据此判定能力缺失。
      await services.zcodeTaskService.listTasks();
      return true;
    } catch {
      return false;
    }
  };

  const listAllTasks = async (): Promise<DeviceTaskMeta[]> => {
    if (!enumerationProbed) {
      supportsDeviceWideEnumeration = await probeDeviceWideEnumeration();
      enumerationProbed = true;
    }
    if (supportsDeviceWideEnumeration) {
      try {
        const raw = await services.zcodeTaskService.listTasks();
        return raw.map(asTaskMeta).filter((item): item is DeviceTaskMeta => item !== null);
      } catch {
        // 探测后仍失败（如连接中断）：继续走退化路径，不把失败当"没有会话"。
        supportsDeviceWideEnumeration = false;
      }
    }
    // 退化：按设备已登记的项目逐个查询，再合并去重。
    const projects = await listRegisteredProjects();
    const seen = new Set<string>();
    const merged: DeviceTaskMeta[] = [];
    for (const projectPath of projects) {
      for (const task of await listProjectTasks(projectPath)) {
        if (seen.has(task.taskId)) continue;
        seen.add(task.taskId);
        merged.push({ ...task, workspacePath: task.workspacePath ?? projectPath });
      }
    }
    return merged;
  };

  return {
    access: { listAllTasks, listRegisteredProjects, listProjectTasks },
    // 用 getter 而非快照：能力结论在首次 listAllTasks 时才确定，
    // 若在返回对象时取值，调用方拿到的永远是探测前的初始值。
    get supportsDeviceWideEnumeration() {
      return supportsDeviceWideEnumeration;
    },
  };
}

/**
 * 由设备的会话集合推导「投影项目清单」。
 *
 * 取「已登记项目」与「实际有会话的项目」的并集：新登记但尚无会话的项目必须可见，
 * 否则用户添加后看不到会困惑；只按已登记会让跑过但未登记的项目消失。
 */
export function buildProjectedProjectList(params: {
  registeredProjects: readonly string[];
  tasks: readonly DeviceTaskMeta[];
}): Array<{ path: string; sessionCount: number }> {
  const counts = new Map<string, number>();
  for (const projectPath of params.registeredProjects) {
    if (projectPath) counts.set(projectPath, counts.get(projectPath) ?? 0);
  }
  for (const task of params.tasks) {
    const projectPath = task.workspacePath;
    if (!projectPath) continue;
    counts.set(projectPath, (counts.get(projectPath) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([path, sessionCount]) => ({ path, sessionCount }))
    .sort(
      (left, right) =>
        right.sessionCount - left.sessionCount || left.path.localeCompare(right.path),
    );
}
