import {
  zcodeProtocolMethods,
  zcodeWorkspaceUpdateAskMattFlowPreferencesResultSchema,
  zcodeWorkspaceUpdateInteractionPreferencesResultSchema,
  zcodeWorkspaceUpdateModelIoPreferencesResultSchema,
  type ZCodeWorkspaceRef,
} from "@zcode/shared";
import type { ZCodeAgentAppRuntimePreferences } from "./zcodeAgent.js";
import type { ZCodeProtocolClient } from "./zcodeProtocolClient.js";

/**
 * App 全局运行时偏好 → workspace Host 的同步（卡 #204/A3 在此追加 ask-matt 一项）。
 *
 * 为什么单点：偏好是多字段的 App 级事实，Host 侧是**独立协议方法**（interaction / modelIo /
 * askMattFlow），逐个方法各自处理 method-not-found 兼容。提取成纯函数 + 单次同步调用后，
 * 「哪些字段走哪个方法、旧 CLI 缺方法时是否降级」可以直接在假 client 上断言，
 * 不必构造完整 zcodeAgentService。
 *
 * 兼容策略：interaction 是既有必备方法（失败上抛）；modelIo 与 ask-matt 是后加方法，
 * 旧 CLI 只报 method-not-found（-32601）时降级忽略，其他失败仍上抛。
 */

/** 归一化：可选开关字段只认显式 true（缺省/非布尔 = 关，与 App 侧判据同源）。 */
export function normalizeAppRuntimePreferences(
  preferences: ZCodeAgentAppRuntimePreferences,
): ZCodeAgentAppRuntimePreferences {
  return {
    ...preferences,
    askMattFlowEnabled: preferences.askMattFlowEnabled === true,
    modelIoFullRetentionEnabled: preferences.modelIoFullRetentionEnabled === true,
  };
}

export function isProtocolMethodNotFoundError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === -32601
  );
}

export interface SyncWorkspaceAppRuntimePreferencesParams {
  client: Pick<ZCodeProtocolClient, "request">;
  preferences: ZCodeAgentAppRuntimePreferences;
  workspace: ZCodeWorkspaceRef;
}

export async function syncWorkspaceAppRuntimePreferences(
  params: SyncWorkspaceAppRuntimePreferencesParams,
): Promise<void> {
  const { client, preferences, workspace } = params;
  await client.request(
    zcodeProtocolMethods.workspaceUpdateInteractionPreferences,
    {
      workspace,
      preferences: {
        askUserQuestionAutoResolutionEnabled: preferences.askUserQuestionAutoResolutionEnabled,
      },
    },
    zcodeWorkspaceUpdateInteractionPreferencesResultSchema,
  );
  try {
    await client.request(
      zcodeProtocolMethods.workspaceUpdateModelIoPreferences,
      {
        workspace,
        preferences: {
          fullRetentionEnabled: preferences.modelIoFullRetentionEnabled === true,
        },
      },
      zcodeWorkspaceUpdateModelIoPreferencesResultSchema,
    );
  } catch (error) {
    // 新 Host 兼容尚未升级的 CLI：只有 method-not-found 可降级，其他同步失败仍需上抛。
    if (!isProtocolMethodNotFoundError(error)) throw error;
  }
  try {
    await client.request(
      zcodeProtocolMethods.workspaceUpdateAskMattFlowPreferences,
      // 载荷必须与 shared 的 zcodeWorkspaceUpdateAskMattFlowPreferencesParamsSchema（strict）同形：
      // {workspace, enabled}——服务端 ask-matt-flow-policy.ts 用它 parseParams，形状不符即 -32602。
      // 这正是 F1（卡 #204 二绿）：曾误发 {workspace, preferences:{...}}，开关永不同步；
      // off-peak / dynamic-workflow 先例同为 {workspace, enabled}。回归判据见
      // packages/services/test/appRuntimePreferencesSync.test.ts 的跨包合同用例。
      {
        workspace,
        enabled: preferences.askMattFlowEnabled === true,
      },
      zcodeWorkspaceUpdateAskMattFlowPreferencesResultSchema,
    );
  } catch (error) {
    // 与 modelIo 同判据：旧 CLI 不认识该方法时降级（CLI 维持 fail-closed 零注册）。
    if (!isProtocolMethodNotFoundError(error)) throw error;
  }
}
