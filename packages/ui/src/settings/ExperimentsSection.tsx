import { useState } from "react";
import { Switch } from "@/components/ui/switch.js";
import { useSettings } from "@/hooks/useSettingService.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { logger } from "@/logger.js";
import { SettingsGroupCard, SettingsRow } from "@/settings/SettingsPageParts.js";

/**
 * 「实验功能」分区：所有实验开关的统一去处。
 *
 * 开关直接读写运行期 appSettings.experimentalAgentSquadsEnabled（默认关闭），
 * 不做编译期隐藏 —— 用户必须能在运行期自行开启，否则实验功能等于无法开启。
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
      // 不额外弹 toast：开关的 checked 取自共享 settings 快照，写入失败后 update() 内部的
      // refresh 会把开关回落到服务端真实值，用户能直接看到这次修改没有生效。
      logger.warn("[ExperimentsSection] 更新多智能体小队实验开关失败", {
        error: error instanceof Error ? error.message : String(error),
      });
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
    </SettingsGroupCard>
  );
}
