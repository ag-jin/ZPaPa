/**
 * 远程设备管理区块（设置页）。
 *
 * 职责：管理"连哪台设备"这一件事 —— 添加/编辑/删除设备、发起连接、显示连接状态。
 * 这是设备投射的**连接入口**，不依赖已连接的 workspace（与 RemoteDeviceSettingsSection
 * 的区别：那个需要在连接建立后才能读写对端设置，本区块在连接之前就要可用）。
 *
 * 数据边界（见 CONTEXT.md「设备边界」）：
 * - 只保存连接入口（主机/认证）与投射端自己的显示偏好。
 * - 不保存项目清单、不保存会话数据；项目清单连接后从设备实时获取。
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { LoaderCircle, MonitorSmartphone, Plus, Trash2 } from "lucide-react";
import type { RemoteDeviceEntry } from "@zcode/shared";
import { Button } from "@/components/ui/button.js";
import { Input } from "@/components/ui/input.js";
import { Switch } from "@/components/ui/switch.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { logger } from "@/logger.js";
import { SettingsGroupCard, SettingsRow } from "@/settings/SettingsPageParts.js";

export interface RemoteDeviceDraft {
  host: string;
  port?: number;
  username: string;
  privateKeyPath?: string;
}

interface RemoteDeviceManagementSectionProps {
  /** 已保存的设备（首版只支持一台，取第一条）。 */
  device?: RemoteDeviceEntry | null;
  /** 连接状态：由上层传入（源自连接流程）。 */
  connectionStatus: "never" | "connecting" | "connected" | "failed";
  connectionError?: string;
  /** 已连接时可读到的项目清单（来自设备访问层）。 */
  connectedProjects?: ReadonlyArray<{ path: string; sessionCount: number }>;
  onSaveDevice: (draft: RemoteDeviceDraft) => Promise<void> | void;
  onRemoveDevice: () => Promise<void> | void;
  onConnect: () => Promise<void> | void;
  onDisconnect: () => Promise<void> | void;
  /** 显示偏好：设备上哪些项目在投射端显示。 */
  visibleProjects?: Readonly<Record<string, boolean>>;
  onVisibleProjectsChange?: (next: Record<string, boolean>) => void;
}

function formatTargetSummary(device: RemoteDeviceEntry): string {
  const target = device.target;
  if (target.kind !== "ssh") return String(target.kind);
  const port = target.port ? `:${target.port}` : "";
  return `${target.username}@${target.host}${port}`;
}

