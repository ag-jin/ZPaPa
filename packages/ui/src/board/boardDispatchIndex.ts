/**
 * `dispatch` 派生段（提案形状 `dispatch/1`，卡 #185）的只读映射。
 *
 * 口径真源：`evidence/T185/schema-proposal.txt`（编译器字段提案；判据权威 =
 * `skills/zcode-board/assets/tools/next-dispatch.mjs`——编译器侧将来与 CLI 共用同一推导实现）。
 *
 * 边界（契约 §13.6 同纪律；AD-11③）：
 * - 本模块只做形态映射：**成员/顺序/计数/域文本照读**（不重排、不合并、不改判据、
 *   不按 `status`/`blockers`/`activeRun`/`runs` 重推任何编排结论）；
 * - 整段可用性：`dispatch` 段缺失或关键字段形态坏 → `null`（未就绪）——消费面指名重编译，
 *   不部分渲染制造假象（与四段索引「缺任一键 = 整体不可用」同口径）；
 * - 条目按段内原序透出，只做最小形态收敛（缺 `no` 等身份字段的条目整条丢弃，不猜）。
 */
import {
  isRecord,
  readPositiveInteger,
  readPositiveCount,
  readText,
  readTextList,
} from "./boardJsonRead.js";

/** 域映射（CLI `domainForCard` 结论；`unknown` = 无任何声明面可推断）。 */
export interface BoardDispatchDomain {
  files: string[];
  /** 声明来源（如「计划稿冲突区」「卡文」「无声明」；原文透出，本地化归显示层）。 */
  source: string;
  /** 置信（高/中/低/未知；原文透出）。 */
  confidence: string;
  unknown: boolean;
}

/** 在途卡（CLI deriveInFlight 结论；域占随行）。 */
export interface BoardDispatchInFlightCard {
  no: number;
  title: string;
  nextAssignee: string | null;
  domain: BoardDispatchDomain;
}

export interface BoardDispatchInFlight {
  source: string;
  count: number;
  slotsFree: number;
  cards: BoardDispatchInFlightCard[];
}

/** 可派卡（frontier rank 序，已扣在途与域占）。 */
export interface BoardDispatchCard {
  no: number;
  title: string;
  rank: number | null;
  nextAssignee: string | null;
  domain: BoardDispatchDomain;
}

/** 域占命中（CLI `detail` 条目）。 */
export interface BoardDispatchDomainHit {
  file: string;
  occupiedBy: number;
  occupyFile: string | null;
}

/** 不可派逐张证据（domain = 域被在途占；dependency = 板 blocked 归因）。 */
export interface BoardDispatchBlockedEntry {
  no: number;
  title: string;
  kind: string;
  by: number[];
  targetInFlight: boolean;
  evidence: string;
  detail: BoardDispatchDomainHit[];
}

/** 汇总（CLI `summary` 原文透出；仅诊断/空态文案用）。 */
export interface BoardDispatchSummary {
  frontier: number;
  dispatchable: number;
  dispatchableFree: number;
  needsReview: number;
  blocked: number;
  inFlight: number;
  slotsFree: number;
}

export interface BoardDispatchIndex {
  capacity: number;
  inFlight: BoardDispatchInFlight;
  dispatchable: BoardDispatchCard[];
  parallelGroup: number[];
  needsReview: number[];
  blocked: BoardDispatchBlockedEntry[];
  summary: BoardDispatchSummary | null;
}

function readDomain(value: unknown): BoardDispatchDomain | null {
  if (!isRecord(value)) return null;
  const files = readTextList(value.files);
  const source = readText(value.source);
  const confidence = readText(value.confidence);
  if (source === null || confidence === null) return null;
  return { files, source, confidence, unknown: value.unknown === true };
}

function readInFlightCard(value: unknown): BoardDispatchInFlightCard | null {
  if (!isRecord(value)) return null;
  const no = readPositiveInteger(value.no);
  const domain = readDomain(value.domain);
  if (no === null || domain === null) return null;
  return {
    no,
    title: readText(value.title) ?? "",
    nextAssignee: readText(value.nextAssignee),
    domain,
  };
}

