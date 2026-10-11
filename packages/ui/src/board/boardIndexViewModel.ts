/**
 * 薄索引（`INDEX.json`，板 v3 薄索引面）的只读映射（卡 #219/D6；契约 §15 定稿）。
 *
 * 边界（契约 §0/§7.2/§15）：应用侧只读 `<工作目录>/.zcode/board/INDEX.json` 一个文件——
 * 它只承载「清单 + 指针 + 首屏派生」（`screen` 五槽计数 / `frontier` 前沿投影 / 卡级 `cardFile`
 * 分片指针）；卡文与执行详情**零进索引**（在 `cards/<no>.md` 分片或旧面 `board.json` 内联承载）。
 * 本模块只做「JSON → 可渲染结构」的映射与版本门禁，不解析真相源、不做状态推导、不读盘。
 *
 * 版本门禁（§15.1）：`INDEX.version` 是**板 v3 薄索引面**的独立读取门禁（与 board.json 的
 * `version=2` 双写期并存、互不干涉）；判定沿用 §14 口径——过新 → version-newer（升级应用/技能）；
 * 过旧 → version-older（重编译）；缺失/非数/非有限 → damaged（无比较基准，不猜）。
 *
 * 形状校验（N1 消费面自卫）：INDEX 是**新面**，字段面比 board.json 窄，但下游视图仍按
 * `BoardViewModel` 消费——这里做一层**轻量**结构校验（顶层对象 / version / `features` 数组 /
 * 各特性与任务最小身份字段），形态坏即 `damaged`，不把半成品索引静默当完整板渲染。
 * 字段缺失（如 `screen` / `frontier`）按契约宽容读（缺省即未知，不编造）。
 */
import { readDerivedFrontier } from "./boardDerivedIndex.js";
import { isRecord, readPositiveCount, readPositiveInteger, readText } from "./boardJsonRead.js";
import {
  BOARD_KNOWN_VERSION,
  BOARD_PLAN_CODE_RE,
  type BoardAttentionSummary,
  type BoardFeatureNode,
  type BoardScreenCounts,
  type BoardTaskNode,
  type BoardViewModel,
} from "./boardViewModel.js";
import type { BoardDerivedFrontierEntry } from "./boardDerivedIndex.js";

/** 应用侧认识的 INDEX 主版本（板 v3 薄索引面，契约 §15.1 当前值 3）。 */
export const BOARD_INDEX_KNOWN_VERSION = 3;

export type BoardIndexParseOutcome =
  | { kind: "ready"; board: BoardViewModel }
  | { kind: "empty" }
  | { kind: "damaged" }
  | { kind: "version-newer"; version: number }
  | { kind: "version-older"; version: number };

/** INDEX 不携带的字段一律取「显式缺省」——不猜、不借子树的值（与 board.json 映射同纪律）。 */
function emptyAttentionSummary(): BoardAttentionSummary {
  return {
    interviewedNotArranged: 0,
    arrangedNotExpanded: 0,
    interruptedResume: 0,
    unmergedWorktree: 0,
  };
}

/**
 * `screen` 五槽计数（契约 §15.2）：只认非负整数（其余一律 0）——计数是呈现事实，
 * 小数/负数/非数不 trunc（与 `readPositiveCount` 同款名实统一）。缺省整段 → `null`（未知）。
 */
function readScreen(value: unknown): BoardScreenCounts | null {
  if (!isRecord(value)) return null;
  return {
    attention: readPositiveCount(value.attention),
    blocked: readPositiveCount(value.blocked),
    running: readPositiveCount(value.running),
    review: readPositiveCount(value.review),
    recent: readPositiveCount(value.recent),
  };
}

/** 计划码（与 board.json 映射同一形态守卫；INDEX 只在非空时落键）。 */
function readIndexPlanCode(value: unknown): string | null {
  const text = readText(value);
  return text !== null && BOARD_PLAN_CODE_RE.test(text) ? text : null;
}

/** 依赖阻塞稳定号数组（`blockedBy`）：非正整数项丢弃（不猜号位；契约 §15.2）。 */
function readBlockedBy(value: unknown): number[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    const no = readPositiveInteger(entry);
    return no === null ? [] : [no];
  });
}

/**
 * INDEX 卡级清单 → `BoardTaskNode`：只回填索引携带的字段（号/label/标题/状态/段位 +
 * `blockedBy`（依赖阻塞，摘要/证据缺省）+ `cardFile` 指针）；执行详情与卡文三字段留缺省
 * （点卡时按 `cardFile` 读分片，见 `boardCardDetail`）。嵌套子卡递归。
 */
function mapIndexTask(raw: unknown, parentId: string, index: number, depth: number): BoardTaskNode {
  const node = isRecord(raw) ? raw : {};
  const no = readPositiveInteger(node.no);
  const label = readText(node.label);
  const id = `task:${no !== null ? String(no) : `${parentId}#${index}`}`;
  return {
    id,
    no,
    label,
    title: readText(node.title) ?? "",
    details: null,
    status: readText(node.status),
    statusRule: null,
    stage: readText(node.stage),
    draft: false,
    attention: [],
    // blockedBy 是依赖阻塞稳定号数组（契约 §15.2）：映射为 dependency 阻拦项（摘要/证据缺省，
    // 不编造）；外部阻塞归板面 blocked 面，不在索引字段面。
    blockers: readBlockedBy(node.blockedBy).map((blockedBy) => ({
      kind: "dependency",
      blockedBy,
      summary: null,
      evidence: [],
    })),
    assignees: [],
    origin: null,
    evidence: [],
    lastRun: null,
    activeRun: null,
    currentAssignee: null,
    nextAssignee: null,
    section: null,
    goal: null,
    deliverables: [],
    acceptance: null,
    cardFile: readText(node.cardFile),
    depth,
    worktree: null,
    pr: null,
    createdAt: null,
    updatedAt: null,
    children: Array.isArray(node.tasks)
      ? node.tasks.map((child, childIndex) => mapIndexTask(child, id, childIndex, depth + 1))
      : [],
  };
}

