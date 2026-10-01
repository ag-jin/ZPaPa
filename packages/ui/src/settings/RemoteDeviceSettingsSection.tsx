/**
 * 远程设备设置投射区块。
 *
 * 用途：在设置页展示「已连接的远程设备」的**可投射设置**，并支持远程读写。
 *
 * 数据来源：当前 workspace 若是远程工作区（`workspaceIdentity` 以 remote: 开头），
 * 其 services 已由 host 路由到对端；因此这里用 `useWorkspaceServices(workspacePath,
 * remoteSessionId, workspaceIdentity)` 拿到对端的 settingService，无需新协议。
 *
 * 安全约定（见 lib/remoteDeviceSettings.ts）：
 * - 只展示经排除法（黑名单）筛选后仍可投射的字段：布尔、非敏感、非设备本地属性、
 *   非实验开关。投射是「默认投射、命中黑名单才排除」，不是白名单。
 * - 写操作遵循「记录原值 → 写入 → 读回确认」，失败或值不符时提示用户。
 * - 不缓存、不持久化远端设置值：每次挂载重新读取，符合"投射"语义。
 */
import { useCallback, useEffect, useState } from "react";
import type { IServiceAccessor } from "@zcode/services";
import { LoaderCircle, MonitorSmartphone } from "lucide-react";
import { Switch } from "@/components/ui/switch.js";
import { useWorkspaceServices } from "@/hooks/useWorkspaceServices.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import {
  formatProjectableSettingLabel,
  pickProjectableSettings,
  type ProjectableSettingEntry,
} from "@/lib/remoteDeviceSettings.js";
import { logger } from "@/logger.js";
import { SettingsGroupCard, SettingsRow } from "@/settings/SettingsPageParts.js";

interface RemoteDeviceSettingsSectionProps {
  /** 远程工作区路径（对端机器上的真实路径）。 */
  workspacePath: string;
  remoteSessionId: string;
  workspaceIdentity: string;
  /**
   * 已知的对端服务访问面。设备级投射传它 —— 投射条目按 ADR 0001 不带远端
   * identity，靠 workspace 三元组解析不出 session；这里直接给定 session 的服务面。
   * 未提供时按 workspace 三元组解析（远程 workspace 的既有用法）。
   */
  services?: IServiceAccessor;
}

type SectionState =
  | { status: "loading" }
  | { status: "ready"; entries: ProjectableSettingEntry[] }
  | { status: "unavailable"; message: string };

