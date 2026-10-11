/**
 * 编排视图（#185）夹具构建器：**以 next-dispatch.mjs 结论为独立真源**造板。
 *
 * 做法：在临时目录里按「计划稿 + board.json + runs.json」三件套造一个可被 CLI 读取的项目根 →
 * 跑 `skills/zcode-board/assets/tools/next-dispatch.mjs --json`（判据权威，本仓 vendored 件与
 * 技能仓权威件 sha256 一致）→ 把 CLI 的结论字段按 `evidence/T185/schema-proposal.txt` 的
 * `dispatch` 段形状原样搬进板夹具（此处扮演「提案落地后的编译器」角色，只做字段搬运，零判据）→
 * 写回带 `dispatch` 段的板，供 UI 侧消费。
 *
 * 由此，UI 测试的期望值全部来自 CLI 输出（独立真源），UI 实现不含任何编排判据；
 * 反例/突变的对照面也随 CLI 对同一夹具的改判同步变（两处同步变的咬点）。
 *
 * 夹具语料（base）：
 *   #101 域 assets/shared.mjs（计划稿冲突区声明）—— 被在途 #104 占 → 不可派（domain）
 *   #102 域 assets/independent.mjs（卡文提及）—— 可派
 *   #103 无域声明 —— 可派但域未知（needsReview）
 *   #104 在途（implementer done）且在前沿 —— 证明在途排除（不入可派/不可派）
 *   #106 在途（implementer done）且在前沿 —— X2-1 的 blocked-by 目标（targetInFlight）
 *   #107 blocked-by #108（前置未完成、未在途）—— 不可派（dependency）
 *   #108 域 assets/other.mjs —— 可派（并入并发组）
 * 变异语料（mutated，「板改判」反例）：
 *   #104 的 run 改 failed（不再是在途）→ #101 域释放转可派；
 *   #108 置已完成、#107 解除阻塞并进前沿 → #107 转可派、blocked 段清空。
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
export const NEXT_DISPATCH_TOOL = join(
  REPO_ROOT,
  "skills",
  "zcode-board",
  "assets",
  "tools",
  "next-dispatch.mjs",
);

/** CLI `--json` 输出（next-dispatch/1）的结论字段（本夹具用到的子集）。 */
export interface NextDispatchJson {
  schema: string;
  capacity: number;
  inFlight: {
    source: string;
    count: number;
    slotsFree: number;
    cards: Array<{
      no: number;
      title: string;
      nextAssignee: string | null;
      domain: DispatchDomainJson;
    }>;
  };
  dispatchable: Array<{
    no: number;
    title: string;
    rank: number | null;
    nextAssignee: string | null;
    domain: DispatchDomainJson;
  }>;
  parallelGroup: number[];
  needsReview: number[];
  blocked: Array<{
    no: number;
    title: string;
    kind: string;
    by: number[];
    targetInFlight?: boolean;
    evidence: string;
    detail?: Array<{ file: string; occupiedBy: number; occupyFile: string }>;
  }>;
  summary: Record<string, number>;
}

export interface DispatchDomainJson {
  files: string[];
  source: string;
  confidence: string;
  unknown: boolean;
}

/** 提案形状的 `dispatch` 段（evidence/T185/schema-proposal.txt §2）。 */
export interface DispatchSection {
  capacity: number;
  inFlight: {
    source: string;
    count: number;
    slotsFree: number;
    cards: Array<{
      no: number;
      title: string;
      nextAssignee: string | null;
      domain: DispatchDomainJson;
    }>;
  };
  dispatchable: NextDispatchJson["dispatchable"];
  parallelGroup: number[];
  needsReview: number[];
  blocked: NextDispatchJson["blocked"];
  summary: Record<string, number>;
}

export interface DispatchFixture {
  root: string;
  boardRaw: Record<string, unknown>;
  boardJson: string;
  cli: NextDispatchJson;
}

