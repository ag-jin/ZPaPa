import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { SquadRunRecord } from "@zcode/services";
import type { TeamAgent, WorkItem } from "@zcode/shared";
import { Button } from "@/components/ui/button.js";
import { Spinner } from "@/components/ui/spinner.js";
import { cn } from "@/components/lib/utils.js";
import { useServices } from "@/hooks/useServices.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { logger } from "@/logger.js";
import { SUBAGENT_COLOR_CLASS } from "@/lib/subagentColors.js";
import { SquadTimeline } from "./SquadTimeline.js";
import { buildSquadTimelineModel } from "./squadTimelineModel.js";
import {
  squadEntryErrorFeedback,
  squadServiceUnavailableFeedback,
  type SquadEntryFeedback,
} from "./squadEntryViewModel.js";
import {
  SQUAD_RUNTIME_SERVICE_UNAVAILABLE_CODE,
  resolveSquadRuntimeService,
  squadWorkspaceTarget,
} from "./squadRuntimeAccess.js";

/* 「工作项」页看板里、批根行下方内联展开的**时间线分区**（§11.2 的挂载点，controller 2026-10-03 收口）：
   展开即挂载 ⇒ 拉**本批历史**（`listSquadRuns(target, { parentWorkItemId })`，含 merged / discarded
   —— 只画活跃 run 会让每次收尾把图上的一段静默抹掉）并渲染；**收起即卸载**（数据随组件一起丢弃，
   不做展开态记忆）。

   取数纪律与三个小队页面同款：经 `resolveSquadRuntimeService`（缺服务**响亮抛**，不静默成
   一片空白）、失败带原因 + 重试（`squadEntryErrorFeedback` / `squadServiceUnavailableFeedback`）。
   **只读历史**：本分区不拉快照（`getSnapshot` 在这里一次都不出现）—— 快照口径的「待收尾运行」
   由页面既有的 SquadRunsReview 负责，两者互补不重复。

   宽度用**容器实测宽**（ResizeObserver；环境没有它就只量一次）；宽度变化只重画、**不重取数据**
   （重取数据的依赖里没有宽度）。`matchMedia` / `ResizeObserver` 都不存在的非浏览器环境
   （node:test / SSR）量不到宽 ⇒ 用兜底宽画一张可辨认的图（0 宽会把时间线退化成一个点）。 */

/** 量不到容器宽的兜底画布宽（px）：非浏览器环境用（见文件顶注）。 */
const SQUAD_TIMELINE_FALLBACK_WIDTH = 480;

