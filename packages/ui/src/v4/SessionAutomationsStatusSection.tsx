import { useEffect, useMemo } from "react";
import type { ZCodeAutomation } from "@zcode/shared";
import { cn } from "@/components/lib/utils.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { useZCodeAgentService } from "@/hooks/useZCodeAgentService.js";
import { AutomationSwitchToggle } from "@/settings/AutomationSwitchToggle.js";
import { describeCronBuilder, parseCronToBuilder } from "@/settings/automationFormat.js";
import { useAutomationManagementStore } from "@/store/automationManagementStore.js";
import { logger } from "@/logger.js";

/**
 * 会话右侧面板的「定时任务」区块：展示绑定到当前会话的 automation，并支持快捷暂停/继续。
 *
 * 数据来自 automationManagementStore（automation 的唯一所有者），这里只按 targetTaskId
 * 过滤本会话绑定的条目——不新建第二份列表副本，否则暂停/继续后的状态会与设置页分叉。
 *
 * 面板与设置页是两个入口，命中同一份 store：先到者初始化，后到者读缓存。
 */
export function SessionAutomationsStatusSection({
  sessionId,
  workspacePath,
  workspaceIdentity,
  separated,
}: {
  sessionId: string | undefined;
  workspacePath: string;
  workspaceIdentity?: string;
  separated: boolean;
}) {
  const { intl } = useZCodeIntl();
  const agentService = useZCodeAgentService(workspacePath, null, workspaceIdentity ?? null);
  const automations = useAutomationManagementStore((state) => state.automations);
  const loading = useAutomationManagementStore((state) => state.loading);
  const operationId = useAutomationManagementStore((state) => state.operationId);
  const initialize = useAutomationManagementStore((state) => state.initialize);
  const refresh = useAutomationManagementStore((state) => state.refresh);
  const setEnabled = useAutomationManagementStore((state) => state.setEnabled);

  // 会话内创建的定时任务带 targetTaskId；面板只展示绑定到本会话的那些。
  // 未初始化时补一次初始化，否则从会话直接进入（没开过设置页）会看到空区块。
  const bound = useMemo(
    () => (sessionId ? automations.filter((item) => item.targetTaskId === sessionId) : []),
    [automations, sessionId],
  );

  const storeWorkspacePath = useAutomationManagementStore((state) => state.workspacePath);
  useEffect(() => {
    if (!sessionId) return;
    // 已有同一 workspace 的缓存时 store 内部会走后台刷新，不会闪烁。
    if (storeWorkspacePath === workspacePath) return;
    void initialize({
      workspacePath,
      ...(workspaceIdentity ? { workspaceIdentity } : {}),
      agentService,
    }).catch((error) => {
      logger.warn("[session-automations] initialize failed", { error: String(error) });
    });
  }, [agentService, initialize, sessionId, storeWorkspacePath, workspaceIdentity, workspacePath]);

  if (bound.length === 0) return null;

  return (
    <SessionAutomationsSectionShell
      separated={separated}
      title={intl.formatMessage({ id: "chat.statusPanel.automations" })}
      count={bound.length}
      loading={loading}
      onRefresh={() => {
        void refresh(agentService).catch((error) => {
          logger.warn("[session-automations] refresh failed", { error: String(error) });
        });
      }}
    >
      <div className="flex min-w-0 flex-col gap-1">
        {bound.map((automation) => (
          <SessionAutomationRow
            key={automation.automationId}
            automation={automation}
            busy={operationId === `automation:setEnabled:${automation.automationId}`}
            onToggle={(nextEnabled) => {
              void setEnabled(automation.automationId, nextEnabled, agentService);
            }}
          />
        ))}
      </div>
    </SessionAutomationsSectionShell>
  );
}

/** 区块外壳：标题 + 数量 + 刷新，样式与其余 status 区块保持一致。 */
function SessionAutomationsSectionShell({
  children,
  count,
  loading,
  onRefresh,
  separated,
  title,
}: {
  children: React.ReactNode;
  count: number;
  loading: boolean;
  onRefresh: () => void;
  separated: boolean;
  title: string;
}) {
  return (
    <div
      data-status-section="session-automations"
      className={cn(
        "flex min-w-0 flex-none flex-col gap-1.5",
        separated && "border-t border-[var(--color-border)] pt-2",
      )}
    >
      <div className="flex min-w-0 items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-1.5 text-ui-sm text-[var(--color-foreground-subtlest)]">
          <span className="truncate">{title}</span>
          <span className="shrink-0 tabular-nums">{count}</span>
        </div>
        <button
          type="button"
          onClick={onRefresh}
          disabled={loading}
          data-testid="session-automations-refresh"
          className="shrink-0 rounded px-1 text-ui-sm text-[var(--color-foreground-subtlest)] hover:text-[var(--color-foreground)] disabled:opacity-50"
        >
          ↻
        </button>
      </div>
      {children}
    </div>
  );
}

function SessionAutomationRow({
  automation,
  busy,
  onToggle,
}: {
  automation: ZCodeAutomation;
  busy: boolean;
  onToggle: (enabled: boolean) => void;
}) {
  const { intl } = useZCodeIntl();
  const scheduleText = useMemo(() => {
    const builder = parseCronToBuilder(automation.cronExpr);
    return describeCronBuilder(builder, intl);
  }, [automation.cronExpr, intl]);
  const isPaused = !automation.enabled || automation.lifecycleStatus === "paused";

  return (
    <div
      data-testid="session-automation-row"
      className="flex min-w-0 items-center gap-2 rounded-lg bg-[var(--color-background-secondary)] px-2 py-1.5"
    >
      <div className="flex min-w-0 flex-1 flex-col">
        <span
          className={cn(
            "truncate text-ui-sm",
            isPaused && "text-[var(--color-foreground-subtlest)]",
          )}
        >
          {automation.title}
        </span>
        <span className="truncate text-ui-sm text-[var(--color-foreground-subtlest)]">
          {scheduleText}
        </span>
      </div>
      <AutomationSwitchToggle
        checked={!isPaused}
        size="sm"
        ariaLabel={
          isPaused
            ? intl.formatMessage({ id: "automations.resume" })
            : intl.formatMessage({ id: "automations.pause" })
        }
        onChange={(next) => {
          if (busy) return;
          onToggle(next);
        }}
      />
    </div>
  );
}