const PLAN_X = `# fixture 计划稿（plan-x，编排视图夹具）

## 与其它线的文件域冲突点（共享写者，禁并行派发）

- \`assets/shared.mjs\`：X1-1 与 X1-4 共享（逐卡串行）。
- \`assets/shared.mjs\`：X3-1 改同一共享文件（占域被在途卡压住 → 全阻塞夹具的域占卡）。

## X1 批

- [ ] X1-1 改共享域 <!-- zcode-board: no=101 -->
  责任: implementer
  目标: 改 assets/shared.mjs 的判定逻辑。
- [ ] X1-2 独立域卡 <!-- zcode-board: no=102 -->
  责任: implementer
  目标: 新增 assets/independent.mjs 工具（只增不改共享文件）。
- [ ] X1-3 无声明卡 <!-- zcode-board: no=103 -->
  责任: implementer
  目标: 收口对账文本，交付面按批注执行。
- [ ] X1-4 共享域在途卡 <!-- zcode-board: no=104 -->
  责任: implementer
  目标: 改 assets/shared.mjs 的共享判定。
- [ ] X2-1 依赖在途卡 <!-- zcode-board: no=105 -->
  责任: implementer
  目标: 依赖 X2-2 的产出。
- [ ] X2-2 在途工具卡 <!-- zcode-board: no=106 -->
  责任: implementer
  目标: 新增 assets/tool-b.mjs。
- [ ] X2-3 依赖未在途卡 <!-- zcode-board: no=107 -->
  责任: implementer
  目标: 依赖 X2-4 的产出，补 assets/final.mjs 断言。
- [ ] X2-4 独立收口卡 <!-- zcode-board: no=108 -->
  责任: implementer
  目标: 新增 assets/other.mjs。

## X3 批（全阻塞夹具）

- [ ] X3-1 共享域再占卡 <!-- zcode-board: no=201 -->
  责任: implementer
  目标: 改 assets/shared.mjs 的判定逻辑（与在途卡同域）。
- [ ] X3-2 占域在途卡 <!-- zcode-board: no=202 -->
  责任: implementer
  目标: 改 assets/shared.mjs 的共享判定。
- [ ] X3-3 依赖在途卡 <!-- zcode-board: no=203 -->
  责任: implementer
  目标: 依赖 X3-2 的产出。
`;

function writeText(root: string, rel: string, text: string): void {
  const path = join(root, rel);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text, "utf8");
}

function writeJson(root: string, rel: string, value: unknown): void {
  writeText(root, rel, `${JSON.stringify(value, null, 2)}\n`);
}

function task(
  no: number,
  title: string,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    no,
    label: String(extra.label || no),
    title,
    status: extra.status || "pending",
    stage: extra.stage || "待办",
    nextAssignee: extra.nextAssignee || "implementer",
    currentAssignee: null,
    blockers: extra.blockers || [],
    source: { file: ".zcode/plans/plan-x.md", selector: `item-${no}` },
    worktree: null,
  };
}

function frontierEntry(rank: number, no: number, title: string, resolvedDeps: number[] = []) {
  return { rank, no, title, stage: "待办", nextAssignee: "implementer", resolvedDeps };
}

function implRun(at: string, cards: number[], result = "done") {
  return {
    runId: `run-fixture-${cards.join("-")}-${result}`,
    sessionId: "sess_fixture_t185",
    role: "implementer",
    at,
    result,
    cards,
    worktree: null,
    branch: null,
    evidence: [],
    breakpoint: { stoppedAt: null, next: "" },
  };
}

