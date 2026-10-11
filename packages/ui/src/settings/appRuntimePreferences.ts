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

/** update 路径的设置取值面：patch 里三个偏好字段 + 上一快照（可为空）。 */
type AppRuntimePreferenceSettings = Pick<
  AppSettings,
  | "askUserQuestionAutoResolutionEnabled"
  | "experimentalAskMattFlowEnabled"
  | "modelIoFullRetentionEnabled"
>;

/**
 * 设置写入路径（`useSettingService.update`）的载荷合成单点：patch 优先、缺省沿用上一快照，
 * 再交给 `buildAppRuntimePreferences` 判据。
 *
 * 为什么必须走这里（F1 整链回炉）：该路径曾就地拼 `{askUserQuestion..., modelIo...}` 两字段，
 * 一次「改别的偏好」就会把未携带的 ask-matt 字段归一化成 false 同步给 Host——UI 开关仍显示开，
 * 面板三命令与技能注册却被误关。广播载荷同源复用该函数，其他窗口不再丢 ask-matt。
 * 快照缺失（设置未加载）时按 fail-closed 落到缺省判据，不放行实验能力。
 */
export function buildAppRuntimePreferencesFromPatch(
  patch: Partial<AppRuntimePreferenceSettings>,
  currentSettings: AppRuntimePreferenceSettings | null | undefined,
): ZCodeAgentAppRuntimePreferences {
  return buildAppRuntimePreferences({
    askUserQuestionAutoResolutionEnabled:
      patch.askUserQuestionAutoResolutionEnabled ??
      currentSettings?.askUserQuestionAutoResolutionEnabled,
    experimentalAskMattFlowEnabled:
      patch.experimentalAskMattFlowEnabled ?? currentSettings?.experimentalAskMattFlowEnabled,
    modelIoFullRetentionEnabled:
      patch.modelIoFullRetentionEnabled ?? currentSettings?.modelIoFullRetentionEnabled,
  });
}
