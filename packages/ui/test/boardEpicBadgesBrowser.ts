/**
 * 卡 #90 / A4-4 组头徽章 + epic 弹窗的**浏览器行为断言**（真引擎 + 真 Tailwind 产物 CSS + 真 DOM +
 * 真事件）——独立脚本，文件名不含 `.test.`（`node --test` 常规套件不收它）。
 *
 * 为什么 SSR 不算数（UI 卡门禁）：组头徽章是渲染事实，但「点标题区开弹窗、点 summary 仍折叠」是
 * 点击路由分区行为；「指针下钻先展开祖先层再滚动/高亮」是宿主状态 + 真 DOM 的联合结果；
 * 宽窄两档的溢出是排版行为——都必须真事件、真引擎量。
 *
 * 覆盖（对应卡文验收「点开 epic 组头看到计数与缺口徽章、点入弹窗看到 L2 rollup 与指针下钻；
 * 反例：活跃史诗不出现终态徽章」+ 门禁的溢出探针）：
 *   1. 四视图组头徽章：计数/缺口值逐视图（看板列内投影）；CNCL 落终态、KANB 不落（反例）；
 *   2. 层头点击分区：标题区 → epic 弹窗（名 + 计数 + 缺口 + L2 段位构成 + 期次指针；不自算段位）；
 *      summary → 仍是折叠、不落弹窗（不落卡弹窗）；
 *   3. 指针下钻：点 KANB1 指针 → 关弹窗 + 展开被用户收起的祖先层 + 期次块高亮落点 + 真滚动
 *      （scrollIntoView 落点/参数/可见性）；折叠记忆交互（收起 false → 下钻 true → 重挂读回仍展开）；
 *   4. 关闭路径：× 关窗且焦点归还打开者；
 *   5. 溢出探针：宽 1400 / 窄 360 四视图层头行（层名/计数片/缺口徽章）+ 窄档弹窗盒与区块。
 *
 * 运行条件（缺一即报错退出，不静默跳过）：Electron 二进制 / `@tailwindcss/node` / esbuild
 * （解析同 `boardKanbanBrowserLayoutHarness`；worktree 未装产物时沿上溯找主仓那份）。
 *
 * 命令（在 `packages/ui` 下）：
 *   node --import tsx test/boardEpicBadgesBrowser.ts
 */
import assert from "node:assert/strict";
import {
  assertNoHorizontalOverflow,
  type BoardBrowserOverflowProbe,
} from "./boardBrowserProbeKit.js";
import { epicBadgesDriverSource } from "./boardEpicBadgesBrowserDrivers.js";
import {
  buildPageHtml,
  bundleBoardPaneClient,
  compileBoardPaneCss,
  resolveElectronBinary,
  runBoardPaneInElectron,
} from "./boardKanbanBrowserLayoutHarness.js";
import { EPIC_BOARD } from "./boardEpicFixture.js";

/** 溢出压力：真实板里长中文标题形态（层头行/弹窗头不得被撑出横向溢出）。 */
const LONG_TITLE =
  "看板系统（KANB）——含多期容器层、跨列长标题与折叠默认态压测-abcdefghijklmnopqrstuvwxyz-0123456789";

function buildBoardJson(): string {
  const raw = structuredClone(EPIC_BOARD) as {
    epics: Array<{ title: string }>;
    features: Array<{ title: string }>;
  };
  for (const epic of raw.epics) epic.title = LONG_TITLE;
  for (const feature of raw.features) feature.title = `${feature.title}——${LONG_TITLE}`;
  return JSON.stringify(raw);
}

interface HeaderRow {
  code: string | null;
  planCount: string | null;
  phaseCount: string | null;
  gapCount: string | null;
  gapText: string | null;
  status: string | null;
  header: BoardBrowserOverflowProbe | null;
  layerName: BoardBrowserOverflowProbe | null;
  planChip: BoardBrowserOverflowProbe | null;
  gapBadge: BoardBrowserOverflowProbe | null;
}

