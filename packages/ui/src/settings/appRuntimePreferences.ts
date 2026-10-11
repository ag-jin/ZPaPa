import type { ZCodeAgentAppRuntimePreferences } from "@zcode/services";
import type { AppSettings } from "@zcode/shared";
import { askMattFlowEntryVisible } from "@/settings/askMattFlowEntryVisibility.js";

/**
 * App 设置 → Agent/Bot 运行时偏好的**同步载荷单点**（卡 #204/A3）。
 *
 * Root 往 zcodeAgentService 与 botsService 同步的是同一份偏好；字段判据在这里收口一处，
 * 避免两个调用点各写一遍比较（尤其 ask-matt 这类实验开关：判据必须与呈现面
 * `askMattFlowEntryVisible` 同源，只有显式 true 才算开）。
 *
 * 载荷字段语义：
 * - askUserQuestionAutoResolutionEnabled：缺省开启（只有显式 false 才关，存量兼容）；
 * - modelIoFullRetentionEnabled / askMattFlowEnabled：实验/新能力一律 fail-closed，
 *   缺省关闭（未设置、未加载都不放行）。
 */
export function buildAppRuntimePreferences(
  settings: Pick<
    AppSettings,
    | "askUserQuestionAutoResolutionEnabled"
    | "experimentalAskMattFlowEnabled"
    | "modelIoFullRetentionEnabled"
  >,
): ZCodeAgentAppRuntimePreferences {
  return {
    askUserQuestionAutoResolutionEnabled: settings.askUserQuestionAutoResolutionEnabled !== false,
    askMattFlowEnabled: askMattFlowEntryVisible(settings),
    modelIoFullRetentionEnabled: settings.modelIoFullRetentionEnabled === true,
  };
}
