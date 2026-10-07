import { useCallback, useEffect, useState } from "react";
import { resolveTeamAgentMaxConcurrentRuns, type TeamAgent } from "@zcode/shared";
import { isTerminalWorkItemStatus, type WorkItem } from "@zcode/shared";
import type { SquadRunRecord, SquadSnapshot } from "@zcode/services";
import { Button } from "@/components/ui/button.js";
import { cn } from "@/components/lib/utils.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { useServices } from "@/hooks/useServices.js";
import { SUBAGENT_COLOR_CLASS, resolveSubagentColorFromName } from "@/lib/subagentColors.js";
import { buildAgentPresence } from "./squadPresenceViewModel.js";
import { mergeRunHistoryPages, runSettleReasonMessageId } from "./squadRunHistoryViewModel.js";
import { resolveSquadRuntimeService } from "./squadRuntimeAccess.js";
import { listMcpServerEntries, mcpTransportMessageId } from "./teamAgentMcpViewModel.js";
import { logger } from "@/logger.js";

/* ④刀（用户 2026-10-06 裁定①：新独立视图）——agent 详情页骨架（4a）：
   概览区（定义字段 + presence + 并发展示「运行中 N / 上限 M」——resolve 单源）；
   任务表/运行历史/DM 直通/并发编辑控件在 4b 落地（台账第 94 轮切分）。 */

const BADGE_CLASSNAME = "text-ui-xs text-foreground-subtlest";
const SECTION_CLASSNAME = "rounded-lg border border-border px-3 py-2";

