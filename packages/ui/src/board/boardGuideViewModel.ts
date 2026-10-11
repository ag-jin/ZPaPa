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
 *   完成数只筛 `status === "completed"`）；rollup 缺口计数（#139/AD-6）同源 A4 单点
 *   `boardLayerGapCount`（成员卡 attention 码条数之和），不重造判据。每行/每槽的文件点都
 *   收敛在本模块与 `boardGuideParts`，后续卡（#138 队列 / #139 胶囊）复用同一投影，禁二份口径。
 *
 * 展示口径（itw-20261011-9003 视觉准入 + E7 §3.1/§4.2 设计面）：
 * - 五槽条 = 主数 + 短解释；零值槽仍有明确文案（不消失、不留空壳）；
 * - 计划区块 = 「名 + 已完成/总卡 + 微条」一行 + 「段位 + 期次 + 前沿/在途」摘要行 +
 *   可执行前沿队列（卡 #138/C3-3：该计划在四段投影里的 frontier 成员**全量**，frontier 序直读；
 *   在途卡不入队列——队列 = 可执行卡）；计划块排序 = 活跃置顶（板字段 status）→ 期次序
 *   （A4 单点比较器 `compareBoardPhaseOrder`）→ 板序（稳定排序保序），禁二份实现。
 */
