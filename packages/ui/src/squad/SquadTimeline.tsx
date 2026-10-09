import { useEffect, useMemo, useState, type KeyboardEvent } from "react";
import type { SquadRunStatus } from "@zcode/services";
import { cn } from "@/components/lib/utils.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { SUBAGENT_COLOR_CLASS } from "@/lib/subagentColors.js";
import { squadRunStatusMessageId } from "./squadEntryViewModel.js";
import { SQUAD_TIMELINE_STATION_INSET_Y, layoutSquadTimeline } from "./squadTimelineLayout.js";
import type { SquadTimelineModel, TimelineStation } from "./squadTimelineModel.js";

/* 「活动时间线」（规格 §11.2）的 **SVG 渲染**：只把 `layoutSquadTimeline` 给的几何画出来。

   分工（三段式）：模型（squadTimelineModel）= 有哪些 lane / 站 / 弧；布局（squadTimelineLayout）
   = 每个数字在哪；本层 = 数字 → SVG 元素。本层**不做任何几何判断**（不重算 x/y/width、
   不再推断弧），也不从别处取值：几何只从布局拿；分支 / 会话 / 起止时刻这些**叙事字段**
   按 runId 回模型查（布局类型保持最小，不撑成模型的拷贝）。

   视觉纪律（§11.3）：
   · **九色板只表达身份** —— 全文件只有一处九色板取色点（`identityClassByLane`，lane 身份表），
     lane 圆点与站条都经它取色（SVG 里 bg-* 半段无效、text-* 半段配 `fill-current` 生效；
     不另建十六进制表 —— 那会是第二份九色板）；
   · **状态只用语义色 token**（`STATION_STATUS_CLASSES`），并用既有 `squadRunStatusMessageId`
     翻词；状态**绝不**走九色板；
   · **弧线按成色分流**（判据全在模型，本层只照抄 `arc.kind`）：**recorded（台账事实）画实线**；
     **inferred（回落推断）画虚线 + 低不透明度** —— 图例与每条弧的悬停说明把两种成色说清。 */

/** 每条 lane 的行高（px）：站条 ~20 高 + 上下呼吸。 */
const SQUAD_TIMELINE_LANE_HEIGHT = 28;
/** 左内边距给 lane 标签（身份点 + 名字）留位；右内边距给末端一点呼吸。 */
const SQUAD_TIMELINE_PADDING = { left: 104, right: 10 };
/** 条宽到这个值才落状态文字（更窄就只留徽标 + 悬停说明，避免文字压到相邻站上）。 */
const SQUAD_TIMELINE_STATUS_TEXT_MIN_WIDTH = 56;

/** 运行状态 → **语义状态色 token** 的 class（§11.3：状态不靠九色板表达）。 */
const STATION_STATUS_CLASSES: Record<SquadRunStatus, string> = {
  open: "text-foreground-subtle",
  produced: "text-warning",
  rejected: "text-destructive",
  merged: "text-success",
  discarded: "text-foreground-subtlest",
  // C2 排队态：穷尽键（Record 编译强制）；queued 行在建模型时已被排除（R6），不会走到渲染。
  queued: "text-foreground-subtlest",
};