interface BadgesResult {
  ua: string;
  headers: Record<"tree" | "list" | "kanban" | "table", HeaderRow[]>;
  dialogBox: {
    code: string | null;
    role: string | null;
    ariaModal: string | null;
    layerName: string | null;
    planCount: string | null;
    phaseCount: string | null;
    gapCount: string | null;
    status: string | null;
    hasStageBadge: boolean;
    composition: Array<{ stage: string | null; text: string }>;
    compositionNone: number;
    pointers: Array<{ name: string | null; label: string | null; text: string }>;
    cardDialogPresent: boolean;
    epicStillOpen: boolean | null;
  };
  closedAfterX: boolean;
  focusAfterClose: boolean;
  drill: {
    dialogClosed: boolean;
    phaseOpen: boolean | null;
    epicOpen: boolean | null;
    highlightedPhase: string | null;
    otherHighlighted: number;
    scrollCalls: Array<{
      card: string | null;
      phase: string | null;
      epic: string | null;
      block: string | null;
    }>;
    phaseVisible: boolean;
    memoryAfterCollapse: string | null;
    memoryAfterDrill: string | null;
  };
  afterRemount: { phaseOpen: boolean; epicOpen: boolean };
  partition: {
    folded: boolean | null;
    dialogAfterSummaryClick: boolean;
    cardDialogAfterSummaryClick: boolean;
  };
  wide: Record<"tree" | "list" | "kanban" | "table", HeaderRow[]>;
  narrow: Record<"tree" | "list" | "kanban" | "table", HeaderRow[]>;
  dialogNarrowProbes: {
    box: BoardBrowserOverflowProbe | null;
    header: BoardBrowserOverflowProbe | null;
    composition: BoardBrowserOverflowProbe | null;
    phases: BoardBrowserOverflowProbe | null;
    pointer: BoardBrowserOverflowProbe | null;
  };
}

/** 组头行溢出探针：行本体 + 层名 + 计数片 + 缺口徽章（缺省不探的项跳过）。 */
function assertNoHeaderOverflow(rows: HeaderRow[], label: string): void {
  for (const row of rows) {
    assert.ok(row.header, `${label}：${row.code} 层头行可探`);
    assertNoHorizontalOverflow(row.header, `${label} 层头行（${row.code}）`);
    assert.ok(row.layerName, `${label}：${row.code} 层名可探`);
    assertNoHorizontalOverflow(row.layerName, `${label} 层名（${row.code}）`);
    if (row.planChip) {
      assertNoHorizontalOverflow(row.planChip, `${label} 计数片（${row.code}）`);
    }
    if (row.gapBadge) {
      assertNoHorizontalOverflow(row.gapBadge, `${label} 缺口徽章（${row.code}）`);
    }
  }
}

function findRow(rows: HeaderRow[], code: string): HeaderRow {
  const row = rows.find((entry) => entry.code === code);
  assert.ok(row, `应有 ${code} 层头行（实测 ${rows.map((entry) => entry.code).join(",")}）`);
  return row;
}

