/**
 * 看板视图的纯函数层（卡 #33：看板列视图 + 列表视图）。
 *
 * 边界（消费契约 §13.6）：视图不写任何板文件、不解析真相源、**不自算 `stage`/`attention`**；
 * 本模块只做「视图模型 → 列/行」的分组、排序与过滤，全部字段读 board.json 映射结果。
 *
 * 单一真源：
 * - §13.2 视图矩阵：四视图共用同一 board.json、同一节点集合与同一段位派生；视图差异只在呈现层。
 * - §13.3 待设计列 = interview-only 聚合子区。
 * - §3.5 排序：attention 项置顶，其余按 updatedAt 倒序；「最老未动」是第二视角。
 */
import {
  BOARD_STAGES,
  isBoardAttentionCode,
  isBoardStatusValue,
  type BoardAttentionCode,
  type BoardOrigin,
  type BoardPr,
  type BoardStage,
  type BoardStatusValue,
} from "./boardViewModel.js";
import type {
  BoardActiveRun,
  BoardBlocker,
  BoardFeatureNode,
  BoardLastRun,
  BoardProgress,
  BoardTaskNode,
  BoardViewModel,
} from "./boardViewModel.js";

/**
 * 视图节点（四视图共用）：特性节点与任务卡在同一集合里，`kind` 只用于呈现分组标记，
 * 不合并节点、不改字段（§13.2）。字段一律是 board.json 的只读映射结果（含弹窗/表格所需：
 * `details`/`blockers`/`origin`/`evidence`/`createdAt`/`pr`/`assignees`，契约 §6/§13.5）。
 */
export interface BoardViewNode {
  id: string;
  kind: "feature" | "task";
  /** 特性节点的 `kind`（spec / plan / interview-only）；任务卡为 null。 */
  featureKind: string | null;
  no: number | null;
  label: string | null;
  /** 计划码（#46 B1）：任务节点从所属特性继承（显示层）；无 → null。 */
  planCode: string | null;
  title: string;
  details: string | null;
  status: string | null;
  statusRule: string | null;
  stage: string | null;
  attention: BoardAttentionCode[];
  blockers: BoardBlocker[];
  assignees: string[];
  /** 当前执行者（#46 A3/B6）：管线 ∩ activeRun；无 → null。 */
  currentAssignee: string | null;
  /** 计划稿章节（#46 B2）：仅计划任务可能非空。 */
  section: string | null;
  /** 结构深度（0 = 特性；1 = 其下第一层任务；呈现缩进用，不信 label 段数）。 */
  depth: number;
  origin: BoardOrigin | null;
  evidence: string[];
  activeRun: BoardActiveRun | null;
  lastRun: BoardLastRun | null;
  worktree: string | null;
  pr: BoardPr | null;
  createdAt: string | null;
  updatedAt: string | null;
  progress: BoardProgress | null;
  draft: boolean;
}

function featureViewNode(feature: BoardFeatureNode): BoardViewNode {
  return {
    id: feature.id,
    kind: "feature",
    featureKind: feature.kind,
    no: feature.no,
    label: feature.label,
    planCode: feature.planCode,
    title: feature.title,
    details: feature.details,
    status: feature.status,
    statusRule: feature.statusRule,
    stage: feature.stage,
    attention: feature.attention,
    // 特性级字段照实搬（有 blockers 就带）：不猜、不借子树的值（§13.2 各格按节点自身字段呈现）。
    blockers: feature.blockers,
    assignees: feature.assignees,
    currentAssignee: feature.currentAssignee,
    section: null,
    depth: 0,
    origin: feature.origin,
    evidence: feature.evidence,
    // 特性级没有 run/worktree/pr 字段：不猜、不借子树的值。
    activeRun: null,
    lastRun: null,
    worktree: null,
    pr: null,
    createdAt: feature.createdAt,
    updatedAt: feature.updatedAt,
    progress: feature.progress,
    draft: false,
  };
}

function taskViewNode(task: BoardTaskNode, owner: BoardFeatureNode): BoardViewNode {
  return {
    id: task.id,
    kind: "task",
    featureKind: null,
    no: task.no,
    label: task.label,
    // 任务不携带 planCode 字段：显示层从所属特性继承（UI01-1.2 的完整形态同源）。
    planCode: owner.planCode,
    title: task.title,
    details: task.details,
    status: task.status,
    statusRule: task.statusRule,
    stage: task.stage,
    attention: task.attention,
    blockers: task.blockers,
    assignees: task.assignees,
    currentAssignee: task.currentAssignee,
    section: task.section,
    depth: task.depth,
    origin: task.origin,
    evidence: task.evidence,
    activeRun: task.activeRun,
    lastRun: task.lastRun,
    worktree: task.worktree,
    pr: task.pr,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
    progress: null,
    draft: task.draft,
  };
}

