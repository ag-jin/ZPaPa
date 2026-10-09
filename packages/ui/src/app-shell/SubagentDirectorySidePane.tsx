import { memo, useEffect, useMemo, useState } from "react";
import type { ZCodeSessionEndedSubagent } from "@zcode/shared";
import type { RunningSubagentSummary } from "@zcode/shared/zcode-protocol-v4";
import {
  BanIcon,
  CheckCircle2Icon,
  CircleAlertIcon,
  CircleDashedIcon,
  LoaderCircleIcon,
  PauseCircleIcon,
} from "lucide-react";
import { Button } from "@/components/ui/button.js";
import { useSessionSubagents } from "@/hooks/useSessionSubagents.js";
import { useSettings } from "@/hooks/useSettingService.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { SquadRunsDirectorySection } from "@/squad/SquadRunsDirectorySection.js";
import { squadDirectorySectionVisible } from "@/squad/squadRunsDirectoryViewModel.js";
import type {
  OpenScopedSubagentSideTabRequest,
  SubagentDirectorySidePaneTab,
} from "@/lib/workspaceSidePane.js";
import { formatTaskRelativeTime } from "@/lib/taskListItemPresentation.js";
import type { PaneWorkspaceScope } from "@/v4/paneLayoutStore.js";
import type { SessionLease } from "@/v4/sessionDataLayer.js";
import { V4PaneConversationProvider, useV4Conversation } from "@/v4/V4ConversationContext.js";
import { useConversationProjection } from "@/v4/useConversationProjection.js";

type DirectoryItem = RunningSubagentSummary | ZCodeSessionEndedSubagent;

const EMPTY_RUNNING: readonly RunningSubagentSummary[] = [];

function buildSubagentDirectoryOpenRequest(
  tab: SubagentDirectorySidePaneTab,
  item: DirectoryItem,
): OpenScopedSubagentSideTabRequest {
  return {
    workspacePath: tab.workspacePath,
    ...(tab.workspaceIdentity ? { workspaceIdentity: tab.workspaceIdentity } : {}),
    ...(tab.remoteSessionId ? { remoteSessionId: tab.remoteSessionId } : {}),
    rootSessionId: tab.rootSessionId,
    parentSessionId: tab.parentSessionId,
    childSessionId: item.childSessionId,
    subagentType: item.subagentType,
    title: item.title,
  };
}

function StatusIcon({ status }: { status: DirectoryItem["status"] }) {
  const className = "size-4 shrink-0";
  switch (status) {
    case "running":
      return <LoaderCircleIcon aria-hidden className={`${className} animate-spin`} />;
    case "waiting":
    case "blocked":
      return <PauseCircleIcon aria-hidden className={className} />;
    case "success":
      return <CheckCircle2Icon aria-hidden className={className} />;
    case "failed":
      return <CircleAlertIcon aria-hidden className={className} />;
    case "cancelled":
      return <BanIcon aria-hidden className={className} />;
    case "lost":
      return <CircleDashedIcon aria-hidden className={className} />;
  }
}

const DirectoryRow = memo(function DirectoryRow({
  item,
  onOpen,
}: {
  item: DirectoryItem;
  onOpen: (item: DirectoryItem) => void;
}) {
  const { intl } = useZCodeIntl();
  const timestamp = "endedAt" in item ? item.endedAt : item.startedAt;
  return (
    <button
      type="button"
      className="flex w-full min-w-0 items-start gap-3 rounded-lg px-3 py-2.5 text-left text-ui-base transition-colors hover:bg-surface-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-input-border-focused"
      onClick={() => onOpen(item)}
    >
      <span className="mt-0.5 text-foreground-subtle">
        <StatusIcon status={item.status} />
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex min-w-0 items-center gap-2">
          <span className="truncate font-medium text-foreground">{item.title}</span>
          <span className="shrink-0 text-ui-sm text-foreground-subtlest">
            {intl.formatMessage({ id: `subagentDirectory.status.${item.status}` })}
          </span>
        </span>
        {item.summary ? (
          <span className="mt-0.5 block truncate text-ui-sm text-foreground-subtle">
            {item.summary}
          </span>
        ) : null}
      </span>
      {timestamp ? (
        <span className="shrink-0 text-ui-sm text-foreground-subtlest">
          {formatTaskRelativeTime(timestamp, intl)}
        </span>
      ) : null}
    </button>
  );
});

export const SubagentDirectorySidePane = memo(function SubagentDirectorySidePane({
  tab,
  onOpenSubagentSession,
  onOpenSquadRunSession,
}: {
  tab: SubagentDirectorySidePaneTab;
  onOpenSubagentSession: (request: OpenScopedSubagentSideTabRequest) => void;
  /** 打开某个小队 run 的独立会话（本会话面板里「小队运行（本项目）」分区的穿透入口）。
      必填而不是可选：可选会留下「按钮在、点了没反应」的静默路径（`onOpenSquadRunSession?.()`
      无声吞掉）—— 侧栏宿主恒会传（shell 的 handleSelectTaskInChat 接线），把契约钉在类型上。 */
  onOpenSquadRunSession: (sessionId: string) => void;
}) {
  const scope = useMemo<PaneWorkspaceScope>(
    () => ({
      workspacePath: tab.workspacePath,
      ...(tab.workspaceIdentity ? { workspaceIdentity: tab.workspaceIdentity } : {}),
      ...(tab.remoteSessionId ? { remoteSessionId: tab.remoteSessionId } : {}),
    }),
    [tab.remoteSessionId, tab.workspaceIdentity, tab.workspacePath],
  );
  return (
    <V4PaneConversationProvider scope={scope}>
      <SubagentDirectoryContents
        tab={tab}
        onOpenSubagentSession={onOpenSubagentSession}
        onOpenSquadRunSession={onOpenSquadRunSession}
      />
    </V4PaneConversationProvider>
  );
});

