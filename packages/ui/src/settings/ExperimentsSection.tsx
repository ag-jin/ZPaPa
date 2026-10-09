import { useState } from "react";
import {
  isGithubPullRequestTokenConfigured,
  resolveSquadMergeMode,
  type SquadMergeMode,
} from "@zcode/shared";
import { Switch } from "@/components/ui/switch.js";
import { toast } from "@/components/ui/toast.js";
import { useSettings } from "@/hooks/useSettingService.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { logger } from "@/logger.js";
import { GitHubIntegrationSettingsRow } from "@/settings/GitHubIntegrationSettingsRow.js";
import { SettingsGroupCard, SettingsRow } from "@/settings/SettingsPageParts.js";
import { squadEntryVisible } from "@/squad/squadEntryVisibility.js";

/**
 * 「实验功能」分区：所有实验开关的统一去处。
 *
 * 开关直接读写运行期 appSettings.experimentalAgentSquadsEnabled（默认关闭），
 * 不做编译期隐藏 —— 用户必须能在运行期自行开启，否则实验功能等于无法开启。
 *
 * **本区的终态**（用户 2026-10-03 裁定后的既定计划）：只留**总开关 + 一行指引**。
 * 多智能体小队的三个功能面（智能体 / 小队 / 工作项）都已搬到**侧栏一级入口**
 * （「入口不藏设置」，与 multica 的左侧栏同构）；设置区不再渲染任何小队视图
 * （旧设置卡的最小视图已随本轮退役、不留拷贝），只留这一行指引防止用过旧界面的用户
 * 在原处找不到 —— 找不到会看起来像「功能没了」。
 */
export function ExperimentsSection() {
  const { intl } = useZCodeIntl();
  const { settings, update } = useSettings();
  const [saving, setSaving] = useState(false);

  const setAgentSquadsEnabled = async (enabled: boolean) => {
    setSaving(true);
    try {
      await update({ experimentalAgentSquadsEnabled: enabled });
    } catch (error) {
      // 这里没有乐观更新：Switch 的 checked 直接取自共享 settings 快照，而
      // useSettings().update 是先写 settingService、成功后才 refresh —— 写失败时
      // refresh 不执行，快照不变，开关就停在原值。失败因此对用户完全不可见，
      // 必须显式提示，不能只记日志。
      logger.warn("[ExperimentsSection] 更新多智能体小队实验开关失败", {
        error: error instanceof Error ? error.message : String(error),
      });
      toast(intl.formatMessage({ id: "settings.experiments.saveFailed" }));
    } finally {
      setSaving(false);
    }
  };

  /* #8 D2：GitHub PAT 的读写（本仓第一个 secret 字段）。
     · token 值**只**从这里流向 settings 与「是否已配置」这个布尔事实 —— 渲染层拿不到 token 本身
       （`GitHubIntegrationSettingsRow` 的 props 里没有那个字段，回显在结构上不可能）；
     · 清除 = 写空串（schema 允许；与 httpProxy 的「空串 = 显式清空」同款语义）；
     · 失败：留痕 + toast + **抛回行内**（草稿保留，用户能直接重试）。 */
  const saveGithubToken = async (token: string) => {
    setSaving(true);
    try {
      await update({ githubPullRequestToken: token });
    } catch (error) {
      logger.warn("[ExperimentsSection] 保存 GitHub 访问令牌失败", {
        error: error instanceof Error ? error.message : String(error),
      });
      toast(intl.formatMessage({ id: "settings.experiments.githubIntegration.saveFailed" }));
      throw error;
    } finally {
      setSaving(false);
    }
  };
  const clearGithubToken = async () => {
    setSaving(true);
    try {
      await update({ githubPullRequestToken: "" });
    } catch (error) {
      logger.warn("[ExperimentsSection] 清除 GitHub 访问令牌失败", {
        error: error instanceof Error ? error.message : String(error),
      });
      toast(intl.formatMessage({ id: "settings.experiments.githubIntegration.saveFailed" }));
      throw error;
    } finally {
      setSaving(false);
    }
  };

  /* #8 D3：整批收尾模式的读写（同一行区）。失败与 token 同款：留痕 + toast + 抛回行内。
     切到 pr-gate 不校验 token —— 前置不满足时**收尾那一刻降级**（收件箱留痕），
     而不是在设置里拦住（用户可以先选模式、再配 token）。 */
  const saveSquadMergeMode = async (mode: SquadMergeMode) => {
    setSaving(true);
    try {
      await update({ squadMergeMode: mode });
    } catch (error) {
      logger.warn("[ExperimentsSection] 保存整批收尾模式失败", {
        error: error instanceof Error ? error.message : String(error),
      });
      toast(intl.formatMessage({ id: "settings.experiments.githubIntegration.saveFailed" }));
      throw error;
    } finally {
      setSaving(false);
    }
  };

  return (
    <SettingsGroupCard>
      <SettingsRow
        label={intl.formatMessage({ id: "settings.experiments.squadToggle.label" })}
        description={intl.formatMessage({ id: "settings.experiments.squadToggle.description" })}
        control={
          <Switch
            checked={settings?.experimentalAgentSquadsEnabled === true}
            disabled={saving || !settings}
            onCheckedChange={(checked) => {
              void setAgentSquadsEnabled(checked);
            }}
            aria-label={intl.formatMessage({ id: "settings.experiments.squadToggle.label" })}
          />
        }
      />
      {/* 指引行：只说「入口在哪」。显隐沿用同一份纯函数 squadEntryVisible（开关关闭 /
          settings 未加载 ⇒ 不显示）—— 入口都隐藏时说「入口在侧栏」是句假话。
          这只是**呈现**：真正的门禁是服务层单点 ISquadRuntimeService.assertDispatchEnabled。 */}
      {squadEntryVisible(settings) ? (
        <SettingsRow
          label={intl.formatMessage({ id: "squad.common.settingsMovedHint" })}
          control={null}
        />
      ) : null}
      {/* #8 D2：GitHub 集成（PAT）——传下去的**只有布尔事实**（token 值不进渲染层）。
          #8 D3：同一行区内含整批收尾模式（local / pr-gate）。模式是**闭集值**（不是凭据），
          可以直接进渲染层；判据的归一只有一处（shared 的 `resolveSquadMergeMode`）。 */}
      <GitHubIntegrationSettingsRow
        tokenConfigured={isGithubPullRequestTokenConfigured(settings?.githubPullRequestToken)}
        saving={saving}
        mergeMode={resolveSquadMergeMode(settings?.squadMergeMode)}
        onSave={saveGithubToken}
        onClear={clearGithubToken}
        onSelectMergeMode={saveSquadMergeMode}
      />
    </SettingsGroupCard>
  );
}
