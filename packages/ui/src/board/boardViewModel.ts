/**
 * 项目看板（board.json v2）的只读视图模型（卡 #32「UI tracer：只读树形视图面板」）。
 *
 * 边界（消费契约 §0/§7.2）：应用侧只读 `<工作目录>/.zcode/board/board.json` 一个文件，
 * 不解析任何真相源、不做状态推导；本模块只做「JSON → 可渲染结构」的映射与版本门禁。
 * 字段与判据的单一真源：`.zcode/board/board-consumption-contract.md` §0/§2/§3/§4
 * 与 `~/.zcode/skills/zcode-board/assets/samples/board.golden.json`。
 *
 * 版本门禁（卡 #70 兼容判定）：不认识的主版本不猜测渲染——板版本高于已知 → version-newer
 * （提示升级应用/技能）；低于已知 → version-older（提示重编译）；同主版本宽容读
 * （minor 差异向前读、未知字段忽略——映射只认契约字段；契约 §14）。
 *
 * #136/C3-1 拆文件不拆语义：低层读取原语归 `boardJsonRead`、四段派生映射归 `boardDerivedIndex`
 * （文件逼近仓库 `max-lines` 上限）；本模块的公开面（含再导出的四段类型）与拆前一致。
 *
 * #185 增：编排派生段 `dispatch` 的映射归 `boardDispatchIndex`（提案形状 `dispatch/1`；
 * 段缺失/形态坏 → `dispatchIndex: null`，消费面指名重编译，不自行派生兜底）。
 */
import { readDerivedIndex } from "./boardDerivedIndex.js";
import type { BoardDerivedFrontierEntry, BoardDerivedIndex } from "./boardDerivedIndex.js";
import { readDispatchIndex } from "./boardDispatchIndex.js";
import type { BoardDispatchIndex } from "./boardDispatchIndex.js";
import {
  isRecord,
  readActiveRun,
  readLastRun,
  readPositiveCount,
  readPositiveInteger,
  readText,
  readTextList,
} from "./boardJsonRead.js";

/** 四缺口码（契约 §4，逐字；其文案在 boardPresentation/词条表内）。 */
export const BOARD_ATTENTION_CODES = [
  "interviewed-not-arranged",
  "arranged-not-expanded",
  "interrupted-resume",
  "unmerged-worktree",
] as const;

export type BoardAttentionCode = (typeof BOARD_ATTENTION_CODES)[number];

/**
 * 七段位词表（按列序/流水序：待设计 → 待办 → 执行中 → 审核中 → 阻塞 → 已完成 → 已取消）。
 *
 * 单一真源：消费契约 §13.1「段位定义与优先级」表（与 `board.schema.json` v2.1 的
 * `stage` 枚举、编译器 `lib/derive.mjs` 的 `deriveStage` 同源）。应用侧**只读渲染，不得自算段位**；
 * 本词表只用于「认识/定位」段位值，不用于派生。
 */
export const BOARD_STAGES = [
  "待设计",
  "待办",
  "执行中",
  "审核中",
  "阻塞",
  "已完成",
  "已取消",
] as const;

export type BoardStage = (typeof BOARD_STAGES)[number];

/** schema v2.1 的 `status` 枚举（过滤控件取值用；判定口径仍只读板上字段）。 */
export const BOARD_STATUS_VALUES = [
  "pending",
  "active",
  "blocked",
  "completed",
  "cancelled",
] as const;

export type BoardStatusValue = (typeof BOARD_STATUS_VALUES)[number];

/** 状态取值守卫（契约 §3.2 四态 + v2.1 `cancelled`）：UI 取值只在闭集内，不认识即不筛。 */
export function isBoardStatusValue(value: unknown): value is BoardStatusValue {
  // #60/T-3：不裸 `as`（原 `(… as readonly string[]).includes`）——闭集数组逐项比较，
  // 类型收窄由 `value is` 谓词显式承担。
  return typeof value === "string" && BOARD_STATUS_VALUES.some((candidate) => candidate === value);
}

/** 缺口码取值守卫（契约 §4 四个固定词汇）：不认识即不筛，不猜语义。 */
export function isBoardAttentionCode(value: unknown): value is BoardAttentionCode {
  return typeof value === "string" && BOARD_ATTENTION_CODES.some((code) => code === value);
}

