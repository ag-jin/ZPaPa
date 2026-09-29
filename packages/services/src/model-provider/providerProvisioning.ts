import type { ProviderProvisioningEnvelope, ProviderProvisioningResult } from "@zcode/shared";
import { ServiceChannels } from "@zcode/shared";
import { createServiceDescriptor } from "../descriptors.js";

/** 仅供 Window Host 调用的远端 Environment target，不加入 IServiceAccessor。 */
export interface IProviderProvisioningTargetService {
  apply(envelope: ProviderProvisioningEnvelope): Promise<ProviderProvisioningResult>;
}

export const IProviderProvisioningTargetService =
  createServiceDescriptor<IProviderProvisioningTargetService>(
    ServiceChannels.ProviderProvisioningTarget,
  );

/**
 * Provisioning 携带跨 Environment 凭据（含 OAuth 会话与账号 API key），
 * 只有受信 Desktop Host 连接可以使用真实 target。`desktop-continuous` 是桌面
 * 实时链路（含投射端经 /ws/host 的挂载）；手机与 Web 远控走 `web-remote-replayable`。
 */
export const PROVIDER_PROVISIONING_TRUSTED_CLIENT_MODE = "desktop-continuous" as const;

export function isProviderProvisioningTrustedClientMode(clientMode: string): boolean {
  return clientMode === PROVIDER_PROVISIONING_TRUSTED_CLIENT_MODE;
}

export const PROVIDER_PROVISIONING_UNTRUSTED_ERROR_MESSAGE =
  "Provider Provisioning 仅支持受信 Desktop Host";

/**
 * 非受信连接用的占位 target：保留频道名不泄漏拓扑，但任何写入都被拒绝。
 * 桌面 MessagePort 面与 Web HTTP 面共用这一份定义，避免两处各写一遍信任判定。
 */
export function createUntrustedProviderProvisioningTarget(): IProviderProvisioningTargetService {
  return {
    async apply(): Promise<ProviderProvisioningResult> {
      throw new Error(PROVIDER_PROVISIONING_UNTRUSTED_ERROR_MESSAGE);
    },
  };
}
