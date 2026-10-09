/**
 * 项目看板（board.json v2）的只读视图模型（卡 #32「UI tracer：只读树形视图面板」）。
 *
 * 边界（消费契约 §0/§7.2）：应用侧只读 `<工作目录>/.zcode/board/board.json` 一个文件，
 * 不解析任何真相源、不做状态推导；本模块只做「JSON → 可渲染结构」的映射与版本门禁。
 * 字段与判据的单一真源：`.zcode/board/board-consumption-contract.md` §0/§2/§3/§4
 * 与 `~/.zcode/skills/zcode-board/assets/samples/board.golden.json`。
 *
 * 版本门禁：不认识的主版本一律空态 C（damaged），不猜测渲染（契约 §2/§12）。
 */

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
  return typeof value === "string" && (BOARD_STATUS_VALUES as readonly string[]).includes(value);
}

/** 缺口码取值守卫（契约 §4 四个固定词汇）：不认识即不筛，不猜语义。 */
export function isBoardAttentionCode(value: unknown): value is BoardAttentionCode {
  return typeof value === "string" && (BOARD_ATTENTION_CODES as readonly string[]).includes(value);
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
  worktree: string | null;
  pr: BoardPr | null;
  createdAt: string | null;
  /** 卡龄排序基准（契约 §3.5；= max(源推导时间, 最新 run.at)，编译器已算好）。 */
  updatedAt: string | null;
  children: BoardTaskNode[];
}

export interface BoardFeatureNode {
  id: string;
  no: number | null;
  label: string | null;
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

export interface BoardViewModel {
  version: number;
  projectName: string;
  projectRoot: string | null;
  updatedAt: string | null;
  features: BoardFeatureNode[];
  attentionSummary: BoardAttentionSummary;
  diagnostics: BoardDiagnostic[];
}

export type BoardParseOutcome =
  | { kind: "ready"; board: BoardViewModel }
  | { kind: "empty" }
  | { kind: "damaged" };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readText(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function readPositiveInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : null;
}

/**
 * 计数读取（`attentionSummary` 四项与 `progress` 两项共用）：只认**正整数**，其余一律 0。
 * 名字与行为对齐（评审 S1）：不是「非负」——`0` 与缺省同为 0；小数/非数不 trunc
 * （2.5 若被截成 2，界面上会多出一个「看起来像真的」的计数）。
 */
function readPositiveCount(value: unknown): number {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : 0;
}

/** 未知缺口码不进徽章（契约只给四个固定词汇的文案；未知码不猜）。 */
function readAttentionCodes(value: unknown): BoardAttentionCode[] {
  if (!Array.isArray(value)) return [];
  return BOARD_ATTENTION_CODES.filter((code) => value.includes(code));
}

function readLastRun(value: unknown): BoardLastRun | null {
  if (!isRecord(value)) return null;
  const at = readText(value.at);
  const role = readText(value.role);
  const result = readText(value.result);
  if (!at && !role && !result) return null;
  return {
    at: at ?? "",
    role: role ?? "",
    result: result ?? "",
    stoppedAt: readPositiveInteger(value.stoppedAt),
    next: readText(value.next),
  };
}

function readActiveRun(value: unknown): BoardActiveRun | null {
  if (!isRecord(value)) return null;
  const role = readText(value.role);
  if (!role) return null;
  return { role, at: readText(value.at) };
}

function readProgress(value: unknown): BoardProgress | null {
  if (!isRecord(value)) return null;
  const totalTasks = readPositiveCount(value.totalTasks);
  const completedTasks = readPositiveCount(value.completedTasks);
  if (totalTasks <= 0 && completedTasks <= 0) return null;
  return { totalTasks, completedTasks };
}

/** 字符串数组（evidence / assignees）：非字符串项丢弃，空串丢弃（不渲染空路径）。 */
function readTextList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    const text = readText(entry);
    return text === null ? [] : [text];
  });
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

function mapTask(raw: unknown, parentId: string, index: number): BoardTaskNode {
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
    worktree: readText(node.worktree),
    pr: readPr(node.pr),
    createdAt: readText(node.createdAt),
    updatedAt: readText(node.updatedAt),
    children: Array.isArray(node.tasks)
      ? node.tasks.map((child, childIndex) => mapTask(child, id, childIndex))
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
    kind: readText(node.kind),
    title: readText(node.title) ?? "",
    details: readText(node.details),
    status: readText(node.status),
    statusRule: readText(node.statusRule),
    stage: readText(node.stage),
    attention: readAttentionCodes(node.attention),
    blockers: readBlockers(node.blockers),
    assignees: readTextList(node.assignees),
    origin: readOrigin(node.origin),
    evidence: readTextList(node.evidence),
    createdAt: readText(node.createdAt),
    progress: readProgress(node.progress),
    updatedAt: readText(node.updatedAt),
    tasks: Array.isArray(node.tasks)
      ? node.tasks.map((task, taskIndex) => mapTask(task, id, taskIndex))
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
 * - JSON 解析失败 / 顶层非对象 / 主版本不认识 / features 非数组 → damaged（空态 C）；
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
  if (parsed.version !== BOARD_KNOWN_VERSION) return { kind: "damaged" };
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
      features: parsed.features.map((feature, index) => mapFeature(feature, index)),
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