/** 应用侧认识的 board.json 主版本（schema v2，T1 冻结）。 */
export const BOARD_KNOWN_VERSION = 2;

export const EMPTY_ATTENTION_SUMMARY: BoardAttentionSummary = Object.freeze({
  interviewedNotArranged: 0,
  arrangedNotExpanded: 0,
  interruptedResume: 0,
  unmergedWorktree: 0,
});

export interface BoardAttentionSummary {
  interviewedNotArranged: number;
  arrangedNotExpanded: number;
  interruptedResume: number;
  unmergedWorktree: number;
}

export interface BoardLastRun {
  at: string;
  role: string;
  result: string;
  stoppedAt: number | null;
  next: string | null;
}

export interface BoardActiveRun {
  role: string;
  at: string | null;
}

export interface BoardProgress {
  totalTasks: number;
  completedTasks: number;
}

/**
 * 首屏五槽计数（#219/D6；v3 薄索引面 `INDEX.json.screen` 的只读投影）：
 * 需处理 / 阻塞 / 运行 / 待收口 / 最近活动——与 `boardGuideViewModel` 的五槽键一一对应。
 * 只有 INDEX 路径产出；旧面（board.json）为 `null`（五槽计数在旧面走四段派生 `derivedIndex`）。
 * 单点口径见消费契约 §15.2（`screen.attention` = attentionSummary 合计等），应用侧只读，不自算。
 */
export interface BoardScreenCounts {
  attention: number;
  blocked: number;
  running: number;
  review: number;
  recent: number;
}

/**
 * 阻拦项（契约 §6「阻拦」区块；形态真源 `board.golden.json`）：
 * `external` → summary + 证据；`dependency` → 对方稳定号 `blockedBy`（可跳转）。
 * 两者都可能缺字段（golden 真实形态：dependency 可以没有 `blockedBy`）——缺就留 null，不编造。
 */
export interface BoardBlocker {
  /** 原值透出（契约只给 external / dependency 两种文案；不认识的 kind 不猜语义）。 */
  kind: string;
  /** dependency 的对方稳定号；缺省即无跳转目标。 */
  blockedBy: number | null;
  summary: string | null;
  evidence: string[];
}

/**
 * 来源（契约 §6「来源」区块）：interviewId / specRoot / sessionId / planRef / type。
 * 契约点名的五个键之外不映射（应用侧只读契约字段，不搬运未知字段）。
 */
export interface BoardOrigin {
  type: string | null;
  interviewId: string | null;
  sessionId: string | null;
  specRoot: string | null;
  planRef: string | null;
}

/** PR 区块（契约 §6「PR（远程模式）」）：远程号 + 链接；两者全缺 → null（区块隐藏）。 */
export interface BoardPr {
  number: number | null;
  url: string | null;
}