export function SquadTimeline({
  model,
  width,
  now,
  onOpenSession,
  workItemTitles,
}: {
  model: SquadTimelineModel;
  /** 画布可用宽（容器实测，由分区给）。 */
  width: number;
  /** 「现在」（布局据此把开口站伸到此刻；见 squadTimelineLayout 的缩放注释）。 */
  now: number;
  /** 打开某次运行的会话；不传 ⇒ 站点**不可点**（没有去处就不给可点的样子）。 */
  onOpenSession?: (sessionId: string) => void;
  /** 工作项标题表（run.workItemId → 标题）：站点 tooltip 的**第一行**——「这次运行做的是哪条活」
      比分支名更先需要知道。取不到（已归档/被删）就不出现该片段，绝不渲染 undefined。 */
  workItemTitles?: ReadonlyMap<string, string>;
}) {
  const { intl } = useZCodeIntl();
  const t = (id: string, values?: Record<string, string | number>) =>
    intl.formatMessage({ id }, values);

  /* 开口站的「秒级伸展」：**仅当图上有开口站**时按 1s 推进 now（闭合图没有会变的右端，
     一个 ticker 都不起）。**必须尊重 prefers-reduced-motion**：命中 ⇒ 不启动（静态画到当前 now）。
     matchMedia 不可用（SSR / node:test）同样按「不启动」处理 —— 拿不到媒体查询能力就没有
     「用户是否要求减少动效」的证据，宁可静止。 */
  const hasOpenStation = model.lanes.some((lane) => lane.stations.some((station) => station.open));
  const [tickedNow, setTickedNow] = useState<number | null>(null);
  useEffect(() => {
    if (!hasOpenStation) return;
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const timer = window.setInterval(() => setTickedNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [hasOpenStation]);
  // 本地 tick 只前进；prop 的 now 更新（父级重新取数）也会被采纳。
  const effectiveNow = tickedNow === null ? now : Math.max(now, tickedNow);

  const layout = useMemo(
    () =>
      layoutSquadTimeline({
        model,
        width,
        laneHeight: SQUAD_TIMELINE_LANE_HEIGHT,
        now: effectiveNow,
        padding: SQUAD_TIMELINE_PADDING,
      }),
    [model, width, effectiveNow],
  );

  /** runId → 模型站：分支 / 会话 / 起止时刻这些事实字段按 runId 回模型查（几何仍只从布局拿）。 */
  const stationsById = useMemo(() => {
    const map = new Map<string, TimelineStation>();
    for (const lane of model.lanes) {
      for (const station of lane.stations) map.set(station.runId, station);
    }
    return map;
  }, [model]);

  /** laneId → 身份 class：**唯一**的九色板取色点（圆点 / 条共用；单一来源）。 */
  const identityClassByLane = useMemo(
    () => new Map(layout.lanes.map((lane) => [lane.laneId, SUBAGENT_COLOR_CLASS[lane.color]])),
    [layout.lanes],
  );

  const barHeight = SQUAD_TIMELINE_LANE_HEIGHT - 2 * SQUAD_TIMELINE_STATION_INSET_Y;
  const statusText = (status: SquadRunStatus) => t(squadRunStatusMessageId(status));
  const durationText = (startAt: number, endAt: number | null) =>
    t("squad.timeline.durationSeconds", {
      seconds: Math.max(0, Math.round(((endAt ?? effectiveNow) - startAt) / 1000)),
    });

  return (
    <svg
      role="img"
      aria-label={t("squad.timeline.ariaLabel", {
        lanes: layout.lanes.length,
        runs: layout.stations.length,
      })}
      data-testid="squad-timeline"
      width={layout.width}
      height={layout.height}
      viewBox={`0 0 ${layout.width} ${layout.height}`}
      className="animate-in fade-in max-w-full duration-200 motion-reduce:animate-none"
    >
      {/* 每条 lane 一行：身份点 + 名字 + 轨道基线。 */}
      {layout.lanes.map((lane) => {
        const centerY = lane.y + SQUAD_TIMELINE_LANE_HEIGHT / 2;
        return (
          <g key={lane.laneId} data-lane-id={lane.laneId}>
            <circle
              cx={SQUAD_TIMELINE_PADDING.left - 92}
              cy={centerY}
              r={3.5}
              className={cn(identityClassByLane.get(lane.laneId), "fill-current")}
              aria-hidden
            />
            <text
              x={SQUAD_TIMELINE_PADDING.left - 82}
              y={centerY}
              dominantBaseline="central"
              className={cn(
                "fill-current text-ui-xs",
                lane.isLeaderLane ? "font-medium text-foreground" : "text-foreground-subtle",
              )}
            >
              {lane.label}
            </text>
            <line
              x1={SQUAD_TIMELINE_PADDING.left}
              x2={layout.width - SQUAD_TIMELINE_PADDING.right}
              y1={centerY}
              y2={centerY}
              strokeWidth={1}
              className="stroke-border"
              aria-hidden
            />
          </g>
        );
      })}

      {/* 站点条 = 一次运行。身份侧（填充 / 描边）用 lane 色；状态用文字 / 徽标 + 语义 token。 */}
      {layout.stations.map((station) => {
        const meta = stationsById.get(station.runId);
        const branchLabel = meta?.branchLabel ?? station.runId;
        const sessionId = meta?.sessionId ?? null;
        // 可点的唯一条件：有去处（onOpenSession）**且**台账里真有会话 —— 没有会话就没有
        // 可打开的东西，给一个点了必然失败的站比不给更糟（与 run 目录同一口径）。
        const openSession =
          onOpenSession !== undefined && sessionId !== null
            ? () => onOpenSession(sessionId)
            : undefined;
        const handleKeyDown = (event: KeyboardEvent<SVGGElement>) => {
          if (openSession === undefined) return;
          if (event.key !== "Enter" && event.key !== " ") return;
          event.preventDefault();
          openSession();
        };
        const centerY = station.y + barHeight / 2;
        const workItemTitle =
          meta !== undefined && workItemTitles !== undefined
            ? (workItemTitles.get(meta.workItemId) ?? null)
            : null;
        const title = [
          ...(workItemTitle !== null ? [workItemTitle] : []),
          branchLabel,
          statusText(station.status),
          durationText(meta?.startAt ?? 0, meta?.endAt ?? null),
          ...(station.isLeaderTask ? [t("squad.runs.leader")] : []),
          ...(openSession ? [t("squad.timeline.openSessionTooltip")] : []),
        ].join(" · ");
        return (
          <g
            key={station.runId}
            data-run-id={station.runId}
            role={openSession === undefined ? undefined : "button"}
            tabIndex={openSession === undefined ? undefined : 0}
            className={openSession === undefined ? undefined : "cursor-pointer"}
            onClick={openSession}
            onKeyDown={openSession === undefined ? undefined : handleKeyDown}
          >
            <title>{title}</title>
            {/* 圆角条：填充用身份色（低不透明度），描边同色 —— 身份侧两端都在（§11.3）。 */}
            <rect
              x={station.x}
              y={station.y}
              width={station.width}
              height={barHeight}
              rx={4}
              fillOpacity={0.35}
              strokeWidth={station.isLeaderTask ? 2 : 1}
              className={cn(identityClassByLane.get(station.laneId), "fill-current stroke-current")}
              aria-hidden
            />
            {/* 开口站（`open` 原样来自模型）：右端用虚线端「吃掉」条帽 —— 还在继续，右端不是终点。 */}
            {station.open ? (
              <line
                x1={station.x + station.width}
                x2={station.x + station.width}
                y1={station.y}
                y2={station.y + barHeight}
                strokeDasharray="1 3"
                strokeWidth={1.5}
                className={cn(identityClassByLane.get(station.laneId), "stroke-current")}
                aria-hidden
              />
            ) : null}
            {/* 状态徽标：语义色 token（九色板不编码状态）。 */}
            <rect
              x={station.x + station.width - 7}
              y={centerY - 3}
              width={5}
              height={5}
              rx={1}
              className={cn(STATION_STATUS_CLASSES[station.status], "fill-current")}
              aria-hidden
            />
            {/* 条够宽才落状态文字（复用既有状态文案；更窄就只留徽标 + 悬停说明）。 */}
            {station.width >= SQUAD_TIMELINE_STATUS_TEXT_MIN_WIDTH ? (
              <text
                x={station.x + station.width - 11}
                y={centerY}
                textAnchor="end"
                dominantBaseline="central"
                className={cn("fill-current text-ui-xs", STATION_STATUS_CLASSES[station.status])}
                aria-hidden
              >
                {statusText(station.status)}
                {station.isLeaderTask ? ` · ${t("squad.runs.leader")}` : ""}
              </text>
            ) : null}
          </g>
        );
      })}

      {/* 弧线 = 派发关系，两种成色（**判据全在模型**；本层只按 arc.kind 选样式，不再判成因）：
          recorded（台账 0008 两列记着的派发）= **实线**；inferred（遗留行回落推断）= **虚线**。
          每条弧自带悬停说明，把「这条是哪种成色」说出来。 */}
      {layout.arcs.map((arc) => (
        <path
          key={`${arc.fromRunId}->${arc.toRunId}`}
          data-arc-from={arc.fromRunId}
          data-arc-to={arc.toRunId}
          data-arc-kind={arc.kind}
          d={`M ${arc.from.x} ${arc.from.y} Q ${arc.control.x} ${arc.control.y} ${arc.to.x} ${arc.to.y}`}
          fill="none"
          strokeDasharray={arc.kind === "leader_dispatch_inferred" ? "4 3" : undefined}
          strokeWidth={1.25}
          opacity={0.55}
          className="stroke-foreground-subtle"
          aria-hidden
        >
          <title>
            {arc.kind === "leader_dispatch_recorded"
              ? t("squad.timeline.recordedTooltip")
              : t("squad.timeline.inferredTooltip")}
          </title>
        </path>
      ))}
    </svg>
  );
}