/** 同一个节点集合（§13.2）：特性节点在前、其任务卡按文档序前序展开（含嵌套子卡）。 */
export function collectBoardViewNodes(board: BoardViewModel): BoardViewNode[] {
  const nodes: BoardViewNode[] = [];
  const walkTasks = (tasks: BoardTaskNode[], owner: BoardFeatureNode) => {
    for (const task of tasks) {
      nodes.push(taskViewNode(task, owner));
      walkTasks(task.children, owner);
    }
  };
  for (const feature of board.features) {
    nodes.push(featureViewNode(feature));
    walkTasks(feature.tasks, feature);
  }
  return nodes;
}

/**
 * 特性分组视图节点（#46 B3/B4）：每组 = 特性头 + 其任务卡（文档序前序，含嵌套子卡）。
 * 列表/表格的分组行与看板的分组头共用这一份形态（分组只是呈现，节点字段一字不改）。
 */
export function collectBoardFeatureGroups(
  board: BoardViewModel,
): Array<{ feature: BoardViewNode; nodes: BoardViewNode[] }> {
  return board.features.map((feature) => ({
    feature: featureViewNode(feature),
    nodes: collectFeatureTaskNodes(feature),
  }));
}

function collectFeatureTaskNodes(feature: BoardFeatureNode): BoardViewNode[] {
  const nodes: BoardViewNode[] = [];
  const walk = (tasks: BoardTaskNode[]) => {
    for (const task of tasks) {
      nodes.push(taskViewNode(task, feature));
      walk(task.children);
    }
  };
  walk(feature.tasks);
  return nodes;
}

export interface BoardKanbanColumn {
  stage: BoardStage;
  nodes: BoardViewNode[];
  /** 仅「待设计」列：interview-only 聚合子区（§13.3）；其余列为 null。 */
  interview: { count: number; nodes: BoardViewNode[] } | null;
}

/** 排序第二视角（§3.5：「最老未动」由用户主动切换，不改变默认排序）。 */
export type BoardViewSort = "recent" | "oldest";

/* ---------------- 视图模式（闭集） ---------------- */

/** 面板内四视图（**闭集**：加视图 ⇒ 类型报错拖出宿主分支、控件选项与词条映射）。 */
export type BoardViewMode = "tree" | "kanban" | "list" | "table";

export const BOARD_VIEW_MODES: readonly BoardViewMode[] = ["tree", "kanban", "list", "table"];

/* ---------------- 视图节点类型（闭集） ---------------- */

/** 视图节点类型（§13.2 表格「待设计」格的 kind 筛选用）：特性节点与任务卡。 */
export type BoardViewNodeKind = BoardViewNode["kind"];

export const BOARD_VIEW_NODE_KINDS: readonly BoardViewNodeKind[] = ["feature", "task"];

/** 类型词条（`Record<…>` 穷尽：类型闭集加值在编译期报缺，不落裸 key）。 */
export const BOARD_VIEW_NODE_KIND_MESSAGE_IDS: Record<BoardViewNodeKind, string> = {
  feature: "board.kind.feature",
  task: "board.kind.task",
};

export function isBoardViewNodeKind(value: unknown): value is BoardViewNodeKind {
  return typeof value === "string" && (BOARD_VIEW_NODE_KINDS as readonly string[]).includes(value);
}

/** 视图名文案（`Record<…>` 穷尽：加视图 ⇒ 编译期在这里报缺失，而不是界面上多一个裸 key）。 */
export const BOARD_VIEW_MODE_MESSAGE_IDS: Record<BoardViewMode, string> = {
  tree: "board.view.tree",
  kanban: "board.view.kanban",
  list: "board.view.list",
  table: "board.view.table",
};

export function isBoardViewMode(value: unknown): value is BoardViewMode {
  return typeof value === "string" && (BOARD_VIEW_MODES as readonly string[]).includes(value);
}

function updatedAtEpoch(node: BoardViewNode): number | null {
  if (!node.updatedAt) return null;
  const epochMs = Date.parse(node.updatedAt);
  return Number.isFinite(epochMs) ? epochMs : null;
}

/**
 * 节点排序（§3.5）：attention 项置顶**恒定**；其余按 `updatedAt` 倒序（`recent`）或升序（`oldest`）。
 * `updatedAt` 缺失/解析不了 = 没有卡龄信号 → 沉底（不冒充最新）；同刻按 id 稳定收敛。
 * 纯函数：不改写入参数组。
 *
 * `sinkStage`（可选）：命中该段位的节点整体沉到**所在组末尾**——列表默认排序用它把「已完成」沉底
 * （§13.2 列表列：「已完成」行徽章 + 默认排序沉底）。置顶优先于沉底：带缺口的已完成卡仍在置顶组
 * （缺口不许被埋，§3.5）。
 */
