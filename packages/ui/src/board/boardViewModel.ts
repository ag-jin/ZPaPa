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

export interface BoardTaskNode {
  /** 渲染 key：有稳定号用号，否则用父节点下序号。 */
  id: string;
  no: number | null;
  label: string | null;
  title: string;
  status: string | null;
  /** 段位溯源（契约 §13.1；应用侧只读，不自算段位）。 */
  statusRule: string | null;
  stage: string | null;
  draft: boolean;
  attention: BoardAttentionCode[];
  blockerCount: number;
  lastRun: BoardLastRun | null;
  activeRun: BoardActiveRun | null;
  worktree: string | null;
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
  status: string | null;
  /** 段位溯源（契约 §13.1；已取消列展示取消原因的来源）。 */
  statusRule: string | null;
  stage: string | null;
  attention: BoardAttentionCode[];
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

function readNonNegativeInteger(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.trunc(value) : 0;
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
  const totalTasks = readNonNegativeInteger(value.totalTasks);
  const completedTasks = readNonNegativeInteger(value.completedTasks);
  if (totalTasks <= 0 && completedTasks <= 0) return null;
  return { totalTasks, completedTasks };
}

function readBlockerCount(value: unknown): number {
  return Array.isArray(value) ? value.length : 0;
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
    status: readText(node.status),
    statusRule: readText(node.statusRule),
    stage: readText(node.stage),
    draft: node.draft === true,
    attention: readAttentionCodes(node.attention),
    blockerCount: readBlockerCount(node.blockers),
    lastRun: readLastRun(node.lastRun),
    activeRun: readActiveRun(node.activeRun),
    worktree: readText(node.worktree),
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
    status: readText(node.status),
    statusRule: readText(node.statusRule),
    stage: readText(node.stage),
    attention: readAttentionCodes(node.attention),
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
    interviewedNotArranged: readNonNegativeInteger(value.interviewedNotArranged),
    arrangedNotExpanded: readNonNegativeInteger(value.arrangedNotExpanded),
    interruptedResume: readNonNegativeInteger(value.interruptedResume),
    unmergedWorktree: readNonNegativeInteger(value.unmergedWorktree),
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
