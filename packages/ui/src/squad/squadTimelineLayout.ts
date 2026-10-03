import type { SquadRunStatus } from "@zcode/services";
import type { AgentColor } from "@zcode/shared";
import type { SquadTimelineModel } from "./squadTimelineModel.js";

/* 「活动时间线」（规格 §11.2）的**纯几何**：布局模型 + 画布参数 → 可逐值断言的坐标。

   为什么再拆一层（模型 → 布局 → 渲染三段）：模型只回答「有哪些 lane / 站 / 弧、时间域多大」，
   渲染只回答「把这些数字画成 SVG」。缩放、最小宽、开口站的右端、弧的三点这些**算术**放在这里 ——
   ui 包没有渲染测试设施，算术留在组件里就等于不可测（照 squadTimelineModel 的既定理由）。

   三条纪律：
   · **不 import React**、不 import UI 原语、不碰 i18n / class 名 —— 纯函数，同输入同输出；
   · **不读时钟**：「现在」由渲染层经 `input.now` 给（模型不许带 now，见模型顶注）；
   · **弧不在本层重新推断**：只把 `model.arcs` 给的每条边翻成三点坐标（推断规则是模型的事，
     判据单一来源；本层若再推一次，两处判据迟早漂移而漂移不报错）。 */

/**
 * 站点条的**最小可见宽**（px）。
 *
 * 为什么需要它：零长度的站（`startAt === endAt`、或零长度域里的每个站）映射后宽度是 0 ——
 * 0 宽的 `rect` 在 SVG 里什么都不画，"这段时间有过一次运行"这个事实就静默消失了。
 * 下界保证任何站都至少是一条可见的细线。
 *
 * 为什么零长度域的站宽也**复用**这一个常数（而不是另定一个"固定宽"）：可见性的下界只该有
 * 一处定义。零长度域里所有站都落在 `padding.left`，宽度天然算出差 0，被同一个下界兜住 ——
 * 一条规则覆盖两种退化，没有第二份口径。
 */
export const SQUAD_TIMELINE_MIN_STATION_WIDTH = 2;

/**
 * 站点条在 lane 行内的**上下内边距**（px）。条顶 = `lane.y + 本值`；条高 = `laneHeight - 2 * 本值`
 * （渲染层用同一个常数求条高 —— 单源，避免"布局留了边距、渲染又按满行高清"这种两处口径）。
 * 留边距的理由：相邻 lane 的条不贴在一起，时间线才读得出"行"的结构。
 */
export const SQUAD_TIMELINE_STATION_INSET_Y = 4;

export type SquadTimelineLayoutInput = {
  model: SquadTimelineModel;
  /** 画布可用宽度（px）。 */
  width: number;
  /** 每条 lane 的行高（px）。 */
  laneHeight: number;
  /** 「现在」（渲染层给；模型不许带 now —— 见模型顶注）。 */
  now: number;
  /** 左/右内边距（给 lane 标签留位）。 */
  padding: { left: number; right: number };
};

export type SquadTimelineLayout = {
  width: number;
  height: number;
  /** `endAt = max(model.domain.endAt, now)`（开口站要伸到 now —— 见 `layoutSquadTimeline` 的缩放注释）。 */
  domain: { startAt: number; endAt: number };
  lanes: Array<{
    laneId: string;
    label: string;
    color: AgentColor;
    isLeaderLane: boolean;
    y: number;
  }>;
  stations: Array<{
    runId: string;
    laneId: string;
    x: number;
    y: number;
    width: number;
    /** 原样带出（模型已判）：渲染层据它画开口端帽，不重算。 */
    open: boolean;
    isLeaderTask: boolean;
    status: SquadRunStatus;
  }>;
  arcs: Array<{
    fromRunId: string;
    toRunId: string;
    kind: "leader_dispatch_inferred";
    /** 二次贝塞尔的三点（起点 = 队长站条右缘中点，终点 = 队员站条左缘中点，控制点 = x 取两站中点、y 取两 lane 中线）。 */
    from: { x: number; y: number };
    control: { x: number; y: number };
    to: { x: number; y: number };
  }>;
};

