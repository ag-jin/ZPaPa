import {
  BOARD_ATTENTION_LABEL_MESSAGE_IDS,
  formatBoardCardAge,
  formatBoardLastRunText,
  formatBoardRunTime,
  formatBoardStageText,
  formatBoardStatusText,
  type BoardMessageFormatter,
} from "./boardPresentation.js";
import {
  buildBoardListRows,
  type BoardListQuery,
  type BoardViewNode,
} from "./boardViewsViewModel.js";
import type { BoardViewModel } from "./boardViewModel.js";

/**
 * 表格视图的列配置纯函数层（卡 #34：表格视图，列可配置）。
 *
 * 边界（消费契约 §13.6）：视图不写任何板文件、不解析真相源、不自算 `stage`/`attention`。
 * 本模块只管**呈现层的列配置**（哪些列可见）——列集合是闭集，取值只从 board.json 映射结果来。
 *
 * 单一真源：
 * - §13.5 表格列可配置：默认列 = 编号 / 名称 / 段位 / `status` / `assignees` / `lastRun` /
 *   `updatedAt` / `blockers` / `attention`；可见性与顺序可配置。
 * - 卡 #34 派发指令：列 = 号（`ID-<label>` / 未领号 / `#<no>` 降级）/ 名称 / 段位 / 状态 /
 *   最近执行 / 卡龄（`updatedAt` 距今天数）；选择持久会话内（与 #33 视图模式同 sessionStorage 先例）。
 * - 列序取闭集序（契约默认列序 + 把卡龄插在 `updatedAt` 之后）：配置只管显示/隐藏，
 *   关掉再打开回到本序位，不产生「顺序配置」这第二种状态。
 */

/**
 * 表格列闭集（顺序即渲染序）。加列 ⇒ 类型与词条映射两处编译期报缺，不会在界面上露出裸 key。
 */
export const BOARD_TABLE_COLUMNS = [
  "no",
  "title",
  "stage",
  "status",
  "assignees",
  "lastRun",
  "updatedAt",
  "age",
  "blockers",
  "attention",
] as const;

export type BoardTableColumnKey = (typeof BOARD_TABLE_COLUMNS)[number];

/** 列头文案词条（zh-CN 逐字见词条表；`Record<…>` 穷尽）。 */
export const BOARD_TABLE_COLUMN_MESSAGE_IDS: Record<BoardTableColumnKey, string> = {
  no: "board.column.no",
  title: "board.column.title",
  stage: "board.column.stage",
  status: "board.column.status",
  assignees: "board.column.assignees",
  lastRun: "board.column.lastRun",
  updatedAt: "board.column.updatedAt",
  age: "board.column.age",
  blockers: "board.column.blockers",
  attention: "board.column.attention",
};

/** 列可见性（闭集上的布尔表）；`Record<…>` 穷尽，缺列在编译期报错。 */
export type BoardTableColumnVisibility = Record<BoardTableColumnKey, boolean>;

/** 默认全可见：契约默认列与派发指令的卡龄列都看得见（隐藏是用户的显式选择）。 */
export const DEFAULT_BOARD_TABLE_COLUMN_VISIBILITY: BoardTableColumnVisibility = Object.freeze(
  Object.fromEntries(BOARD_TABLE_COLUMNS.map((key) => [key, true])) as BoardTableColumnVisibility,
);

export function isBoardTableColumnKey(value: unknown): value is BoardTableColumnKey {
  return typeof value === "string" && (BOARD_TABLE_COLUMNS as readonly string[]).includes(value);
}

/** 可见列（恒按闭集序；配置不改列序）。 */
export function visibleBoardTableColumns(
  visibility: BoardTableColumnVisibility,
): BoardTableColumnKey[] {
  return BOARD_TABLE_COLUMNS.filter((key) => visibility[key]);
}

