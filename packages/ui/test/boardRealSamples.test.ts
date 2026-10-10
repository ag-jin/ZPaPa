import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { BoardPaneView } from "../src/board/BoardPaneView.js";
import { BoardCardDialog } from "../src/board/BoardCardDialog.js";
import { resolveBoardDialogNode } from "../src/board/boardDialogViewModel.js";
import { loadBoardDocument, type BoardPaneLoadState } from "../src/board/loadBoardDocument.js";
import type { BoardFeatureNode, BoardTaskNode } from "../src/board/boardViewModel.js";
import { ZCodeIntlProvider } from "../src/i18n/IntlProvider.js";
import { LARGE_BOARD_TAIL_TITLE, buildLargeBoard } from "./boardTestFixture.js";

/**
 * 真实素材 + 真实文件系统的可复现验证记录（卡 #32 验收：「对 golden 样例与本工作区真实板均可渲染；
 * 空态 A/B/C 正确」）。
 *
 * - golden 样例：`~/.zcode/skills/zcode-board/assets/samples/board.golden.json`（T1 冻结交付物，单一来源）；
 * - 真实板：`<ZCODE_BOARD_WORKSPACE 或 /Users/linguojin/Workspace/ZCode>/.zcode/board/board.json`
 *   （默认取本机工作区；换机器用环境变量覆盖，缺失即 skip）；
 * - 空态三态：在临时目录里落真实文件（无板 / features:[] / 损坏 JSON），走**真实 loader**
 *   （checkFilesExist → readTextFile → parse → view），不是直接注入状态。
 */

const GOLDEN_PATH = join(homedir(), ".zcode/skills/zcode-board/assets/samples/board.golden.json");

const REAL_BOARD_WORKSPACE =
  process.env.ZCODE_BOARD_WORKSPACE ?? "/Users/linguojin/Workspace/ZCode";
const REAL_BOARD_PATH = join(REAL_BOARD_WORKSPACE, ".zcode/board/board.json");

/** 七段位词表：真源是编译器的 STAGE 枚举（`assets/lib/derive.mjs`）。 */
const STAGE_VALUES = ["待设计", "待办", "执行中", "审核中", "阻塞", "已完成", "已取消"];

/** 文件服务文本读的默认/硬上限（真源：`packages/services/src/file/fileService.ts:32-33`）。 */
const SERVICE_DEFAULT_TEXT_READ_BYTES = 128 * 1024;
const SERVICE_MAX_TEXT_READ_BYTES = 256 * 1024;

/**
 * 文件服务端口的 node:fs 实现：验证用夹具，不是应用代码（应用侧只经 IFileService）。
 * 按 fileService.ts 的语义收敛 `length`（缺省 128 KiB、硬上限 256 KiB）并如实回报 truncated
 * —— 不模拟上限的「整读」假件会让「调用方漏传 length」在测试里永远绿。
 */
function createNodeFileService() {
  return {
    checkFilesExist: async ({ paths }: { paths: string[] }) =>
      paths.map((path) => ({ path, exists: existsSync(path) })),
    readTextFile: async ({
      path,
      offset = 0,
      length,
    }: {
      path: string;
      offset?: number;
      length?: number;
    }) => {
      const bytes = await readFile(path);
      const start = Math.max(0, Math.trunc(offset));
      const requested = Number.isFinite(length)
        ? Math.trunc(length as number)
        : SERVICE_DEFAULT_TEXT_READ_BYTES;
      const target = Math.min(Math.max(requested, 1), SERVICE_MAX_TEXT_READ_BYTES);
      const readLength = Math.min(target, Math.max(0, bytes.length - start));
      const chunk = bytes.subarray(start, start + readLength);
      return {
        path,
        content: chunk.toString("utf8"),
        offset: start,
        bytesRead: chunk.length,
        totalBytes: bytes.length,
        truncated: start + chunk.length < bytes.length,
        isBinary: false,
      };
    },
  };
}

async function loadFromRealFile(workspace: string): Promise<BoardPaneLoadState> {
  return loadBoardDocument({
    fileService: createNodeFileService(),
    workspacePath: workspace,
  });
}

