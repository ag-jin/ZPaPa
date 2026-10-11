/**
 * 指引面（guide 面）的只读投影（卡 #136 / C3-1）。
 *
 * 边界（消费契约 §13.6；AD-11①③）：
 * - 视图不写板文件、不解析真相源、不自算 `stage`/`attention`；
 * - 五槽计数与计划内卡行**直取编译器四段派生投影与板字段**（成员/顺序/计数照读：
 *   不重排、不改判据、不合并节点）——「需处理」取 `attentionSummary`（板字段），
 *   「阻塞/运行/待收口/最近活动」取 `blocked[]`/`active[]`/`recent[]`；
 * - 板缺四段（旧版编译器产物）→ 槽值未知（`count=null`）并指名重编译，**不按卡字段自算兜底**；
 * - 计划进度计数（已完成卡/总卡）= 该特性 `tasks` 子树里编译器产出的 `status` 计数
 *   （卡字段直读；不重推状态：总数走四视图组头的既有单点 `countBoardFeatureTasks`，
 *   完成数只筛 `status === "completed"`）。每行/每槽的文件点都收敛在本模块与
 *   `boardGuideParts`，后续卡（#138 队列 / #139 胶囊）复用同一投影，禁二份口径。
 *
 * 展示口径（itw-20261011-9003 视觉准入 + E7 §3.1/§4.2 设计面）：
 * - 五槽条 = 主数 + 短解释；零值槽仍有明确文案（不消失、不留空壳）；
 * - 计划区块 = 「名 + 已完成/总卡 + 微条」一行 + 「段位 + 期次 + 前沿/在途」摘要行 +
 *   前沿行入口（该计划在四段投影里的成员卡，frontier 序在前、active 序在后，行数有上限）；
 * - 行数上限 `GUIDE_PLAN_ROW_LIMIT`：L1 只给入口，完整队列归 C3-3（#138），裁剪量由
 *   `hiddenRows` 显式表达（不静默丢）。
 */
import { groupBoardFeaturesByEpic } from "./boardEpicContainers.js";
import {
  collectBoardViewNodes,
  countBoardFeatureTasks,
  type BoardViewNode,
} from "./boardViewsViewModel.js";
import type { BoardTaskNode, BoardViewModel } from "./boardViewModel.js";

/** 五槽键（**闭集**：顺序即呈现顺序——需处理/阻塞/运行/待收口/最近活动）。 */
export type BoardGuideSlotKey = "attention" | "blocked" | "running" | "review" | "recent";

export const BOARD_GUIDE_SLOT_KEYS: readonly BoardGuideSlotKey[] = [
  "attention",
  "blocked",
  "running",
  "review",
  "recent",
];

/** 「运行/待收口」两槽的 active 段位判别值（同源于编译器 stage 词表，不新增词汇）。 */
const GUIDE_RUNNING_STAGE = "执行中";
const GUIDE_REVIEW_STAGE = "审核中";

/** 计划区块每计划的上前沿行数上限（完整队列归 C3-3/#138；L1 只给入口）。 */
export const GUIDE_PLAN_ROW_LIMIT = 3;

export interface BoardGuideSlot {
  key: BoardGuideSlotKey;
  /** 计数；`null` = 板上四段缺失（未知，不猜）。 */
  count: number | null;
}

/** 计划内卡行（五槽/计划区块的「入口」）：身份取四段条目，视图节点 id 由板面卡号解析。 */
export interface BoardGuideCardRow {
  /** 视图节点 id（`task:<no>`）——卡片弹窗路由的既有锚点值。 */
  id: string;
  no: number;
  /** 板面卡层级 label（显示层；与视图节点同源，不另算）。 */
  label: string | null;
  title: string;
  stage: string | null;
  nextAssignee: string | null;
  /** 来自哪一段（frontier 行在前、active 行在后，段内保板序）。 */
  source: "frontier" | "active";
}

export interface BoardGuidePlan {
  featureId: string;
  no: number | null;
  label: string | null;
  planCode: string | null;
  title: string;
  stage: string | null;
  /** 板字段 `status === "active"`（活跃计划置顶的排序键；不在视图侧自算活跃度）。 */
  statusActive: boolean;
  /** 期次合成名（AD-3 单点 `phaseDisplayName`；无归属 → null）。 */
  phaseName: string | null;
  /** 已完成卡数（`status === "completed"`，含嵌套子卡）。 */
  completed: number;
  /** 总卡数（含嵌套子卡；0 = 未拆解）。 */
  total: number;
  /** 本计划在 frontier[] 的成员数（四段投影计数）。 */
  frontierCount: number;
  /** 本计划在 active[] 的成员数（四段投影计数）。 */
  activeCount: number;
  /** 展示的卡行（≤ GUIDE_PLAN_ROW_LIMIT）。 */
  rows: BoardGuideCardRow[];
  /** 被上限裁掉的卡行数（0 = 全部展示；数值显式，不静默丢）。 */
  hiddenRows: number;
}

export interface BoardGuideSummary {
  /** 四段齐备（旧板 false → 槽值未知 + 指名重编译）。 */
  indexAvailable: boolean;
  slots: BoardGuideSlot[];
  plans: BoardGuidePlan[];
  /** 最近活动最新一条的时刻（recent[] 首条；无 → null）。 */
  latestActivityAt: string | null;
}