import {
  boardLayerGapCount,
  compareBoardPhaseOrder,
  groupBoardFeaturesByEpic,
} from "./boardEpicContainers.js";
import {
  collectBoardViewNodes,
  countBoardFeatureTasks,
  EMPTY_BOARD_LIST_CONTROLS,
  type BoardListControls,
  type BoardViewMode,
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

export interface BoardGuideSlot {
  key: BoardGuideSlotKey;
  /** 计数；`null` = 板上四段缺失（未知，不猜）。 */
  count: number | null;
}

/**
 * 可执行前沿队列行（卡 #138/C3-3）：身份取四段条目，视图节点 id 由板面卡号解析；
 * 处置指引（接手位/已解除依赖）**直读 frontier 条目字段**，不在视图侧重推。
 */
export interface BoardGuideQueueRow {
  /** 视图节点 id（`task:<no>`）——卡片弹窗路由的既有锚点值。 */
  id: string;
  no: number;
  /** 板面卡层级 label（显示层；与视图节点同源，不另算）。 */
  label: string | null;
  title: string;
  stage: string | null;
  /** 处置指引：接手位（`frontier.nextAssignee` 直读；`null` = 板面未指派，不猜）。 */
  nextAssignee: string | null;
  /** 已解除依赖稳定号（`frontier.resolvedDeps` 直读；空数组 = 无依赖或引用缺号）。 */
  resolvedDeps: number[];
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
  /** 板字段期次序（`phase`；`null` = 无归属）——排序复用 A4 单点比较器，不在视图侧重推。 */
  phase: number | null;
  /** 期次合成名（AD-3 单点 `phaseDisplayName`；无归属 → null）。 */
  phaseName: string | null;
  /** 已完成卡数（`status === "completed"`，含嵌套子卡）。 */
  completed: number;
  /** 总卡数（含嵌套子卡；0 = 未拆解）。 */
  total: number;
  /** 该计划成员卡的 rollup 缺口计数（attention 码条数之和；A4 单点 `boardLayerGapCount`）。 */
  gapCount: number;
  /** 本计划在 frontier[] 的成员数（四段投影计数；= 队列行数）。 */
  frontierCount: number;
  /**
   * 本计划在 active[] 的成员数（四段投影计数）；`null` = 薄索引面（四段派生 active[] 不在
   * INDEX 字段面，#219/D6）——视图不渲染「在途」，不拿未知当 0。
   */
  activeCount: number | null;
  /** 可执行前沿队列（frontier 成员全量，frontier 序直读；在途卡不入队列）。 */
  queue: BoardGuideQueueRow[];
}

export interface BoardGuideSummary {
  /** 四段齐备（旧板 false → 槽值未知 + 指名重编译）。 */
  indexAvailable: boolean;
  slots: BoardGuideSlot[];
  plans: BoardGuidePlan[];
  /** 最近活动最新一条的时刻（recent[] 首条；无 → null）。 */
  latestActivityAt: string | null;
}

/* ---------------- 槽下钻路由与激活判据（卡 #137 / C3-2） ---------------- */

/**
 * 槽下钻的落点（**既有视图 + 既有过滤/排序**，禁第二路由）：`mode` 走宿主的既有视图切换；
 * `controls` 是既有 `BoardListControls` 的完整取值（仅列表/表格目标给——看板目标不消费列表控制，
 * 给了反而把用户没选的排序写进会话记忆）。显式给全量控制 = 落点确定（不吃上一次留下的筛子）。
 *
 * 字段名用中性 `mode` 而非 `viewMode`：板域有源码守卫（`boardViewModeMemory.test.ts`）禁
 * `viewMode: "<视图名>"` 字面量，防「默认视图」在第二处写死；本表是**显式落点**、不是缺省，
 * 换中性名让守卫继续只盯缺省面（`DEFAULT_BOARD_VIEW_MODE` 仍是唯一缺省所有者）。
 */
export interface BoardGuideSlotDrilldown {
  mode: BoardViewMode;
  controls?: BoardListControls;
}

/**
 * 五槽 → 落点的唯一映射（卡 #137；派发落点口径 + 板数据可达性「就近」；`Record` 穷尽：
 * 槽闭集加值在编译期报缺）：
 * - `attention`（需处理）→ 看板列：四码 attention 是逐卡角标信号、跨段位分布，且**没有**
 *   单码筛能覆盖「四码合计」（板字段只给合计不给集合）——看板是能逐列扫这些卡的既有视图；
 * - `blocked`（阻塞）→ 表格（受阻清单形态）：既有表格默认列含「受阻」列，受阻卡逐行可读；
 *   列表/看板的筛子（段位/状态/缺口码/类型）都不能表达 `blocked[]` 归因段（一卡多行），
 *   硬套段位筛会把「阻塞槽计数 ≠ 落点集合」的错配固化成假对应；
 * - `running`/`review`（运行/待收口）→ 列表 + 段位筛（执行中/审核中）——段位是这两个槽的
 *   同一判据（`active[]` 段位子集），既有筛子直接可达；
 * - `recent`（最近活动）→ 列表 + 最近视角（`recent` 排序）——「最近视图」是既有排序视角。
 * 落点两两不同（浏览器断言要能逐槽分辨）；本表不读板、不改任何判据（计数仍归 `buildBoardGuideSummary`）。
 */
const BOARD_GUIDE_SLOT_DRILLDOWN: Record<BoardGuideSlotKey, BoardGuideSlotDrilldown> = {
  attention: { mode: "kanban" },
  blocked: { mode: "table", controls: EMPTY_BOARD_LIST_CONTROLS },
  running: {
    mode: "list",
    controls: { ...EMPTY_BOARD_LIST_CONTROLS, stage: GUIDE_RUNNING_STAGE },
  },
  review: {
    mode: "list",
    controls: { ...EMPTY_BOARD_LIST_CONTROLS, stage: GUIDE_REVIEW_STAGE },
  },
  recent: { mode: "list", controls: EMPTY_BOARD_LIST_CONTROLS },
};

/** 落点查询（返回拷贝：共享表不被调用方改写；控制对象同为拷贝）。 */
export function boardGuideSlotDrilldownTarget(slot: BoardGuideSlotKey): BoardGuideSlotDrilldown {
  const target = BOARD_GUIDE_SLOT_DRILLDOWN[slot];
  return {
    mode: target.mode,
    ...(target.controls ? { controls: { ...target.controls } } : {}),
  };
}

/** 槽激活结果：`drill` = 下钻；`empty` = 空态指引（不跳）；`none` = 无落点（不跳，不缺省猜）。 */
export type BoardGuideSlotActivation = "drill" | "empty" | "none";

/**
 * 槽激活判据（单点；卡文验收「零 attention 槽点击有明确空态指引（不落死跳转）」+ §13.6 缺四段）：
 * - `count > 0` → `drill`；
 * - `count === 0` → `empty`（显式零，给空态指引，**不**跳到空集合）；
 * - `count === null` → `none`（旧板缺四段 = 未知；重编译提示已点名，不拿未知当空、也不猜集合）。
 * 判据只吃投影出来的 `count`（板字段/四段派生），不碰节点字段（禁自算）。
 */
export function boardGuideSlotActivation(slot: BoardGuideSlot): BoardGuideSlotActivation {
  if (slot.count === null) return "none";
  return slot.count > 0 ? "drill" : "empty";
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

/** 计划子树内的卡节点（前序遍历一份；卡号集合与缺口 rollup 都从这里派生，不各走一遍）。 */
function collectPlanCardNodes(tasks: BoardTaskNode[]): BoardTaskNode[] {
  const nodes: BoardTaskNode[] = [];
  const walk = (list: BoardTaskNode[]) => {
    for (const task of list) {
      nodes.push(task);
      walk(task.children);
    }
  };
  walk(tasks);
  return nodes;
}

/**
 * 指引面投影（纯函数）：五槽 + 计划区块。计划 = `kind === "plan"` 且非 cancelled——
 * 计划块排序 = 活跃置顶（板字段 `status`）→ 期次序（A4 单点 `compareBoardPhaseOrder`）
 * → 无期次殿后；同键由稳定排序保板序（三键口径见排序处注释）。
 */
export function buildBoardGuideSummary(board: BoardViewModel): BoardGuideSummary {
  const index = board.derivedIndex;
  // 五槽数据源（#219/D6）：旧面走四段派生 `derivedIndex`；v3 薄索引面 `derivedIndex` 为 null 时
  // 以 `screen` 五槽计数兜（契约 §15.2 单点口径）——两源都不在才判「未知」（指名重编译）。
  const screen = board.screen;
  const indexAvailable = index !== null || screen !== null;
  const counts: Record<BoardGuideSlotKey, number> =
    index !== null
      ? {
          attention:
            board.attentionSummary.interviewedNotArranged +
            board.attentionSummary.arrangedNotExpanded +
            board.attentionSummary.interruptedResume +
            board.attentionSummary.unmergedWorktree,
          blocked: index.blocked.length,
          running: index.active.filter((entry) => entry.stage === GUIDE_RUNNING_STAGE).length,
          review: index.active.filter((entry) => entry.stage === GUIDE_REVIEW_STAGE).length,
          recent: index.recent.length,
        }
      : screen !== null
        ? {
            attention: screen.attention,
            blocked: screen.blocked,
            running: screen.running,
            review: screen.review,
            recent: screen.recent,
          }
        : { attention: 0, blocked: 0, running: 0, review: 0, recent: 0 };
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
  // 前沿段数据源（#219/D6）：旧面取 `derivedIndex.frontier`；薄索引面取 `board.frontier`（同形投影）。
  const frontierIndex = index?.frontier ?? board.frontier ?? [];
  const activeIndex = index?.active ?? [];

  const plans = board.features
    .filter((feature) => feature.kind === "plan" && feature.status !== "cancelled")
    .map((feature) => {
      const cardNodes = collectPlanCardNodes(feature.tasks);
      const cardNos = new Set<number>();
      for (const node of cardNodes) if (node.no !== null) cardNos.add(node.no);
      const frontierRows = frontierIndex.filter((entry) => cardNos.has(entry.no));
      const activeRows = activeIndex.filter((entry) => cardNos.has(entry.no));
      // 可执行前沿队列（卡 #138/C3-3）：frontier 成员全量、frontier 序直读（不重排、不裁剪、不含
      // active 行——队列 = 该计划的可执行卡）；处置指引（接手位/已解除依赖）直取条目字段。
      const queue: BoardGuideQueueRow[] = frontierRows.map((entry) => ({
        id: nodeByNo.get(entry.no)?.id ?? `task:${entry.no}`,
        no: entry.no,
        label: nodeByNo.get(entry.no)?.label ?? null,
        title: entry.title,
        stage: entry.stage,
        nextAssignee: entry.nextAssignee,
        resolvedDeps: [...entry.resolvedDeps],
      }));
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
        // 期次序 = 板字段 `phase`（排序键；比较走 A4 单点，不在视图侧合成）。
        phase: feature.phase,
        phaseName: phaseNames.get(feature.id) ?? null,
        completed: progress.completed,
        total: progress.total,
        // rollup 缺口（#139/AD-6）= 成员卡 attention 码条数之和——A4 单点 `boardLayerGapCount`
        // 同一判据（层 rollup = 成员 attention 求和）；只数成员卡，不数计划自身（自身信号
        // 归角标簇），也不排除嵌套子卡。
        gapCount: boardLayerGapCount(cardNodes),
        frontierCount: frontierRows.length,
        // 在途计数（#219/D6）：薄索引面（derivedIndex=null）四段派生 active[] 不在索引字段面 → null
        // （视图不渲染「在途」，不拿未知当 0）；旧面路径照常给数。
        activeCount: index !== null ? activeRows.length : null,
        queue,
      };
    })
    // 计划块（队列分组）排序（卡 #138/C3-3；三键，稳定排序保板序）：
    // ① 活跃计划置顶（#136 既有口径：板字段 `status === "active"`）；
    // ② 有期次者按纯期次序升序——比较只调 A4 单点 `compareBoardPhaseOrder`（禁二份实现）；
    // ③ 无期次（无归属）计划在期次轴外：殿后并按板序保持（不重排是板序纪律的同一姿态）。
    // 同键（同活跃档/同期次/同无期次）一律保持板序不变。
    .sort((left, right) => {
      const activeDelta = (left.statusActive ? 0 : 1) - (right.statusActive ? 0 : 1);
      if (activeDelta !== 0) return activeDelta;
      if (left.phase !== null && right.phase !== null) {
        return compareBoardPhaseOrder(left.phase, right.phase);
      }
      if (left.phase !== null) return -1;
      if (right.phase !== null) return 1;
      return 0;
    });

  return {
    indexAvailable,
    slots,
    plans,
    latestActivityAt: index?.recent[0]?.at ?? null,
  };
}