function render(state: BoardPaneLoadState): string {
  return renderToStaticMarkup(
    createElement(ZCodeIntlProvider, {
      initialLocale: "zh-CN" as const,
      children: createElement(BoardPaneView, { state }),
    }),
  );
}

function flattenTasks(features: BoardFeatureNode[]): BoardTaskNode[] {
  const out: BoardTaskNode[] = [];
  const walk = (tasks: BoardTaskNode[]) => {
    for (const task of tasks) {
      out.push(task);
      walk(task.children);
    }
  };
  for (const feature of features) walk(feature.tasks);
  return out;
}

/** 提示条可见文本（剥标签后归一空白）：每段现在是独立元素，逐字比对要比可见文本。 */
function bannerTextOf(markup: string): string {
  const anchor = markup.indexOf("data-board-attention-banner");
  assert.ok(anchor >= 0, "markup 里找不到提示条");
  const start = markup.indexOf(">", anchor) + 1;
  const slice = markup.slice(start, markup.indexOf("</div>", start));
  return slice
    .replace(/<[^>]*>/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * 契约 §3.1 提示条模板：从样本自身的 `attentionSummary` 构造期望（独立真源是契约文案，
 * 不是实现），零缺口时按契约不出现提示条——健康板（全零）因此不会把套件弄红。
 */
function assertAttentionBanner(params: { markup: string; summary: Record<string, unknown> }): void {
  const count = (key: string): number => {
    const value = params.summary[key];
    return typeof value === "number" && Number.isFinite(value) ? value : 0;
  };
  const expected = [
    `${count("interviewedNotArranged")} 已访谈未安排`,
    `${count("arrangedNotExpanded")} 已安排未展开`,
    `${count("interruptedResume")} 执行中断可续`,
    `${count("unmergedWorktree")} 待合并`,
  ].join(" · ");
  const hasSignal = [
    "interviewedNotArranged",
    "arrangedNotExpanded",
    "interruptedResume",
    "unmergedWorktree",
  ].some((key) => count(key) > 0);
  if (hasSignal) {
    assert.equal(bannerTextOf(params.markup), expected, `提示条应逐字渲染：${expected}`);
    return;
  }
  assert.ok(!params.markup.includes("data-board-attention-banner"), "零缺口不出现提示条");
}

async function stageWorkspace(boardContent: string | null): Promise<{
  workspace: string;
  cleanup: () => Promise<void>;
}> {
  const workspace = await mkdtemp(join(tmpdir(), "board-empty-"));
  if (boardContent !== null) {
    await mkdir(join(workspace, ".zcode/board"), { recursive: true });
    await writeFile(join(workspace, ".zcode/board/board.json"), boardContent, "utf8");
  }
  return {
    workspace,
    cleanup: async () => {
      await rm(workspace, { recursive: true, force: true });
    },
  };
}

const hasGolden = existsSync(GOLDEN_PATH);
const hasRealBoard = existsSync(REAL_BOARD_PATH);

type RawRecord = Record<string, unknown>;

function isRawRecord(value: unknown): value is RawRecord {
  return typeof value === "object" && value !== null;
}

function rawAttentionCodes(nodes: RawRecord[]): string[] {
  return nodes.flatMap((node) =>
    Array.isArray(node.attention)
      ? node.attention.filter((code): code is string => typeof code === "string")
      : [],
  );
}

/** 从原始 JSON 收集任务卡（含嵌套），期望值全部取自样本自身，不写死样本版本。 */
function collectRawTasks(features: RawRecord[]): RawRecord[] {
  const out: RawRecord[] = [];
  const walk = (value: unknown) => {
    if (!Array.isArray(value)) return;
    for (const task of value) {
      if (!isRawRecord(task)) continue;
      out.push(task);
      walk(task.tasks);
    }
  };
  for (const feature of features) if (isRawRecord(feature)) walk(feature.tasks);
  return out;
}

test(
  "真实 golden 样例：全字段形态可加载且完整渲染（含四种缺口码逐字文案）",
  {
    skip: !hasGolden,
  },
  async () => {
    // 读取真实 golden 文件后按固定布局（<workspace>/.zcode/board/board.json）落牌再走真实 loader。
    const goldenContent = await readFile(GOLDEN_PATH, "utf8");
    const raw = JSON.parse(goldenContent) as {
      project?: { name?: string };
      features: RawRecord[];
      attentionSummary: Record<string, number>;
      diagnostics?: unknown[];
    };
    const { workspace, cleanup } = await stageWorkspace(goldenContent);
    try {
      const state = await loadFromRealFile(workspace);
      assert.equal(state.kind, "ready", `golden 应可加载：${GOLDEN_PATH}`);
      if (state.kind !== "ready") return;
      const board = state.board;

      // 结构一致性：加载器的节点数与 golden 自身一致（golden 是活动交付物，测试不写死计数）。
      const rawTasks = collectRawTasks(raw.features);
      const tasks = flattenTasks(board.features);
      assert.equal(board.projectName, raw.project?.name);
      assert.equal(board.features.length, raw.features.length);
      assert.equal(tasks.length, rawTasks.length);

      // 四种缺口码：样本自身覆盖（前提），映射后一个不少。
      const rawCodes = [...new Set(rawAttentionCodes([...raw.features, ...rawTasks]))].sort();
      assert.deepEqual(
        rawCodes,
        [
          "arranged-not-expanded",
          "interrupted-resume",
          "interviewed-not-arranged",
          "unmerged-worktree",
        ],
        "golden 应覆盖四种缺口码（样本前提）",
      );
      const mappedCodes = [
        ...new Set([
          ...board.features.flatMap((f) => f.attention),
          ...tasks.flatMap((t) => t.attention),
        ]),
      ].sort();
      assert.deepEqual(mappedCodes, rawCodes, "缺口码在映射中不得丢失");

      // 段位：样本里的 stage 值都在七段位词表内，映射保留（含「已取消」「审核中」等）。
      const rawStageValues = [...raw.features, ...rawTasks]
        .map((node) => node.stage)
        .filter((stage): stage is string => typeof stage === "string");
      assert.ok(rawStageValues.length > 0, "golden 应带 stage 字段");
      for (const stage of rawStageValues) {
        assert.ok(STAGE_VALUES.includes(stage), `段位 ${stage} 不在七段位词表内`);
      }
      for (const feature of board.features) {
        if (feature.stage !== null) assert.ok(STAGE_VALUES.includes(feature.stage));
      }

      const markup = render(state);

      // 七段位徽章：golden 里出现的每个 stage 值都必须渲染出徽章文本（卡级 stage 也要渲染）。
      for (const stage of new Set(rawStageValues)) {
        assert.ok(markup.includes(stage), `段位徽章应渲染：${stage}`);
      }

      // 提示条：按契约 §3.1 模板从样本自身的计数构造期望，逐字比对（可见文本，剥标签）。
      assertAttentionBanner({ markup, summary: raw.attentionSummary });

      // 四缺口码徽章文案：样本里每种码取自己的数据构造期望。
      assert.ok(markup.includes("已访谈，尚未落卡"));
      assert.ok(markup.includes("已安排，尚未拆解任务"));
      assert.ok(markup.includes("待合并（执行现场未回流）"));
      const interruptedNode = [...raw.features, ...rawTasks].find((node) =>
        rawAttentionCodes([node]).includes("interrupted-resume"),
      );
      assert.ok(interruptedNode, "golden 应有 interrupted-resume 节点");
      const interruptedRun = isRawRecord(interruptedNode.lastRun) ? interruptedNode.lastRun : null;
      assert.equal(typeof interruptedRun?.stoppedAt, "number");
      assert.ok(
        markup.includes(`执行中断，可续（停在 #${interruptedRun?.stoppedAt}）`),
        "interrupted-resume 的 #N 应替换为 lastRun.stoppedAt",
      );

      // 最近执行四要素：样本里带 next 的卡，时间/result/停在 #N/next 都要出现。
      const nodeWithNext = rawTasks.find(
        (task) => isRawRecord(task.lastRun) && typeof task.lastRun.next === "string",
      );
      assert.ok(nodeWithNext, "golden 应有带 next 的 lastRun");
      const run = nodeWithNext.lastRun as RawRecord;
      assert.ok(markup.includes(String(run.result)));
      assert.ok(markup.includes(`停在 #${run.stoppedAt}`));
      assert.ok(markup.includes(String(run.next)));

      // 未领号 / 草案 / 受阻 N：样本前提 → 渲染覆盖。
      assert.ok(
        [...raw.features, ...rawTasks].some(
          (node) => node.no === undefined && node.label === undefined,
        ),
        "golden 应有未领号节点（样本前提）",
      );
      assert.ok(markup.includes("未领号"));
      assert.ok(
        rawTasks.some((task) => task.draft === true),
        "golden 应有草案卡（样本前提）",
      );
      assert.ok(markup.includes("草案"));
      const blockedNode = rawTasks.find(
        (task) => Array.isArray(task.blockers) && task.blockers.length > 0,
      );
      assert.ok(blockedNode);
      assert.ok(markup.includes(`受阻 ${(blockedNode.blockers as unknown[]).length}`));

      // 诊断只读展示（diagnostics 非空属合法形态）。
      const diagnosticCount = Array.isArray(raw.diagnostics) ? raw.diagnostics.length : 0;
      // #46 B7：诊断区默认折叠为一行「诊断 N 条」。
      assert.ok(markup.includes(`诊断 ${diagnosticCount} 条`));
    } finally {
      await cleanup();
    }
  },
);

test("本工作区真实板：全部可渲染，段位都在七段位词表内", { skip: !hasRealBoard }, async () => {
  const state = await loadFromRealFile(REAL_BOARD_WORKSPACE);
  assert.equal(state.kind, "ready", `真实板应可加载：${REAL_BOARD_PATH}`);
  if (state.kind !== "ready") return;
  const board = state.board;

  const tasks = flattenTasks(board.features);
  const stageNodes = [...board.features, ...tasks];
  assert.ok(board.features.length > 0, "真实板应至少有特性节点");
  assert.ok(tasks.length > 0, "真实板应至少有卡片");
  for (const node of stageNodes) {
    if (node.stage !== null) {
      assert.ok(
        STAGE_VALUES.includes(node.stage),
        `段位 ${node.stage} 不在七段位词表内（节点 ${node.id}）`,
      );
    }
  }
  assert.ok(
    stageNodes.some((node) => node.stage !== null),
    "真实板应带段位（stage 字段）",
  );

  const markup = render(state);
  assert.ok(markup.includes('data-board-pane=""'), "真实板应渲染出面板骨架");
  assert.ok(markup.includes(board.projectName), "面板应显示项目名");
  assert.ok(
    stageNodes.some((node) => node.stage && markup.includes(node.stage)),
    "应渲染段位徽章",
  );
  // 提示条（有缺口才出现）：从真实板自身的计数构造期望——板是活动物，**不写死计数**，
  // 也不假设「一定有缺口」（健康板的四计数全零，此时期望按契约是不出现提示条）。
  assertAttentionBanner({ markup, summary: { ...board.attentionSummary } });
  // 数量进证据日志（板是活动物，测试只钉结构不钉计数）。
  console.log(
    `[board] 真实板：${board.features.length} 特性 / ${tasks.length} 卡 / 段位节点 ${stageNodes.filter((n) => n.stage).length} / 缺口计数 ${JSON.stringify(board.attentionSummary)}`,
  );
});

test(
  "本工作区真实板：#54 冒烟 —— 四视图渲染 + 接手位「下一个」+ 依赖行走计划码编号",
  { skip: !hasRealBoard },
  async () => {
    // 期望值全部取自板自身（板是活动物：不写死卡号/计数；#53 的 nextAssignee 是编译器输出）。
    const raw = JSON.parse(await readFile(REAL_BOARD_PATH, "utf8")) as {
      features: Array<RawRecord & { planCode?: string; tasks?: unknown[] }>;
    };
    const state = await loadFromRealFile(REAL_BOARD_WORKSPACE);
    assert.equal(state.kind, "ready", `真实板应可加载：${REAL_BOARD_PATH}`);
    if (state.kind !== "ready") return;
    const board = state.board;

    // 1) 四视图渲染冒烟：四个根锚点都在（视图矩阵 §13.2 的四态载体）。
    const views: Array<[string, string]> = [
      ["tree", 'data-board-view="tree"'],
      ["kanban", 'data-board-view="kanban"'],
      ["list", 'data-board-view="list"'],
      ["table", 'data-board-view="table"'],
    ];
    const markups = new Map<string, string>();
    for (const [mode, anchor] of views) {
      const markup = renderToStaticMarkup(
        createElement(ZCodeIntlProvider, {
          initialLocale: "zh-CN" as const,
          children: createElement(BoardPaneView, {
            state,
            viewMode: mode as "tree" | "kanban" | "list" | "table",
          }),
        }),
      );
      assert.ok(markup.includes(anchor), `真实板应渲染出 ${mode} 视图根锚点`);
      markups.set(mode, markup);
    }

    // 2) 接手位（#54-1）：每张带 nextAssignee 的卡在表格责任管线列都显示对应接手位 + 词条标记。
    const rawTasks = collectRawTasks(raw.features);
    const cardsWithNext = rawTasks.filter(
      (task) => typeof task.nextAssignee === "string" && task.nextAssignee.length > 0,
    );
    assert.ok(
      cardsWithNext.length > 0,
      "真实板应有带 nextAssignee 的卡（前提：板由 v2.3 编译器产出，#53 已落地）",
    );
    // 正在执行的角色不重复标「下一个」（boardNodeParts 有意为之：current === next 时同角色不双标），
    // 故断言面只覆盖非活跃卡；全部活跃时降级为打印——板是活动物，活卡状态不得成为套件红的来源（T-2 方向）。
    const assertableNext = cardsWithNext.filter(
      (task) => task.currentAssignee !== task.nextAssignee,
    );
    const table = markups.get("table") ?? "";
    for (const task of assertableNext) {
      const no = task.no;
      if (typeof no !== "number") continue;
      const start = table.indexOf(`data-board-card="task:${no}"`);
      assert.ok(start >= 0, `表格视图应渲染卡 #${no}`);
      const rowEnd = table.indexOf("<tr", start + 1);
      const row = table.slice(start, rowEnd === -1 ? table.length : rowEnd);
      assert.ok(
        row.includes(`data-board-pipeline-next="${String(task.nextAssignee)}"`),
        `卡 #${no} 的管线应标出接手位 ${String(task.nextAssignee)}`,
      );
      assert.ok(row.includes("下一个"), `卡 #${no} 的接手位应带词条标记「下一个」`);
    }

    // 3) 依赖行（#54-6）：取板上第一个「依赖目标有计划码」的卡，弹窗里编号应是计划码-层级 + 稳定号。
    const allTasks: Array<{ task: RawRecord; planCode: string | null; feature: RawRecord }> = [];
    const walk = (value: unknown, planCode: string | null, feature: RawRecord) => {
      if (!Array.isArray(value)) return;
      for (const entry of value) {
        if (!isRawRecord(entry)) continue;
        allTasks.push({ task: entry, planCode, feature });
        walk(entry.tasks, planCode, feature);
      }
    };
    for (const feature of raw.features) {
      const planCode = typeof feature.planCode === "string" ? feature.planCode : null;
      walk(feature.tasks, planCode, feature);
    }
    const byNo = new Map<number, { task: RawRecord; planCode: string | null }>();
    for (const entry of allTasks) {
      if (typeof entry.task.no === "number") {
        byNo.set(entry.task.no, { task: entry.task, planCode: entry.planCode });
      }
    }
    const dependency = allTasks.find(({ task }) =>
      (Array.isArray(task.blockers) ? task.blockers : []).some((blocker) => {
        if (!isRawRecord(blocker) || blocker.kind !== "dependency") return false;
        const target =
          typeof blocker.blockedBy === "number" ? byNo.get(blocker.blockedBy) : undefined;
        return (
          target !== undefined && target.planCode !== null && typeof target.task.label === "string"
        );
      }),
    );
    assert.ok(dependency, "真实板应有「依赖目标带计划码」的卡（#54-6 的当场形态）");
    const blocker = (dependency.task.blockers as RawRecord[]).find((entry) => {
      const target = typeof entry.blockedBy === "number" ? byNo.get(entry.blockedBy) : undefined;
      return (
        entry.kind === "dependency" &&
        target !== undefined &&
        target.planCode !== null &&
        typeof target.task.label === "string"
      );
    });
    assert.ok(blocker && typeof blocker.blockedBy === "number");
    const target = byNo.get(blocker.blockedBy as number);
    assert.ok(target && target.planCode !== null);
    const expectedTargetText = `${target.planCode}-${String(target.task.label)} · #${String(blocker.blockedBy)}`;
    const dialogNode = resolveBoardDialogNode(board, `task:${String(dependency.task.no)}`);
    assert.ok(dialogNode, "依赖卡应能在弹窗里解析到");
    const dialogMarkup = renderToStaticMarkup(
      createElement(ZCodeIntlProvider, {
        initialLocale: "zh-CN" as const,
        children: createElement(BoardCardDialog, { board, node: dialogNode }),
      }),
    );
    assert.ok(
      dialogMarkup.includes(expectedTargetText),
      `依赖行应显示 ${expectedTargetText}（不落回 ID-<label> 形态）：\n${dialogMarkup.slice(0, 600)}`,
    );
    console.log(
      `[board] #54 冒烟：接手位卡 ${cardsWithNext.length} 张；依赖样例 #${String(dependency.task.no)} → ${expectedTargetText}`,
    );
  },
);

test("空态 A（真实文件系统：无板）逐字不静默", async () => {
  const { workspace, cleanup } = await stageWorkspace(null);
  try {
    const state = await loadFromRealFile(workspace);
    assert.equal(state.kind, "missing");
    const markup = render(state);
    assert.ok(markup.includes("本项目还没有看板。完成一次访谈登记或创建第一个 spec 后自动生成。"));
  } finally {
    await cleanup();
  }
});

test("空态 B（真实文件系统：features:[]）逐字不静默", async () => {
  const { workspace, cleanup } = await stageWorkspace(
    JSON.stringify({
      version: 2,
      project: { root: "/tmp/ws", name: "空板" },
      updatedAt: "2026-10-09T16:05:00+08:00",
      generatedBy: "zcode-board/0.2",
      sources: [],
      features: [],
      attentionSummary: {
        interviewedNotArranged: 0,
        arrangedNotExpanded: 0,
        interruptedResume: 0,
        unmergedWorktree: 0,
      },
      diagnostics: [],
    }),
  );
  try {
    const state = await loadFromRealFile(workspace);
    assert.equal(state.kind, "empty");
    assert.ok(render(state).includes("尚无规格或计划。"));
  } finally {
    await cleanup();
  }
});

test("空态 C（真实文件系统：损坏 JSON）逐字且不白屏", async () => {
  const { workspace, cleanup } = await stageWorkspace("{ 这不是 JSON");
  try {
    const state = await loadFromRealFile(workspace);
    assert.equal(state.kind, "damaged");
    assert.ok(
      render(state).includes("板格式无法读取（版本过新/损坏），请在会话中运行编译器重建。"),
    );
  } finally {
    await cleanup();
  }
});

test("P1 回归（真实文件系统）：>128 KiB 的合法板正常渲染，不是空态 C", async () => {
  const board = buildLargeBoard({ minBytes: SERVICE_DEFAULT_TEXT_READ_BYTES });
  assert.ok(
    board.bytes > SERVICE_DEFAULT_TEXT_READ_BYTES,
    `夹具前提：板应超过服务默认上限（实测 ${board.bytes} B）`,
  );
  const { workspace, cleanup } = await stageWorkspace(board.content);
  try {
    const state = await loadFromRealFile(workspace);
    assert.equal(state.kind, "ready", `>128 KiB 的合法板应可加载（实测 ${board.bytes} B）`);
    if (state.kind !== "ready") return;

    const markup = render(state);
    assert.ok(
      markup.includes(LARGE_BOARD_TAIL_TITLE),
      "尾哨兵在 128 KiB 之后：渲染出现即证明走的是读全的板",
    );
    assert.ok(
      !markup.includes("板格式无法读取（版本过新/损坏），请在会话中运行编译器重建。"),
      "合法板不得落空态 C，更不得指引无效的「重编译」",
    );
  } finally {
    await cleanup();
  }
});