export function RemoteDeviceManagementSection({
  device,
  connectionStatus,
  connectionError,
  connectedProjects,
  onSaveDevice,
  onRemoveDevice,
  onConnect,
  onDisconnect,
  visibleProjects,
  onVisibleProjectsChange,
}: RemoteDeviceManagementSectionProps) {
  const { intl } = useZCodeIntl();
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);

  // 表单初值：编辑时用已存设备的值（不含密钥内容，密钥只引用路径）。
  const initialDraft = useMemo<RemoteDeviceDraft>(() => {
    const target = device?.target;
    if (target && target.kind === "ssh") {
      return {
        host: target.host,
        ...(target.port ? { port: target.port } : {}),
        username: target.username,
        ...(target.privateKeyPath ? { privateKeyPath: target.privateKeyPath } : {}),
      };
    }
    return { host: "", username: "", privateKeyPath: "~/.ssh/id_ed25519" };
  }, [device]);

  const [draft, setDraft] = useState<RemoteDeviceDraft>(initialDraft);
  useEffect(() => {
    setDraft(initialDraft);
  }, [initialDraft]);

  const statusLabel = useMemo(() => {
    switch (connectionStatus) {
      case "connected":
        return intl.formatMessage({ id: "settings.remoteDevice.status.connected" });
      case "connecting":
        return intl.formatMessage({ id: "settings.remoteDevice.status.connecting" });
      case "failed":
        return intl.formatMessage({ id: "settings.remoteDevice.status.failed" });
      default:
        return intl.formatMessage({ id: "settings.remoteDevice.status.never" });
    }
  }, [connectionStatus, intl]);

  const handleSave = useCallback(async () => {
    if (!draft.host.trim() || !draft.username.trim()) {
      return;
    }
    setSaving(true);
    try {
      await onSaveDevice({
        host: draft.host.trim(),
        ...(draft.port ? { port: draft.port } : {}),
        username: draft.username.trim(),
        ...(draft.privateKeyPath?.trim() ? { privateKeyPath: draft.privateKeyPath.trim() } : {}),
      });
      setEditing(false);
    } catch (error) {
      logger.warn("[remoteDevice] 保存设备失败", {
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setSaving(false);
    }
  }, [draft, onSaveDevice]);

  const toggleProject = useCallback(
    (projectPath: string, visible: boolean) => {
      if (!onVisibleProjectsChange) return;
      onVisibleProjectsChange({ ...(visibleProjects ?? {}), [projectPath]: visible });
    },
    [onVisibleProjectsChange, visibleProjects],
  );

  // 未配置设备：显示添加表单。
  if (!device || editing) {
    return (
      <SettingsGroupCard>
        <SettingsRow
          label={
            <span className="flex items-center gap-2">
              <MonitorSmartphone className="size-4 text-foreground-subtle" />
              {intl.formatMessage({ id: "settings.remoteDevice.title" })}
            </span>
          }
          description={intl.formatMessage({ id: "settings.remoteDevice.addHint" })}
          control={null}
        />
        <SettingsRow
          label={intl.formatMessage({ id: "settings.remoteDevice.field.host" })}
          control={
            <Input
              value={draft.host}
              placeholder="100.66.1.2"
              onChange={(event) => setDraft((current) => ({ ...current, host: event.target.value }))}
            />
          }
        />
        <SettingsRow
          label={intl.formatMessage({ id: "settings.remoteDevice.field.username" })}
          control={
            <Input
              value={draft.username}
              placeholder="user"
              onChange={(event) =>
                setDraft((current) => ({ ...current, username: event.target.value }))
              }
            />
          }
        />
        <SettingsRow
          label={intl.formatMessage({ id: "settings.remoteDevice.field.privateKeyPath" })}
          description={intl.formatMessage({
            id: "settings.remoteDevice.field.privateKeyPathHint",
          })}
          control={
            <Input
              value={draft.privateKeyPath ?? ""}
              placeholder="~/.ssh/id_ed25519"
              onChange={(event) =>
                setDraft((current) => ({ ...current, privateKeyPath: event.target.value }))
              }
            />
          }
        />
        <SettingsRow
          label=""
          control={
            <div className="flex items-center gap-2">
              {editing ? (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    setEditing(false);
                    setDraft(initialDraft);
                  }}
                >
                  {intl.formatMessage({ id: "common.cancel" })}
                </Button>
              ) : null}
              <Button
                type="button"
                size="sm"
                disabled={saving || !draft.host.trim() || !draft.username.trim()}
                onClick={() => void handleSave()}
              >
                {saving ? <LoaderCircle className="size-4 animate-spin" /> : null}
                {intl.formatMessage({ id: "settings.remoteDevice.save" })}
              </Button>
            </div>
          }
        />
      </SettingsGroupCard>
    );
  }

  // 已配置设备：显示状态、连接操作、项目清单与显示偏好。
  return (
    <SettingsGroupCard>
      <SettingsRow
        label={
          <span className="flex items-center gap-2">
            <MonitorSmartphone className="size-4 text-foreground-subtle" />
            {formatTargetSummary(device)}
          </span>
        }
        description={
          connectionStatus === "failed" && connectionError
            ? `${statusLabel} · ${connectionError}`
            : statusLabel
        }
        control={
          <div className="flex items-center gap-2">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              aria-label={intl.formatMessage({ id: "settings.remoteDevice.edit" })}
              onClick={() => setEditing(true)}
            >
              {intl.formatMessage({ id: "settings.remoteDevice.edit" })}
            </Button>
            {connectionStatus === "connected" ? (
              <Button type="button" variant="outline" size="sm" onClick={() => void onDisconnect()}>
                {intl.formatMessage({ id: "settings.remoteDevice.disconnect" })}
              </Button>
            ) : (
              <Button
                type="button"
                size="sm"
                disabled={connectionStatus === "connecting"}
                onClick={() => void onConnect()}
              >
                {connectionStatus === "connecting" ? (
                  <LoaderCircle className="size-4 animate-spin" />
                ) : (
                  <Plus className="size-4" />
                )}
                {intl.formatMessage({ id: "settings.remoteDevice.connect" })}
              </Button>
            )}
          </div>
        }
      />

      {/* 项目清单（仅连接后可得）：勾选决定投射端显示哪些项目 */}
      {connectionStatus === "connected" && connectedProjects && connectedProjects.length > 0 ? (
        <>
          <SettingsRow
            label={intl.formatMessage({ id: "settings.remoteDevice.projects" })}
            description={intl.formatMessage(
              { id: "settings.remoteDevice.projectsHint" },
              { count: connectedProjects.length },
            )}
            control={null}
          />
          {connectedProjects.map((project) => (
            <SettingsRow
              key={project.path}
              label={project.path}
              description={intl.formatMessage(
                { id: "settings.remoteDevice.projectSessionCount" },
                { count: project.sessionCount },
              )}
              control={
                <Switch
                  // 缺省显示：用户没显式关掉的项目默认投射，避免"连上了却什么都看不到"。
                  checked={visibleProjects?.[project.path] !== false}
                  onCheckedChange={(checked) => toggleProject(project.path, checked === true)}
                  aria-label={project.path}
                />
              }
            />
          ))}
        </>
      ) : null}

      <SettingsRow
        label={intl.formatMessage({ id: "settings.remoteDevice.remove" })}
        control={
          <Button
            type="button"
            variant="ghost"
            size="sm"
            aria-label={intl.formatMessage({ id: "settings.remoteDevice.remove" })}
            onClick={() => void onRemoveDevice()}
          >
            <Trash2 className="size-4" />
          </Button>
        }
      />
    </SettingsGroupCard>
  );
}
