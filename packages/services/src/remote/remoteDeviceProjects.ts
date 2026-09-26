/**
 * 设备项目清单服务：读取**设备自身**登记的项目（投射用）。
 *
 * 为什么不能复用 settingService：远端 workspace 语义下，host 刻意把
 * `ISettingService` 注册为本机实现（见 remoteWorkspaceServiceCollection.ts：
 * 设置/凭据/OAuth/模型供应商必须读写本机，否则远端 shell 枚举、模型配置会串到对端）。
 * 但设备级投射要读的是「**那台设备**登记了哪些项目」这一业务事实。
 * 复用 settingService 的结果实测是：读回 A 自己的 recentProjects，
 * B 的 10 个项目一个都拿不到。
 *
 * 因此单开一个只读通道，由 A 侧 host 用它手里的**对端原始访问面**
 * （params.connectionServices，指向 B 的 resident host）代为读取。
 * 这样：
 * - 不改远端 workspace 的既有设置语义（模型配置等仍读本机）
 * - 不要求 B 升级（B 跑官方包也能答，因为读的就是 B 的 settingService.get）
 * - 语义清晰：拿到的是设备业务事实，不是"把对端设置当本机设置"
 */
import { createServiceDescriptor } from "../descriptors.js";

export interface IRemoteDeviceProjectsService {
  /**
   * 设备上已登记的项目路径（来自设备自身的 recentProjects）。
   *
   * 只读，且只返回路径字符串数组 —— 不含会话数据、不含设备本地偏好，
   * 与「投射端不存任何会话索引」的约定一致（见 ADR 0001）。
   */
  listRegisteredProjects(): Promise<string[]>;
  /**
   * 读设备自身的完整设置（供设置投射挑白名单字段展示）。
   *
   * 必须走这条而不是 session.services.settingService：后者按远端 workspace 语义
   * 刻意保留本机实现（见 remoteWorkspaceServiceCollection），用它读会拿到 A 的设置。
   */
  getSettings(): Promise<Record<string, unknown>>;
  /**
   * 写设备自身的一个设置字段。
   *
   * 调用方必须遵守「改前记录原值 → 写入 → 读回确认」的既有约定
   * （见 lib/remoteDeviceSettings.ts 的安全说明）。
   */
  updateSetting(key: string, value: unknown): Promise<void>;
}

export const IRemoteDeviceProjectsService = createServiceDescriptor<IRemoteDeviceProjectsService>(
  "remote-device-projects",
);
