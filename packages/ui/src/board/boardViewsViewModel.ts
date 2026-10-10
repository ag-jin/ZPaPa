/**
 * 看板视图的纯函数层（卡 #33：看板列视图 + 列表视图）。
 *
 * 边界（消费契约 §13.6）：视图不写任何板文件、不解析真相源、**不自算 `stage`/`attention`**；
 * 本模块只做「视图模型 → 列/行」的分组、排序与过滤，全部字段读 board.json 映射结果。
 *
 * 单一真源：
 * - §13.2 视图矩阵：四视图共用同一 board.json、同一节点集合与同一段位派生；视图差异只在呈现层。
 * - §13.3 待设计列 = interview-only 聚合子区。
 * - §3.5 排序与完成沉底：判定单点在 `boardViewSorting`（行序/列内序/组序共用一份比较器）。
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
import {
  BOARD_COMPLETED_STAGE,
  compareBoardViewNodes,
  isBoardStage,
  sortBoardViewNodes,
  type BoardViewSort,
} from "./boardViewSorting.js";

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
  /** 下一接手人（v2.3/#53）：管线序首个无 done 证据角色；全完成/缺省 → null。 */
  nextAssignee: string | null;
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
    // nextAssignee 是卡级字段（契约 §2 字段表）：特性节点不借子树的值。
    nextAssignee: null,
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
    nextAssignee: task.nextAssignee,
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
  // 任务侧复用唯一一份前序遍历（`collectFeatureTaskNodes`）——两份走法早晚对不上顺序。
  return board.features.flatMap((feature) => [
    featureViewNode(feature),
    ...collectFeatureTaskNodes(feature),
  ]);
}

/**
 * 特性分组视图节点（#46 B3/B4）：每组 = 特性头 + 其任务卡（文档序前序，含嵌套子卡）。
 * 列表/表格的分组行与看板的分组头共用这一份形态（分组只是呈现，节点字段一字不改）。
 * `totalCards`（#59 S-1）：特性卡总数单点产出（`countBoardFeatureTasks`），消费方不再各算一份。
 */