function readDispatchableCard(value: unknown): BoardDispatchCard | null {
  if (!isRecord(value)) return null;
  const no = readPositiveInteger(value.no);
  const domain = readDomain(value.domain);
  if (no === null || domain === null) return null;
  return {
    no,
    title: readText(value.title) ?? "",
    rank: readPositiveInteger(value.rank),
    nextAssignee: readText(value.nextAssignee),
    domain,
  };
}

function readBlockedEntry(value: unknown): BoardDispatchBlockedEntry | null {
  if (!isRecord(value)) return null;
  const no = readPositiveInteger(value.no);
  const kind = readText(value.kind);
  if (no === null || kind === null) return null;
  const detail = Array.isArray(value.detail)
    ? value.detail.flatMap((hit) => {
        if (!isRecord(hit)) return [];
        const occupiedBy = readPositiveInteger(hit.occupiedBy);
        const file = readText(hit.file);
        if (occupiedBy === null || file === null) return [];
        return [{ file, occupiedBy, occupyFile: readText(hit.occupyFile) }];
      })
    : [];
  return {
    no,
    title: readText(value.title) ?? "",
    kind,
    by: Array.isArray(value.by)
      ? value.by.flatMap((entry) => {
          const target = readPositiveInteger(entry);
          return target === null ? [] : [target];
        })
      : [],
    targetInFlight: value.targetInFlight === true,
    evidence: readText(value.evidence) ?? "",
    detail,
  };
}

function readNumberList(value: unknown): number[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    const no = readPositiveInteger(entry);
    return no === null ? [] : [no];
  });
}

function readSummary(value: unknown): BoardDispatchSummary | null {
  if (!isRecord(value)) return null;
  return {
    frontier: readPositiveCount(value.frontier),
    dispatchable: readPositiveCount(value.dispatchable),
    dispatchableFree: readPositiveCount(value.dispatchableFree),
    needsReview: readPositiveCount(value.needsReview),
    blocked: readPositiveCount(value.blocked),
    inFlight: readPositiveCount(value.inFlight),
    slotsFree: readPositiveCount(value.slotsFree),
  };
}

/**
 * `dispatch` 段映射：段缺失或关键字段形态坏 → `null`（未就绪）。
 * 关键字段（恒写出面）：`capacity` 正整数、`inFlight`（record：`cards` 数组 + 计数）、
 * `dispatchable[]`、`parallelGroup[]`、`needsReview[]`、`blocked[]`；`summary` 可选（诊断面）。
 */
export function readDispatchIndex(parsed: Record<string, unknown>): BoardDispatchIndex | null {
  const raw = parsed.dispatch;
  if (!isRecord(raw)) return null;
  const capacity = readPositiveInteger(raw.capacity);
  const rawInFlight = raw.inFlight;
  if (capacity === null || !isRecord(rawInFlight) || !Array.isArray(rawInFlight.cards)) return null;
  if (!Array.isArray(raw.dispatchable)) return null;
  if (!Array.isArray(raw.parallelGroup)) return null;
  if (!Array.isArray(raw.needsReview)) return null;
  if (!Array.isArray(raw.blocked)) return null;
  return {
    capacity,
    inFlight: {
      source: readText(rawInFlight.source) ?? "",
      count: readPositiveCount(rawInFlight.count),
      slotsFree: readPositiveCount(rawInFlight.slotsFree),
      cards: rawInFlight.cards.flatMap((entry) => {
        const card = readInFlightCard(entry);
        return card === null ? [] : [card];
      }),
    },
    dispatchable: raw.dispatchable.flatMap((entry) => {
      const card = readDispatchableCard(entry);
      return card === null ? [] : [card];
    }),
    parallelGroup: readNumberList(raw.parallelGroup),
    needsReview: readNumberList(raw.needsReview),
    blocked: raw.blocked.flatMap((entry) => {
      const blockedEntry = readBlockedEntry(entry);
      return blockedEntry === null ? [] : [blockedEntry];
    }),
    summary: readSummary(raw.summary),
  };
}