export function RemoteDeviceSettingsSection({
  workspacePath,
  remoteSessionId,
  workspaceIdentity,
  services: providedServices,
}: RemoteDeviceSettingsSectionProps) {
  const { intl } = useZCodeIntl();
  const resolvedServices = useWorkspaceServices(workspacePath, remoteSessionId, workspaceIdentity);
  // 设备级投射直接给服务面（投射条目没有远端 identity，解析不出来）；
  // 远程 workspace 场景仍走解析。
  const services = providedServices ?? resolvedServices;
  // 设置读写必须走设备通道：services.settingService 在远端 workspace 语义下
  // 刻意是本机实现，用它读会显示 A 的设置、写会改到 A（已实测）。
  const deviceSettings = services.remoteDeviceProjectsService;
  const [state, setState] = useState<SectionState>({ status: "loading" });
  // 每个字段的写入中状态，避免同一字段重复提交。
  const [pendingKeys, setPendingKeys] = useState<ReadonlySet<string>>(() => new Set());

  const load = useCallback(async () => {
    try {
      const settings = deviceSettings
        ? await deviceSettings.getSettings()
        : await services.settingService.get();
      setState({ status: "ready", entries: pickProjectableSettings(settings) });
    } catch (error) {
      // 读不到通常是连接已断开：明确告知，不留空列表让用户误以为没有可改项。
      const message = error instanceof Error ? error.message : String(error);
      logger.warn("[remoteDeviceSettings] 读取远端设置失败", { error: message });
      setState({ status: "unavailable", message });
    }
  }, [deviceSettings, services.settingService]);

  useEffect(() => {
    void load();
  }, [load]);

  const updateSetting = useCallback(
    async (key: string, nextValue: boolean) => {
      setPendingKeys((current) => new Set(current).add(key));
      try {
        // 读改写都走设备通道（若可用）：services.settingService 是本机实现，
        // 用它会把设备设置写到 A 本机（已实测：A 被改、B 未变）。
        const readAll = async (): Promise<Record<string, unknown>> =>
          deviceSettings
            ? await deviceSettings.getSettings()
            : ((await services.settingService.get()) as unknown as Record<string, unknown>);
        const before = await readAll();
        const originalValue = before[key];
        if (deviceSettings) {
          await deviceSettings.updateSetting(key, nextValue);
        } else {
          await services.settingService.update({ [key]: nextValue });
        }
        const after = await readAll();
        const actualValue = after[key];
        if (actualValue !== nextValue) {
          // 读回不符：不能把 UI 更新成"已生效"，否则用户在两端看到的值不一致。
          logger.warn("[remoteDeviceSettings] 远端写入未生效", {
            key,
            expected: nextValue,
            actual: actualValue,
            originalValue,
          });
          await load();
          return;
        }
        setState((current) =>
          current.status === "ready"
            ? {
                status: "ready",
                entries: current.entries.map((entry) =>
                  entry.key === key ? { ...entry, value: nextValue } : entry,
                ),
              }
            : current,
        );
        logger.info("[remoteDeviceSettings] 远端设置已更新", {
          key,
          from: originalValue,
          to: nextValue,
        });
      } catch (error) {
        logger.warn("[remoteDeviceSettings] 写入远端设置失败", {
          key,
          error: error instanceof Error ? error.message : String(error),
        });
        await load();
      } finally {
        setPendingKeys((current) => {
          const next = new Set(current);
          next.delete(key);
          return next;
        });
      }
    },
    [deviceSettings, load, services.settingService],
  );

  if (state.status === "loading") {
    return (
      <SettingsGroupCard>
        <SettingsRow
          label={intl.formatMessage({ id: "settings.remoteDevice.loading" })}
          control={<LoaderCircle className="size-4 animate-spin text-foreground-subtle" />}
        />
      </SettingsGroupCard>
    );
  }

  if (state.status === "unavailable") {
    return (
      <SettingsGroupCard>
        <SettingsRow
          label={intl.formatMessage({ id: "settings.remoteDevice.unavailable" })}
          description={state.message}
          control={null}
        />
      </SettingsGroupCard>
    );
  }

  return (
    <SettingsGroupCard>
      <SettingsRow
        label={
          <span className="flex items-center gap-2">
            <MonitorSmartphone className="size-4 text-foreground-subtle" />
            {intl.formatMessage({ id: "settings.remoteDevice.title" })}
          </span>
        }
        description={intl.formatMessage(
          { id: "settings.remoteDevice.description" },
          { path: workspacePath },
        )}
        control={null}
      />
      {/* 项目投射范围已上移到「远程设备」区块（那里能拿到设备通道的项目清单）；
          这里不再重复一份 —— 原先走 zcodeTaskService.listTasks() 无参枚举，
          而设备侧不支持该枚举，会恒显示「0 个项目」误导用户。 */}
      {state.entries.map((entry) => (
        <SettingsRow
          key={entry.key}
          // 优先用产品设置页现有的文案：同一个开关在两处叫法必须一致，
          // 否则用户会以为它们是不同东西。仅有内部开关才回退到键名。
          label={
            entry.labelId
              ? intl.formatMessage({ id: entry.labelId })
              : formatProjectableSettingLabel(entry.key)
          }
          description={
            entry.descriptionId
              ? intl.formatMessage({ id: entry.descriptionId })
              : entry.labelId
                ? undefined
                : entry.key
          }
          control={
            pendingKeys.has(entry.key) ? (
              <LoaderCircle className="size-4 animate-spin text-foreground-subtle" />
            ) : (
              <Switch
                checked={entry.value}
                onCheckedChange={(checked) => void updateSetting(entry.key, checked === true)}
                aria-label={formatProjectableSettingLabel(entry.key)}
              />
            )
          }
        />
      ))}
    </SettingsGroupCard>
  );
}