export function collectBoardFeatureGroups(
  board: BoardViewModel,
): Array<{ feature: BoardViewNode; nodes: BoardViewNode[]; totalCards: number }> {
  return board.features.map((feature) => ({
    feature: featureViewNode(feature),
    nodes: collectFeatureTaskNodes(feature),
    totalCards: countBoardFeatureTasks(feature),
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

/**
 * 特性卡总数（含嵌套子卡，单点；#59 S-1）：四视图组头 `[N 张卡]` 共用同一口径，不受过滤影响；
 * 复用唯一一份前序遍历，卡数与节点集合不会漂移。
 */
export const countBoardFeatureTasks = (feature: BoardFeatureNode): number =>
  collectFeatureTaskNodes(feature).length;

export interface BoardKanbanGroup {
  /** 分组头：特性节点（可点开弹窗；渲染为分组行，不是独立卡）。 */
  feature: BoardViewNode;
  /** 本列中属于该特性的任务卡（组内已排序）。 */
  nodes: BoardViewNode[];
  /**
   * 特性卡总数（#54-2）：组头展示特性自身规模；列内张数由列头计数表达。
   * 与 `nodes.length`（本列张数）分开——跨列时两者不等，组头不能把特性读小。
   */
  totalCards: number;
  /** 特性节点自身段位 = 本列（分组头带自身徽章）；false = 跨列随行的轻量标签。 */
  featureInColumn: boolean;
  /** 分组排序键（组内最高优先成员；`compareBoardViewNodes` 比较）。 */
  sortKey: BoardViewNode;
}

export interface BoardKanbanColumn {
  stage: BoardStage;
  /** 本列的扁平节点序列（分组渲染序：分组头在前、组内按排序）——分组只是呈现。 */
  nodes: BoardViewNode[];
  /** 列内分组（#46 B3）：特性名 = 分组头，任务卡随行。 */
  groups: BoardKanbanGroup[];
  /** 仅「待设计」列：interview-only 聚合子区（§13.3）；其余列为 null。 */
  interview: { count: number; nodes: BoardViewNode[] } | null;
}

/** 列表/表格分组（#46 B4）：特性头 + 过滤排序后的子行（组序 = 成员首次出现序）。 */
export interface BoardListGroup {
  feature: BoardViewNode;
  nodes: BoardViewNode[];
  /**
   * 特性卡总数（#59 S-1，与看板分组头同源单点）：组头 `[N 张卡]` 表达特性规模，
   * 不受过滤影响——过滤只减行，行数表达当前呈现。
   */
  totalCards: number;
}

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
    { sinkStage: sort === "recent" ? BOARD_COMPLETED_STAGE : null },
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
 * 四个过滤 `<select>` 的取值 → 控件状态：`""`（「全部」）与不认识的值一律 `null`。
 * 排序的归一（闭集三选一，坏值回落 `recent`）在 `boardViewSorting.boardSortFilterValue`。
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
  // 与列表/表格同一口径（#65）：默认序里「已完成」沉底。列 = 段位，已完成节点天然只在已完成列，
  // 因此这里的沉底**不改动列归属与列序**（列整体位置不动），只保证组内/组序与其余视图同一条比较器。
  const sinkStage = sort === "recent" ? BOARD_COMPLETED_STAGE : null;
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
    const groups: BoardKanbanGroup[] = [];
    for (const { feature, nodes: featureNodes, totalCards } of collectBoardFeatureGroups(board)) {
      // 访谈聚合节点按**节点粒度**过滤（#55 S-1，评审 #46 S-1）：特性级 `continue` 会连带
      // 静默丢弃「访谈聚合特性携带任务」形状的任务节点。聚合判据只作用于节点自身——
      // 聚合节点自身不占主列（它归「访谈汇总」子区），其任务照常按自身段位入场；
      // 主列归并与子区聚合因此不重复投放同一节点。
      const featureInColumn = !isInterviewSummaryNode(feature) && feature.stage === stage;
      const taskNodes = featureNodes.filter(
        (node) => node.stage === stage && !isInterviewSummaryNode(node),
      );
      if (!featureInColumn && taskNodes.length === 0) continue;
      const sortedTasks = sortBoardViewNodes(taskNodes, sort, { sinkStage });
      // 分组排序键 = 组内最高优先成员（特性自身也算成员：attention 置顶，已完成沉底，updatedAt 倒序）
      const members = sortBoardViewNodes(
        featureInColumn ? [feature, ...sortedTasks] : sortedTasks,
        sort,
        { sinkStage },
      );
      const sortKey = members[0] ?? feature;
      groups.push({ feature, nodes: sortedTasks, totalCards, featureInColumn, sortKey });
    }
    groups.sort((left, right) => {
      const compared = compareBoardViewNodes(left.sortKey, right.sortKey, sort, { sinkStage });
      if (compared !== 0) return compared;
      return left.feature.id < right.feature.id ? -1 : left.feature.id > right.feature.id ? 1 : 0;
    });
    // 扁平序 = 分组渲染序（分组头在前、组内按排序）——分组只是呈现，节点集合仍是同一批。
    const flat = groups.flatMap((group) => [
      ...(group.featureInColumn ? [group.feature] : []),
      ...group.nodes,
    ]);
    if (stage !== "待设计") {
      return { stage, nodes: flat, groups, interview: null };
    }
    // 待设计列：interview-only 节点单独聚合为「访谈汇总」子区（§13.3）；
    // 子区计数取 `attentionSummary.interviewedNotArranged`（契约点名的来源，不由节点条数回算）。
    return {
      stage,
      nodes: flat,
      groups,
      interview: {
        count: board.attentionSummary.interviewedNotArranged,
        nodes: sortBoardViewNodes(nodes.filter(isInterviewSummaryNode), sort),
      },
    };
  });

  return { columns, unplacedCount };
}

/**
 * 列表/表格分组（#46 B4）：先走既有平铺管线（过滤 → 排序，语义一字不改），再按「所属特性」
 * 归组——分组只是呈现分区，行序在组内保持平铺管线的相对序（组序 = 成员首次出现序）。
 * 特性自身匹配过滤时保留（无子行的分组头也渲染：筛选到特性时它仍看得见）。
 */
export function buildBoardListGroups(
  board: BoardViewModel,
  query: BoardListQuery = {},
): BoardListGroup[] {
  const flat = buildBoardListRows(board, query);
  const ownerByTaskId = new Map<string, BoardViewNode>();
  // 特性卡总数（#59 S-1）：与看板分组头同源（`collectBoardFeatureGroups` 单点产出）。
  const totalByFeatureId = new Map<string, number>();
  for (const { feature, nodes, totalCards } of collectBoardFeatureGroups(board)) {
    totalByFeatureId.set(feature.id, totalCards);
    for (const node of nodes) ownerByTaskId.set(node.id, feature);
  }
  const groups: BoardListGroup[] = [];
  const byFeatureId = new Map<string, BoardListGroup>();
  const ensureGroup = (feature: BoardViewNode): BoardListGroup => {
    let group = byFeatureId.get(feature.id);
    if (!group) {
      group = { feature, nodes: [], totalCards: totalByFeatureId.get(feature.id) ?? 0 };
      byFeatureId.set(feature.id, group);
      groups.push(group);
    }
    return group;
  };
  for (const node of flat) {
    if (node.kind === "feature") {
      ensureGroup(node);
      continue;
    }
    const owner = ownerByTaskId.get(node.id);
    if (!owner) continue;
    ensureGroup(owner).nodes.push(node);
  }
  return groups;
}