export interface BoardTaskNode {
  /** 渲染 key：有稳定号用号，否则用父节点下序号。 */
  id: string;
  no: number | null;
  label: string | null;
  title: string;
  /** 契约 §6「细节」：全文（存储即有界 ≤200 字符）；空串归一为 null（区块隐藏）。 */
  details: string | null;
  status: string | null;
  /** 段位溯源（契约 §13.1；应用侧只读，不自算段位）。 */
  statusRule: string | null;
  stage: string | null;
  draft: boolean;
  attention: BoardAttentionCode[];
  blockers: BoardBlocker[];
  /** 责任管线（§13.5 `assignees` 列）：顺序即管线序；缺省不编造标准管线。 */
  assignees: string[];
  origin: BoardOrigin | null;
  /** 证据路径（契约 §6「证据路径」）：展示路径文本，不承诺编辑器打开（A3 未验证）。 */
  evidence: string[];
  lastRun: BoardLastRun | null;
  activeRun: BoardActiveRun | null;
  /** 当前执行者（v2.2 / #46 A3）：管线 ∩ activeRun；无 → null（只读映射，不自算）。 */
  currentAssignee: string | null;
  /**
   * 下一接手人（v2.3 / #53）：`assignees[]` 序中首个无 done run 证据的角色；全完成 → null。
   * 卡级字段（特性节点没有）；缺省与 null 同形——应用侧只透传，不自算管线进度。
   */
  nextAssignee: string | null;
  /** 计划稿章节（v2.2 / #46 B2 数据面）：仅计划任务可能非空（树形章节子分组用）。 */
  section: string | null;
  /**
   * 卡片正文（#183 前置核实分支 b 的**数据就绪读取**）：目标（这卡要干什么）。
   * 字段名/截断口径见 evidence/T183/schema-proposal.txt（待契约 + schema 顺延落地）；
   * 编译器尚未产出时恒 null → 弹窗按「未携带」显式空态渲染，不猜、不自算。
   */
  goal: string | null;
  /** 卡片正文：交付面全量枚举（逐项）；字段缺省/坏形态 → 空数组（不猜）。 */
  deliverables: string[];
  /** 卡片正文：验收句（怎么算完成）。 */
  acceptance: string | null;
  /**
   * 卡详情分片指针（#219/D6；v3 薄索引面）：`<任务目录相对路径>/cards/<no>.md`（项目根相对、posix），
   * `null` = 过渡期内联形态（卡文仍在旧面 board.json 内联）。判据与编译器 `isShardedCard` 同构。
   * 旧面（board.json）读取时恒 `null`——分片指针只由 INDEX.json 携带。
   */
  cardFile: string | null;
  /** 结构深度（1 = 特性下第一层；呈现缩进用，不信 label 段数——计划任务 label 是计划内层级）。 */
  depth: number;
  worktree: string | null;
  pr: BoardPr | null;
  createdAt: string | null;
  /** 卡龄排序基准（契约 §3.5；= max(源推导时间, 最新 run.at)，编译器已算好）。 */
  updatedAt: string | null;
  children: BoardTaskNode[];
}

/**
 * epic 登记行透出（§10.2；A4-1 三层容器第一层）：`code`/`title`/`status` 三字段。
 *
 * 只读透出，不做终态推导：`status ∈ {active, cancelled, archived}` 是 epic 壳层终态载体
 * （§10.5「成员活跃不复活 epic 终态」），**不认识的取值原样保留**——由呈现层决定标不标注，
 * 应用侧不猜语义、不把未知值当进行态。
 */
export interface BoardEpicNode {
  code: string;
  title: string;
  status: string | null;
}

export interface BoardFeatureNode {
  id: string;
  no: number | null;
  label: string | null;
  /** 计划码（v2.2 / #46 A1）：4 位显示码（如 UI01）；无计划码 → null。 */
  planCode: string | null;
  /**
   * epic 归属引用（§10.3；A4-1）：登记 id 形态 `epic:<4位码>` 或稳定号（正整数，十进制文本）。
   * 原值形态透出——**归组判据在容器装配层单点判定**（与 board.md 同口径：只有登记 id 且能反查
   * 到 `epics[]` 登记行才归组；稳定号与孤儿引用顶层平铺）。缺省/非法形态 → null（不猜）。
   */
  epic: string | null;
  /** 期次序（§10.3）：单值正整数；缺省/非法 → null。与 `epic` 成对（原子对），单写其一是违规板。 */
  phase: number | null;
  kind: string | null;
  title: string;
  /** 契约 §6「细节」：全文；空串归一为 null（区块隐藏）。 */
  details: string | null;
  status: string | null;
  /** 段位溯源（契约 §13.1；已取消列展示取消原因的来源）。 */
  statusRule: string | null;
  stage: string | null;
  attention: BoardAttentionCode[];
  /** 特性级无 blockers 字段时为空数组；真有也照实映射（不借子树的值）。 */
  blockers: BoardBlocker[];
  assignees: string[];
  /** 当前执行者（v2.2 / #46 A3）：特性级 = 子树首个非空；无 → null。 */
  currentAssignee: string | null;
  origin: BoardOrigin | null;
  evidence: string[];
  createdAt: string | null;
  progress: BoardProgress | null;
  updatedAt: string | null;
  tasks: BoardTaskNode[];
}

export interface BoardDiagnostic {
  path: string;
  message: string;
}

/* ---------------- 四段派生索引（C2-1/#133 编译器产物；C3-1/#136 UI 消费面） ---------------- */

/**
 * 四段派生索引的映射与类型单点在 `boardDerivedIndex`（口径成文见该模块头注释）；
 * 这里原样再导出类型，既有调用方（`boardGuideViewModel` / 测试）导入面零变化。
 */