const SubagentDirectoryContents = memo(function SubagentDirectoryContents({
  tab,
  onOpenSubagentSession,
  onOpenSquadRunSession,
}: {
  tab: SubagentDirectorySidePaneTab;
  onOpenSubagentSession: (request: OpenScopedSubagentSideTabRequest) => void;
  onOpenSquadRunSession: (sessionId: string) => void;
}) {
  const { intl } = useZCodeIntl();
  const { layer } = useV4Conversation();
  const { settings } = useSettings();
  const [lease, setLease] = useState<SessionLease | null>(null);
  const projection = useConversationProjection(lease);
  const subagents = projection.snapshot?.subagents;
  useEffect(() => {
    const nextLease = layer.acquire(tab.parentSessionId);
    setLease(nextLease);
    return () => nextLease.release();
  }, [layer, tab.parentSessionId]);
  const directory = useSessionSubagents({
    enabled: projection.snapshot !== null,
    workspacePath: tab.workspacePath,
    workspaceIdentity: tab.workspaceIdentity,
    remoteSessionId: tab.remoteSessionId,
    sessionId: tab.parentSessionId,
    refreshKey: subagents?.revision ?? 0,
  });
  const running = subagents?.running ?? EMPTY_RUNNING;
  const endedTotal = subagents?.endedTotal ?? 0;
  const handleOpen = (item: DirectoryItem) => {
    onOpenSubagentSession(buildSubagentDirectoryOpenRequest(tab, item));
  };
  /* 整段「小队运行（本项目）」的显隐：**远端会话恒不渲染**（投射边界，spec §16 S9 —— 投射端连
     小队运行时服务都没有），实验开关关闭 / 设置未加载也不渲染（复用 squadEntryVisible 语义）。
     判据是纯函数，本层只问它（与侧栏一级入口同一份语义、同一份实现）。 */
  const showSquadRuns = squadDirectorySectionVisible({
    remoteSessionId: tab.remoteSessionId,
    settings,
  });

  return (
    <div className="flex size-full min-h-0 flex-col bg-background">
      <div className="border-b border-border px-4 py-3">
        <h2 className="text-ui-base font-semibold text-foreground">
          {intl.formatMessage({ id: "subagentDirectory.title" })}
        </h2>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-2 py-3">
        <section>
          <h3 className="px-3 pb-1.5 text-ui-sm font-medium text-foreground-subtlest">
            {intl.formatMessage({ id: "subagentDirectory.running" })} · {running.length}
          </h3>
          {running.length > 0 ? (
            running.map((item) => (
              <DirectoryRow key={item.childSessionId} item={item} onOpen={handleOpen} />
            ))
          ) : (
            <p className="px-3 py-3 text-ui-base text-foreground-subtlest">
              {intl.formatMessage({ id: "subagentDirectory.runningEmpty" })}
            </p>
          )}
        </section>

        {/* 「小队运行（本项目）」：位于**正在运行之后、已结束之前** —— 三段都是"本会话相关"的
            目录（running / 小队运行 / ended），小队运行与 ended 之间没有更强的相邻理由，
            放在这里同时保住"活动类目录在上、历史类目录在下"的既有阅读次序。 */}
        {showSquadRuns ? (
          <SquadRunsDirectorySection
            workspacePath={tab.workspacePath}
            workspaceIdentity={tab.workspaceIdentity}
            onOpenSession={onOpenSquadRunSession}
          />
        ) : null}

        <section className="mt-5">
          <h3 className="px-3 pb-1.5 text-ui-sm font-medium text-foreground-subtlest">
            {intl.formatMessage({ id: "subagentDirectory.ended" })} · {endedTotal}
          </h3>
          {directory.ended.items.map((item) => (
            <DirectoryRow key={item.childSessionId} item={item} onOpen={handleOpen} />
          ))}
          {directory.ended.nextCursor ? (
            <div className="px-3 pt-2">
              <Button
                type="button"
                variant="ghost"
                size="sm"
                disabled={directory.loading}
                onClick={() => void directory.loadMore()}
              >
                {intl.formatMessage({ id: "subagentDirectory.showMore" })}
              </Button>
            </div>
          ) : null}
        </section>

        {directory.error ? (
          <p role="alert" className="mx-3 mt-4 text-ui-sm text-[var(--color-danger)]">
            {intl.formatMessage({ id: "subagentDirectory.loadFailed" })}
          </p>
        ) : null}
      </div>
    </div>
  );
});
