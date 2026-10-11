import { zcodeWorkspaceUpdateAskMattFlowPreferencesParamsSchema } from "@zcode/shared";
import { parseParams, type ZCodeProtocolAgentServerContext } from "./server-types.js";

/**
 * 「ask-matt 开发流程」实验开关的 workspace 级同步（卡 #204/A3）。
 *
 * 判定权在 App（设置·实验功能里的开关，判据 = askMattFlowEntryVisible，默认关）；
 * CLI 只缓存结论，供三条消费路径读取，从不自己读设置文件：
 *   - 内置包技能注册面（createRecord → create-app 的 skillPort disabledPaths）；
 *   - `/` 目录装配（listProtocolSlashCommands 的 askMattFlowEnabled）；
 *   - 内置命令展开（resolveZCodeBuiltinPromptCommand 的 askMattFlowEnabled）。
 *
 * 与 dynamic-workflow-policy.ts / model-io-preferences.ts 同构：只影响之后创建/恢复的
 * record（技能注册在 runtime 构造期固定，已活跃会话不回收注册面），目录与展开读进程缓存，
 * 下一次 snapshot/workspace 发布即生效。旧 CLI 不认识该方法 → method-not-found，Host 降级忽略。
 */
export async function updateAskMattFlowPreferences(
  context: ZCodeProtocolAgentServerContext,
  rawParams: unknown,
) {
  const params = parseParams(zcodeWorkspaceUpdateAskMattFlowPreferencesParamsSchema, rawParams);
  context.appRuntimePreferences.askMattFlowEnabled = params.enabled === true;
  return { workspace: params.workspace, enabled: context.appRuntimePreferences.askMattFlowEnabled };
}