export type {
  BoardDerivedActiveEntry,
  BoardDerivedBlockedEntry,
  BoardDerivedFrontierEntry,
  BoardDerivedIndex,
  BoardDerivedRecentEntry,
} from "./boardDerivedIndex.js";

/* ---------------- 编排派生段（dispatch/1 提案形状；#185 UI 消费面） ---------------- */

/**
 * 编排派生段的映射与类型单点在 `boardDispatchIndex`（口径成文见该模块头注释；
 * 编译器字段提案 = `evidence/T185/schema-proposal.txt`）。这里原样再导出类型，消费方导入面单点。
 */
export type {
  BoardDispatchBlockedEntry,
  BoardDispatchCard,
  BoardDispatchDomain,
  BoardDispatchDomainHit,
  BoardDispatchInFlight,
  BoardDispatchInFlightCard,
  BoardDispatchIndex,
  BoardDispatchSummary,
} from "./boardDispatchIndex.js";

export interface BoardViewModel {
  version: number;
  projectName: string;
  projectRoot: string | null;
  updatedAt: string | null;
  /**
   * epic 登记行（§10.2；A4-1）：登记序透出。**无 `epics` 键 = 零 epic 项目**（AD-8）——
   * 归一为空数组，渲染层据此平铺（不造容器、不标「未归属」）。
   */
  epics: BoardEpicNode[];
  features: BoardFeatureNode[];
  /**
   * 四段派生索引（C3-1/#136）。`null` = 板上四段缺失（旧版编译器产物/未重编译）——
   * 消费面**不得自算兜底**（契约 §13.6），只许指名重编译。
   */
  derivedIndex: BoardDerivedIndex | null;
  /**
   * 编排派生段（`dispatch/1` 提案形状，#185）。`null` = 板上无该段或形态坏（未就绪）——
   * 编排视图据 `null` 走「未就绪 + 重编译」形态，不自行派生兜底（与 `derivedIndex` 同纪律）。
   */
  dispatchIndex: BoardDispatchIndex | null;
  /**
   * 首屏五槽计数（#219/D6；v3 薄索引面）：只有 INDEX 路径非 `null`（旧面 board.json 为 `null`）。
   * 指引面在 `derivedIndex` 缺失时以它兜五槽计数（契约 §15.2 单点口径），不按卡字段自算。
   */
  screen: BoardScreenCounts | null;
  /**
   * 可执行前沿段（#219/D6；v3 薄索引面 `INDEX.json.frontier`）：只有 INDEX 路径非 `null`。
   * 与 `derivedIndex.frontier` 同形（`BoardDerivedFrontierEntry`）；旧面走 `derivedIndex`。
   */
  frontier: BoardDerivedFrontierEntry[] | null;
  attentionSummary: BoardAttentionSummary;
  diagnostics: BoardDiagnostic[];
}

export type BoardParseOutcome =
  | { kind: "ready"; board: BoardViewModel }
  | { kind: "empty" }
  | { kind: "damaged" }
  | { kind: "version-newer"; version: number }
  | { kind: "version-older"; version: number };

/** 未知缺口码不进徽章（契约只给四个固定词汇的文案；未知码不猜）。 */
function readAttentionCodes(value: unknown): BoardAttentionCode[] {
  if (!Array.isArray(value)) return [];
  return BOARD_ATTENTION_CODES.filter((code) => value.includes(code));
}

function readProgress(value: unknown): BoardProgress | null {
  if (!isRecord(value)) return null;
  const totalTasks = readPositiveCount(value.totalTasks);
  const completedTasks = readPositiveCount(value.completedTasks);
  if (totalTasks <= 0 && completedTasks <= 0) return null;
  return { totalTasks, completedTasks };
}

function readBlockers(value: unknown): BoardBlocker[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    if (!isRecord(entry)) return [];
    const kind = readText(entry.kind);
    if (kind === null) return [];
    return [
      {
        kind,
        blockedBy: readPositiveInteger(entry.blockedBy),
        summary: readText(entry.summary),
        evidence: readTextList(entry.evidence),
      },
    ];
  });
}

