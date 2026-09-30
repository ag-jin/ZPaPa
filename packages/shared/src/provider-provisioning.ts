import { z } from "zod";
import { modelSelectionSchema } from "./model-selection.js";
import { providerFamilyConnectionSelectionSettingsSchema } from "./provider-family-connection-selection.js";

const nonEmptyString = z.string().trim().min(1);

export const providerProvisioningTriggerSchema = z.enum([
  "environment-online",
  "personal-config",
  "configured-default",
  "account-settings",
  "credential",
]);
export type ProviderProvisioningTrigger = z.infer<typeof providerProvisioningTriggerSchema>;

/** Provisioning 中允许跨 Environment 传输的凭据类别。 */
export const providerProvisioningCredentialScopeSchema = z.enum([
  "oauth-session",
  "account-provider",
]);

export type ProviderProvisioningCredentialScope = z.infer<
  typeof providerProvisioningCredentialScopeSchema
>;

/** 只允许同步 Account Provider 的请求期 API key，不同步账号身份或未来其它扩展字段。 */
export function isProviderProvisioningAccountCredentialKey(key: string): boolean {
  const normalized = key.trim();
  return normalized === key && /^account-provider:.+:api-key$/.test(normalized);
}

/** Personal Config 的 Envelope；具体字段由 @zcode/provider 在目标 Environment 再校验。 */
export const providerProvisioningPersonalConfigSchema = z
  .object({
    providerConfigRules: z.object({ providerRules: z.array(z.unknown()) }).strict(),
    modelConfigRules: z
      .object({
        providerModelRules: z.array(z.unknown()),
        manualProviderModelRules: z.array(z.unknown()),
      })
      .strict(),
    providerOrder: z.array(nonEmptyString).optional(),
    defaultModelSelection: modelSelectionSchema.optional(),
  })
  .strict();

export type ProviderProvisioningPersonalConfig = z.infer<
  typeof providerProvisioningPersonalConfigSchema
>;

export const providerProvisioningAccountSettingsSchema = z
  .object({
    providerFamilyDomain: z.enum(["zai", "bigmodel"]).nullable(),
    providerFamilyConnectionSelections: providerFamilyConnectionSelectionSettingsSchema,
  })
  .strict();

export type ProviderProvisioningAccountSettings = z.infer<
  typeof providerProvisioningAccountSettingsSchema
>;

export const providerProvisioningCredentialEntrySchema = z
  .object({
    scope: providerProvisioningCredentialScopeSchema,
    key: nonEmptyString,
    value: z.string(),
  })
  .strict();

export type ProviderProvisioningCredentialEntry = z.infer<
  typeof providerProvisioningCredentialEntrySchema
>;

export const providerProvisioningEnvelopeSchema = z
  .object({
    schemaVersion: z.literal(1),
    syncId: nonEmptyString,
    personalConfig: providerProvisioningPersonalConfigSchema,
    accountSettings: providerProvisioningAccountSettingsSchema,
    credentials: z.array(providerProvisioningCredentialEntrySchema).max(256),
  })
  .strict();

export type ProviderProvisioningEnvelope = z.infer<typeof providerProvisioningEnvelopeSchema>;

export const providerProvisioningResultSchema = z
  .object({
    syncId: nonEmptyString,
    status: z.enum(["applied", "already-applied", "unsupported", "failed", "rollback_failed"]),
    personalProviderCount: z.number().int().nonnegative(),
    credentialCount: z.number().int().nonnegative(),
    configRevision: nonEmptyString.optional(),
    errorMessage: z.string().optional(),
    rolledBack: z.boolean(),
  })
  .strict();

export type ProviderProvisioningResult = z.infer<typeof providerProvisioningResultSchema>;

export const PROVIDER_PROVISIONING_SYNC_DISABLED_REASON = "模型配置同步已取消";

/**
 * 模型/供应商配置同步总开关 —— **当前关闭**（2026-09-30 由用户决定取消）。
 *
 * 关闭原因：口径是「用户显式选方向（A→B / B→A / 不同步），并且可选合并」，
 * 落地的却是「一连上就自动把本端整份 Personal Provider 配置推给对端并整体替换」——
 * 没有方向选择、没有合并选项、没有写入前预览。结果是投射端在连接瞬间静默抹掉
 * 对端本地新增的 Provider 与模型配置（真实事故：B 端手工添加的模型被整份覆盖丢失，
 * 且因整份替换，对端在本地做的任何增量改动都不可恢复）。
 *
 * 关闭后的行为（两端同源，不会出现一端启用一端禁用）：
 *   - 发起端 `RemoteProviderProvisioningExecutor`：不读本端 Source、不发 RPC；
 *   - 目标端 `ProviderProvisioningTarget.apply`：在解析、加锁、写盘之前返回。
 *
 * 两侧都回 `already-applied` 而不是 `unsupported`/`failed`：旧版本把「首次同步成功」
 * 当作 remote workspace 的**发布屏障**，返回失败会让整个远程连接建不起来
 * （`Provider Provisioning 首次同步失败`）—— 那不是取消，是换一种坏法。
 *
 * 重新启用前必须先做到：方向由用户显式选择 + 合并模式 + 写入前预览差异。
 * 不要只把这个函数改回 true —— 整体替换的语义本身就是事故根因。
 */
export function isProviderProvisioningSyncEnabled(): boolean {
  return false;
}
