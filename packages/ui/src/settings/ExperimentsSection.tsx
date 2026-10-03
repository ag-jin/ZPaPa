import { useState } from "react";
import { Switch } from "@/components/ui/switch.js";
import { toast } from "@/components/ui/toast.js";
import { useSettings } from "@/hooks/useSettingService.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { logger } from "@/logger.js";
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
    </SettingsGroupCard>
  );
}