function readOrigin(value: unknown): BoardOrigin | null {
  if (!isRecord(value)) return null;
  const origin: BoardOrigin = {
    type: readText(value.type),
    interviewId: readText(value.interviewId),
    sessionId: readText(value.sessionId),
    specRoot: readText(value.specRoot),
    planRef: readText(value.planRef),
  };
  const hasAny = Object.values(origin).some((entry) => entry !== null);
  return hasAny ? origin : null;
}

function readPr(value: unknown): BoardPr | null {
  if (!isRecord(value)) return null;
  const pr: BoardPr = {
    number: readPositiveInteger(value.number),
    url: readText(value.url),
  };
  return pr.number === null && pr.url === null ? null : pr;
}

/**
 * 计划码（v2.2 / #46 A1）：`^[A-Z][A-Z0-9]{3}$` 之外的形态一律不映射（不猜显示码；
 * 编译器对坏值已落 diagnostics，应用侧只做形态守卫）。空串/缺省 → null。
 */
export const BOARD_PLAN_CODE_RE = /^[A-Z][A-Z0-9]{3}$/;

function readPlanCode(value: unknown): string | null {
  const text = readText(value);
  return text !== null && BOARD_PLAN_CODE_RE.test(text) ? text : null;
}

/**
 * epic 归属引用（§10.3；A4-1）：登记 id `epic:<4位码>` 与稳定号（正整数）**原值形态透出**：
 * 稳定号归一为十进制文本（`31` → `"31"`），其余字符串去空白保留。值域/形态校验（前缀、码位、
 * 登记行反查）归 A2-2 的 `--check` 断言包——应用侧只读，不在这里拒收、也不在渲染层猜语义。
 */
function readEpicReference(value: unknown): string | null {
  if (typeof value === "number") {
    return Number.isInteger(value) && value > 0 ? String(value) : null;
  }
  return readText(value);
}

/** epic 登记行（§10.2）：缺 `code` 的行不采纳（归组靠 code 反查，无码行不可归组）；其余字段宽松透出。 */
function readEpics(value: unknown): BoardEpicNode[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    if (!isRecord(entry)) return [];
    const code = readText(entry.code);
    if (code === null) return [];
    return [{ code, title: readText(entry.title) ?? "", status: readText(entry.status) }];
  });
}

function mapTask(raw: unknown, parentId: string, index: number, depth: number): BoardTaskNode {
  const node = isRecord(raw) ? raw : {};
  const no = readPositiveInteger(node.no);
  const label = readText(node.label);
  const id = `task:${no !== null ? String(no) : `${parentId}#${index}`}`;
  return {
    id,
    no,
    label,
    title: readText(node.title) ?? "",
    details: readText(node.details),
    status: readText(node.status),
    statusRule: readText(node.statusRule),
    stage: readText(node.stage),
    draft: node.draft === true,
    attention: readAttentionCodes(node.attention),
    blockers: readBlockers(node.blockers),
    assignees: readTextList(node.assignees),
    origin: readOrigin(node.origin),
    evidence: readTextList(node.evidence),
    lastRun: readLastRun(node.lastRun),
    activeRun: readActiveRun(node.activeRun),
    currentAssignee: readText(node.currentAssignee),
    nextAssignee: readText(node.nextAssignee),
    section: readText(node.section),
    // 卡片正文（#183 数据就绪读取；schema 提案字段，缺省即未携带——与 details 同款宽容读）。
    goal: readText(node.goal),
    deliverables: readTextList(node.deliverables),
    acceptance: readText(node.acceptance),
    // 卡详情分片指针（#219/D6）：旧面 board.json 不携带 → 恒 null；INDEX 路径由 boardIndexViewModel 回填。
    cardFile: readText(node.cardFile),
    depth,
    worktree: readText(node.worktree),
    pr: readPr(node.pr),
    createdAt: readText(node.createdAt),
    updatedAt: readText(node.updatedAt),
    children: Array.isArray(node.tasks)
      ? node.tasks.map((child, childIndex) => mapTask(child, id, childIndex, depth + 1))
      : [],
  };
}