export function SquadTimelineSection({
  workItemId,
  workspacePath,
  workspaceIdentity,
  teamAgents,
  workItems,
  onOpenSession,
}: {
  /** 批根工作项 id：本批历史按 `parentWorkItemId` 收敛在它名下。 */
  workItemId: string;
  workspacePath: string;
  workspaceIdentity?: string;
  /** 名册（页面的同一份快照口径）：模型据此定 lane 的名字与身份色。 */
  teamAgents: TeamAgent[];
  /** 工作项全集（页面同一次快照的口径）：用来把 `run.workItemId` 翻成**站点 tooltip 的第一行**
      （"这次运行做的是哪条活"）——与 `teamAgents` 同源同传，不另从快照里挑字段。 */
  workItems: WorkItem[];
  /** 打开某次运行的会话；不传 ⇒ 站点不可点（透传自页面，见 WorkItemsBoard）。 */
  onOpenSession?: (sessionId: string) => void;
}) {
  const { intl } = useZCodeIntl();
  const services = useServices();

  const target = useMemo(
    () => squadWorkspaceTarget(workspacePath, workspaceIdentity),
    [workspacePath, workspaceIdentity],
  );

  const [runs, setRuns] = useState<SquadRunRecord[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [failure, setFailure] = useState<SquadEntryFeedback | null>(null);
  /** 「现在」= 数据到齐的时刻（开口站的持续推进由 SquadTimeline 内部的 ticker 负责）。 */
  const [renderedAt, setRenderedAt] = useState(() => Date.now());

  const t = useCallback((id: string) => intl.formatMessage({ id }), [intl]);

  /* 读取：mount 一次（展开）+ 失败后的重试按钮。**失败不清空已有数据** —— 重试失败要变成
     图上的一行原因，而不是把已经画出来的历史抹掉（同三个小队页面的口径）。 */
  const reload = useCallback(async () => {
    // target 与页面同式同源（页面渲染看板时它必非空）；这里只保证「没目标就不发请求」。
    if (!target) return;
    setLoading(true);
    try {
      const service = resolveSquadRuntimeService(services);
      setRuns(await service.listSquadRuns(target, { parentWorkItemId: workItemId }));
      setFailure(null);
      setRenderedAt(Date.now());
    } catch (error) {
      logger.error("[SquadTimelineSection] 读取时间线失败", {
        error: error instanceof Error ? error.message : String(error),
      });
      setFailure(
        (error as { code?: unknown } | null)?.code === SQUAD_RUNTIME_SERVICE_UNAVAILABLE_CODE
          ? squadServiceUnavailableFeedback()
          : squadEntryErrorFeedback(error),
      );
    } finally {
      setLoading(false);
    }
  }, [services, target, workItemId]);

  useEffect(() => {
    void reload();
  }, [reload]);

  /* 容器实测宽：ResizeObserver（每次尺寸变化只更新宽度状态 ⇒ 只重画、不重取数据）。
     没有 ResizeObserver 的环境只量一次 clientWidth；量报 0（首帧 / 非浏览器）⇒ 兜底宽。 */
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [measuredWidth, setMeasuredWidth] = useState<number | null>(null);
  useEffect(() => {
    const element = containerRef.current;
    if (!element) return;
    const update = () => setMeasuredWidth(element.clientWidth);
    update();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(update);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  const timelineWidth =
    measuredWidth !== null && measuredWidth > 0 ? measuredWidth : SQUAD_TIMELINE_FALLBACK_WIDTH;

  /** run.workItemId → 标题（tooltip 用）；取不到不出现该片段。 */
  const workItemTitles = useMemo(
    () => new Map(workItems.map((item) => [item.id, item.title] as const)),
    [workItems],
  );
  const model = useMemo(
    () => (runs === null ? null : buildSquadTimelineModel({ runs, teamAgents })),
    [runs, teamAgents],
  );

  /* 四个呈现态（与共享状态机同口径：首帧无数据也算「正在读取」；重试进行中优先于旧失败）：
     加载 / 失败（带原因 + 重试）/ 空（该批还没有运行）/ 就绪。 */
  let mode: "loading" | "error" | "empty" | "ready";
  if (runs === null) {
    mode = loading || failure === null ? "loading" : "error";
  } else {
    mode = runs.length === 0 ? "empty" : "ready";
  }

  return (
    <div className="mt-2 border-t border-border pt-2" data-testid="squad-timeline-section">
      <div ref={containerRef} className="min-w-0">
        {mode === "loading" ? (
          <div
            className="flex items-center gap-2 px-1 py-1 text-ui-sm text-foreground-subtle"
            data-testid="squad-timeline-loading"
          >
            <Spinner className="size-3.5" />
            {t("squad.timeline.loading")}
          </div>
        ) : null}

        {/* 失败必须带原因（含原始 detail）+ 重试。 */}
        {mode === "error" && failure !== null ? (
          <div
            className="flex flex-col items-start gap-2 px-1 py-1"
            data-testid="squad-timeline-error"
          >
            <p role="alert" className="text-ui-sm text-destructive">
              {t("squad.timeline.loadFailed")}：{t(failure.messageId)}
              {failure.detail ? `：${failure.detail}` : ""}
            </p>
            <Button
              variant="outline"
              size="sm"
              data-testid="squad-timeline-retry"
              onClick={() => {
                void reload();
              }}
            >
              {t("squad.common.refresh")}
            </Button>
          </div>
        ) : null}

        {mode === "empty" ? (
          <p
            className="px-1 py-1 text-ui-sm text-foreground-subtlest"
            data-testid="squad-timeline-empty"
          >
            {t("squad.timeline.empty")}
          </p>
        ) : null}

        {mode === "ready" && model !== null ? (
          /* 宽度变化只走到这里（重画）；取数依赖里没有宽度 —— 尺寸抖动不会重放请求。 */
          <SquadTimeline
            model={model}
            width={timelineWidth}
            now={renderedAt}
            onOpenSession={onOpenSession}
            workItemTitles={workItemTitles}
          />
        ) : null}
      </div>

      {/* 图例：身份色（九色板）只表达队员身份；**实线 = 台账记录的派发**（0008 两列，队长工具落账）、
       **虚线 = 推断**的派发关系（遗留行 / 入边缺失时的回落）。 */}
      {mode === "ready" && model !== null ? (
        <div
          className="flex flex-wrap items-center gap-x-4 gap-y-1 px-1 pt-2 text-ui-xs text-foreground-subtlest"
          data-testid="squad-timeline-legend"
        >
          <span>{t("squad.timeline.legendTitle")}</span>
          <span className="flex items-center gap-1.5">
            <span className="w-5 shrink-0 border-t border-foreground-subtle" aria-hidden />
            {t("squad.timeline.legendRecorded")}
          </span>
          <span className="flex items-center gap-1.5">
            <span
              className="w-5 shrink-0 border-t border-dashed border-foreground-subtle"
              aria-hidden
            />
            {t("squad.timeline.legendInferred")}
          </span>
          <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <span>{t("squad.timeline.legendIdentity")}</span>
            {model.lanes.map((lane) => (
              <span key={lane.laneId} className="flex items-center gap-1.5">
                <span
                  className={cn("size-2 shrink-0 rounded-full", SUBAGENT_COLOR_CLASS[lane.color])}
                  aria-hidden
                />
                {lane.label}
              </span>
            ))}
          </span>
        </div>
      ) : null}
    </div>
  );
}
