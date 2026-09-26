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
 * - 只展示白名单字段（布尔、非敏感、非设备本地属性）。
 * - 写操作遵循「记录原值 → 写入 → 读回确认」，失败或值不符时提示用户。
 * - 不缓存、不持久化远端设置值：每次挂载重新读取，符合"投射"语义。
 */
import { useCallback, useEffect, useState } from "react";
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
import { Button } from "@/components/ui/button.js";
import { FolderIcon } from "lucide-react";

interface RemoteDeviceSettingsSectionProps {
  /** 远程工作区路径（对端机器上的真实路径）。 */
  workspacePath: string;
  remoteSessionId: string;
  workspaceIdentity: string;
  /**
   * 项目显示选择（键为远端 identity，值为是否显示）。
   * 只保存"选择"，不保存会话数据；由父级写入本地设置实现跨重启保留。
   */
  projectVisibility?: Readonly<Record<string, boolean>>;
  onProjectVisibilityChange?: (next: Record<string, boolean>) => void;
}

type SectionState =
  | { status: "loading" }
  | { status: "ready"; entries: ProjectableSettingEntry[] }
  | { status: "unavailable"; message: string };

export function RemoteDeviceSettingsSection({
  workspacePath,
  remoteSessionId,
  workspaceIdentity,
  projectVisibility,
  onProjectVisibilityChange,
}: RemoteDeviceSettingsSectionProps) {
  const { intl } = useZCodeIntl();
  const services = useWorkspaceServices(workspacePath, remoteSessionId, workspaceIdentity);
  const [state, setState] = useState<SectionState>({ status: "loading" });
  // 每个字段的写入中状态，避免同一字段重复提交。
  const [pendingKeys, setPendingKeys] = useState<ReadonlySet<string>>(() => new Set());
  // 对端的项目清单（按会话数排序）—— 供用户勾选要投射哪些项目。
  const [projects, setProjects] = useState<{ path: string; count: number }[]>([]);
  const [showProjects, setShowProjects] = useState(false);

  const load = useCallback(async () => {
    try {
      const settings = await services.settingService.get();
      setState({ status: "ready", entries: pickProjectableSettings(settings) });
    } catch (error) {
      // 读不到通常是连接已断开：明确告知，不留空列表让用户误以为没有可改项。
      const message = error instanceof Error ? error.message : String(error);
      logger.warn("[remoteDeviceSettings] 读取远端设置失败", { error: message });
      setState({ status: "unavailable", message });
    }
  }, [services.settingService]);

  useEffect(() => {
    void load();
  }, [load]);

  // 项目清单从对端 taskIndex 实时枚举（不传 workspacePath = 全量），
  // 不落库、不缓存：符合"投射"语义，断开后自然消失。
  const loadProjects = useCallback(async () => {
    try {
      const tasks = await services.zcodeTaskService.listTasks();
      const counts = new Map<string, number>();
      for (const task of tasks) {
        const path = task.workspacePath;
        if (!path) continue;
        counts.set(path, (counts.get(path) ?? 0) + 1);
      }
      const list = [...counts.entries()]
        .map(([path, count]) => ({ path, count }))
        .sort((left, right) => right.count - left.count || left.path.localeCompare(right.path));
      setProjects(list);
    } catch (error) {
      logger.warn("[remoteDeviceSettings] 枚举远端项目失败", {
        error: error instanceof Error ? error.message : String(error),
      });
      setProjects([]);
    }
  }, [services.zcodeTaskService]);

  const updateSetting = useCallback(
    async (key: string, nextValue: boolean) => {
      setPendingKeys((current) => new Set(current).add(key));
      try {
        const before = await services.settingService.get();
        const originalValue = Object.entries(before).find(([k]) => k === key)?.[1];
        await services.settingService.update({ [key]: nextValue });
        const after = await services.settingService.get();
        const actualValue = Object.entries(after).find(([k]) => k === key)?.[1];
        if (actualValue !== nextValue) {
          // 读回不符：不能把 UI 更新成"已生效"，否则用户在两端看到的值不一致。
          logger.warn("[remoteDeviceSettings] 远端写入未生效", {
            key,
            expected: nextValue,
            actual: actualValue,
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
    [load, services.settingService],
  );

  const toggleProject = useCallback(
    (projectPath: string, visible: boolean) => {
      if (!onProjectVisibilityChange) return;
      const key = `${workspaceIdentity.split(":").slice(0, -1).join(":")}:${projectPath}`;
      onProjectVisibilityChange({ ...(projectVisibility ?? {}), [key]: visible });
    },
    [onProjectVisibilityChange, projectVisibility, workspaceIdentity],
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
      {/* 项目投射范围：由用户勾选显示哪些远端项目；清单实时从对端枚举 */}
      <SettingsRow
        label={
          <span className="flex items-center gap-2">
            <FolderIcon className="size-4 text-foreground-subtle" />
            {intl.formatMessage({ id: "settings.remoteDevice.projects" })}
          </span>
        }
        description={intl.formatMessage(
          { id: "settings.remoteDevice.projectsHint" },
          { count: projects.length },
        )}
        control={
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => {
              if (!showProjects && projects.length === 0) void loadProjects();
              setShowProjects((current) => !current);
            }}
          >
            {showProjects
              ? intl.formatMessage({ id: "common.collapse" })
              : intl.formatMessage({ id: "common.expand" })}
          </Button>
        }
      />
      {showProjects
        ? projects.map((project) => {
            const key = `${workspaceIdentity.split(":").slice(0, -1).join(":")}:${project.path}`;
            // 缺省视为显示：用户没显式关掉的项目默认投射，避免"连上了却什么都看不到"。
            const visible = projectVisibility?.[key] !== false;
            return (
              <SettingsRow
                key={project.path}
                label={project.path}
                description={intl.formatMessage(
                  { id: "settings.remoteDevice.projectSessionCount" },
                  { count: project.count },
                )}
                control={
                  <Switch
                    checked={visible}
                    onCheckedChange={(checked) => toggleProject(project.path, checked === true)}
                    aria-label={project.path}
                  />
                }
              />
            );
          })
        : null}
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
