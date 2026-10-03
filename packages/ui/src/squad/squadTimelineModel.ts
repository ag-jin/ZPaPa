import type { SquadRunRecord, SquadRunStatus } from "@zcode/services";
import type { AgentColor, TeamAgent } from "@zcode/shared";
import { resolveSubagentColorFromName } from "@/lib/subagentColors.js";

/* 「活动时间线」（规格 §11.2）的**纯布局模型**：台账 + 名册 → 可断言的轨道/站点/弧线。
   不 import React、不 import UI 原语 —— ui 包没有渲染测试设施，几何的**判据**留在组件里
   就等于不可测；本文件只做投影，渲染层（下一轮）只负责把这里的数字画出来。

   视觉语言（§11.2）：**lane = 队员 / station = 一次运行 / 弧线 = 交接**。
   本模型**不复用** workflow 时间线组件的任何代码；身份色只用九色板
   （`SUBAGENT_COLORS` 一侧的 `resolveSubagentColorFromName`），状态只带**枚举值**由渲染层
   翻成语义状态色（模型不碰 i18n、不碰 class 名 —— 判据单一来源在 `squadRunStatusMessageId`）。

   三条输入纪律：
   · 数据是**历史**（服务面 `listSquadRuns` 的全量口径，含 merged / discarded）——只画活跃 run
     会让每次收尾把图上的一段静默抹掉；
   · 模型是**纯函数**：同输入同输出、不读时钟（「现在」由渲染层给，见 `TimelineStation.open`）；
   · `teamAgents` 查不到不是错误（agent 定义被删 / 归档的历史 run 也要画出来），回落见下。 */

/** 时间线的一个站点 = **一次运行**。开放/闭合的判据只在这里一处出现。 */
export type TimelineStation = {
  runId: string;
  /** 站点起点：`run.createdAt`（记录即真相，不取「读到它的时刻」）。 */
  startAt: number;
  /** 终点：**终态** run 取 `run.updatedAt`；活跃 run 为 `null`（开放站点，右端由渲染层延伸到「现在」）。 */
  endAt: number | null;
  /** 开放判据的唯一落点（`endAt === null`）：活跃 = 还没收尾。渲染层据它画开口的站点。 */
  open: boolean;
  /** 运行状态枚举（**由渲染层**经既有 `squadRunStatusMessageId` 翻词；模型不碰 i18n）。 */
  status: SquadRunStatus;
  isLeaderTask: boolean;
  /** 分支名；队长 run 没有分支 ⇒ `null`（与 `SquadRunDirectoryRow.branchLabel` 的回落**不同**：
      目录行回落 runId 是为了「总有一行字可显示」，时间线站点的分支是**事实字段**，没有就是没有）。 */
  branchLabel: string | null;
  workItemId: string;
  sessionId: string | null;
};

/** 一条 lane = 一位队员（或队长）在时间线上的固定行。 */
export type TimelineLane = {
  /** `run.agentId`。 */
  laneId: string;
  /** 显示名：查 `teamAgents` 的 `name`，查不到回落 `laneId`（同 `resolveTeamAgentName` 的规则，
      只是本层直接拿列表、不为了一个字段去构造 snapshot 对象）。 **不丢行**：查不到也要画。 */
  label: string;
  /** 身份色（九色板）：`agent.color`，未设 / 查不到按 label 稳定取色（不编码状态，§11.3）。 */
  color: AgentColor;
  /** 该 lane 上有任何 `isLeaderTask` 的站 ⇒ true（lane 顺序据此把队长置顶）。 */
  isLeaderLane: boolean;
  /** 按 `startAt ASC, runId ASC` 排序（与台账 `ORDER_BY_CREATED` 同一序，见 build 的注释）。 */
  stations: TimelineStation[];
};

/**
 * 一条弧 = 一次**交接**：`fromRunId`（队长 run）→ `toRunId`（队员 run）。
 *
 * ⚠️ **这是推断，不是台账里的边**（本轮最大的诚实点）：
 * · 台账 `squad_runs` **没有**「谁派生了谁」的列 —— 派发关系在现有数据里不存在；
 * · v1 的代理判据（见 buildSquadTimelineModel 第 ④ 步）：队员站取「**同批**
 *   （`parentWorkItemId` 相同）中、`isLeaderTask === true`、`createdAt <= 该队员站 createdAt`」
 *   里 `createdAt` 最大的那条队长站；
 * · **典型成立**（队长先起 run、再派单 —— 正常路径）；**不典型不成立**：
 *   手工在队长 run 之前起的队员 run 不会被画弧；两条队长 run 时间交叠时，归给**最近先前**的一条
 *   （未必是真正派它的那条）。
 * · 升级路径：要给真边就**给台账加一列**（派发时写入）或另存事件 —— 那需要迁移与写者，
 *   不在本轮的加法范围内。在此之前，渲染层**必须以「推断」呈现**（虚线 / 问号 / 图例说明，
 *   具体样式下一轮定），不得把它画成既成事实。
 * `kind` 是**字面量类型**：把「这是推断」钉进类型与用例 —— 将来真边落地时，
 * 它要么改类型（编译期拖出全部消费点），要么新增一种 kind（界面可以两者并存地显示）。
 */