function makeBoard(variant: "base" | "mutated" | "all-blocked"): {
  board: Record<string, unknown>;
  runs: unknown[];
} {
  if (variant === "all-blocked") return makeAllBlockedBoard();
  const mutated = variant === "mutated";
  const tasks = [
    task(101, "X1-1 改共享域"),
    task(102, "X1-2 独立域卡"),
    task(103, "X1-3 无声明卡"),
    task(104, "X1-4 共享域在途卡", { nextAssignee: "test-verifier" }),
    task(105, "X2-1 依赖在途卡", {
      blockers: [{ kind: "dependency", blockedBy: 106, summary: "依赖 X2-2" }],
    }),
    task(106, "X2-2 在途工具卡", { nextAssignee: "test-verifier" }),
    task(107, "X2-3 依赖未在途卡", {
      blockers: mutated ? [] : [{ kind: "dependency", blockedBy: 108, summary: "依赖 X2-4" }],
    }),
    task(108, "X2-4 独立收口卡", mutated ? { status: "completed", stage: "已完成" } : {}),
  ];
  const frontier = mutated
    ? [
        frontierEntry(1, 101, "X1-1 改共享域"),
        frontierEntry(2, 102, "X1-2 独立域卡"),
        frontierEntry(3, 103, "X1-3 无声明卡"),
        frontierEntry(4, 104, "X1-4 共享域在途卡"),
        frontierEntry(5, 106, "X2-2 在途工具卡"),
        frontierEntry(6, 107, "X2-3 依赖未在途卡", [108]),
      ]
    : [
        frontierEntry(1, 101, "X1-1 改共享域"),
        frontierEntry(2, 106, "X2-2 在途工具卡"),
        frontierEntry(3, 102, "X1-2 独立域卡"),
        frontierEntry(4, 103, "X1-3 无声明卡"),
        frontierEntry(5, 108, "X2-4 独立收口卡"),
        frontierEntry(6, 104, "X1-4 共享域在途卡"),
      ];
  const blocked = mutated
    ? []
    : [
        {
          no: 105,
          title: "X2-1 依赖在途卡",
          stage: "待办",
          blockerKind: "dependency",
          targetId: 106,
          summary: "依赖 X2-2",
        },
        {
          no: 107,
          title: "X2-3 依赖未在途卡",
          stage: "待办",
          blockerKind: "dependency",
          targetId: 108,
          summary: "依赖 X2-4",
        },
      ];
  const runs = mutated
    ? [
        implRun("2026-10-11T08:00:00+08:00", [104], "failed"),
        implRun("2026-10-11T08:30:00+08:00", [106]),
      ]
    : [implRun("2026-10-11T08:00:00+08:00", [104]), implRun("2026-10-11T08:30:00+08:00", [106])];
  const board = {
    version: 2,
    project: { root: ".", name: "t185-dispatch-fixture" },
    updatedAt: "2026-10-11T09:00:00+08:00",
    generatedBy: "zcode-board/0.5.0",
    sources: [],
    epics: [],
    features: [
      {
        id: "plan:plan-x",
        no: 100,
        label: "100",
        title: "X 线（编排夹具）",
        status: "active",
        stage: "执行中",
        tasks,
      },
    ],
    frontier,
    active: [],
    blocked,
    recent: [],
    attentionSummary: {},
    diagnostics: [],
  };
  return { board, runs };
}

/** 全阻塞夹具（X3 批）：前沿两卡一域占一在途 → 可派 0 路（CLI 退出码 1 的合法信号）。 */
function makeAllBlockedBoard(): { board: Record<string, unknown>; runs: unknown[] } {
  const board = {
    version: 2,
    project: { root: ".", name: "t185-dispatch-fixture-all-blocked" },
    updatedAt: "2026-10-11T09:00:00+08:00",
    generatedBy: "zcode-board/0.5.0",
    sources: [],
    epics: [],
    features: [
      {
        id: "plan:plan-x",
        no: 200,
        label: "200",
        title: "X3 线（全阻塞夹具）",
        status: "active",
        stage: "执行中",
        tasks: [
          task(201, "X3-1 共享域再占卡"),
          task(202, "X3-2 占域在途卡", { nextAssignee: "test-verifier" }),
          task(203, "X3-3 依赖在途卡", {
            blockers: [{ kind: "dependency", blockedBy: 202, summary: "依赖 X3-2" }],
          }),
        ],
      },
    ],
    frontier: [
      frontierEntry(1, 201, "X3-1 共享域再占卡"),
      frontierEntry(2, 202, "X3-2 占域在途卡"),
    ],
    active: [],
    blocked: [
      {
        no: 203,
        title: "X3-3 依赖在途卡",
        stage: "待办",
        blockerKind: "dependency",
        targetId: 202,
        summary: "依赖 X3-2",
      },
    ],
    recent: [],
    attentionSummary: {},
    diagnostics: [],
  };
  return { board, runs: [implRun("2026-10-11T08:00:00+08:00", [202])] };
}

