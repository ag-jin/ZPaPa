/**
 * 远程设备配置服务：投射端的设备连接入口与显示偏好。
 *
 * 为什么独立于 settings：settings.json 是**多个版本实例共享**的文件，不认识新增
 * 字段的旧版本实例会在写入时把它丢弃（实测：同机并存的官方版每次写 settings 都
 * 抹掉设备配置）。设备配置因此走独立文件，与 credentials / bot-config 同类。
 */
import { createServiceDescriptor } from "../descriptors.js";
import type { RemoteTarget } from "@zcode/shared";

export interface RemoteDeviceConfigRecord {
  readonly target: RemoteTarget;
  readonly lastConnectedAt?: number;
  readonly lastConnectionStatus: "connected" | "failed" | "never";
  readonly lastConnectionError?: string;
  /** 显示偏好：设备上哪些项目在投射端显示（键为设备上的项目路径）。 */
  readonly visibleProjects?: Record<string, boolean>;
}

export interface IRemoteDeviceConfigService {
  /** 读取已保存的设备（首版只支持一台，返回列表以便将来扩展）。 */
  list(): Promise<RemoteDeviceConfigRecord[]>;
  /** 覆盖写入设备列表。 */
  save(devices: readonly RemoteDeviceConfigRecord[]): Promise<void>;
}

export const IRemoteDeviceConfigService = createServiceDescriptor<IRemoteDeviceConfigService>(
  // 频道名与 ServiceChannels.RemoteDeviceConfig 对齐，避免两处字符串漂移。
  "remote-device-config",
);
