/**
 * 卡片弹窗的纯函数层（卡 #34，消费契约 §6「弹窗契约」逐字）。
 *
 * 边界（契约 §6 引言 + 勘误 4）：弹窗只读，**全部字段来自被点卡片自身**，应用侧无需额外读取
 * 任何文件；本模块只做「节点 + 板 → 弹窗模型」的映射与跳转目标解析，不写任何东西。
 *
 * 单一真源：
 * - §6 各区块：编号+名称 / 状态·缺口 / 细节（空串 → 隐藏）/ 阻拦 / 最近执行 / 来源 / 证据路径 /
 *   时间戳 / PR（null → 隐藏）；阻拦的 `dependency` 显示对方 `ID-<对方label>` 与 `#<对方no>`，
 *   目标不在当前板 → 显示 summary、禁用跳转；特性节点弹窗的阻拦区块隐藏。
 * - §6.1 时间线语义：弹窗只展示 `lastRun`（board.json 内唯一的 run 摘要），不承诺 activity 全文。
 */
import {
  collectBoardViewNodes,
  isBoardStage,
  type BoardViewMode,
  type BoardViewNode,
} from "./boardViewsViewModel.js";
import type {
  BoardActiveRun,
  BoardAttentionCode,
  BoardLastRun,
  BoardOrigin,
  BoardPr,
  BoardViewModel,
} from "./boardViewModel.js";

/** 来源区块的固定行序（契约 §6 点名的五个 origin 键；缺省的键不出现）。 */
export const BOARD_DIALOG_ORIGIN_KEYS = [
  "type",
  "interviewId",
  "sessionId",
  "specRoot",
  "planRef",
] as const;

export type BoardDialogOriginKey = (typeof BOARD_DIALOG_ORIGIN_KEYS)[number];

/**
 * 来源行标签词条（`Record<…>` 穷尽：origin 键加值在编译期报缺，不落裸 key）。
 * 与键枚举**同模块**（评审 S6）：加一个 origin 键时枚举与词条在同一处改，呈现层叶子
 * （`boardPresentation`）不再反依赖本 VM。
 */
export const BOARD_ORIGIN_MESSAGE_IDS: Record<BoardDialogOriginKey, string> = {
  type: "board.dialog.origin.type",
  interviewId: "board.dialog.origin.interviewId",
  sessionId: "board.dialog.origin.sessionId",
  specRoot: "board.dialog.origin.specRoot",
  planRef: "board.dialog.origin.planRef",
};

export interface BoardDialogOriginRow {
  key: BoardDialogOriginKey;
  value: string;
}

/** 依赖跳转目标：板上那张卡自身（按稳定号定位），不是复制一份字段。 */
export interface BoardDialogJumpTarget {
  id: string;
  no: number;
  label: string | null;
  title: string;
  /** 目标段位（视图层判「当前视图能不能渲染它」用；不自算、只搬运）。 */
  stage: string | null;
}

export interface BoardDialogBlocker {
  index: number;
  /** 原值透出（契约只给 external / dependency 两种呈现，不认识的 kind 不猜语义）。 */
  kind: string;
  summary: string | null;
  evidence: string[];
  /** 有目标才可跳转；无目标（缺 `blockedBy` / 目标不在板上）→ null，视图层禁用跳转。 */
  target: BoardDialogJumpTarget | null;
  /** 对方编号文本：`ID-<对方label> · #<对方no>`（缺 label 时只给稳定号）；无目标 → null。 */
  targetText: string | null;
}

export interface BoardCardDialogModel {
  id: string;
  kind: "feature" | "task";
  no: number | null;
  label: string | null;
  title: string;
  status: string | null;
  statusRule: string | null;
  stage: string | null;
  attention: BoardAttentionCode[];
  activeRun: BoardActiveRun | null;
  draft: boolean;
  worktree: string | null;
  /** 细节全文；空串在映射层已归一为 null（区块隐藏）。 */
  details: string | null;
  /** 阻拦区块是否可见：**仅任务卡**且 blockers 非空（§6：特性节点弹窗的阻拦区块隐藏）。 */
  showBlockers: boolean;
  blockers: BoardDialogBlocker[];
  lastRun: BoardLastRun | null;
  origin: BoardDialogOriginRow[];
  evidence: string[];
  createdAt: string | null;
  updatedAt: string | null;
  pr: BoardPr | null;
}