function mapFeature(raw: unknown, index: number): BoardFeatureNode {
  const node = isRecord(raw) ? raw : {};
  const no = readPositiveInteger(node.no);
  const label = readText(node.label);
  // 渲染 key：板内 id 本来就是全板唯一（spec:/plan:/interview: 前缀）；缺 id 时用序号兜底。
  const id = readText(node.id) ?? `feature#${index}`;
  return {
    id,
    no,
    label,
    planCode: readPlanCode(node.planCode),
    epic: readEpicReference(node.epic),
    phase: readPositiveInteger(node.phase),
    kind: readText(node.kind),
    title: readText(node.title) ?? "",
    details: readText(node.details),
    status: readText(node.status),
    statusRule: readText(node.statusRule),
    stage: readText(node.stage),
    attention: readAttentionCodes(node.attention),
    blockers: readBlockers(node.blockers),
    assignees: readTextList(node.assignees),
    currentAssignee: readText(node.currentAssignee),
    origin: readOrigin(node.origin),
    evidence: readTextList(node.evidence),
    createdAt: readText(node.createdAt),
    progress: readProgress(node.progress),
    updatedAt: readText(node.updatedAt),
    tasks: Array.isArray(node.tasks)
      ? node.tasks.map((task, taskIndex) => mapTask(task, id, taskIndex, 1))
      : [],
  };
}

function readAttentionSummary(value: unknown): BoardAttentionSummary {
  if (!isRecord(value)) return { ...EMPTY_ATTENTION_SUMMARY };
  return {
    interviewedNotArranged: readPositiveCount(value.interviewedNotArranged),
    arrangedNotExpanded: readPositiveCount(value.arrangedNotExpanded),
    interruptedResume: readPositiveCount(value.interruptedResume),
    unmergedWorktree: readPositiveCount(value.unmergedWorktree),
  };
}

function readDiagnostics(value: unknown): BoardDiagnostic[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    if (!isRecord(entry)) return [];
    return [
      {
        path: readText(entry.path) ?? "",
        message: readText(entry.message) ?? "",
      },
    ];
  });
}

/**
 * 解析 board.json 文本。
 * - JSON 解析失败 / 顶层非对象 / `version` 缺失或非数 / features 非数组 → damaged（损坏态）；
 * - `version` 与已知主版本比较（兼容判定，卡 #70）：过新 → version-newer；过旧 → version-older；
 *   同主版本 → 宽容读（minor 差异向前读、未知字段忽略——映射只认契约字段），不因板由更新的
 *   minor 编译器产出而拒绝渲染（契约 §14）；
 * - `features: []` → empty（空态 B）；
 * - 其余 → ready（按契约映射为可渲染结构）。
 */
export function parseBoardJson(raw: string): BoardParseOutcome {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { kind: "damaged" };
  }

  if (!isRecord(parsed)) return { kind: "damaged" };
  const boardVersion =
    typeof parsed.version === "number" && Number.isFinite(parsed.version) ? parsed.version : null;
  if (boardVersion === null) return { kind: "damaged" };
  if (boardVersion > BOARD_KNOWN_VERSION) return { kind: "version-newer", version: boardVersion };
  if (boardVersion < BOARD_KNOWN_VERSION) return { kind: "version-older", version: boardVersion };
  if (!Array.isArray(parsed.features)) return { kind: "damaged" };
  if (parsed.features.length === 0) return { kind: "empty" };

  const project = isRecord(parsed.project) ? parsed.project : {};
  return {
    kind: "ready",
    board: {
      version: BOARD_KNOWN_VERSION,
      projectName: readText(project.name) ?? "",
      projectRoot: readText(project.root),
      updatedAt: readText(parsed.updatedAt),
      epics: readEpics(parsed.epics),
      features: parsed.features.map((feature, index) => mapFeature(feature, index)),
      derivedIndex: readDerivedIndex(parsed),
      dispatchIndex: readDispatchIndex(parsed),
      // 旧面（board.json）不携带薄索引面：screen/frontier 恒 null（分片指针见 mapTask 的 cardFile）。
      screen: null,
      frontier: null,
      attentionSummary: readAttentionSummary(parsed.attentionSummary),
      diagnostics: readDiagnostics(parsed.diagnostics),
    },
  };
}

/** 提示条只在 attentionSummary 有非零项时出现（契约 §3.1）。 */
export function hasAttentionSignal(summary: BoardAttentionSummary): boolean {
  return (
    summary.interviewedNotArranged > 0 ||
    summary.arrangedNotExpanded > 0 ||
    summary.interruptedResume > 0 ||
    summary.unmergedWorktree > 0
  );
}