export type TimelineArc = {
  fromRunId: string;
  toRunId: string;
  kind: "leader_dispatch_inferred";
};

export type SquadTimelineModel = {
  /** 队长 lane 最上；其余按该 lane 最早站的 `startAt` 升序，同刻按 `laneId`（见 build 第 ② 步）。 */
  lanes: TimelineLane[];
  arcs: TimelineArc[];
  /** 时间域：`startAt` = 最早站起点；`endAt` = `max(endAt ?? startAt)`（活跃站按 `startAt` 计
      —— **不引入 now**，模型必须纯：把「现在」塞进来会让同输入在不同时刻给出不同结果）。 */
  domain: { startAt: number; endAt: number };
};

/** 终态判据的**唯一落点**（`merged` / `discarded` = 已收尾）：活跃集合的补集，
    与 services 侧 `SQUAD_RUN_ACTIVE_STATUSES`（open / produced / rejected）互为对照。
    写成本文件的私有函数而不是各自 `status === "…"`：开放/闭合、端时刻都从它派生。 */
function isTerminalRunStatus(status: SquadRunStatus): boolean {
  return status === "merged" || status === "discarded";
}

/** runId 的字典序比较（代码单元序，与 SQLite TEXT 的 BINARY 排序一致 —— 与台账 `ORDER BY run_id` 同序）。 */
function compareRunId(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function toStation(run: SquadRunRecord): TimelineStation {
  const terminal = isTerminalRunStatus(run.status);
  return {
    runId: run.runId,
    startAt: run.createdAt,
    // 终态才闭合并取收尾时刻；活跃站**不取 updatedAt**（那只是「最近一次写台账」，不是终点 ——
    // 取它会把一条还在跑的站点画成闭合的短站，看上去像已经结束）。
    endAt: terminal ? run.updatedAt : null,
    open: !terminal,
    status: run.status,
    isLeaderTask: run.isLeaderTask,
    branchLabel: run.branch,
    workItemId: run.workItemId,
    sessionId: run.sessionId,
  };
}

function compareStations(a: TimelineStation, b: TimelineStation): number {
  return a.startAt - b.startAt || compareRunId(a.runId, b.runId);
}

/** lane 的排序键：队长 lane 优先（同类内按「最早队长站」的时间）；其余按最早站的 `startAt`。
    两类都再用 `laneId` 收尾 ⇒ 全序，输出与输入顺序无关。 */
function laneOrderKey(lane: TimelineLane): { leader: boolean; earliest: number } {
  const leaderStations = lane.stations.filter((station) => station.isLeaderTask);
  if (leaderStations.length > 0) {
    // stations 已排序 ⇒ 第一条队长站就是最早的队长站。
    return { leader: true, earliest: leaderStations[0]!.startAt };
  }
  return { leader: false, earliest: lane.stations[0]!.startAt };
}

/**
 * 台账 + 名册 → 时间线模型（纯函数：同输入两次调用结果**逐字一致**）。五条规则：
 *
 * ① **lane 归一**：每个出现过的 `agentId` 一条，名字 / 色查 `teamAgents`；查不到回落 `laneId`
 *    与按名字稳定取色 —— **不丢行**（agent 定义被删 / 归档的历史 run 也要画出来）。
 * ② **lane 顺序**：有队长站的 lane 最上（多个按最早队长站时间）；其余按该 lane 最早站的 `startAt`；
 *    全序 tie-break 用 `laneId`。队长置顶是**角色**语义（lane 不是「按时间先来后到」的排序，
 *    队长是这条时间线的「指挥行」，成员行随它展开）。
 * ③ **站点的开放 / 闭合**：终态（`merged` / `discarded`）⇒ `endAt = updatedAt`、`open = false`；
 *    其余（`open` / `produced` / `rejected`）⇒ `endAt = null`、`open = true`。活跃站**不取 now**：
 *    模型必须纯（同输入同输出），「现在」由渲染层给。
 * ④ **弧线（推断，见 `TimelineArc` 顶注）**：对每个**队员**站，取「同批 + `isLeaderTask` +
 *    `createdAt <= 该站 createdAt`」里 `createdAt` **最大**的那条队长站 ⇒ 一条
 *    `leader_dispatch_inferred` 弧；**找不到就不画**（不许编一条）。同刻队长站并列时取台账顺序里
 *    靠后的那条（`createdAt` 相同再按 `runId`，即 `ORDER_BY_CREATED` 的最后一条）——
 *    与「最近先前」的口径一致，且保证确定性。
 * ⑤ **容错**：同一 `runId` 重复 ⇒ 只取第一条（防御：坏数据不得把同一次运行画成两个站；
 *    「第一条」= 给定顺序里的第一条，确定性不依赖 Map 行为）；`teamAgents` 为空 ⇒ 全 lane
 *    回落 id + 稳定色（仍有 lane，见 ①）。
 *
 * 空输入：`lanes` / `arcs` 为空数组，`domain` 取 **`{startAt: 0, endAt: 0}`**（零长度域）。
 * 为什么不用 `null` 或 NaN：类型保持一对数（渲染层的每一处 `endAt - startAt` 缩放都不必加
 * 空分支）；NaN 是最坏的选项 —— 它静默产出一个空/黑 SVG 与非法的 style 值，而不是一个能看见的
 * 错误。空态的**权威判据是 `lanes.length === 0`**，`0/0` 只是让时间轴退化成零长度，不伪装成
 * 「有一条 0 点的数据」。
 */
export function buildSquadTimelineModel(input: {
  runs: SquadRunRecord[];
  teamAgents: TeamAgent[];
}): SquadTimelineModel {
  // ⑤ 去重（防御）：坏数据里同 runId 出现两次不得画成两个站 / 两条 lane 行。
  const seenRunIds = new Set<string>();
  const runs: SquadRunRecord[] = [];
  for (const run of input.runs) {
    if (seenRunIds.has(run.runId)) continue;
    seenRunIds.add(run.runId);
    runs.push(run);
  }

  // ① run → station，按 agentId 归 lane。
  const stationsByLane = new Map<string, TimelineStation[]>();
  for (const run of runs) {
    const station = toStation(run);
    const lane = stationsByLane.get(run.agentId);
    if (lane) {
      lane.push(station);
    } else {
      stationsByLane.set(run.agentId, [station]);
    }
  }

  const agentsById = new Map(input.teamAgents.map((agent) => [agent.id, agent]));
  const lanes: TimelineLane[] = [...stationsByLane.entries()].map(([laneId, stations]) => {
    stations.sort(compareStations);
    const agent = agentsById.get(laneId);
    const label = agent?.name ?? laneId;
    return {
      laneId,
      label,
      color: agent?.color ?? resolveSubagentColorFromName(label),
      isLeaderLane: stations.some((station) => station.isLeaderTask),
      stations,
    };
  });

  // ② lane 全序：队长 lane 最上 → 最早站时间 → laneId（tie-break）。
  lanes.sort((a, b) => {
    const keyA = laneOrderKey(a);
    const keyB = laneOrderKey(b);
    if (keyA.leader !== keyB.leader) return keyA.leader ? -1 : 1;
    return keyA.earliest - keyB.earliest || compareRunId(a.laneId, b.laneId);
  });

  // ④ 弧线：先把 run 归到台账顺序（created_at ASC, run_id ASC），再逐队员站找最近先前的队长站。
  const orderedRuns = [...runs].sort(
    (a, b) => a.createdAt - b.createdAt || compareRunId(a.runId, b.runId),
  );
  const leadersByBatch = new Map<string, SquadRunRecord[]>();
  for (const run of orderedRuns) {
    if (!run.isLeaderTask) continue;
    const leaders = leadersByBatch.get(run.parentWorkItemId);
    if (leaders) {
      leaders.push(run);
    } else {
      leadersByBatch.set(run.parentWorkItemId, [run]);
    }
  }
  const arcs: TimelineArc[] = [];
  for (const run of orderedRuns) {
    if (run.isLeaderTask) continue; // 队长站是弧的起点，不是终点。
    const leaders = leadersByBatch.get(run.parentWorkItemId);
    if (!leaders) continue;
    let dispatchedBy: SquadRunRecord | null = null;
    for (const leader of leaders) {
      // leaders 按台账顺序 ⇒ 循环到第一条「晚于本队员站」的队长站就停；
      // 停之前最后留下的那条正是「createdAt 最大且 <= 本队员站」的（同刻取台账靠后的）。
      if (leader.createdAt > run.createdAt) break;
      dispatchedBy = leader;
    }
    // 找不到先前队长 ⇒ **不画弧**：推断不出来就说不知道，不拿别的站凑一条假边。
    if (!dispatchedBy) continue;
    arcs.push({
      fromRunId: dispatchedBy.runId,
      toRunId: run.runId,
      kind: "leader_dispatch_inferred",
    });
  }

  // domain：活跃站按 startAt 计（不引入 now，见类型注释）。
  if (lanes.length === 0) {
    return { lanes: [], arcs: [], domain: { startAt: 0, endAt: 0 } };
  }
  let startAt = Number.POSITIVE_INFINITY;
  let endAt = Number.NEGATIVE_INFINITY;
  for (const lane of lanes) {
    for (const station of lane.stations) {
      startAt = Math.min(startAt, station.startAt);
      endAt = Math.max(endAt, station.endAt ?? station.startAt);
    }
  }
  return { lanes, arcs, domain: { startAt, endAt } };
}
