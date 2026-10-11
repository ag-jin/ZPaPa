/**
 * 看板视图**排序与「已完成沉底」的符号集合**（单点；卡 #65）。
 *
 * 模块双职责（本模块就这两件事，别再拆散或各写一份）：
 * 1. **排序视角**——三视角闭集（`recent` / `oldest` / `stage`）、默认视角常量（`DEFAULT_BOARD_VIEW_SORT`）、
 *    取值归一（`boardSortFilterValue`）与单点比较器（`compareBoardViewNodes`）。
 * 2. **「已完成沉底」**——默认序把「已完成」沉到所在组/列末尾（列表/表格/看板列内），树形同级组内
 *    （`sinkCompletedTreeSiblings`）；沉底段位由 `boardSortSinkStage` 单点给出。
 *
 * 宿主变化：本模块由 `boardViewsViewModel` 抽出（卡 #65）——原宿主继续堆叠会越过仓库 oxlint
 * `max-lines`（400）上限。抽出只挪宿主、不动符号集合：对外仍是同一批导出（仅导入路径变化），
 * 新宿主（`boardViewsViewModel` 与四视图）只消费这套判定，不另起第二份。
 *
 * 边界（消费契约 §13.6）：只做排序/沉底的纯函数判定——不读板文件、不解析真相源、
 * 不自算 `stage`/`attention`；四视图的行序、看板列内序与分组序都走这里同一份比较器。
 *
 * 单一真源：§3.5（attention 项置顶；其余按 `updatedAt` 倒序；「最老未动」是用户主动切换的第二视角）
 * + 卡 #65 三视角定义（最近更新 / 最老未动 / 段位序）。
 */
import { BOARD_STAGES, type BoardAttentionCode, type BoardStage } from "./boardViewModel.js";

/**
 * 可排序节点的**结构约定**：排序与沉底只读这四个字段。排序模块因此不依赖视图节点的全量定义
 * （视图节点多出来的字段是呈现/弹窗的事，与行序无关）。
 */
export interface BoardSortableNode {
  id: string;
  stage: string | null;
  attention: readonly BoardAttentionCode[];
  updatedAt: string | null;
}

/** 段位是否在七段位词表内（不自算段位，只做「认识/不认识」判定；段位序与段位筛共用一处）。 */
export function isBoardStage(value: string | null): value is BoardStage {
  // #60/T-3：不裸 `as`——闭集数组逐项比较，收窄由谓词承担。
  return value !== null && BOARD_STAGES.some((stage) => stage === value);
}

/**
 * 「已完成」段位（§13.1 七段位之一）：默认序沉底与树形同级沉底共用同一字面量，
 * 不各写一份（两处口径漂移过一次的代价太高）。
 */
export const BOARD_COMPLETED_STAGE: BoardStage = "已完成";

/**
 * 排序视角（§3.5 + 卡 #65）：
 * - `recent` = 契约默认序（attention 置顶 + 已完成沉底 + `updatedAt` 倒序）；
 * - `oldest` = 「最老未动」第二视角（卡龄升序，不沉底——它的语义就是最老在前）；
 * - `stage` = 段位序（七段位流水序，attention 仍置顶；已完成按流水序落在倒数第二位，已取消垫底）。
 */
export type BoardViewSort = "recent" | "oldest" | "stage";

/** 排序视角闭集（顺序即控件选项序；`Record<…>` 穷尽：加视角在编译期报缺，不落裸 key）。 */
export const BOARD_VIEW_SORTS: readonly BoardViewSort[] = ["recent", "oldest", "stage"];

/**
 * 默认排序视角 = 契约序（§3.5）：attention 置顶 + `updatedAt` 倒序 + 已完成沉底。
 * **单点常量**：闭集回落的默认值、函数默认参数、控件初值都取这里，不各写 `"recent"` 字面量。
 */
export const DEFAULT_BOARD_VIEW_SORT: BoardViewSort = "recent";

/** 排序视角文案词条（zh-CN 逐字见词条表）。 */
export const BOARD_VIEW_SORT_MESSAGE_IDS: Record<BoardViewSort, string> = {
  recent: "board.sort.recent",
  oldest: "board.sort.oldest",
  stage: "board.sort.stage",
};

export function isBoardViewSort(value: unknown): value is BoardViewSort {
  // #60/T-3：不裸 `as`——闭集数组逐项比较，收窄由谓词承担。
  return typeof value === "string" && BOARD_VIEW_SORTS.some((sort) => sort === value);
}

/** 控件取值归一：闭集成员原样透传，空串/坏值回落默认视角（UI 不写裸 `as` 断言）。 */
export function boardSortFilterValue(value: string): BoardViewSort {
  return isBoardViewSort(value) ? value : DEFAULT_BOARD_VIEW_SORT;
}