async function main(): Promise<void> {
  const boardJson = buildBoardJson();
  const bundle = await bundleBoardPaneClient();
  const css = await compileBoardPaneCss({
    boards: [boardJson],
    viewModes: ["tree", "kanban", "list", "table"],
  });
  console.log(
    `bundle bytes=${bundle.length} css bytes=${css.length} electron=${resolveElectronBinary()}`,
  );
  const result = (await runBoardPaneInElectron({
    pageHtml: buildPageHtml({ css, boardJson, bundle }),
    driver: epicBadgesDriverSource(),
    label: "epic-badges",
  })) as BadgesResult | null;
  console.log(`EPIC_BADGES_MEASUREMENTS=${JSON.stringify(result, null, 1)}`);
  assert.ok(result, "组头徽章场景应回传量取结果");

  /* 1. 四视图组头徽章：计数/缺口值；KANB 活跃不落终态章、CNCL 落（反例 + 正例）。 */
  for (const mode of ["tree", "list", "table"] as const) {
    const kanb = findRow(result.headers[mode], "KANB");
    assert.equal(kanb.planCount, "3", `${mode}：KANB 稿数=3`);
    assert.equal(kanb.phaseCount, "2", `${mode}：KANB 期数=2`);
    assert.equal(kanb.gapCount, "1", `${mode}：KANB 缺口=1`);
    assert.equal(kanb.gapText, "缺口 1", `${mode}：缺口徽章文案`);
    assert.equal(kanb.status, null, `${mode}：活跃史诗不出现终态徽章（反例）`);
    const cncl = findRow(result.headers[mode], "CNCL");
    assert.equal(cncl.status, "cancelled", `${mode}：终态登记行落终态徽章`);
    assert.equal(cncl.gapCount, null, `${mode}：无缺口层不落缺口徽章`);
  }
  /* 看板列内投影：承载 PLW0 的列（缺口 1）= 本列 1 稿；待办列 CNCL 落终态、无缺口。 */
  const kanbanGapRow = result.headers.kanban.find(
    (row) => row.code === "KANB" && row.gapCount === "1",
  );
  assert.ok(kanbanGapRow, "看板：应有承载缺口成员的 KANB 列（缺口=1）");
  assert.equal(kanbanGapRow.planCount, "1", "看板：缺口列 KANB 计数 = 本列承载（1 稿，非全量 3）");
  assert.equal(kanbanGapRow.phaseCount, "1", "看板：缺口列期数 = 本列承载（1 期）");
  assert.ok(
    result.headers.kanban.some((row) => row.code === "KANB" && row.gapCount === null),
    "看板：无缺口列不落缺口徽章（列内投影）",
  );
  assert.equal(
    result.headers.kanban.some((row) => row.code === "KANB" && row.status !== null),
    false,
    "看板：KANB 各列均不落终态章",
  );
  assert.ok(
    result.headers.kanban.some((row) => row.code === "CNCL" && row.status === "cancelled"),
    "看板：CNCL 所在列落终态章",
  );

  /* 2. 标题区点击 → epic 弹窗（真事件路由；名 + 计数 + 缺口 + L2 构成 + 指针）。 */
  assert.equal(result.dialogBox.code, "KANB", "弹窗身份 = epic 码");
  assert.equal(result.dialogBox.role, "dialog", "弹窗语义");
  assert.equal(result.dialogBox.ariaModal, "true", "模态语义");
  assert.equal(result.dialogBox.layerName, "KANB", "弹窗头复用组头零件的层身份位");
  assert.equal(result.dialogBox.planCount, "3", "弹窗头稿数");
  assert.equal(result.dialogBox.phaseCount, "2", "弹窗头期数");
  assert.equal(result.dialogBox.gapCount, "1", "弹窗头 rollup 缺口徽章");
  assert.equal(result.dialogBox.status, null, "活跃史诗弹窗不落终态章（反例同守）");
  assert.equal(result.dialogBox.hasStageBadge, false, "不自算段位：弹窗不落段位徽章");
  assert.equal(result.dialogBox.cardDialogPresent, false, "epic 弹窗不落卡片弹窗（层不是卡）");
  assert.equal(result.dialogBox.epicStillOpen, true, "点标题区不折叠（preventDefault 分区）");
  assert.deepEqual(
    result.dialogBox.composition.map((row) => [row.stage, row.text]),
    [
      ["待办", "待办1"],
      ["执行中", "执行中1"],
      ["审核中", "审核中1"],
    ],
    "L2 rollup 段位构成按词表序（只读成员已有段位）",
  );
  assert.equal(result.dialogBox.compositionNone, 0, "无无段位成员 → 不落无段位行");
  assert.deepEqual(
    result.dialogBox.pointers.map((pointer) => [pointer.name, pointer.label, pointer.text]),
    [
      ["KANB1", "下钻到 KANB1", "KANB12 稿缺口 1"],
      ["KANB2", "下钻到 KANB2", "KANB21 稿"],
    ],
    "期次指针：升序 + 下钻可及名称 + 本期稿数/缺口",
  );

  /* 3. 关闭路径与焦点归还。 */
  assert.equal(result.closedAfterX, true, "× 关窗");
  assert.equal(result.focusAfterClose, true, "关闭后焦点归还打开者（epic 层头标题区）");

  /* 4. 指针下钻：关弹窗 + 展开被用户收起的祖先层 + 期次块高亮落点（唯一命中）。 */
  assert.equal(result.drill.dialogClosed, true, "下钻关弹窗");
  assert.equal(result.drill.phaseOpen, true, "下钻展开被用户收起的期次层");
  assert.equal(result.drill.epicOpen, true, "祖先 epic 层展开");
  assert.equal(result.drill.highlightedPhase, "true", "期次块带高亮锚点（落点看得见）");
  assert.equal(result.drill.otherHighlighted, 1, "高亮只命中期次块一处");
  /* 4b. 下钻滚动落点（M3 覆盖缺口固化）：宿主 scrollIntoView 真调用观测（探针思路照搬）。 */
  const phaseCall = result.drill.scrollCalls.find((call) => call.phase === "KANB1");
  assert.ok(
    phaseCall,
    `下钻后应有滚动到 KANB1 期次块的 scrollIntoView 调用（实测=${JSON.stringify(result.drill.scrollCalls)}）`,
  );
  assert.equal(phaseCall.block, "center", "滚动落点用 block=center");
  assert.ok(result.drill.phaseVisible, "滚动后 KANB1 期次块在面板视口内");
  /* 4c. 下钻与 #89 折叠记忆交互（探针断言固化）：收起 false → 下钻 true → 重挂读回仍展开。 */
  const collapseState = JSON.parse(result.drill.memoryAfterCollapse ?? "{}") as Record<
    string,
    boolean
  >;
  assert.equal(collapseState["phase:KANB#1"], false, "用户收起的期次在记忆里是 false");
  const drillState = JSON.parse(result.drill.memoryAfterDrill ?? "{}") as Record<string, boolean>;
  assert.equal(drillState["phase:KANB#1"], true, "下钻把被用户收起的期次在记忆里改回 true");
  assert.equal(drillState["epic:KANB"], true, "下钻同时展开 epic 祖先（写同一记忆）");
  assert.equal(result.afterRemount.phaseOpen, true, "重挂后 KANB1 仍展开（记忆读回）");
  assert.equal(result.afterRemount.epicOpen, true, "重挂后 KANB 仍展开（记忆读回）");

  /* 5. 分区纪律：点 summary 仍是折叠（真指针序列）；不落任何弹窗。 */
  assert.equal(result.partition.folded, false, "点 summary → 收起（原生 toggle 生效）");
  assert.equal(result.partition.dialogAfterSummaryClick, false, "点 summary 不落 epic 弹窗");
  assert.equal(result.partition.cardDialogAfterSummaryClick, false, "点 summary 不落卡片弹窗");

  /* 6. 溢出探针：宽 1400 / 窄 360，四视图层头行；窄档弹窗盒与区块。 */
  for (const mode of ["tree", "list", "kanban", "table"] as const) {
    assertNoHeaderOverflow(result.wide[mode], `${mode}（宽 1400）`);
  }
  for (const mode of ["tree", "list", "kanban", "table"] as const) {
    assertNoHeaderOverflow(result.narrow[mode], `${mode}（窄 360）`);
  }
  const surfaces = result.dialogNarrowProbes;
  for (const key of ["box", "header", "composition", "phases", "pointer"] as const) {
    assert.ok(surfaces[key], `窄档弹窗 ${key} 可探`);
    assertNoHorizontalOverflow(surfaces[key], `窄档弹窗 ${key}`);
  }

  console.log(
    `EPIC_BADGES_ASSERTIONS_OK 树形组头=${JSON.stringify(result.headers.tree)} ` +
      `弹窗=${JSON.stringify(result.dialogBox.pointers)} 下钻=${JSON.stringify(result.drill)} ` +
      `窄档 tree 层头数=${result.narrow.tree.length}`,
  );
  console.log("BOARD_EPIC_BADGES_BROWSER_ASSERTIONS_OK");
}

await main();