/** 已完成卡计数（`status === "completed"`，含嵌套子卡；只筛编译器产出字段，不重推状态）。 */
function countCompletedTasks(tasks: BoardTaskNode[]): number {
  let completed = 0;
  const walk = (list: BoardTaskNode[]) => {
    for (const task of list) {
      if (task.status === "completed") completed += 1;
      walk(task.children);
    }
  };
  walk(tasks);
  return completed;
}

/** 特性 → 期次合成名映射（复用 A4 归组单点：期次名/归组判据不在这里重写）。 */
function buildPhaseNameMap(board: BoardViewModel): Map<string, string> {
  const map = new Map<string, string>();
  for (const group of groupBoardFeaturesByEpic(board).epics) {
    for (const phase of group.phases) {
      for (const feature of phase.features) map.set(feature.id, phase.name);
    }
  }
  return map;
}

/** 计划内卡号集合（只读板面卡字段；用于把四段成员归到计划）。 */
function collectPlanCardNos(tasks: BoardTaskNode[]): Set<number> {
  const nos = new Set<number>();
  const walk = (list: BoardTaskNode[]) => {
    for (const task of list) {
      if (task.no !== null) nos.add(task.no);
      walk(task.children);
    }
  };
  walk(tasks);
  return nos;
}

/**
 * 指引面投影（纯函数）：五槽 + 计划区块。计划 = `kind === "plan"` 且非 cancelled——
 * `status === "active"` 的活跃计划置顶（组内保持板序，不重排）。
 */
export function buildBoardGuideSummary(board: BoardViewModel): BoardGuideSummary {
  const index = board.derivedIndex;
  const indexAvailable = index !== null;
  const counts: Record<BoardGuideSlotKey, number> = {
    attention:
      board.attentionSummary.interviewedNotArranged +
      board.attentionSummary.arrangedNotExpanded +
      board.attentionSummary.interruptedResume +
      board.attentionSummary.unmergedWorktree,
    blocked: index?.blocked.length ?? 0,
    running: index?.active.filter((entry) => entry.stage === GUIDE_RUNNING_STAGE).length ?? 0,
    review: index?.active.filter((entry) => entry.stage === GUIDE_REVIEW_STAGE).length ?? 0,
    recent: index?.recent.length ?? 0,
  };
  const slots = BOARD_GUIDE_SLOT_KEYS.map((key) => ({
    key,
    count: indexAvailable ? counts[key] : null,
  }));

  const nodeByNo = new Map<number, BoardViewNode>();
  for (const node of collectBoardViewNodes(board)) {
    if (node.kind === "task" && node.no !== null && !nodeByNo.has(node.no)) {
      nodeByNo.set(node.no, node);
    }
  }
  const phaseNames = buildPhaseNameMap(board);

  const plans = board.features
    .filter((feature) => feature.kind === "plan" && feature.status !== "cancelled")
    .map((feature) => {
      const cardNos = collectPlanCardNos(feature.tasks);
      const frontierRows = (index?.frontier ?? []).filter((entry) => cardNos.has(entry.no));
      const activeRows = (index?.active ?? []).filter((entry) => cardNos.has(entry.no));
      const rows: BoardGuideCardRow[] = [
        ...frontierRows.map((entry) => ({
          id: nodeByNo.get(entry.no)?.id ?? `task:${entry.no}`,
          no: entry.no,
          label: nodeByNo.get(entry.no)?.label ?? null,
          title: entry.title,
          stage: entry.stage,
          nextAssignee: entry.nextAssignee,
          source: "frontier" as const,
        })),
        ...activeRows.map((entry) => ({
          id: nodeByNo.get(entry.no)?.id ?? `task:${entry.no}`,
          no: entry.no,
          label: nodeByNo.get(entry.no)?.label ?? null,
          title: entry.title,
          stage: entry.stage,
          nextAssignee: entry.nextAssignee,
          source: "active" as const,
        })),
      ];
      const progress = {
        // 总卡数 = 四视图组头 `[N 张卡]` 的既有单点（前序遍历一份，卡数不漂移）。
        total: countBoardFeatureTasks(feature),
        completed: countCompletedTasks(feature.tasks),
      };
      return {
        featureId: feature.id,
        no: feature.no,
        label: feature.label,
        planCode: feature.planCode,
        title: feature.title,
        stage: feature.stage,
        // 活跃口径 = 板字段 `status === "active"`（卡文「活跃计划置顶（status=active 特性）」；
        // 视图不自算活跃度——段位在摘要行呈现，不参与排序）。
        statusActive: feature.status === "active",
        phaseName: phaseNames.get(feature.id) ?? null,
        completed: progress.completed,
        total: progress.total,
        frontierCount: frontierRows.length,
        activeCount: activeRows.length,
        rows: rows.slice(0, GUIDE_PLAN_ROW_LIMIT),
        hiddenRows: Math.max(0, rows.length - GUIDE_PLAN_ROW_LIMIT),
      };
    })
    // 活跃计划置顶（稳定排序：同组保持板序不变——不重排是对板序纪律的同一姿态）。
    .sort((left, right) => (left.statusActive ? 0 : 1) - (right.statusActive ? 0 : 1));

  return {
    indexAvailable,
    slots,
    plans,
    latestActivityAt: index?.recent[0]?.at ?? null,
  };
}