export function sortBoardViewNodes(
  nodes: BoardViewNode[],
  sort: BoardViewSort = "recent",
  options: { sinkStage?: BoardStage | null } = {},
): BoardViewNode[] {
  const sinkStage = options.sinkStage ?? null;
  return [...nodes].sort((left, right) => {
    const leftPinned = left.attention.length > 0 ? 0 : 1;
    const rightPinned = right.attention.length > 0 ? 0 : 1;
    if (leftPinned !== rightPinned) return leftPinned - rightPinned;

    if (sinkStage !== null) {
      const leftSunk = left.stage === sinkStage ? 1 : 0;
      const rightSunk = right.stage === sinkStage ? 1 : 0;
      if (leftSunk !== rightSunk) return leftSunk - rightSunk;
    }

    const leftAt = updatedAtEpoch(left);
    const rightAt = updatedAtEpoch(right);
    if (leftAt === null || rightAt === null) {
      if (leftAt !== rightAt) return leftAt === null ? 1 : -1;
    } else if (leftAt !== rightAt) {
      return sort === "oldest" ? leftAt - rightAt : rightAt - leftAt;
    }

    return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
  });
}

export interface BoardKanban {
  columns: BoardKanbanColumn[];
  /**
   * 段位缺省或不在七段位词表内的节点数（旧编译器产物 / 未来段位）。
   * 这些节点不落任何列（视图只有七列，不造第八列），但**不静默丢失**：
   * 视图层按此计数给出提示，列表视图仍全量可见。
   */
  unplacedCount: number;
}

/**
 * 列表过滤条件（§13.2 列表列：按段位/状态/缺口码筛；表格「待设计」格另可按 kind 筛；
 * 「过滤 UI 最小化」）。各条件都可缺省（`undefined`/`null` = 不筛），取值只从视图层的闭集词表来；
 * 这里只做**精确匹配**—— 不归一、不猜（不认识的取值只会筛出空集，不会静默变成别的筛子）。
 */
export interface BoardListFilter {
  stage?: BoardStage | null;
  status?: string | null;
  attention?: BoardAttentionCode | null;
  /** 视图节点类型（§13.2 表格「待设计」格「可按 attention 与 kind 过滤」）。 */
  kind?: BoardViewNodeKind | null;
}

export interface BoardListQuery {
  filter?: BoardListFilter;
  sort?: BoardViewSort;
}

function matchesFilter(node: BoardViewNode, filter: BoardListFilter): boolean {
  if (filter.stage !== undefined && filter.stage !== null && node.stage !== filter.stage)
    return false;
  if (filter.status !== undefined && filter.status !== null && node.status !== filter.status) {
    return false;
  }
  if (
    filter.attention !== undefined &&
    filter.attention !== null &&
    !node.attention.includes(filter.attention)
  ) {
    return false;
  }
  if (filter.kind !== undefined && filter.kind !== null && node.kind !== filter.kind) {
    return false;
  }
  return true;
}

/** 过滤（§13.2）：条件是交集；过滤先于排序（attention 置顶是**结果内**的排序，不是豁免过滤）。 */
export function filterBoardViewNodes(
  nodes: BoardViewNode[],
  filter: BoardListFilter = {},
): BoardViewNode[] {
  return nodes.filter((node) => matchesFilter(node, filter));
}

/**
 * 列表行：全卡平铺（不分特性组、不丢节点）→ 过滤 → 排序（§13.2 列表列 + §3.5）。
 * 默认排序把「已完成」沉底（§13.2 列表列）；「最老未动」第二视角不沉底（它的语义就是最老在前）。
 * 空结果由视图层给「没有匹配」文案，这里只返回空数组。
 */
export function buildBoardListRows(
  board: BoardViewModel,
  query: BoardListQuery = {},
): BoardViewNode[] {
  const sort = query.sort ?? "recent";
  return sortBoardViewNodes(
    filterBoardViewNodes(collectBoardViewNodes(board), query.filter ?? {}),
    sort,
    { sinkStage: sort === "recent" ? "已完成" : null },
  );
}

/**
 * 过滤控件状态（UI 直持的扁平形态；`null` = 不筛）。
 * 取值都是闭集成员，`<select>` 的空串与坏值在这里归一到 `null`（UI ↔ 纯函数的唯一转换点，
 * 见 `boardStageFilterValue` 等四个归一函数 —— 视图层不写裸 `as` 断言）。
 */