function mapIndexFeature(raw: unknown, index: number): BoardFeatureNode {
  const node = isRecord(raw) ? raw : {};
  const no = readPositiveInteger(node.no);
  const id = `feature#${index}`;
  return {
    id,
    no,
    label: readText(node.label),
    planCode: readIndexPlanCode(node.planCode),
    epic: null,
    phase: null,
    kind: readText(node.kind),
    title: readText(node.title) ?? "",
    details: null,
    status: readText(node.status),
    statusRule: null,
    stage: readText(node.stage),
    attention: [],
    blockers: [],
    assignees: [],
    currentAssignee: null,
    origin: null,
    evidence: [],
    createdAt: null,
    progress: null,
    updatedAt: null,
    tasks: Array.isArray(node.tasks)
      ? node.tasks.map((task, taskIndex) => mapIndexTask(task, id, taskIndex, 1))
      : [],
  };
}

/**
 * INDEX 结构最小校验（N1 消费面自卫；宽容读的底线）：顶层对象、`version` 是有限数、
 * `features` 是数组、每个特性是对象且 `title` 是字符串（最小身份字段）。其余字段缺失按宽容读。
 * 坏形态返回 false → 调用方按 `damaged` 呈现（不把半成品索引当完整板渲染）。
 */
export function isBoardIndexShape(value: unknown): value is Record<string, unknown> {
  if (!isRecord(value)) return false;
  if (typeof value.version !== "number" || !Number.isFinite(value.version)) return false;
  if (!Array.isArray(value.features)) return false;
  return value.features.every(
    (feature) =>
      isRecord(feature) &&
      typeof feature.title === "string" &&
      (feature.tasks === undefined || Array.isArray(feature.tasks)),
  );
}

/**
 * 解析 `INDEX.json` 文本 → `BoardViewModel`（薄索引面）。
 * - JSON 解析失败 / 顶层非对象 / version 缺失或非有限 / features 非数组 / 特性形态坏 → damaged；
 * - version 与已知主版本比较（§15.1）：过新 → version-newer；过旧 → version-older；
 *   同主版本宽容读（未知字段忽略）；
 * - `features: []` → empty；
 * - 其余 → ready（`screen`/`frontier` 按契约宽容读，缺省即 null）。
 */
export function parseBoardIndex(raw: string): BoardIndexParseOutcome {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { kind: "damaged" };
  }

  if (!isRecord(parsed)) return { kind: "damaged" };
  const indexVersion =
    typeof parsed.version === "number" && Number.isFinite(parsed.version) ? parsed.version : null;
  if (indexVersion === null) return { kind: "damaged" };
  if (indexVersion > BOARD_INDEX_KNOWN_VERSION) {
    return { kind: "version-newer", version: indexVersion };
  }
  if (indexVersion < BOARD_INDEX_KNOWN_VERSION) {
    return { kind: "version-older", version: indexVersion };
  }
  // 结构校验（N1）：版本已知后再验形状——形态坏与「版本不认识」分开成态。
  // 不裸 `as` 标注形状（#60/T-3 板域守卫）：`Array.isArray` 收窄后 features 才可用。
  const rawFeatures: unknown = parsed.features;
  if (!isBoardIndexShape(parsed) || !Array.isArray(rawFeatures)) return { kind: "damaged" };
  if (rawFeatures.length === 0) return { kind: "empty" };

  const project = isRecord(parsed.project) ? parsed.project : {};
  const frontier: BoardDerivedFrontierEntry[] | null = Array.isArray(parsed.frontier)
    ? readDerivedFrontier(parsed.frontier)
    : null;

  return {
    kind: "ready",
    board: {
      version: BOARD_KNOWN_VERSION,
      projectName: readText(project.name) ?? "",
      projectRoot: readText(project.root),
      updatedAt: readText(parsed.updatedAt),
      // INDEX 不携带 epic 登记行（§15.2 不在字段面）：容器归组降级为空（顶层平铺）。
      epics: [],
      features: rawFeatures.map((feature, index) => mapIndexFeature(feature, index)),
      // 四段派生（active/blocked/recent）不在索引字段面：derivedIndex=null（指引面据 screen 兜五槽）。
      derivedIndex: null,
      dispatchIndex: null,
      screen: readScreen(parsed.screen),
      frontier,
      // attentionSummary 的**四码明细**不在索引字段面（只有 `screen.attention` 合计）：
      // 逐码置零（不编造分布），置顶提示条在 INDEX 路径隐藏——五槽「需处理」计数仍由 screen 承载。
      attentionSummary: emptyAttentionSummary(),
      diagnostics: [],
    },
  };
}