/** CLI 结论 → 提案 `dispatch` 段（字段搬运，零判据；形状见 schema-proposal.txt §2）。 */
export function dispatchSectionFromCli(cli: NextDispatchJson): DispatchSection {
  return {
    capacity: cli.capacity,
    inFlight: {
      source: cli.inFlight.source,
      count: cli.inFlight.count,
      slotsFree: cli.inFlight.slotsFree,
      cards: cli.inFlight.cards.map((card) => ({
        no: card.no,
        title: card.title,
        nextAssignee: card.nextAssignee,
        domain: card.domain,
      })),
    },
    dispatchable: cli.dispatchable.map((card) => ({
      no: card.no,
      title: card.title,
      rank: card.rank,
      nextAssignee: card.nextAssignee,
      domain: card.domain,
    })),
    parallelGroup: [...cli.parallelGroup],
    needsReview: [...cli.needsReview],
    blocked: cli.blocked.map((entry) => ({
      no: entry.no,
      title: entry.title,
      kind: entry.kind,
      by: [...entry.by],
      ...(entry.targetInFlight !== undefined ? { targetInFlight: entry.targetInFlight } : {}),
      evidence: entry.evidence,
      detail: entry.detail ? entry.detail.map((hit) => ({ ...hit })) : [],
    })),
    summary: { ...cli.summary },
  };
}

/**
 * 造夹具：临时项目根 + 跑 CLI（判据权威）+ 按提案形状把结论搬进板。
 * `withDispatch = false` 时为「缺段老板」（数据未就绪形态的夹具）。
 * CLI 退出码 0（有可派）/ 1（无可派——全阻塞夹具的合法信号）都接受；其余为夹具故障。
 */
export function buildDispatchFixture(
  options: {
    variant?: "base" | "mutated" | "all-blocked";
    withDispatch?: boolean;
  } = {},
): DispatchFixture {
  const variant = options.variant ?? "base";
  const withDispatch = options.withDispatch ?? true;
  const root = mkdtempSync(join(tmpdir(), `t185-dispatch-${variant}-`));
  const { board, runs } = makeBoard(variant);
  writeText(root, ".zcode/plans/plan-x.md", PLAN_X);
  writeJson(root, ".zcode/board/board.json", board);
  writeJson(root, ".zcode/board/runs.json", { version: 1, runs });

  const result = spawnSync(process.execPath, [NEXT_DISPATCH_TOOL, root, "--json"], {
    encoding: "utf8",
  });
  if (result.status !== 0 && result.status !== 1) {
    throw new Error(
      `next-dispatch 夹具运行失败（exit=${result.status}）：${result.stderr || result.stdout}`,
    );
  }
  const cli = JSON.parse(result.stdout) as NextDispatchJson;
  const boardRaw = withDispatch
    ? { ...board, dispatch: dispatchSectionFromCli(cli) }
    : { ...board };
  const boardJson = `${JSON.stringify(boardRaw, null, 2)}\n`;
  writeJson(root, ".zcode/board/board.json", boardRaw);
  return { root, boardRaw, boardJson, cli };
}

export function cleanupDispatchFixture(fixture: DispatchFixture | { root: string }): void {
  rmSync(fixture.root, { recursive: true, force: true });
}
