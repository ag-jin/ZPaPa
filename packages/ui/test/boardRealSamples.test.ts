import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { BoardPaneView, type BoardPaneViewProps } from "../src/board/BoardPaneView.js";
import { BoardCardDialog } from "../src/board/BoardCardDialog.js";
import { resolveBoardDialogNode } from "../src/board/boardDialogViewModel.js";
import { boardFoldIdsOfCard } from "../src/board/boardFoldState.js";
import { loadBoardDocument, type BoardPaneLoadState } from "../src/board/loadBoardDocument.js";
import type { BoardViewMode } from "../src/board/boardViewsViewModel.js";
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
      const requested =
        typeof length === "number" && Number.isFinite(length)
          ? Math.trunc(length)
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

function render(state: BoardPaneLoadState, props: Partial<BoardPaneViewProps> = {}): string {
  return renderToStaticMarkup(
    createElement(ZCodeIntlProvider, {
      initialLocale: "zh-CN" as const,
      children: createElement(BoardPaneView, { state, ...props }),
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

/**
 * JSON.parse 的收窄读取面（#60/T-3 评审点名点位；不裸 `as` 标注形状）：
 * 解析结果先落 `unknown`，形状不对就以可点名的断言/空值收场，而不是断言一个不存在的形状。
 */
function parseRawRecord(text: string, label: string): RawRecord {
  const parsed: unknown = JSON.parse(text);
  assert.ok(isRawRecord(parsed), `${label} 应是 JSON 对象`);
  return parsed;
}

/** 记录里的数组字段（缺省/非数组 → 空数组）：形状由 `Array.isArray` 收窄。 */
function rawArrayField(record: RawRecord, key: string): unknown[] {
  const value = record[key];
  return Array.isArray(value) ? value : [];
}

/** 记录里的对象数组字段（逐项收窄为记录；非记录项丢弃不读数）。 */
function rawRecordsOf(record: RawRecord, key: string): RawRecord[] {
  return rawArrayField(record, key).filter(isRawRecord);
}

test(
  "真实 golden 样例：全字段形态可加载且完整渲染（含四种缺口码逐字文案）",
  {
    skip: !hasGolden,
  },
  async () => {
    // 读取真实 golden 文件后按固定布局（<workspace>/.zcode/board/board.json）落牌再走真实 loader。
    const goldenContent = await readFile(GOLDEN_PATH, "utf8");
    // #60/T-3：JSON.parse 后逐字段收窄（不裸 `as` 标注形状）——样例形状不对时断言点名。
    const golden = parseRawRecord(goldenContent, "golden 样例");
    const goldenProject = isRawRecord(golden.project) ? golden.project : null;
    const goldenFeatures = rawRecordsOf(golden, "features");
    const goldenSummary = isRawRecord(golden.attentionSummary) ? golden.attentionSummary : {};
    const goldenDiagnosticCount = rawArrayField(golden, "diagnostics").length;
    const { workspace, cleanup } = await stageWorkspace(goldenContent);
    try {
      const state = await loadFromRealFile(workspace);
      assert.equal(state.kind, "ready", `golden 应可加载：${GOLDEN_PATH}`);
      if (state.kind !== "ready") return;
      const board = state.board;

      // 结构一致性：加载器的节点数与 golden 自身一致（golden 是活动交付物，测试不写死计数）。
      const rawTasks = collectRawTasks(goldenFeatures);
      const tasks = flattenTasks(board.features);
      assert.equal(
        board.projectName,
        typeof goldenProject?.name === "string" ? goldenProject.name : undefined,
      );
      assert.equal(board.features.length, rawArrayField(golden, "features").length);
      assert.equal(tasks.length, rawTasks.length);

      // 四种缺口码：样本自身覆盖（前提），映射后一个不少。
      const rawCodes = [...new Set(rawAttentionCodes([...goldenFeatures, ...rawTasks]))].sort();
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
      const rawStageValues = [...goldenFeatures, ...rawTasks]
        .map((node) => node.stage)
        .filter((stage): stage is string => typeof stage === "string");
      assert.ok(rawStageValues.length > 0, "golden 应带 stage 字段");
      for (const stage of rawStageValues) {
        assert.ok(STAGE_VALUES.includes(stage), `段位 ${stage} 不在七段位词表内`);
      }
      for (const feature of board.features) {
        if (feature.stage !== null) assert.ok(STAGE_VALUES.includes(feature.stage));
      }

      // 树形面逐字守卫（golden 全字段形态的树面投影）：视图缺省自 C3-5/#140 起为指引面，
      // 本测试的断言面全是树形卡片行锚点，显式钉树形。
      const markup = render(state, { viewMode: "tree" });

      // 七段位徽章：golden 里出现的每个 stage 值都必须渲染出徽章文本（卡级 stage 也要渲染）。
      for (const stage of new Set(rawStageValues)) {
        assert.ok(markup.includes(stage), `段位徽章应渲染：${stage}`);
      }

      // 提示条：按契约 §3.1 模板从样本自身的计数构造期望，逐字比对（可见文本，剥标签）。
      assertAttentionBanner({ markup, summary: goldenSummary });

      // 四缺口码徽章文案：样本里每种码取自己的数据构造期望。
      assert.ok(markup.includes("已访谈，尚未落卡"));
      assert.ok(markup.includes("已安排，尚未拆解任务"));
      assert.ok(markup.includes("待合并（执行现场未回流）"));
      const interruptedNode = [...goldenFeatures, ...rawTasks].find((node) =>
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
      const run = nodeWithNext.lastRun;
      assert.ok(isRawRecord(run), "带 next 的 lastRun 应是对象");
      assert.ok(markup.includes(String(run.result)));
      assert.ok(markup.includes(`停在 #${run.stoppedAt}`));
      assert.ok(markup.includes(String(run.next)));

      // 未领号 / 草案 / 受阻 N：样本前提 → 渲染覆盖。
      assert.ok(
        [...goldenFeatures, ...rawTasks].some(
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
      const blockedCount = Array.isArray(blockedNode.blockers) ? blockedNode.blockers.length : null;
      assert.ok(
        blockedCount !== null && markup.includes(`受阻 ${blockedCount}`),
        "受阻 N 应渲染为该节点自身 blockers 数",
      );

      // 诊断只读展示（diagnostics 非空属合法形态）。
      const diagnosticCount = goldenDiagnosticCount;
      // #46 B7：诊断区默认折叠为一行「诊断 N 条」。
      assert.ok(markup.includes(`诊断 ${diagnosticCount} 条`));
    } finally {
      await cleanup();
    }
  },
);

test(
  "本工作区真实板：≤读取上限照常渲染；超上限走「文件过大」正式态（#70（d））",
  { skip: !hasRealBoard },
  async () => {
    // 文件字节数取自文件系统（独立真源），不是按实现回算：板是活动物，跨过读取上限时
    // 期望随四态语义切换（#87 A4-1 承接线索：真实板 280072 B 超 256 KiB 的红转正式承载）。
    const boardBytes = Buffer.byteLength(await readFile(REAL_BOARD_PATH));
    const state = await loadFromRealFile(REAL_BOARD_WORKSPACE);
    if (boardBytes > SERVICE_MAX_TEXT_READ_BYTES) {
      assert.equal(
        state.kind,
        "too-large",
        `真实板 ${boardBytes} B 超过 ${SERVICE_MAX_TEXT_READ_BYTES} B 读取上限：应呈现「文件过大」态`,
      );
      assert.ok(
        render(state).includes("板文件过大"),
        "文件过大态必须给出独立词条与指引（不静默、不借损坏态、不部分渲染）",
      );
      console.log(
        `[board] 真实板：${boardBytes} B > ${SERVICE_MAX_TEXT_READ_BYTES} B 读取上限 → too-large（#70 正式承载）`,
      );
      return;
    }
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
  },
);

test(
  "本工作区真实板：#54 冒烟 —— 四视图渲染 + 接手位「下一个」+ 依赖行走计划码编号",
  { skip: !hasRealBoard },
  async () => {
    // 期望值全部取自板自身（板是活动物：不写死卡号/计数；#53 的 nextAssignee 是编译器输出）。
    const boardContent = await readFile(REAL_BOARD_PATH, "utf8");
    // #60/T-3（评审点名点位）：JSON.parse 后按记录收窄——不裸 `as` 标注真实板的形状。
    const rawBoard = parseRawRecord(boardContent, "真实板");
    const rawFeatures = rawRecordsOf(rawBoard, "features");
    const state = await loadFromRealFile(REAL_BOARD_WORKSPACE);
    if (Buffer.byteLength(boardContent) > SERVICE_MAX_TEXT_READ_BYTES) {
      // 超读取上限时四视图/接手位/依赖行的深度断言无从取值：不静默跳过，断言「文件过大」
      // 正式态与其指引（#70（d）；#87 A4-1 承接线索：该 2 条既有失败转正式承载）。
      assert.equal(state.kind, "too-large", "超上限真实板应呈现「文件过大」态");
      assert.ok(render(state).includes("板文件过大"), "文件过大态必须给出独立词条与指引");
      console.log(
        `[board] #54 冒烟：真实板 ${Buffer.byteLength(boardContent)} B > ${SERVICE_MAX_TEXT_READ_BYTES} B 读取上限 → too-large（#70 正式承载）`,
      );
      return;
    }
    assert.equal(state.kind, "ready", `真实板应可加载：${REAL_BOARD_PATH}`);
    if (state.kind !== "ready") return;
    const board = state.board;

    // 1) 四视图渲染冒烟：四个根锚点都在（视图矩阵 §13.2 的四态载体）。
    const views: Array<[BoardViewMode, string]> = [
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
            viewMode: mode,
          }),
        }),
      );
      assert.ok(markup.includes(anchor), `真实板应渲染出 ${mode} 视图根锚点`);
      markups.set(mode, markup);
    }

    // 2) 接手位（#54-1）：每张带 nextAssignee 的卡在表格责任管线列都显示对应接手位 + 词条标记。
    const rawTasks = collectRawTasks(rawFeatures);
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
    // #89/A4-3 折叠默认态：表格分组行按默认态**条件渲染**（全完成/全取消组默认折叠，缺口/活跃组展开），
    // 断言面因此分两侧钉：①默认态渲染在 markup 的非折叠卡 —— 钉管线接手位；②默认态不在 markup 的卡 ——
    // 必须落入「祖先折叠组头在场且折叠」的形态（不许是渲染遗漏），再用展开对照渲染复证卡确实能出现。
    const pipelineTasks = assertableNext
      .filter((task) => typeof task.no === "number")
      .map((task) => ({ no: task.no as number, nextAssignee: task.nextAssignee }));
    const inlineTasks = pipelineTasks.filter(({ no }) =>
      table.includes(`data-board-card="task:${no}"`),
    );
    const foldedTasks = pipelineTasks.filter(
      ({ no }) => !table.includes(`data-board-card="task:${no}"`),
    );
    const assertPipelineMarker = (
      markup: string,
      label: string,
      task: { no: number; nextAssignee: unknown },
    ): void => {
      const start = markup.indexOf(`data-board-card="task:${task.no}"`);
      assert.ok(start >= 0, `${label}应渲染卡 #${task.no}`);
      const rowEnd = markup.indexOf("<tr", start + 1);
      const row = markup.slice(start, rowEnd === -1 ? markup.length : rowEnd);
      assert.ok(
        row.includes(`data-board-pipeline-next="${String(task.nextAssignee)}"`),
        `卡 #${task.no} 的管线应标出接手位 ${String(task.nextAssignee)}`,
      );
      assert.ok(row.includes("下一个"), `卡 #${task.no} 的接手位应带词条标记「下一个」`);
    };
    for (const task of inlineTasks) assertPipelineMarker(table, "默认态表格视图", task);

    // 折叠侧：祖先折叠 id 走 boardFoldState 单点（稿层 → epic → 期次）；默认 markup 里必须至少有一个
    // 在场且折叠（aria-expanded="false"）的组头，证明「不在 markup」是折叠设计而非卡被丢。
    const foldIdsOf = (no: number): string[] => boardFoldIdsOfCard(board, `task:${no}`);
    const collapsedHeaderOf = (foldId: string): boolean => {
      for (const anchor of [
        `data-board-group-toggle="${foldId}"`,
        `data-board-layer-toggle="${foldId}"`,
      ]) {
        const at = table.indexOf(anchor);
        if (at < 0) continue;
        const tagEnd = table.indexOf(">", at);
        if (table.slice(at, tagEnd).includes('aria-expanded="false"')) return true;
      }
      return false;
    };
    for (const task of foldedTasks) {
      const foldIds = foldIdsOf(task.no);
      assert.ok(
        foldIds.length > 0,
        `卡 #${task.no} 不在默认 markup 且无祖先折叠 id：疑似渲染遗漏（boardFoldIdsOfCard 空集）`,
      );
      assert.ok(
        foldIds.some(collapsedHeaderOf),
        `卡 #${task.no} 不在默认 markup，但祖先折叠组头在场且折叠的形态不存在：疑似渲染遗漏而非折叠（检查 ${foldIds.join(" / ")}）`,
      );
    }
    // 展开对照：把断言面全部卡的祖先折叠 id 置为展开再渲染一次——折叠组内卡必须出现且管线标记齐全。
    const foldIdsToExpand = [...new Set(pipelineTasks.flatMap(({ no }) => foldIdsOf(no)))];
    const tableExpanded = renderToStaticMarkup(
      createElement(ZCodeIntlProvider, {
        initialLocale: "zh-CN" as const,
        children: createElement(BoardPaneView, {
          state,
          viewMode: "table",
          fold: {
            state: Object.fromEntries(foldIdsToExpand.map((foldId) => [foldId, true])),
            onToggle: () => {},
          },
        }),
      }),
    );
    for (const task of foldedTasks)
      assertPipelineMarker(tableExpanded, "展开折叠后的表格视图", task);

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
    for (const feature of rawFeatures) {
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
    const blocker = rawRecordsOf(dependency.task, "blockers").find((entry) => {
      const target = typeof entry.blockedBy === "number" ? byNo.get(entry.blockedBy) : undefined;
      return (
        entry.kind === "dependency" &&
        target !== undefined &&
        target.planCode !== null &&
        typeof target.task.label === "string"
      );
    });
    if (!blocker || typeof blocker.blockedBy !== "number") {
      assert.fail("依赖样例应带可解析的 dependency 目标编号（number）");
    }
    const blockedBy = blocker.blockedBy;
    const target = byNo.get(blockedBy);
    assert.ok(target && target.planCode !== null);
    const expectedTargetText = `${target.planCode}-${String(target.task.label)} · #${String(blockedBy)}`;
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
    // T6162v B-2：降级打印必须带计数——只用总数时，「全部活跃降级（断言面 0）」与「断言全绿」
    // 在证据日志里不可区分。打印前按原始板的独立计数核对日志行计数段（格式/取值回退即红）。
    const activeExcluded = cardsWithNext.length - assertableNext.length;
    const smokeLine =
      `[board] #54 冒烟：接手位卡 ${cardsWithNext.length} 张（断言面 ${assertableNext.length} 张，` +
      `活跃排除 ${activeExcluded} 张）；依赖样例 #${String(dependency.task.no)} → ${expectedTargetText}`;
    const smokeCounts = smokeLine.match(/接手位卡 (\d+) 张（断言面 (\d+) 张，活跃排除 (\d+) 张）/);
    assert.ok(smokeCounts, "降级打印必须带「断言面/活跃排除」计数（T6162v B-2）");
    assert.deepEqual(
      smokeCounts.slice(1).map((value) => Number(value)),
      [cardsWithNext.length, assertableNext.length, activeExcluded],
      "打印的降级计数必须与原始板独立推算的计数一致",
    );
    console.log(smokeLine);
  },
);

test("空态 A1（真实文件系统：无板且无板产物）逐字不静默", async () => {
  const { workspace, cleanup } = await stageWorkspace(null);
  try {
    const state = await loadFromRealFile(workspace);
    assert.equal(state.kind, "missing-new");
    const markup = render(state);
    assert.ok(markup.includes("本项目还没有看板。完成一次访谈登记或创建第一个 spec 后自动生成。"));
  } finally {
    await cleanup();
  }
});

test("空态 A2（真实文件系统：板产物在场而板本体缺失）逐字不静默", async () => {
  // 契约 §2 A2：board.json 缺失 + 同目录板产物（board.md）在场 → 板文件缺失（损毁/误删）。
  const workspace = await mkdtemp(join(tmpdir(), "board-empty-"));
  try {
    await mkdir(join(workspace, ".zcode/board"), { recursive: true });
    await writeFile(join(workspace, ".zcode/board/board.md"), "# 项目看板\n", "utf8");
    const state = await loadFromRealFile(workspace);
    assert.equal(state.kind, "missing-damaged");
    assert.ok(
      render(state).includes("板文件缺失（可能被删除或未同步），请在会话中运行编译器重建。"),
    );
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("空态 A1 反例（真实文件系统）：只有 evidence/ 目录仍按新生（目录不是板产物）", async () => {
  // ZPaPa 自身的形态：`.zcode/board/` 只有 evidence/。本用例钉「探针闭集不含 evidence」
  //（本文件的 node:fs 假件按 existsSync 判定，比真服务宽——目录也报存在，所以误把 evidence
  // 当板产物的实现坏法在这里必咬）。生产服务口径更严：checkFilesExist 只认文件
  //（`packages/services/src/file/fileService.ts` 的 checkFileExists → stat().isFile()）。
  const workspace = await mkdtemp(join(tmpdir(), "board-empty-"));
  try {
    await mkdir(join(workspace, ".zcode/board/evidence"), { recursive: true });
    const state = await loadFromRealFile(workspace);
    assert.equal(state.kind, "missing-new", "证据目录不是板产物：仍是从未有板的新生");
  } finally {
    await rm(workspace, { recursive: true, force: true });
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

test("损坏态（真实文件系统：损坏 JSON）逐字且不白屏（#70 四态之「JSON 损坏」）", async () => {
  const { workspace, cleanup } = await stageWorkspace("{ 这不是 JSON");
  try {
    const state = await loadFromRealFile(workspace);
    assert.equal(state.kind, "damaged");
    assert.ok(render(state).includes("板文件无法读取或已损坏，请在会话中运行编译器重建。"));
  } finally {
    await cleanup();
  }
});

test("P1 回归（真实文件系统）：>128 KiB 的合法板正常渲染，不是损坏态", async () => {
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
      !markup.includes("板文件无法读取或已损坏，请在会话中运行编译器重建。"),
      "合法板不得落损坏态，更不得指引无效的「重编译」",
    );
  } finally {
    await cleanup();
  }
});