/**
 * 跳转目标解析：按稳定号在**当前板**上找节点（契约 §6：目标不在当前板 → 禁用跳转）。
 * 悬空引用（号不在板上）与缺号一视同仁地返回 null——不猜、不造占位卡。
 */
export function resolveBoardCardJumpTarget(
  board: BoardViewModel,
  no: number | null,
): BoardDialogJumpTarget | null {
  if (no === null || !Number.isInteger(no) || no <= 0) return null;
  const node = collectBoardViewNodes(board).find((entry) => entry.no === no);
  if (!node || node.no === null) return null;
  return {
    id: node.id,
    no: node.no,
    label: node.label,
    title: node.title,
    stage: node.stage,
  };
}

function blockerTargetText(target: BoardDialogJumpTarget | null): string | null {
  if (!target) return null;
  return target.label ? `ID-${target.label} · #${target.no}` : `#${target.no}`;
}

function originRows(origin: BoardOrigin | null): BoardDialogOriginRow[] {
  if (!origin) return [];
  return BOARD_DIALOG_ORIGIN_KEYS.flatMap((key) => {
    const value = origin[key];
    return value === null ? [] : [{ key, value }];
  });
}

/**
 * 打开态 → 至多一个弹窗节点（「同一时刻最多一个弹窗」的数据口径：宿主只持一个 id）。
 * 板上找不到该 id（刷新后卡片消失 / 悬空引用）→ null：不留幽灵弹窗，什么都不渲染。
 */
export function resolveBoardDialogNode(
  board: BoardViewModel,
  openCardId: string | null,
): BoardViewNode | null {
  if (openCardId === null) return null;
  return collectBoardViewNodes(board).find((node) => node.id === openCardId) ?? null;
}

/**
 * Esc 关窗的键位判据（纯函数一处判定，宿主只消费；同 `TaskFindDialog` 的 chat 浮层口径）：
 * 已被内层浮层消费（`defaultPrevented`）的 Esc 不重复关窗，其余键一律 none。
 */
export function boardCardDialogKeyIntent(input: {
  key: string;
  defaultPrevented: boolean;
}): "close" | "none" {
  if (input.defaultPrevented) return "none";
  return input.key === "Escape" ? "close" : "none";
}

/**
 * 跳转是否需要切到列表视图：看板列视图只渲染**落在七段位列里**的节点（段位缺省/不认识的
 * 节点被计入未定位提示，不落列，§13.2）；此时滚不到目标，切列表视图（全量平铺）兜底。
 * 余下三视图都渲染全量节点，无需切换。
 */
export function boardJumpRequiresListView(
  viewMode: BoardViewMode,
  target: BoardDialogJumpTarget,
): boolean {
  return viewMode === "kanban" && !isBoardStage(target.stage);
}

/** 节点 + 板 → 弹窗模型（纯函数：入参不改写、不读其他文件）。 */ export function buildBoardCardDialog(
  board: BoardViewModel,
  node: BoardViewNode,
): BoardCardDialogModel {
  // 特性节点不产出阻拦行（§6 约束）：判据在模型层一处，视图层不再判第二遍。
  const blockerSource = node.kind === "task" ? node.blockers : [];
  return {
    id: node.id,
    kind: node.kind,
    no: node.no,
    label: node.label,
    title: node.title,
    status: node.status,
    statusRule: node.statusRule,
    stage: node.stage,
    attention: node.attention,
    activeRun: node.activeRun,
    draft: node.draft,
    worktree: node.worktree,
    details: node.details,
    showBlockers: blockerSource.length > 0,
    blockers: blockerSource.map((blocker, index) => {
      const target =
        blocker.kind === "dependency" ? resolveBoardCardJumpTarget(board, blocker.blockedBy) : null;
      return {
        index,
        kind: blocker.kind,
        summary: blocker.summary,
        evidence: blocker.evidence,
        target,
        targetText: blockerTargetText(target),
      };
    }),
    lastRun: node.lastRun,
    origin: originRows(node.origin),
    evidence: node.evidence,
    createdAt: node.createdAt,
    updatedAt: node.updatedAt,
    pr: node.pr,
  };
}
