/**
 * 折叠默认态单点（卡 #89 / A4-3；AD-5「缺口展开 · 含活跃期次展开 · 全完成/全取消折叠」）。
 *
 * 单一真源：裁决包 AD-5（itw-20261010-5372）+ 规则书 v2 B2（#46：有 attention 缺口 → 展开、
 * `stage=已完成` → 折叠、缺口优先）+ 卡文「现 B2 规则递归扩展」。B2 原本只有树形特性块一处
 * 判据（`BoardTreeView.boardFeatureDefaultExpanded`），本期收敛到本模块，并由树/列表/表格三视图
 * 在**每一层折叠点**（epic 章 / 期次组 / 稿层分组）共用同一份递归实现（禁二份）。
 */
import { groupBoardFeaturesByEpic } from "./boardEpicContainers.js";
import type { BoardFeatureNode, BoardTaskNode, BoardViewModel } from "./boardViewModel.js";

/** 折叠判据输入节点：叶级 = 稿（自身段位/缺口）；容器层 = 子节点（直接成员）之集。 */
interface BoardFoldNode {
  /** 缺口（attention）：非空即展开——缺口优先于终态与一切（缺口不许被埋）。 */
  attention: readonly unknown[];
  /** 段位（`BOARD_STAGES` 词表）；层头无段位（epic/期次层）传 null。 */
  stage: string | null;
  /** 子节点（容器层 = 直接成员，递归求值）；叶级缺省。 */
  children?: readonly BoardFoldNode[];
}

/** 终态段位词（全完成/全取消折叠：无缺口 + 全终态 → 折叠）。 */
function isBoardFoldTerminalStage(stage: string | null): boolean {
  return stage === "已完成" || stage === "已取消";
}

/** 折叠默认态判据（单点，递归一份）：缺口展开 → 含活跃成员展开 → 全终态折叠 → 其余展开。 */
export function boardFoldDefaultExpanded(node: BoardFoldNode): boolean {
  // 缺口优先：本层自身的缺口（叶级 = 稿的 attention；容器层 = 层自身的缺口位，通常为空）。
  if (node.attention.length > 0) return true;
  const children = node.children;
  if (children !== undefined && children.length > 0) {
    // 递归：任一直接成员展开（含活跃期次/缺口跨层传播）→ 本层展开；全终态成员的组 → 折叠。
    return children.some((child) => boardFoldDefaultExpanded(child));
  }
  return !isBoardFoldTerminalStage(node.stage);
}

/**
 * 折叠覆盖表（会话记忆载体）：`foldId → 用户显式展开态`。只有被用户动过的组才落键；
 * 未落键的组一律按默认态规则（`boardFoldDefaultExpanded`）求值。
 */
export type BoardFoldState = Readonly<Record<string, boolean>>;

/** 解析记忆值（单点；纯函数）：坏 JSON / 非对象 / 非布尔值逐条丢弃——读了不认识的值不猜语义。 */
export function parseBoardFoldState(raw: string | null): BoardFoldState {
  if (raw === null || raw === "") return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const state: Record<string, boolean> = {};
    for (const [id, open] of Object.entries(parsed)) {
      if (typeof open === "boolean") state[id] = open;
    }
    return state;
  } catch {
    return {};
  }
}

export function serializeBoardFoldState(state: BoardFoldState): string {
  return JSON.stringify(state);
}

/**
 * 折叠控制（宿主持有并做会话记忆）：四个视图与容器单点共用这一份传参形态——视图只投影
 * `resolveBoardFoldOpen(state, foldId, defaultExpanded)`，用户动作原样回传 `onToggle`。
 * 缺省（不传）= 只读渲染，一切按默认态（SSR 断言与既有调用面零改动）。
 */
export interface BoardFoldControls {
  state: BoardFoldState;
  onToggle: (foldId: string, open: boolean) => void;
}