/**
 * 模型 + 画布参数 → 几何（纯函数：同输入两次调用结果逐字一致）。
 *
 * **缩放**：`x(t) = padding.left + (t - domain.startAt) / (domain.endAt - domain.startAt) * (width - padding.left - padding.right)`，
 * 其中 `domain.endAt = max(model.domain.endAt, now)`（模型不带 now，开口站的右端要伸到"现在"；
 * 域右端更晚时取域右端 —— 轴始终覆盖全部站与 now）。
 *
 * **零长度域**（`domain.endAt - domain.startAt <= 0`，例如单站且 `now === startAt`，或空模型且 now 为 0）：
 * **不做除法**（0/0 = NaN 会静默产出非法几何与空 SVG，而不是一个能看见的错误），走**固定映射**：
 * 所有站落 `x = padding.left`，宽度由最小站宽兜底。`<=` 而不是 `===`：负跨度只可能来自坏输入
 * （now 早于域起点），同样不值得一次除法。
 *
 * **站宽**：`[startAt, endAt ?? domain.endAt]` 映射后的差，下界 `SQUAD_TIMELINE_MIN_STATION_WIDTH`。
 * 闭合站取模型给的 `endAt`；开口站取**布局域的右端**（`max(域右端, now)`）—— 轴右端就是"还在继续"
 * 的读法，渲染层再据 `open` 吃开口端帽。注意：`now` 小于域右端时（别的站结束得更晚），开口站
 * 也画到域右端 —— 轴是按 `domain.endAt` 缩放的，"到 now 截断"会是第二种缩放规则，规格只要一条。
 *
 * **y**：`lanes[i].y = i * laneHeight`（无顶部偏移）；站的 `y = lane.y + SQUAD_TIMELINE_STATION_INSET_Y`
 * （条高由渲染层用同一常数算），即站的 y 与其 lane 对齐、条在行内留呼吸。
 *
 * **弧**：`from` 取队长站条的**右缘**（时间前进的方向、离开源站的一侧），`to` 取队员站条的**左缘**
 * （到达目标站的一侧），两点 y 都取条的中线（= lane 中线）；`control` = 两点中点（x 是两站中点、
 * y 是两条 lane 中线之间的中线 —— 因为 from/to 的 y 就在各自 lane 中线上，两者一平均就是中线）。
 * 不保证 `from.x <= to.x`（队长站还在跑、队员站已开始时会向左弯 —— 那是一条合法的时间交叠）。
 * 只翻 `model.arcs` 给的边，**不在本层重新推断**；端点站查不到（坏输入）就跳过这条弧（防御：
 * 坏数据不产生 NaN 坐标 —— 模型保证两端存在，这里只是不让违例静默成非法几何）。
 *
 * **空模型**（`lanes` 为空）：`height = 0`、站/弧为空；`domain` 仍按同一条式子给（不特判 ——
 * 没有任何几何消费它，`height = 0` 让空态在渲染层自然成为"没有可画的行"）。
 */
export function layoutSquadTimeline(input: SquadTimelineLayoutInput): SquadTimelineLayout {
  const { model, width, laneHeight, now, padding } = input;

  const domain = { startAt: model.domain.startAt, endAt: Math.max(model.domain.endAt, now) };
  const span = domain.endAt - domain.startAt;
  const drawable = width - padding.left - padding.right;

  // 时间 → x。零长度域走固定映射（见顶注）：绝不出现 0/0。
  const mapX = (time: number): number =>
    span > 0 ? padding.left + ((time - domain.startAt) / span) * drawable : padding.left;

  const lanes: SquadTimelineLayout["lanes"] = [];
  const stations: SquadTimelineLayout["stations"] = [];
  // runId → 已算好的站（弧端点直接引用，不重算 —— 重算就是第二份坐标口径）。
  const stationsByRunId = new Map<string, SquadTimelineLayout["stations"][number]>();

  model.lanes.forEach((lane, index) => {
    const y = index * laneHeight;
    lanes.push({
      laneId: lane.laneId,
      label: lane.label,
      color: lane.color,
      isLeaderLane: lane.isLeaderLane,
      y,
    });
    for (const station of lane.stations) {
      const x = mapX(station.startAt);
      // 开口站伸到布局域右端（= max(域右端, now)）；闭合站取模型的终态时刻（坏数据里
      // endAt 早于 startAt 时差为负，同样被最小宽兜住）。
      const endAt = station.open ? domain.endAt : (station.endAt ?? station.startAt);
      const stationLayout = {
        runId: station.runId,
        laneId: lane.laneId,
        x,
        y: y + SQUAD_TIMELINE_STATION_INSET_Y,
        width: Math.max(SQUAD_TIMELINE_MIN_STATION_WIDTH, mapX(endAt) - x),
        open: station.open,
        isLeaderTask: station.isLeaderTask,
        status: station.status,
      };
      stations.push(stationLayout);
      stationsByRunId.set(station.runId, stationLayout);
    }
  });

  /** 站条的中线 y：站顶 + 条高一半。上下内边距对称 ⇒ 它就等于 lane 中线。 */
  const barCenterY = (stationY: number) =>
    stationY - SQUAD_TIMELINE_STATION_INSET_Y + laneHeight / 2;

  const arcs: SquadTimelineLayout["arcs"] = [];
  for (const arc of model.arcs) {
    const from = stationsByRunId.get(arc.fromRunId);
    const to = stationsByRunId.get(arc.toRunId);
    if (!from || !to) continue; // 防御：端点在图上不存在就跳过（不编坐标）。
    // 起点取源条**右缘**（时间前进的方向、离开队长站的一侧）；终点取目标条**左缘**（到达队员站的一侧）。
    const fromPoint = { x: from.x + from.width, y: barCenterY(from.y) };
    const toPoint = { x: to.x, y: barCenterY(to.y) };
    arcs.push({
      fromRunId: arc.fromRunId,
      toRunId: arc.toRunId,
      kind: arc.kind,
      from: fromPoint,
      control: { x: (fromPoint.x + toPoint.x) / 2, y: (fromPoint.y + toPoint.y) / 2 },
      to: toPoint,
    });
  }

  return {
    width,
    height: lanes.length * laneHeight,
    domain,
    lanes,
    stations,
    arcs,
  };
}
