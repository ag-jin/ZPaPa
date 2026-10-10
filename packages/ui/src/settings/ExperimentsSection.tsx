import { useState } from "react";
import { Switch } from "@/components/ui/switch.js";
import { toast } from "@/components/ui/toast.js";
import { useSettings } from "@/hooks/useSettingService.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { logger } from "@/logger.js";
import { SettingsGroupCard, SettingsRow } from "@/settings/SettingsPageParts.js";

/**
 * 「实验功能」分区：所有实验开关的统一去处（通用容器，将来可挂更多开关）。
 *
 * 开关直接读写运行期 appSettings 字段（默认关闭），不做编译期隐藏 —— 用户必须能在
 * 运行期自行打开，否则实验功能等于没有 UI 通路。
 * 当前只放一行「项目看板」（label-only，用户明确不要副文案）；后续实验开关按同一形态追加。
 */
export function ExperimentsSection() {
  const { intl } = useZCodeIntl();
  const { settings, update } = useSettings();
  const [saving, setSaving] = useState(false);

  const setProjectBoardEnabled = async (enabled: boolean) => {
    setSaving(true);
    try {
      await update({ experimentalProjectBoardEnabled: enabled });
    } catch (error) {
      // 这里没有乐观更新：Switch 的 checked 直接取自共享 settings 快照，而
      // useSettings().update 是先写 settingService、成功后才 refresh —— 写失败时
      // refresh 不执行，快照不变，开关就停在原值。失败因此对用户完全不可见，
      // 必须显式提示，不能只记日志。
      logger.warn("[ExperimentsSection] 更新项目看板实验开关失败", {
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
        label={intl.formatMessage({ id: "settings.experiments.projectBoardToggle.label" })}
        control={
          <Switch
            checked={settings?.experimentalProjectBoardEnabled === true}
            disabled={saving || !settings}
            onCheckedChange={(checked) => {
              void setProjectBoardEnabled(checked);
            }}
            aria-label={intl.formatMessage({ id: "settings.experiments.projectBoardToggle.label" })}
          />
        }
      />
    </SettingsGroupCard>
  );
}
