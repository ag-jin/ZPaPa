import { useState } from "react";
import { Switch } from "@/components/ui/switch.js";
import { toast } from "@/components/ui/toast.js";
import { useSettings } from "@/hooks/useSettingService.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { logger } from "@/logger.js";
import { SettingsGroupCard, SettingsRow } from "@/settings/SettingsPageParts.js";
import { SquadMinimalView } from "@/settings/squadEntry/SquadMinimalView.js";
import { squadEntryVisible } from "@/settings/squadEntry/squadEntryVisibility.js";

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
    <>
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
      {/* 关闭实验 ⇒ 整块入口消失（spec §12 / §16 S8），不是置灰、不是报错页。
          判据是纯函数 squadEntryVisible（settings 还在加载时给 null ⇒ 同样不显示，
          避免加载期先闪一下入口再消失）。这只是**呈现**：真正的门禁是服务层单点
          ISquadRuntimeService.assertDispatchEnabled，两者互不依赖。 */}
      {squadEntryVisible(settings) ? <SquadMinimalView /> : null}
    </>
  );
}