export function SquadAgentDetailPage({
  workspacePath,
  workspaceIdentity,
  agentId,
  onBack,
  onOpenWorkItem,
  onStartConversation,
  canStartConversation,
}: {
  workspacePath: string;
  workspaceIdentity?: string;
  /** 详情页的 id 寻址（App 级意图态；列表行点击时刷新）。 */
  agentId: string | null;
  /** 返回智能体列表（shell 顶栏返回同一条判据）。 */
  onBack: () => void;
  /** B5.1：打开任务表里某条任务的工作项详情（由 shell 注入；返回目标 = 本 agent 详情页）。 */
  onOpenWorkItem: (workItemId: string) => void;
  /** 4b DM 直通（用户裁定③：新建会话 + 预填提及该智能体——复用 startDraft + 预填机制）。 */
  onStartConversation: (agentName: string) => void;
  /** 只读 workspace ⇒ DM 入口隐藏（通路在只读态是静默返回，入口不该出现）。 */
  canStartConversation: boolean;
}) {
  const { intl } = useZCodeIntl();
  const t = (id: string, values?: Record<string, string | number>) =>
    intl.formatMessage({ id }, values);
  const services = useServices();
  const [snapshot, setSnapshot] = useState<SquadSnapshot | null>(null);
  /** 运行历史：**一页 + 游标**（欠账 #13 起不再「全量 + 前端过滤截断」）。
      `agentId` 一起存：它记录「这一页是谁的」——换 agent 时旧数据不得冒充新的（见 RunsZone 的投影）。 */
  const [history, setHistory] = useState<{
    agentId: string;
    runs: SquadRunRecord[];
    nextCursor: string | null;
    loadingMore: boolean;
    moreFailure: string | null;
  } | null>(null);
  const [failure, setFailure] = useState<string | null>(null);

  const target = { path: workspacePath, identity: workspaceIdentity ?? "" };
  const reload = useCallback(async () => {
    if (!workspacePath) return;
    try {
      const service = resolveSquadRuntimeService(services);
      setSnapshot(await service.getSnapshot(target));
      if (agentId !== null) {
        // 第一页：`agentId` **下推 SQL**（服务面按 agent 过滤后再分页），界面不再自己筛。
        const page = await service.listSquadRunHistory(target, {
          agentId,
          limit: RUN_HISTORY_PAGE_SIZE,
        });
        setHistory({
          agentId,
          runs: page.runs,
          nextCursor: page.nextCursor,
          loadingMore: false,
          moreFailure: null,
        });
      }
      setFailure(null);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error("[SquadAgentDetailPage] 读取快照失败", { error: message });
      setFailure(message);
    }
  }, [services, workspacePath, workspaceIdentity, agentId]);

  useEffect(() => {
    void reload();
  }, [reload]);

  /**
   * 「加载更多」：拿**上一页给的游标**追加下一页（游标是不透明字符串，本层不解析）。
   *
   * 三条纪律：① `nextCursor === null` 时**不发请求**（到底了）；② 加载中不接受第二次点击
   * （重复点 = 重复请求 + 重复行）；③ 失败**可见**（就地一条提示 + 可重试），不吞 ——
   * 「点了没反应」在这个页面里凑不出来。追加走 `mergeRunHistoryPages`（去重 + 保序）。
   */
  const loadMore = useCallback(() => {
    const current = history;
    if (!current || current.nextCursor === null || current.loadingMore) return;
    const cursor = current.nextCursor;
    void (async () => {
      setHistory((previous) =>
        previous ? { ...previous, loadingMore: true, moreFailure: null } : previous,
      );
      try {
        const page = await resolveSquadRuntimeService(services).listSquadRunHistory(target, {
          agentId: current.agentId,
          limit: RUN_HISTORY_PAGE_SIZE,
          cursor,
        });
        setHistory((previous) =>
          previous && previous.agentId === current.agentId
            ? {
                ...previous,
                runs: mergeRunHistoryPages(previous.runs, page.runs),
                nextCursor: page.nextCursor,
                loadingMore: false,
              }
            : previous,
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.warn("[SquadAgentDetailPage] 加载更多运行历史失败", { error: message });
        setHistory((previous) =>
          previous ? { ...previous, loadingMore: false, moreFailure: message } : previous,
        );
      }
    })();
  }, [history, services, target]);

  if (agentId === null) {
    return (
      <div data-testid="squad-agent-detail-page" className="flex flex-col gap-2 py-8">
        <p className="text-ui-base text-foreground">{t("squad.agentDetail.noSelection")}</p>
        <Button size="sm" variant="outline" onClick={onBack} data-testid="squad-agent-detail-back">
          {t("squad.agentDetail.back")}
        </Button>
      </div>
    );
  }

  const agent = snapshot?.teamAgents.find((entry) => entry.id === agentId) ?? null;

  return (
    <div data-testid="squad-agent-detail-page" className="flex flex-col gap-3 py-2">
      <div className="flex items-center gap-2">
        <Button size="sm" variant="outline" onClick={onBack} data-testid="squad-agent-detail-back">
          {t("squad.agentDetail.back")}
        </Button>
        {failure ? (
          <span className="text-ui-sm text-destructive">{t("squad.sidebar.loadFailedAlias")}</span>
        ) : null}
      </div>

      {snapshot && agent ? (
        <>
          <OverviewZone
            agent={agent}
            snapshot={snapshot}
            onStartConversation={onStartConversation}
            canStartConversation={canStartConversation}
          />
          <TasksZone
            workItems={snapshot.workItems}
            agentId={agent.id}
            onOpenWorkItem={onOpenWorkItem}
          />
          <RunsZone
            history={history?.agentId === agent.id ? history : null}
            onLoadMore={loadMore}
          />
        </>
      ) : !failure ? (
        <p className="text-ui-sm text-foreground-subtlest">{t("squad.agentDetail.loading")}</p>
      ) : null}
    </div>
  );
}

/** 概览区（4a）：定义字段 + presence + 并发展示。任务/运行/DM 在 4b。 */
function OverviewZone({
  agent,
  snapshot,
  onStartConversation,
  canStartConversation,
}: {
  agent: TeamAgent;
  snapshot: SquadSnapshot;
  onStartConversation: (agentName: string) => void;
  canStartConversation: boolean;
}) {
  const { intl } = useZCodeIntl();
  const t = (id: string, values?: Record<string, string | number>) =>
    intl.formatMessage({ id }, values);
  const presence = buildAgentPresence(agent, snapshot.runs, snapshot.queuedRuns);
  const capacity = resolveTeamAgentMaxConcurrentRuns(agent);
  /* per-agent MCP（设计 §3.6）：只读呈现「名字 + 传输类型」。
     无配置（字段缺席或空 map）**不渲染**这一行 —— 空徽标行是噪音，且「没有」这件事
     已经在表单侧的「继承工作区/用户级配置」提示里说清了。 */
  const mcpRows = listMcpServerEntries(agent.mcpServers);

  return (
    <section
      className={cn(SECTION_CLASSNAME, "flex flex-col gap-2")}
      data-testid="squad-agent-detail-overview"
    >
      <span className="flex items-center gap-2">
        <span
          className={cn(
            "size-2.5 shrink-0 rounded-full",
            SUBAGENT_COLOR_CLASS[agent.color ?? resolveSubagentColorFromName(agent.name)],
          )}
          aria-hidden
        />
        <span className="break-words text-ui-base text-foreground">{agent.name}</span>
        {agent.archivedAt !== undefined ? (
          <span className={BADGE_CLASSNAME}>{t("squad.common.archived")}</span>
        ) : null}
        {!agent.enabled ? (
          <span className={BADGE_CLASSNAME}>{t("squad.common.disabled")}</span>
        ) : null}
      </span>
      {agent.description ? (
        <span className="text-ui-sm text-foreground-subtlest">{agent.description}</span>
      ) : null}
      {canStartConversation ? (
        <span>
          <Button
            size="sm"
            variant="outline"
            data-testid="squad-agent-detail-start-conversation"
            onClick={() => onStartConversation(agent.name)}
          >
            {t("squad.agentDetail.startConversation")}
          </Button>
        </span>
      ) : null}
      <span className="flex flex-wrap gap-2">
        <span className={BADGE_CLASSNAME}>
          {t("squad.agentDetail.capacity", {
            running: presence.runningCount,
            max: capacity,
          })}
        </span>
        {agent.modelSelection ? (
          <span className={BADGE_CLASSNAME}>
            {agent.modelSelection.modelId}
            {agent.modelSelection.options?.reasoningLevel
              ? ` · ${agent.modelSelection.options.reasoningLevel}`
              : ""}
          </span>
        ) : (
          <span className={BADGE_CLASSNAME}>{t("squad.agents.modelDefault")}</span>
        )}
        <span className={BADGE_CLASSNAME}>
          {t(`squad.common.memoryScope.${agent.memoryScope}`)}
        </span>
        {agent.permissionMode ? (
          <span className={BADGE_CLASSNAME}>
            {t(`squad.common.permissionMode.${agent.permissionMode}`)}
          </span>
        ) : null}
        {agent.skills.length > 0 ? (
          <span className={BADGE_CLASSNAME}>{agent.skills.join(" · ")}</span>
        ) : null}
      </span>
      {mcpRows.length > 0 ? (
        <span className="flex flex-wrap items-center gap-2" data-testid="squad-agent-detail-mcp">
          <span className={BADGE_CLASSNAME}>{t("squad.common.mcpServers")}</span>
          {mcpRows.map((row) => (
            <span
              key={row.name}
              className={BADGE_CLASSNAME}
              data-testid="squad-agent-detail-mcp-server"
            >
              {row.name} · {t(mcpTransportMessageId(row.transport))}
            </span>
          ))}
        </span>
      ) : null}
    </section>
  );
}

/** 4b 任务表区：指派给该 agent 的工作项（只读——用户裁定⑥；动作归工作项页）。
    B5.1：行标题成为**可访问入口**（打开工作项详情）——只加导航，不在此页造写路径。 */
function TasksZone({
  workItems,
  agentId,
  onOpenWorkItem,
}: {
  workItems: WorkItem[];
  agentId: string;
  onOpenWorkItem: (workItemId: string) => void;
}) {
  const { intl } = useZCodeIntl();
  const t = (id: string) => intl.formatMessage({ id });
  const assigned = workItems.filter(
    (item) => item.assignee.type === "agent" && item.assignee.id === agentId,
  );
  return (
    <section className={SECTION_CLASSNAME} data-testid="squad-agent-detail-tasks">
      <p className="text-ui-sm font-medium text-foreground">{t("squad.agentDetail.tasksTitle")}</p>
      {assigned.length === 0 ? (
        <p className="text-ui-sm text-foreground-subtlest">{t("squad.agentDetail.tasksEmpty")}</p>
      ) : (
        <ul className="flex flex-col gap-1">
          {assigned.map((item) => (
            <li key={item.id} className="flex items-center gap-2 text-ui-sm">
              <Button
                size="xs"
                variant="ghost"
                className="min-w-0 flex-1 justify-start truncate"
                data-testid="squad-agent-detail-task-open"
                onClick={() => onOpenWorkItem(item.id)}
              >
                {item.title}
              </Button>
              <span className={BADGE_CLASSNAME}>{item.status}</span>
              {item.archivedAt !== undefined ? (
                <span className={BADGE_CLASSNAME}>{t("squad.common.archived")}</span>
              ) : null}
              {isTerminalWorkItemStatus(item.status) ? null : (
                <span className={BADGE_CLASSNAME}>{t("squad.agentDetail.tasksOpen")}</span>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/** 运行历史的**页大小**（欠账 #13 起语义变了：从「硬截断」变成「一次取多少行」——
    归零的是「前端截断」，不是「有界」：服务面按它分页，界面按游标继续要下一页）。 */
const RUN_HISTORY_PAGE_SIZE = 50;

/** 运行数据区的一份历史（一页 + 游标 + 加载态；`null` = 还没取到或还不是这个 agent 的）。 */
type RunHistoryView = {
  runs: SquadRunRecord[];
  nextCursor: string | null;
  loadingMore: boolean;
  moreFailure: string | null;
};

/** 4b 运行数据区：该 agent 的 run 历史，**最新在前、按游标分页**（不再是全量 + 前端过滤截断）。 */
function RunsZone({
  history,
  onLoadMore,
}: {
  /** `null` = 该 agent 的第一页还没到（换 agent 时旧页不得冒充新的）。 */
  history: RunHistoryView | null;
  onLoadMore: () => void;
}) {
  const { intl } = useZCodeIntl();
  const t = (id: string, values?: Record<string, string | number>) =>
    intl.formatMessage({ id }, values);
  const runs = history?.runs ?? [];
  const nextCursor = history?.nextCursor ?? null;
  return (
    <section className={SECTION_CLASSNAME} data-testid="squad-agent-detail-runs">
      <p className="text-ui-sm font-medium text-foreground">
        {t("squad.agentDetail.runsTitle")}
        {runs.length > 0
          ? ` ${nextCursor === null ? t("squad.agentDetail.runsAllLoaded") : t("squad.agentDetail.runsLoaded", { count: runs.length })}`
          : ""}
      </p>
      {history === null ? (
        <p className="text-ui-sm text-foreground-subtlest">{t("squad.agentDetail.loading")}</p>
      ) : runs.length === 0 ? (
        <p className="text-ui-sm text-foreground-subtlest">{t("squad.agentDetail.runsEmpty")}</p>
      ) : (
        <>
          <ul className="flex flex-col gap-1">
            {runs.map((run) => {
              /* 结算原因：已知码值 ⇒ 本地化措辞；**其它非空原文原样显示**（`settle_reason`
                 不是闭集，失败原因原文也落这一列 —— 当枚举隐藏就是把最该看的一行抹掉）；
                 空 ⇒ 整块不渲染。 */
              const reasonMessageId = runSettleReasonMessageId(run.settleReason ?? null);
              return (
                <li key={run.runId} className="flex items-center gap-2 text-ui-sm">
                  <span className={BADGE_CLASSNAME}>{t(`squad.runs.status.${run.status}`)}</span>
                  <span className="min-w-0 flex-1 truncate text-foreground-subtlest">
                    {run.branch ?? run.runId}
                  </span>
                  {run.settleReason ? (
                    <span
                      className={BADGE_CLASSNAME}
                      data-testid="squad-agent-detail-run-settle-reason"
                    >
                      {reasonMessageId ? t(reasonMessageId) : run.settleReason}
                    </span>
                  ) : null}
                  {run.isLeaderTask ? (
                    <span className={BADGE_CLASSNAME}>{t("squad.agentDetail.runsLeader")}</span>
                  ) : null}
                </li>
              );
            })}
          </ul>
          {/* 没有下一页 ⇒ 整个入口不渲染（不给一个点不出东西的按钮）。 */}
          {nextCursor === null ? null : (
            <span className="flex flex-col gap-1">
              <Button
                size="sm"
                variant="outline"
                className="self-start"
                disabled={history.loadingMore}
                data-testid="squad-agent-detail-runs-more"
                onClick={onLoadMore}
              >
                {history.loadingMore
                  ? t("squad.agentDetail.runsMoreLoading")
                  : t("squad.agentDetail.runsMore")}
              </Button>
              {history.moreFailure === null ? null : (
                /* 加载更多失败**必须可见**（否则用户只看到「点了没反应」）：就地一行 + 重试 = 再点一次。 */
                <span
                  className="text-ui-xs text-destructive"
                  data-testid="squad-agent-detail-runs-more-failure"
                >
                  {t("squad.agentDetail.runsMoreFailed")}：{history.moreFailure}
                </span>
              )}
            </span>
          )}
        </>
      )}
    </section>
  );
}
