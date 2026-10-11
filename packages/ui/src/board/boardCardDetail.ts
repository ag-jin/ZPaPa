/**
 * 卡详情按需读取 + 缓存（#219/D6；契约 §15.3 读取契约 2）。
 *
 * 首屏读薄索引 `INDEX.json`（`loadBoardDocument`）；卡文/执行详情**不在索引**里——
 * 点卡/展开时按索引携带的 `cardFile` 指针读 `cards/<no>.md` 分片（分片形态），
 * 或在无指针（`cardFile=null`，过渡期扁平稿）时回落旧面 `board.json` 内联（双形态兼容）。
 *
 * 缓存 + 失效（卡文交付面②）：
 * - 键 = 卡稳定号；**代际** = `工作目录 + INDEX.updatedAt`（板重编译 → `updatedAt` 变 → 换代）；
 * - 换代即整表失效（旧代条目永不命中，也不留在表里），同会话内同卡不重复读（缓存命中）；
 * - 缓存实例由宿主持有（每面板一份），不跨工作区串味；`generation` 变化是唯一失效判据。
 *
 * 分片形态真源：编译器 `renderCardShard` / `renderRunSummary`（`~/.zcode/skills/zcode-board/assets/compile-board.mjs`）——
 * 头部注记 + `## 卡文`（目标 / 交付面全量枚举 / 验收）+ `## 执行摘要`（执行详情，编译器按 runs 回写）。
 * 本模块读卡文三字段（`parseCardShard`）与执行摘要段（`parseCardShardExecution`，#220/D7 执行详情面）。
 */
import { joinFilePath } from "@/lib/path.js";
import {
  BOARD_JSON_MAX_READ_BYTES,
  isBoardFileMissingError,
  resolveBoardJsonPath,
  type BoardFileServicePort,
  type BoardRpcReadyGate,
} from "./loadBoardDocument.js";
import {
  parseBoardJson,
  type BoardActiveRun,
  type BoardLastRun,
  type BoardTaskNode,
  type BoardViewModel,
} from "./boardViewModel.js";

/**
 * 按稳定号在前序遍历中定位任务卡（#219/D6；分片详情/旧面回退共用）：
 * 返回首个 `no` 命中者（板内稳定号唯一）；无 → null。
 */
export function findBoardTaskByNo(board: BoardViewModel, no: number): BoardTaskNode | null {
  const walk = (tasks: BoardTaskNode[]): BoardTaskNode | null => {
    for (const task of tasks) {
      if (task.no === no) return task;
      const hit = walk(task.children);
      if (hit) return hit;
    }
    return null;
  };
  for (const feature of board.features) {
    const hit = walk(feature.tasks);
    if (hit) return hit;
  }
  return null;
}

/** 卡详情补丁（只回填能读到的字段；其余保持索引/旧面缺省——不编造）。 */
export type BoardCardDetailPatch = Partial<
  Pick<
    BoardTaskNode,
    | "goal"
    | "deliverables"
    | "acceptance"
    | "details"
    | "lastRun"
    | "activeRun"
    | "blockers"
    | "assignees"
    | "origin"
    | "evidence"
    | "createdAt"
    | "updatedAt"
    | "statusRule"
    | "attention"
    | "worktree"
    | "pr"
    | "currentAssignee"
    | "nextAssignee"
  >
>;

/**
 * 卡详情读取结果：
 * - `loaded` = 读到（分片三字段 / 旧面整包）；
 * - `missing` = 分片或旧面里没有这张卡（未迁移 / 被删 / 未领号卡无旧面命中）；
 * - `unavailable` = 暂时读不到（断连 / 旧面过大被截断）——不误报成「没有」。
 */
export type BoardCardDetailState =
  | { kind: "loaded"; patch: BoardCardDetailPatch }
  | { kind: "missing" }
  | { kind: "unavailable" };

/**
 * 分片卡文解析（形态真源见本模块头注释）：只取 `## 卡文` 段（目标 / 交付面逐项 / 验收），
 * 到下一个行首 `## ` 标题为止；交付面项 = 该块内缩进 `  - ` 行。缺段/坏形态 → 缺省（不猜）。
 * 纯函数：不读盘、不改入参。
 */