/** 稿层默认态（叶级 B2 判据单点：树形特性块 / 列表分组 / 表格分组行共用）。 */
export function boardFeatureFoldExpanded(feature: {
  attention: readonly unknown[];
  stage: string | null;
}): boolean {
  return boardFoldDefaultExpanded({ attention: feature.attention, stage: feature.stage });
}

/** 容器层默认态（epic 章 / 期次组）：子 = 该层**实际承载**的成员（视图侧投影同口径）。 */
export function boardContainerFoldExpanded(
  members: readonly { attention: readonly unknown[]; stage: string | null }[],
): boolean {
  return boardFoldDefaultExpanded({
    attention: [],
    stage: null,
    children: members.map((member) => ({ attention: member.attention, stage: member.stage })),
  });
}

/* ---------------- 折叠 id 与覆盖解析（消费面共用单点） ---------------- */

/**
 * 层 id 命名：epic 层 = 登记 id 形态 `epic:<码>`（与 `features[].epic` 引用同域）；期次层 =
 * `phase:<码>#<期次序>`；稿层 = 稿自身 id（`plan:`/`spec:` 前缀，天然不与容器层撞键）。
 * 三个命名空间只活在会话记忆里（视图偏好，不落板），撞键的代价仅是该组折叠态被共用。
 */
export function boardEpicFoldId(code: string): string {
  return `epic:${code}`;
}

export function boardPhaseFoldId(code: string, phase: number): string {
  return `phase:${code}#${phase}`;
}

/** 最终展开态 = 用户覆盖 ?? 默认态（单点；各视图折叠点与表格按钮共用）。 */
export function resolveBoardFoldOpen(
  state: BoardFoldState,
  foldId: string,
  defaultExpanded: boolean,
): boolean {
  return state[foldId] ?? defaultExpanded;
}

/** 覆盖写入（纯函数）：只动这一键，返回新表。 */
export function withBoardFoldOpen(
  state: BoardFoldState,
  foldId: string,
  open: boolean,
): BoardFoldState {
  return { ...state, [foldId]: open };
}

/** 批量置展开（跳转揭示：目标卡片的三层祖先一次展开；同一写路径，不另开一条）。 */
export function withBoardFoldExpanded(
  state: BoardFoldState,
  foldIds: readonly string[],
): BoardFoldState {
  if (foldIds.length === 0) return state;
  const next: Record<string, boolean> = { ...state };
  for (const foldId of foldIds) next[foldId] = true;
  return next;
}

/**
 * 跳转揭示判据（消费契约 §13.7 B2「跳转落点在折叠块内时宿主先展开再滚动」）：给一个卡片 id，
 * 回其**祖先折叠 id 集**（稿 → epic → 期次，按收集序）。表格视图的分组行是条件渲染，折叠组
 * 的落点根本不在 DOM 里——揭示必须先展开三层（DOM 侧 `details.open` 兜底只够树/列表/看板）。
 * 无归属稿只回稿层（不造不存在的容器）；板上没有的 id 回空集（不猜）。
 */
export function boardFoldIdsOfCard(board: BoardViewModel, cardId: string): string[] {
  const feature = board.features.find((candidate) => featureContainsCard(candidate, cardId));
  if (feature === undefined) return [];
  const ids = [feature.id];
  for (const group of groupBoardFeaturesByEpic(board).epics) {
    for (const phaseGroup of group.phases) {
      if (phaseGroup.features.some((member) => member.id === feature.id)) {
        ids.push(
          boardEpicFoldId(group.epic.code),
          boardPhaseFoldId(group.epic.code, phaseGroup.phase),
        );
      }
    }
  }
  return ids;
}

function featureContainsCard(feature: BoardFeatureNode, cardId: string): boolean {
  if (feature.id === cardId) return true;
  const taskContains = (task: BoardTaskNode): boolean =>
    task.id === cardId || task.children.some(taskContains);
  return feature.tasks.some(taskContains);
}