/**
 * 视角的「完成沉底」段位（单点）：仅默认序（`DEFAULT_BOARD_VIEW_SORT`）沉底「已完成」；
 * `oldest`（最老在前）与 `stage`（段位流水序）不沉底（§3.5）。返回 `null` = 该视角不沉底。
 */
export function boardSortSinkStage(sort: BoardViewSort): BoardStage | null {
  return sort === DEFAULT_BOARD_VIEW_SORT ? BOARD_COMPLETED_STAGE : null;
}

function updatedAtEpoch(node: BoardSortableNode): number | null {
  if (!node.updatedAt) return null;
  const epochMs = Date.parse(node.updatedAt);
  return Number.isFinite(epochMs) ? epochMs : null;
}

/**
 * 段位流水序位次（§13.1 七段位列序，`待设计 → 已取消`）；段位缺省/不认识 → 排在最后
 * （认不出的段位不冒充已知段位，与「无 `updatedAt` 沉底」同一口径）。
 */
function stageRank(node: BoardSortableNode): number {
  return isBoardStage(node.stage) ? BOARD_STAGES.indexOf(node.stage) : BOARD_STAGES.length;
}

/** 排序选项：`sinkStage` = 命中该段位的节点整体沉到所在组末尾（见 `sortBoardViewNodes`）。 */
export interface BoardSortOptions {
  sinkStage?: BoardStage | null;
}

/**
 * 节点排序（§3.5）：attention 项置顶**恒定**；其余按 `updatedAt` 倒序（`recent`）、
 * 升序（`oldest`）或段位流水序（`stage`）。
 * `updatedAt` 缺失/解析不了 = 没有卡龄信号 → 沉底（不冒充最新）；同刻按 id 稳定收敛。
 * 纯函数：不改写入参数组。
 *
 * `sinkStage`（可选）：命中该段位的节点整体沉到**所在组末尾**——列表默认排序用它把「已完成」沉底
 * （§13.2 列表列：「已完成」行徽章 + 默认排序沉底）。置顶优先于沉底：带缺口的已完成卡仍在置顶组
 * （缺口不许被埋，§3.5）。
 */
export function sortBoardViewNodes<T extends BoardSortableNode>(
  nodes: T[],
  sort: BoardViewSort = DEFAULT_BOARD_VIEW_SORT,
  options: BoardSortOptions = {},
): T[] {
  return [...nodes].sort((left, right) => compareBoardViewNodes(left, right, sort, options));
}

/**
 * 单点比较器（`sortBoardViewNodes` 与看板分组排序共用）：attention 置顶恒在，其次 sinkStage，
 * 再次视角键（`recent`/`oldest` 走 `updatedAt`，`stage` 走段位流水序），最后 id 稳定收敛。
 * 导出供分组序复用——分组排序键 = 组内最高优先成员，判定规则必须与行排序**同一份**，
 * 否则组序与行序互相矛盾。
 */
export function compareBoardViewNodes(
  left: BoardSortableNode,
  right: BoardSortableNode,
  sort: BoardViewSort = DEFAULT_BOARD_VIEW_SORT,
  options: BoardSortOptions = {},
): number {
  const sinkStage = options.sinkStage ?? null;
  const leftPinned = left.attention.length > 0 ? 0 : 1;
  const rightPinned = right.attention.length > 0 ? 0 : 1;
  if (leftPinned !== rightPinned) return leftPinned - rightPinned;

  if (sinkStage !== null) {
    const leftSunk = left.stage === sinkStage ? 1 : 0;
    const rightSunk = right.stage === sinkStage ? 1 : 0;
    if (leftSunk !== rightSunk) return leftSunk - rightSunk;
  }

  if (sort === "stage") {
    const leftRank = stageRank(left);
    const rightRank = stageRank(right);
    if (leftRank !== rightRank) return leftRank - rightRank;
  }

  const leftAt = updatedAtEpoch(left);
  const rightAt = updatedAtEpoch(right);
  if (leftAt === null || rightAt === null) {
    if (leftAt !== rightAt) return leftAt === null ? 1 : -1;
  } else if (leftAt !== rightAt) {
    return sort === "oldest" ? leftAt - rightAt : rightAt - leftAt;
  }

  return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
}

/**
 * 树形结构序内的「已完成沉底」（#65）：把已完成的兄弟节点**稳定地**移到同级末尾——
 * 层级结构（章节子分组、嵌套子卡）与其余卡片的文档序都不重排（树形不是平铺排序视图）。
 * 纯函数：不改写入参数组。
 */
export function sinkCompletedTreeSiblings<T extends { stage: string | null }>(
  nodes: readonly T[],
): T[] {
  const open: T[] = [];
  const completed: T[] = [];
  for (const node of nodes) {
    (node.stage === BOARD_COMPLETED_STAGE ? completed : open).push(node);
  }
  return [...open, ...completed];
}