/** 翻转单列可见性（纯函数：返回新对象，不改写入参）。 */
export function toggleBoardTableColumn(
  visibility: BoardTableColumnVisibility,
  key: BoardTableColumnKey,
): BoardTableColumnVisibility {
  return { ...visibility, [key]: !visibility[key] };
}

/** 会话记忆的序列化形态：可见列的字面量数组（按闭集序，读回来不依赖存取顺序）。 */
export function serializeBoardTableColumnVisibility(
  visibility: BoardTableColumnVisibility,
): string {
  return JSON.stringify(visibleBoardTableColumns(visibility));
}

/**
 * 解析会话记忆（已 JSON.parse 的值或任意坏形态）。
 * 非数组 → 默认列（没有记忆 / 坏值都不猜）；数组 → 只认闭集成员，**空数组是合法取值**
 * （用户把所有列都关了），与坏值区分开。
 */
export function parseBoardTableColumnVisibility(value: unknown): BoardTableColumnVisibility {
  if (!Array.isArray(value)) return { ...DEFAULT_BOARD_TABLE_COLUMN_VISIBILITY };
  const visible = new Set(value.filter(isBoardTableColumnKey));
  return Object.fromEntries(
    BOARD_TABLE_COLUMNS.map((key) => [key, visible.has(key)]),
  ) as BoardTableColumnVisibility;
}

/* ---------------- 单元格值（列 → 文本） ---------------- */

/**
 * 单元格文本（列值 → 可渲染字符串）。全部字段来自 board.json 的映射结果，零推导：
 * - 号列降级链：`ID-<label>` → `#<no>`（缺 label）→「未领号」（派发指令的列定义）；
 * - 段位/状态走词条，未知取值原样透出（不吞字段、不自造词，§13.6）；
 * - `lastRun` 与卡片「最近执行」行同源（四要素，§3.3）；`updatedAt`/卡龄取同一 `now`；
 * - `blockers`/`attention` 用既有徽章文案（§3.3「受阻 N」/ §4 短标签），摘要按闭集序；
 * - `null` = 空单元格（视图层渲染空白，不充占位符、不编造「无」）。
 */
export function boardTableCellText(
  node: BoardViewNode,
  key: BoardTableColumnKey,
  formatMessage: BoardMessageFormatter,
  now: number,
): string | null {
  switch (key) {
    case "no":
      if (node.label) return `ID-${node.label}`;
      if (node.no !== null) return `#${node.no}`;
      return formatMessage({ id: "board.unassigned" });
    case "title":
      return node.title;
    case "stage":
      return formatBoardStageText(node.stage, formatMessage);
    case "status":
      return formatBoardStatusText(node.status, formatMessage);
    case "assignees":
      return node.assignees.length > 0 ? node.assignees.join(" → ") : null;
    case "lastRun":
      return formatBoardLastRunText(node.lastRun, formatMessage);
    case "updatedAt":
      return node.updatedAt ? formatBoardRunTime(node.updatedAt) : null;
    case "age":
      return formatBoardCardAge(node.updatedAt, now, formatMessage);
    case "blockers":
      return node.blockers.length > 0
        ? formatMessage({ id: "board.blockedByCount" }, { count: node.blockers.length })
        : null;
    case "attention":
      // `attention` 在映射层已按 §4 闭集序收敛（多码摘要的顺序不随字段书写顺序漂移）。
      return node.attention.length > 0
        ? node.attention
            .map((code) => formatMessage({ id: BOARD_ATTENTION_LABEL_MESSAGE_IDS[code] }))
            .join(" · ")
        : null;
  }
}

/**
 * 表格行 = 列表视图的同一管线（过滤 → 排序；派发指令「排序按当前列表视图语义复用」）。
 * 单一实现：不复制一份表格专用排序，避免两处语义漂移。
 */
export function buildBoardTableRows(
  board: BoardViewModel,
  query: BoardListQuery = {},
): BoardViewNode[] {
  return buildBoardListRows(board, query);
}
