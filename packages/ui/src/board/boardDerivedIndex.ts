/**
 * 四段派生索引（`frontier[]`/`active[]`/`blocked[]`/`recent[]`）的只读映射（#136/C3-1；
 * 从 `boardViewModel` 拆出，映射语义逐字不变）。
 *
 * 口径真源：`board.schema.json` x-decisions 四段条 + 消费契约 §13.6（#135 成文段）——
 * 编译器是四段唯一所有者，UI/hook 只读消费：**成员/顺序/计数照读**（不重排、不改判据、
 * 不合并节点），不得按 `status`/`blockers`/`activeRun`/`runs` 自算前沿或槽位计数。
 * 四段恒写出（空段 = `[]`）；本模块只做形态映射，条目缺 `no` 等最小身份字段即整条丢弃（不猜）。
 */
import { isRecord, readActiveRun, readPositiveInteger, readText } from "./boardJsonRead.js";
import type { BoardActiveRun } from "./boardViewModel.js";

export interface BoardDerivedFrontierEntry {
  /** 板序 rank=1..n（照读，不重排）。 */
  rank: number;
  no: number;
  title: string;
  stage: string | null;
  nextAssignee: string | null;
  /** 已解除依赖号（数组形态；不含未解除项）。 */
  resolvedDeps: number[];
}

/** 在途活跃条目（stage ∈ 执行中/审核中；板级五槽「运行/待收口」同源于本段）。 */
export interface BoardDerivedActiveEntry {
  no: number;
  title: string;
  stage: string | null;
  currentAssignee: string | null;
  activeRun: BoardActiveRun | null;
  nextAssignee: string | null;
}

/** 受阻归因条目（一卡多项出多行；`targetId` 为依赖目标稳定号，缺号 → null）。 */
export interface BoardDerivedBlockedEntry {
  no: number;
  title: string;
  stage: string | null;
  blockerKind: string;
  targetId: number | null;
  summary: string;
}

/** 最近活动条目（不带 runId：事件身份由 (no, at, role) 承载）。 */
export interface BoardDerivedRecentEntry {
  no: number;
  title: string;
  at: string;
  role: string;
  result: string;
  stoppedAt: number | null;
  next: string | null;
}

export interface BoardDerivedIndex {
  frontier: BoardDerivedFrontierEntry[];
  active: BoardDerivedActiveEntry[];
  blocked: BoardDerivedBlockedEntry[];
  recent: BoardDerivedRecentEntry[];
}

/** 正整数数组（frontier.resolvedDeps）：非整数/非正项丢弃（不猜号位）。 */
function readPositiveIntegers(value: unknown): number[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    const no = readPositiveInteger(entry);
    return no === null ? [] : [no];
  });
}

/**
 * 四段派生映射：**四段键全为数组**才视为齐备（编译器四段恒写出；缺任一 = 旧版产物/残缺板 →
 * `null`，消费面指名重编译，不部分渲染制造假象）。条目按板序原样透出，只做最小形态收敛。
 */
export function readDerivedIndex(parsed: Record<string, unknown>): BoardDerivedIndex | null {
  const rawFrontier = parsed.frontier;
  const rawActive = parsed.active;
  const rawBlocked = parsed.blocked;
  const rawRecent = parsed.recent;
  if (
    !Array.isArray(rawFrontier) ||
    !Array.isArray(rawActive) ||
    !Array.isArray(rawBlocked) ||
    !Array.isArray(rawRecent)
  ) {
    return null;
  }
  const frontier = rawFrontier.flatMap((entry) => {
    if (!isRecord(entry)) return [];
    const no = readPositiveInteger(entry.no);
    if (no === null) return [];
    return [
      {
        rank: readPositiveInteger(entry.rank) ?? 0,
        no,
        title: readText(entry.title) ?? "",
        stage: readText(entry.stage),
        nextAssignee: readText(entry.nextAssignee),
        resolvedDeps: readPositiveIntegers(entry.resolvedDeps),
      },
    ];
  });
  const active = rawActive.flatMap((entry) => {
    if (!isRecord(entry)) return [];
    const no = readPositiveInteger(entry.no);
    if (no === null) return [];
    return [
      {
        no,
        title: readText(entry.title) ?? "",
        stage: readText(entry.stage),
        currentAssignee: readText(entry.currentAssignee),
        activeRun: readActiveRun(entry.activeRun),
        nextAssignee: readText(entry.nextAssignee),
      },
    ];
  });
  const blocked = rawBlocked.flatMap((entry) => {
    if (!isRecord(entry)) return [];
    const no = readPositiveInteger(entry.no);
    const blockerKind = readText(entry.blockerKind);
    if (no === null || blockerKind === null) return [];
    return [
      {
        no,
        title: readText(entry.title) ?? "",
        stage: readText(entry.stage),
        blockerKind,
        targetId: readPositiveInteger(entry.targetId),
        summary: readText(entry.summary) ?? "",
      },
    ];
  });
  const recent = rawRecent.flatMap((entry) => {
    if (!isRecord(entry)) return [];
    const no = readPositiveInteger(entry.no);
    const at = readText(entry.at);
    if (no === null || at === null) return [];
    return [
      {
        no,
        title: readText(entry.title) ?? "",
        at,
        role: readText(entry.role) ?? "",
        result: readText(entry.result) ?? "",
        stoppedAt: readPositiveInteger(entry.stoppedAt),
        next: readText(entry.next),
      },
    ];
  });
  return { frontier, active, blocked, recent };
}
