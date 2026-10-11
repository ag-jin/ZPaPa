/**
 * 编排视图（`dispatch` 面，#185）的只读投影。
 *
 * 边界（消费契约 §13.6 同纪律；提案见 `evidence/T185/schema-proposal.txt`）：
 * - 视图不写板文件、不解析真相源、**不做任何编排判据**：可派清单/阻塞归因/并发组/槽位
 *   全部直取 `board.dispatchIndex`（编译器 `dispatch` 段，判据权威 = next-dispatch.mjs）——
 *   成员/顺序/计数**照读**（不重排、不裁剪、不合并）；UI 本地只做节点身份解析
 *   （`task:<no>` → 既有弹窗路由锚点）与词条化文案组装；
 * - 缺段/形态坏（`dispatchIndex === null`）→ `availability: "missing"`，三区一律空 +
 *   视图给「未就绪 + 重编译」指向，**不按 frontier/blocked 自算兜底**（与指引面缺四段同姿态）。
 *
 * 三区口径：
 * - 可派清单 = `dispatchable`（frontier rank 序扣在途/扣域占后的结论面；域未知行带标记）；
 * - 阻塞归因 = `blocked`（domain = 域被在途占；dependency = 板 blocked 归因；逐卡给原因）；
 * - 并发组 = `parallelGroup`（域不相交、按 rank 贪心、受剩余槽位截断的结论面）+ 槽位计数行。
 */
import type {
  BoardDispatchDomain,
  BoardDispatchDomainHit,
  BoardDispatchIndex,
  BoardViewModel,
} from "./boardViewModel.js";
import { collectBoardViewNodes } from "./boardViewsViewModel.js";

/** 可派行（身份 + 处置指引 + 域；顺序即 `dispatchable` 序）。 */
export interface BoardDispatchRow {
  /** 视图节点 id（`task:<no>`）——卡片弹窗路由的既有锚点值。 */
  id: string;
  no: number;
  /** 板面卡层级 label（显示层；板上找不到该卡时 null，不猜）。 */
  label: string | null;
  planCode: string | null;
  title: string;
  /** 接手位（`dispatchable[].nextAssignee` 直读；null = 板面未指派，不猜）。 */
  nextAssignee: string | null;
  domain: BoardDispatchDomain;
  /** 域未知（= CLI needsReview 判据面；照读 `domain.unknown`）。 */
  domainUnknown: boolean;
}

/** 阻塞归因行（逐卡一条，顺序即 `blocked` 序；一卡可多条）。 */
export interface BoardDispatchBlockedRow {
  id: string;
  no: number;
  label: string | null;
  planCode: string | null;
  title: string;
  /** `domain` = 域被在途占；`dependency` = 板 blocked 归因（未知类别原样透出、渲染给中性文案）。 */
  kind: string;
  /** 归因号位（domain = 占域在途卡号；dependency = 目标号；缺号 = []）。 */
  by: number[];
  /** 仅 dependency 段有意义（目标是否在途）；照读，不重判。 */
  targetInFlight: boolean;
  /** 域占命中细节（domain 段；渲染取首条点名「域 X 被在途 #M 占」）。 */
  detail: BoardDispatchDomainHit[];
}

export interface BoardDispatchSummary {
  /** `missing` = 板上无 `dispatch` 段（未就绪；视图给重编译指向，不自算）。 */
  availability: "ready" | "missing";
  /** 并发上限（`dispatch.capacity` 直读；missing → null，不猜缺省）。 */
  capacity: number | null;
  inFlightCount: number;
  slotsFree: number;
  dispatchable: BoardDispatchRow[];
  blocked: BoardDispatchBlockedRow[];
  /** 并发组成员（`parallelGroup` 序的子集行；域未知卡不入组是 CLI 判据的结论面）。 */
  parallelGroup: BoardDispatchRow[];
  /** 板 frontier 规模（`dispatch.summary.frontier` 直读；空态文案用；missing → null）。 */
  frontierCount: number | null;
}

const MISSING_SUMMARY: BoardDispatchSummary = {
  availability: "missing",
  capacity: null,
  inFlightCount: 0,
  slotsFree: 0,
  dispatchable: [],
  blocked: [],
  parallelGroup: [],
  frontierCount: null,
};

/** 节点身份（id/label/planCode）解析：与指引面同一条既有单点（板面节点集只遍历一次）。 */
interface DispatchNodeIdentity {
  id: string;
  label: string | null;
  planCode: string | null;
}

function buildNodeIdentity(board: BoardViewModel): Map<number, DispatchNodeIdentity> {
  const map = new Map<number, DispatchNodeIdentity>();
  for (const node of collectBoardViewNodes(board)) {
    if (node.kind === "task" && node.no !== null && !map.has(node.no)) {
      map.set(node.no, { id: node.id, label: node.label, planCode: node.planCode });
    }
  }
  return map;
}

function identify(identity: Map<number, DispatchNodeIdentity>, no: number): DispatchNodeIdentity {
  return identity.get(no) ?? { id: `task:${no}`, label: null, planCode: null };
}

function toDispatchRow(
  identity: Map<number, DispatchNodeIdentity>,
  card: BoardDispatchIndex["dispatchable"][number],
): BoardDispatchRow {
  const node = identify(identity, card.no);
  return {
    id: node.id,
    no: card.no,
    label: node.label,
    planCode: node.planCode,
    title: card.title,
    nextAssignee: card.nextAssignee,
    domain: card.domain,
    domainUnknown: card.domain.unknown,
  };
}

/**
 * 编排视图投影（纯函数）：直取 `board.dispatchIndex`；缺段 → 未就绪空态。
 * 任何字段都不在视图侧重推（含 `needsReview`：表现为逐行 `domainUnknown`，不另算集合）。
 */
export function buildBoardDispatchSummary(board: BoardViewModel): BoardDispatchSummary {
  const index = board.dispatchIndex;
  if (index === null) return MISSING_SUMMARY;
  const identity = buildNodeIdentity(board);
  const dispatchable = index.dispatchable.map((card) => toDispatchRow(identity, card));
  const rowByNo = new Map(dispatchable.map((row) => [row.no, row]));
  const blocked = index.blocked.map((entry) => {
    const node = identify(identity, entry.no);
    return {
      id: node.id,
      no: entry.no,
      label: node.label,
      planCode: node.planCode,
      title: entry.title,
      kind: entry.kind,
      by: [...entry.by],
      targetInFlight: entry.targetInFlight,
      detail: entry.detail.map((hit) => ({ ...hit })),
    };
  });
  return {
    availability: "ready",
    capacity: index.capacity,
    inFlightCount: index.inFlight.count,
    slotsFree: index.inFlight.slotsFree,
    dispatchable,
    blocked,
    // 并发组成员 = dispatchable 子集，按 `parallelGroup` 原序取行（不重排、不补造）。
    parallelGroup: index.parallelGroup.flatMap((no) => {
      const row = rowByNo.get(no);
      return row ? [row] : [];
    }),
    frontierCount: index.summary?.frontier ?? null,
  };
}
