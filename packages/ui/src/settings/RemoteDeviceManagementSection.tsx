/**
 * 远程设备区块（设置页）。
 *
 * 职责：显示已连接的设备、其项目清单与显示偏好，并提供断开/移除。
 *
 * **不在这里填连接表单**：主机/用户名/密钥路径等输入由「远程连接」弹窗
 * （SSHDialog）负责 —— 那里已经支持 SSH 全套字段（含口令与端口、WSL/Docker），
 * 且目录步提供「作为设备连接」入口（不选目录，整机接入）。本区块只呈现结果，
 * 避免两套表单并存（字段、校验、认证方式都会各自漂移）。
 *
 * 数据边界（见 CONTEXT.md「设备边界」）：
 * - 只保存连接入口（主机/认证）与投射端自己的显示偏好。
 * - 不保存项目清单、不保存会话数据；项目清单连接后从设备实时获取。
 */
import { useCallback, useMemo } from "react";
import { LoaderCircle, MonitorSmartphone, Trash2 } from "lucide-react";
import type { RemoteDeviceConfig } from "@zcode/shared";
import { Button } from "@/components/ui/button.js";
import { Switch } from "@/components/ui/switch.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { SettingsGroupCard, SettingsRow } from "@/settings/SettingsPageParts.js";

interface RemoteDeviceManagementSectionProps {
  /** 已保存的设备（首版只支持一台，取第一条）。 */
  device?: RemoteDeviceConfig | null;
  /** 连接状态：由上层传入（源自连接流程）。 */
  connectionStatus: "never" | "connecting" | "connected" | "failed";
  connectionError?: string;
  /** 已连接时可读到的项目清单（来自设备访问层）。 */
  connectedProjects?: ReadonlyArray<{ path: string; sessionCount: number }>;
  onRemoveDevice: () => Promise<void> | void;
  onConnect: () => Promise<void> | void;
  onDisconnect: () => Promise<void> | void;
  /** 显示偏好：设备上哪些项目在投射端显示。 */
  visibleProjects?: Readonly<Record<string, boolean>>;
  /**
   * 拨动某个项目的显示开关。
   *
   * 交回的是**意图**（哪个项目、什么值），不是整份 map：整份 map 只能由渲染期快照
   * 拼出，连拨两个开关时前一次会被后一次的快照覆盖丢掉。写入方以仓里最新的一份为底
   * 合并，才能保证每次拨动都留存。
   */
  onToggleProjectVisibility?: (projectPath: string, visible: boolean) => void;
  /** 打开「远程连接」弹窗（新增设备时用；表单由该弹窗负责）。 */
  onOpenRemoteConnection?: () => void;
}

function formatTargetSummary(device: RemoteDeviceConfig): string {
  const target = device.target;
  if (target.kind !== "ssh") return String(target.kind);
  const port = target.port ? `:${target.port}` : "";
  return `${target.username}@${target.host}${port}`;
}

/**
 * 设备条目的主标题。
 *
 * 为什么要与 `formatTargetSummary` 分开：只显示 `user@host:port` 时，用户看到的
 * 就是「一串 SSH 地址」，认不出这是哪台设备、上面有什么 —— 用户实测反馈
 * 「项目全关后设备条目变成一个 ssh 端口」。这里优先用可读身份（SSH 配置别名，
 * 否则主机名），把裸地址降为副标题。
 */
function formatDeviceTitle(device: RemoteDeviceConfig): string {
  const target = device.target;
  if (target.kind !== "ssh") return String(target.kind);
  const alias = target.sshConfigAlias?.trim();
  return alias || target.host;
}

export function RemoteDeviceManagementSection({
  device,
  connectionStatus,
  connectionError,
  connectedProjects,
  onRemoveDevice,
  onConnect,
  onDisconnect,
  visibleProjects,
  onToggleProjectVisibility,
  onOpenRemoteConnection,
}: RemoteDeviceManagementSectionProps) {
  const { intl } = useZCodeIntl();

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

  const toggleProject = useCallback(
    (projectPath: string, visible: boolean) => {
      // 只转达意图：不在这里拼整份 map —— 这份组件持有的 visibleProjects 是渲染期
      // 快照，连拨两个开关时用它作底会把前一次覆盖丢掉（实测缺陷）。
      onToggleProjectVisibility?.(projectPath, visible);
    },
    [onToggleProjectVisibility],
  );

  // 未配置设备：不在这里填表单（连接字段由「远程连接」弹窗负责），只给入口。
  if (!device) {
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
          control={
            onOpenRemoteConnection ? (
              <Button type="button" size="sm" onClick={onOpenRemoteConnection}>
                {intl.formatMessage({ id: "settings.remoteDevice.openConnectionDialog" })}
              </Button>
            ) : null
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
            {formatDeviceTitle(device)}
          </span>
        }
        description={
          connectionStatus === "failed" && connectionError
            ? `${statusLabel} · ${connectionError}`
            : `${statusLabel} · ${formatTargetSummary(device)}`
        }
        control={
          <div className="flex items-center gap-2">
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
                ) : null}
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

      {/* 项目全部关闭时的提示。
          原先此处什么都不渲染：用户把项目逐个关掉后，卡片上只剩设备名与状态，
          看起来像"设备没东西了"，也找不到怎么恢复（实测反馈"变成一个 ssh 端口"）。
          设备连接仍在（连接归设备所有），这里明确说明并指向开关。 */}
      {connectionStatus === "connected" &&
      connectedProjects &&
      connectedProjects.length > 0 &&
      connectedProjects.every((project) => visibleProjects?.[project.path] === false) ? (
        <SettingsRow
          label={intl.formatMessage({ id: "settings.remoteDevice.allProjectsHidden" })}
          description={intl.formatMessage({ id: "settings.remoteDevice.allProjectsHiddenHint" })}
          control={null}
        />
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