export interface BoardListControls {
  stage: BoardStage | null;
  status: BoardStatusValue | null;
  attention: BoardAttentionCode | null;
  kind: BoardViewNodeKind | null;
  sort: BoardViewSort;
}

export const EMPTY_BOARD_LIST_CONTROLS: BoardListControls = Object.freeze({
  stage: null,
  status: null,
  attention: null,
  kind: null,
  sort: "recent",
});

/* ---------------- UI 取值归一（UI ↔ 纯函数的唯一转换点） ---------------- */

/**
 * 四个过滤 `<select>` 的取值 → 控件状态：`""`（「全部」）与不认识的值一律 `null`；
 * 排序是闭集二选一，坏值回落默认视角 `recent`。
 * 视图层因此不需要 `as BoardStage` 之类的断言：不认识的字面量到不了判据，也不会被猜成别的词。
 */
export function boardStageFilterValue(value: string): BoardStage | null {
  return isBoardStage(value) ? value : null;
}

export function boardStatusFilterValue(value: string): BoardStatusValue | null {
  return isBoardStatusValue(value) ? value : null;
}

export function boardAttentionFilterValue(value: string): BoardAttentionCode | null {
  return isBoardAttentionCode(value) ? value : null;
}

export function boardViewNodeKindFilterValue(value: string): BoardViewNodeKind | null {
  return isBoardViewNodeKind(value) ? value : null;
}

export function boardSortFilterValue(value: string): BoardViewSort {
  return value === "oldest" ? "oldest" : "recent";
}

export function boardListControlsToQuery(controls: BoardListControls): BoardListQuery {
  const filter: BoardListFilter = {};
  if (controls.stage !== null) filter.stage = controls.stage;
  if (controls.status !== null) filter.status = controls.status;
  if (controls.attention !== null) filter.attention = controls.attention;
  if (controls.kind !== null) filter.kind = controls.kind;
  return { filter, sort: controls.sort };
}

/**
 * 清过滤（只清筛子，保留排序视角）：弹窗内的依赖跳转用——过滤是临时视角，
 * 目标卡若被筛掉就「跳了个寂寞」，跳转前先清筛子；「最老未动」这类第二视角不属于筛子，保留。
 */
export function clearBoardListFilter(controls: BoardListControls): BoardListControls {
  return { ...controls, stage: null, status: null, attention: null, kind: null };
}

/** 段位是否在七段位词表内（不自算段位，只做「认识/不认识」判定）。 */
export function isBoardStage(value: string | null): value is BoardStage {
  return value !== null && (BOARD_STAGES as readonly string[]).includes(value);
}

/**
 * interview-only 判据（§13.3 原文以缺口码定义）：节点 attention 含 `interviewed-not-arranged`。
 * 不以 `kind === "interview-only"` 判定：T21 起 resolvedBy 悬空/产物缺失的条目退回 interview-only
 * 同挂此码，码才是编译器给的判据。
 */
export function isInterviewSummaryNode(node: BoardViewNode): boolean {
  return node.attention.includes("interviewed-not-arranged");
}

/** 看板列分配：七列固定序（流水序），节点按自身 `stage` 卡入列（§13.1/§13.2）。 */
export function buildBoardKanban(
  board: BoardViewModel,
  options: { sort?: BoardViewSort } = {},
): BoardKanban {
  const sort = options.sort ?? "recent";
  const buckets = new Map<BoardStage, BoardViewNode[]>();
  for (const stage of BOARD_STAGES) buckets.set(stage, []);
  let unplacedCount = 0;
  for (const node of collectBoardViewNodes(board)) {
    if (!isBoardStage(node.stage)) {
      unplacedCount += 1;
      continue;
    }
    buckets.get(node.stage)?.push(node);
  }

  const columns: BoardKanbanColumn[] = BOARD_STAGES.map((stage) => {
    const nodes = buckets.get(stage) ?? [];
    if (stage !== "待设计")
      return { stage, nodes: sortBoardViewNodes(nodes, sort), interview: null };
    // 待设计列：interview-only 节点单独聚合为「访谈汇总」子区（§13.3）；
    // 子区计数取 `attentionSummary.interviewedNotArranged`（契约点名的来源，不由节点条数回算）。
    return {
      stage,
      nodes: sortBoardViewNodes(
        nodes.filter((node) => !isInterviewSummaryNode(node)),
        sort,
      ),
      interview: {
        count: board.attentionSummary.interviewedNotArranged,
        nodes: sortBoardViewNodes(nodes.filter(isInterviewSummaryNode), sort),
      },
    };
  });

  return { columns, unplacedCount };
}