export function parseCardShard(text: string): {
  goal: string | null;
  deliverables: string[];
  acceptance: string | null;
} {
  const lines = text.split(/\r?\n/);
  const cardHeadingIndex = lines.findIndex((line) => /^##\s*卡文\s*$/.test(line));
  if (cardHeadingIndex < 0) return { goal: null, deliverables: [], acceptance: null };
  let endIndex = lines.length;
  for (let i = cardHeadingIndex + 1; i < lines.length; i += 1) {
    if (/^##\s/.test(lines[i] ?? "")) {
      endIndex = i;
      break;
    }
  }
  const block = lines.slice(cardHeadingIndex + 1, endIndex);

  let goal: string | null = null;
  let acceptance: string | null = null;
  const deliverables: string[] = [];
  let inDeliverables = false;
  for (const line of block) {
    const goalMatch = /^-\s*目标:\s*(.*)$/.exec(line);
    if (goalMatch) {
      const value = (goalMatch[1] ?? "").trim();
      goal = value.length > 0 ? value : null;
      inDeliverables = false;
      continue;
    }
    const acceptanceMatch = /^-\s*验收:\s*(.*)$/.exec(line);
    if (acceptanceMatch) {
      const value = (acceptanceMatch[1] ?? "").trim();
      acceptance = value.length > 0 ? value : null;
      inDeliverables = false;
      continue;
    }
    if (/^-\s*交付面全量枚举:\s*$/.test(line)) {
      inDeliverables = true;
      continue;
    }
    if (inDeliverables) {
      const itemMatch = /^\s+-\s+(.*)$/.exec(line);
      if (itemMatch) {
        const value = (itemMatch[1] ?? "").trim();
        if (value.length > 0) deliverables.push(value);
        continue;
      }
      if (line.trim().length > 0) inDeliverables = false;
    }
  }
  return { goal, deliverables, acceptance };
}

/**
 * 分片「## 执行摘要」段解析（#220/D7；形态真源 = 编译器 `renderRunSummary`）：
 * 执行详情（最近执行四要素 + 执行中 + 责任管线/当前/下一接手）由编译器按 runs 回写分片，
 * 本函数按行首锚定的中文标签还原为弹窗执行详情面字段。行形态（逐行，缺省省略）：
 *   `- 最近执行: <at> · <role> · <result>` / `- 停在: #<no>` / `- 下一步: <text>` /
 *   `- 执行中: <role> · <at>` / `- 责任管线: <r1> → <r2> …` / `- 当前执行者: <role>` / `- 下一接手人: <role>`
 * 无该段 / 只有骨架占位（HTML 注释）/ 无可识别行 → null（不猜、不造）。
 * 纯函数：不读盘、不改入参。
 */
export interface BoardCardShardExecution {
  lastRun: BoardLastRun | null;
  activeRun: BoardActiveRun | null;
  assignees: string[];
  currentAssignee: string | null;
  nextAssignee: string | null;
}

export function parseCardShardExecution(text: string): BoardCardShardExecution | null {
  const lines = text.split(/\r?\n/);
  const headingIndex = lines.findIndex((line) => /^##\s*执行摘要\s*$/.test(line));
  if (headingIndex < 0) return null;
  let endIndex = lines.length;
  for (let i = headingIndex + 1; i < lines.length; i += 1) {
    if (/^##\s/.test(lines[i] ?? "")) {
      endIndex = i;
      break;
    }
  }
  const block = lines.slice(headingIndex + 1, endIndex);

  let at: string | null = null;
  let role: string | null = null;
  let result: string | null = null;
  let stoppedAt: number | null = null;
  let next: string | null = null;
  let activeRole: string | null = null;
  let activeAt: string | null = null;
  let assignees: string[] = [];
  let currentAssignee: string | null = null;
  let nextAssignee: string | null = null;

  const text2 = (v: string | undefined) => {
    const t = (v ?? "").trim();
    return t.length > 0 ? t : null;
  };
  for (const line of block) {
    const lastMatch = /^-\s*最近执行:\s*(.*)$/.exec(line);
    if (lastMatch) {
      const parts = (lastMatch[1] ?? "").split(" · ");
      at = text2(parts[0]);
      role = text2(parts[1]);
      result = text2(parts[2]);
      continue;
    }
    const stopMatch = /^-\s*停在:\s*#(\d+)\s*$/.exec(line);
    if (stopMatch) {
      stoppedAt = Number(stopMatch[1]);
      continue;
    }
    const nextMatch = /^-\s*下一步:\s*(.*)$/.exec(line);
    if (nextMatch) {
      next = text2(nextMatch[1]);
      continue;
    }
    const activeMatch = /^-\s*执行中:\s*(.*)$/.exec(line);
    if (activeMatch) {
      const parts = (activeMatch[1] ?? "").split(" · ");
      activeRole = text2(parts[0]);
      activeAt = text2(parts[1]);
      continue;
    }
    const pipelineMatch = /^-\s*责任管线:\s*(.*)$/.exec(line);
    if (pipelineMatch) {
      assignees = (pipelineMatch[1] ?? "")
        .split("→")
        .map((part) => part.trim())
        .filter((part) => part.length > 0);
      continue;
    }
    const currentMatch = /^-\s*当前执行者:\s*(.*)$/.exec(line);
    if (currentMatch) {
      currentAssignee = text2(currentMatch[1]);
      continue;
    }
    const nextAssigneeMatch = /^-\s*下一接手人:\s*(.*)$/.exec(line);
    if (nextAssigneeMatch) {
      nextAssignee = text2(nextAssigneeMatch[1]);
      continue;
    }
  }

  const hasData =
    at !== null ||
    activeRole !== null ||
    assignees.length > 0 ||
    currentAssignee !== null ||
    nextAssignee !== null;
  if (!hasData) return null; // 骨架占位 / 无 run：无执行详情可回填
  const lastRun: BoardLastRun | null =
    at !== null && role !== null && result !== null ? { at, role, result, stoppedAt, next } : null;
  const activeRun: BoardActiveRun | null =
    activeRole !== null ? { role: activeRole, at: activeAt } : null;
  return { lastRun, activeRun, assignees, currentAssignee, nextAssignee };
}

/** 旧面（board.json）内联卡 → 详情补丁（整包执行详情；与分片路径共用同一 `BoardCardDetailPatch`）。 */
function taskNodeToPatch(task: BoardTaskNode): BoardCardDetailPatch {
  return {
    goal: task.goal,
    deliverables: task.deliverables,
    acceptance: task.acceptance,
    details: task.details,
    lastRun: task.lastRun,
    activeRun: task.activeRun,
    blockers: task.blockers,
    assignees: task.assignees,
    origin: task.origin,
    evidence: task.evidence,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
    statusRule: task.statusRule,
    attention: task.attention,
    worktree: task.worktree,
    pr: task.pr,
    currentAssignee: task.currentAssignee,
    nextAssignee: task.nextAssignee,
  };
}

/**
 * 按需读取一张卡的详情：
 * - `cardFile` 非空 → 读 `<工作目录>/<cardFile>` 分片，解析卡文三字段 + 执行摘要段（#220/D7）；
 * - `cardFile` 为空 → 回落旧面 `board.json`（按稳定号定位，整包详情）；无号/未命中 → missing。
 * 只读一个文件，不扫描目录（§7.3）。
 *
 * 错误标签（T4/D7 收口）：只有「ENOENT/文件不存在」才是 `missing`（确定没有）；其余读取失败
 * （断连 / 权限 / 非 ENOENT 的 RPC 错）一律 `unavailable`（暂时读不到）——不得把可恢复的读取失败
 * 误报成「板上没有」（确定性断言），否则弹窗会拿假空态误导用户。
 */
export async function loadBoardCardDetail(params: {
  fileService: BoardFileServicePort;
  workspacePath: string;
  task: { no: number | null; cardFile: string | null };
  isRpcReady?: BoardRpcReadyGate;
}): Promise<BoardCardDetailState> {
  const isRpcReady = params.isRpcReady ?? (() => true);
  if (!isRpcReady()) return { kind: "unavailable" };

  if (params.task.cardFile !== null) {
    const shardPath = joinFilePath(params.workspacePath, params.task.cardFile);
    try {
      const file = await params.fileService.readTextFile({
        path: shardPath,
        offset: 0,
        length: BOARD_JSON_MAX_READ_BYTES,
      });
      if (file.truncated) return { kind: "unavailable" };
      const parsed = parseCardShard(file.content);
      const execution = parseCardShardExecution(file.content);
      const patch: BoardCardDetailPatch = { ...parsed };
      if (execution) {
        patch.lastRun = execution.lastRun;
        patch.activeRun = execution.activeRun;
        patch.assignees = execution.assignees;
        patch.currentAssignee = execution.currentAssignee;
        patch.nextAssignee = execution.nextAssignee;
      }
      return { kind: "loaded", patch };
    } catch (error) {
      // 只有 ENOENT 才是「没有这张卡」；其余（断连/权限/RPC 错）是「暂时读不到」——不误报 missing（T4/D7）。
      if (isBoardFileMissingError(error)) return { kind: "missing" };
      return { kind: "unavailable" };
    }
  }

  // 扁平回退（双形态兼容；契约 §15.2 `cardFile=null`）：卡文仍在旧面 board.json 内联。
  if (params.task.no === null) return { kind: "missing" };
  const boardPath = resolveBoardJsonPath(params.workspacePath);
  let content: string;
  try {
    const file = await params.fileService.readTextFile({
      path: boardPath,
      offset: 0,
      length: BOARD_JSON_MAX_READ_BYTES,
    });
    if (file.truncated) return { kind: "unavailable" };
    content = file.content;
  } catch (error) {
    if (isBoardFileMissingError(error)) return { kind: "missing" };
    return { kind: "unavailable" };
  }
  const outcome = parseBoardJson(content);
  if (outcome.kind !== "ready") return { kind: "missing" };
  const task = findBoardTaskByNo(outcome.board, params.task.no);
  if (!task) return { kind: "missing" };
  return { kind: "loaded", patch: taskNodeToPatch(task) };
}

/**
 * 把已读到的卡详情补丁合并回视图模型（纯函数；返回新 `BoardViewModel`，不改入参）。
 * 只按稳定号替换命中任务的详情字段，其余节点与结构原样保留（结构引用不变的部分复用原对象）。
 * 下游（弹窗/列表/表格）照旧消费同一 `BoardViewModel`，无需感知「详情是按需读到的」。
 */
export function applyBoardCardDetails(
  board: BoardViewModel,
  patches: Map<number, BoardCardDetailPatch>,
): BoardViewModel {
  if (patches.size === 0) return board;
  const mapTask = (task: BoardTaskNode): BoardTaskNode => {
    const children = task.children.map(mapTask);
    const patch = task.no !== null ? patches.get(task.no) : undefined;
    if (!patch) return task;
    return { ...task, ...patch, children };
  };
  return {
    ...board,
    features: board.features.map((feature) => ({
      ...feature,
      tasks: feature.tasks.map(mapTask),
    })),
  };
}

/**
 * 卡详情缓存（每面板一份；代际 = 工作目录 + INDEX.updatedAt）。
 * `begin(generation)` 是唯一失效点：代际变化即清空（板重编译 → 全表失效）。
 */
export class BoardCardDetailCache {
  private generation: string | null = null;
  private readonly entries = new Map<number, BoardCardDetailState>();

  /** 换代（同代不动，异代清空）；返回本次是否发生了失效。 */
  begin(generation: string): boolean {
    if (this.generation === generation) return false;
    this.generation = generation;
    this.entries.clear();
    return true;
  }

  get(no: number): BoardCardDetailState | undefined {
    return this.entries.get(no);
  }

  set(no: number, state: BoardCardDetailState): void {
    this.entries.set(no, state);
  }

  /** 删除单卡条目（#220/D7 同代重试：清 `unavailable` 条目 → 宿主 effect 重新读取）。 */
  delete(no: number): void {
    this.entries.delete(no);
  }

  /** 已读到的详情补丁（按号；只含 `loaded` 项）——渲染期合并回视图模型用。 */
  patches(): Map<number, BoardCardDetailPatch> {
    const out = new Map<number, BoardCardDetailPatch>();
    for (const [no, state] of this.entries) {
      if (state.kind === "loaded") out.set(no, state.patch);
    }
    return out;
  }

  get size(): number {
    return this.entries.size;
  }
}
