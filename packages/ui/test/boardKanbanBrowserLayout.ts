/**
 * 看板「已完成」列的**真实布局缝**行为断言（评审 #35-S1 二轮）——独立脚本，
 * **不在** `node --test` 常规套件里（文件名不含 `.test.`，`'test/'*.test.ts` 不会收它）。
 *
 * 为什么必须另起一层：列体能不能滚、拿到多少剩余高度，只有真实排版量得出来。上一轮的「类字符串」
 * 结构断言已删除——复验实测：`details` 承载高度链时断言全绿，而真实引擎里列体 750/750 永不滚动
 * （溢出列盒 394px）。结构断言不构成行为证据，本文件才是。
 *
 * 运行条件（缺一即无法运行；不满足时本脚本**报错退出**，不静默跳过）：
 * - Electron 二进制（应用自己的引擎：Electron 41 / Chromium 146）。沿 test 目录上溯找
 *   `node_modules/electron`（worktree 内若未安装产物会自动找到主仓那份），也可用
 *   `ZCODE_ELECTRON_BINARY` 显式指定；
 * - `@tailwindcss/node` / `esbuild`：真实 Tailwind 产物 CSS + 真组件 bundle（见 harness 文件头）。
 *
 * 命令（在 `packages/ui` 下）：
 *   node --import tsx test/boardKanbanBrowserLayout.ts [board.json 快照路径]
 *   给了路径就额外量一份真实板形态（只断言布局不变量；列内内容不溢出的前提不成立时打印 SKIP），
 *   不给就只跑内建夹具。
 *
 * 断言分层（如实标注）：
 * - 行为断言（本文件，真引擎 + 真 CSS + 真 DOM + 真交互）：已完成列体 canScroll / `scrollTop`
 *   生效 / 与「待办」列几何同构 / 七列行不纵向滚动 / 点击列头折叠按钮 → aria-expanded +
 *   条件渲染 / 折叠状态下点提示条跳转 → 已完成列自动展开且落点高亮可见。
 * - 结构断言（`boardViewsRender.test.ts`）：折叠锚点、aria-expanded 初值、折叠态列体不渲染。
 * - 纯函数断言（`boardCardInteraction.test.ts`）：跳转揭示判据。
 *
 * 管道分层：页面内驱动在 `boardKanbanBrowserLayoutDrivers.ts`，真 Tailwind CSS / bundle /
 * Electron 运行在 `boardKanbanBrowserLayoutHarness.ts`；本文件只放夹具、判据与流程。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { STAGE_MATRIX_BOARD } from "./boardStageMatrixFixture.js";
import {
  interactiveDriverSource,
  layoutOnlyDriverSource,
} from "./boardKanbanBrowserLayoutDrivers.js";
import {
  bundleBoardPaneClient,
  buildPageHtml,
  compileBoardPaneCss,
  resolveElectronBinary,
  runBoardPaneInElectron,
  type ColumnMeasure,
  type RunResult,
  type Snapshot,
} from "./boardKanbanBrowserLayoutHarness.js";

/** 夹具里的跳转落点卡（提示条 `interrupted-resume` 段的落点，在已完成列内且被折叠）。 */
const FIXTURE_TARGET_NO = 312;

/* ---------------- 夹具：已完成列与待办列都塞到溢出（几何同构要一个同样溢出的对照列） ---------------- */

type RawTask = Record<string, unknown>;
type RawBoard = {
  features: Array<{ tasks: RawTask[] }>;
  attentionSummary: Record<string, number>;
};

function completedTask(no: number, index: number, attention: string[]): RawTask {
  return {
    no,
    label: `8.${index + 1}`,
    title: `已完成卡 ${index + 1}`,
    status: "completed",
    statusRule: "tasks.md checkbox checked",
    stage: "已完成",
    draft: false,
    attention,
    blockers: [],
    lastRun: {
      at: "2026-10-09T15:00:00+08:00",
      role: "integrator",
      result: "done",
      stoppedAt: null,
      next: null,
    },
    activeRun: null,
    worktree: null,
    updatedAt: "2026-10-09T15:00:00+08:00",
  };
}

function pendingTask(no: number, index: number): RawTask {
  return {
    no,
    label: `7.${index + 1}`,
    title: `待办卡 ${index + 1}`,
    status: "pending",
    statusRule: "tasks.md checkbox unchecked",
    stage: "待办",
    draft: false,
    attention: [],
    blockers: [],
    lastRun: null,
    activeRun: null,
    worktree: null,
    updatedAt: "2026-10-09T10:00:00+08:00",
  };
}

/** 内建夹具：14 张已完成 + 15 张待办（列盒高约 485 → 两列内容都远超列盒）。 */
function buildFixtureBoardJson(): string {
  const raw = structuredClone(STAGE_MATRIX_BOARD) as unknown as RawBoard;
  const feature = raw.features[0];
  assert.ok(feature, "夹具应有首个特性");
  for (let index = 0; index < 12; index += 1) feature.tasks.push(pendingTask(200 + index, index));
  for (let index = 0; index < 13; index += 1) {
    const isTarget = 300 + index === FIXTURE_TARGET_NO;
    feature.tasks.push(completedTask(300 + index, index, isTarget ? ["interrupted-resume"] : []));
  }
  // 跳转落点唯一化：清掉 #8 的中断码，提示条该段落点只能是已完成列里那张（#312）。
  const target = feature.tasks.find((task) => task.no === 8);
  assert.ok(target, "夹具应有 #8");
  target.attention = ["unmerged-worktree"];
  raw.attentionSummary = {
    interviewedNotArranged: 0,
    arrangedNotExpanded: 0,
    interruptedResume: 1,
    unmergedWorktree: 0,
  };
  return JSON.stringify(raw);
}

/* ---------------- 断言 ---------------- */

function columnOf(snapshot: Snapshot, stage: string): ColumnMeasure {
  const column = snapshot.columns.find((entry) => entry.stage === stage);
  assert.ok(column && !column.missing, `量取结果应含 ${stage} 列`);
  return column;
}

/** 七列共有的布局不变量：列体不溢出列盒、行不纵向滚动。 */
function assertCommonLayout(snapshot: Snapshot, label: string): void {
  for (const column of snapshot.columns) {
    if (column.missing || column.bodyBox === null) continue;
    assert.equal(
      column.bodyOverflowsBox,
      false,
      `${label}/${column.stage}：列体不得溢出列盒（列体底 ${column.bodyBox.bottom} vs 列盒底 ${column.colBox.bottom}）`,
    );
  }
  assert.ok(
    snapshot.row.scrollH <= snapshot.row.clientH + 1,
    `${label}：七列行不得纵向滚动（scrollH ${snapshot.row.scrollH} vs clientH ${snapshot.row.clientH}）——` +
      `列内溢出必须由列体自己滚`,
  );
}

/** 「已完成」列与「待办」列几何同构 + 列体能滚且 scrollTop 生效（本轮收口判据）。 */
function assertDoneColumnScrolls(snapshot: Snapshot, label: string): void {
  const done = columnOf(snapshot, "已完成");
  const todo = columnOf(snapshot, "待办");
  assert.equal(done.ariaExpanded, "true", `${label}：已完成列应展开`);
  assert.ok(
    done.contentH !== null &&
      done.headerBox !== null &&
      done.contentH > done.colBox.h - done.headerBox.h,
    `${label}：前提——已完成列内容(${done.contentH})必须高于可用高(${done.colBox.h - (done.headerBox?.h ?? 0)})，否则本断言无意义`,
  );
  assert.equal(done.bodyCanScroll, true, `${label}：已完成列体应可滚动（评审 #35-S1）`);
  assert.ok(
    (done.bodyScrolledTo ?? 0) > 0,
    `${label}：列体 scrollTop 应生效（实测 ${done.bodyScrolledTo}）`,
  );
  assert.ok(
    done.bodyClientH !== null && done.bodyScrollH !== null && done.bodyScrollH > done.bodyClientH,
    `${label}：列体 scrollHeight 应大于 clientHeight（实测 ${done.bodyScrollH}/${done.bodyClientH}）`,
  );
  assert.equal(done.colBox.h, todo.colBox.h, `${label}：已完成列盒高应与六列同（行内拉伸）`);
  assert.equal(
    done.bodyClientH,
    todo.bodyClientH,
    `${label}：已完成列体应拿到与同样溢出的六列（待办）相同的剩余高度`,
  );
  assert.equal(done.bodyBox?.bottom, todo.bodyBox?.bottom, `${label}：两列列体底边应齐平`);
  assert.equal(todo.bodyCanScroll, true, `${label}：对照列（待办）同样溢出可滚（同一条链）`);
}

/* ---------------- 主流程 ---------------- */

async function runFixtureCase(params: {
  css: string;
  boardJson: string;
  bundle: string;
}): Promise<void> {
  const fixtureRun = (await runBoardPaneInElectron({
    pageHtml: buildPageHtml({
      css: params.css,
      boardJson: params.boardJson,
      bundle: params.bundle,
    }),
    driver: interactiveDriverSource({ targetCardId: `task:${FIXTURE_TARGET_NO}` }),
    label: "fixture",
  })) as RunResult;
  console.log(`FIXTURE_MEASUREMENTS=${JSON.stringify(fixtureRun, null, 1)}`);
  const expanded = fixtureRun.measurements.find((entry) => entry.label === "expanded");
  assert.ok(expanded, "夹具应产出首次展开量取");
  // 先量布局（本轮的收口判据），再量交互：坏实现（如 details 承载高度链）的失败点落在布局上、
  // 带着真实数字，而不是在找不到按钮的地方超时。
  assertCommonLayout(expanded, "夹具/展开");
  assertDoneColumnScrolls(expanded, "夹具/展开");

  const collapsed = fixtureRun.measurements.find((entry) => entry.label === "collapsed");
  const reExpanded = fixtureRun.measurements.find((entry) => entry.label === "re-expanded");
  assert.ok(
    collapsed && reExpanded && fixtureRun.reveal,
    `夹具应产出折叠/再展开/揭示三段量取（toggleMissing=${fixtureRun.toggleMissing}）`,
  );

  // 折叠：aria-expanded + 条件渲染（列体整块不渲染），列盒高与六列不受影响
  const doneCollapsed = columnOf(collapsed, "已完成");
  assert.equal(doneCollapsed.ariaExpanded, "false", "夹具/折叠：aria-expanded=false");
  assert.equal(doneCollapsed.bodyBox, null, "夹具/折叠：列体应整块不渲染（条件渲染）");
  assert.equal(doneCollapsed.cardCount, 0, "夹具/折叠：列内卡片应不在 DOM 里");
  assert.equal(
    doneCollapsed.colBox.h,
    columnOf(expanded, "已完成").colBox.h,
    "夹具/折叠：列盒高不因折叠变化（折叠只是不渲染列体）",
  );
  for (const stage of ["待设计", "待办", "执行中", "审核中", "阻塞", "已取消"]) {
    assert.deepEqual(
      columnOf(collapsed, stage).colBox,
      columnOf(expanded, stage).colBox,
      `夹具/折叠：${stage} 列几何不应受已完成列折叠影响`,
    );
  }
  assertCommonLayout(collapsed, "夹具/折叠");

  // 再展开：回到与首测逐项相同的几何与滚动行为
  assertCommonLayout(reExpanded, "夹具/再展开");
  assertDoneColumnScrolls(reExpanded, "夹具/再展开");
  const doneReExpanded = columnOf(reExpanded, "已完成");
  const doneExpanded = columnOf(expanded, "已完成");
  assert.deepEqual(
    {
      colBox: doneReExpanded.colBox,
      bodyBox: doneReExpanded.bodyBox,
      bodyClientH: doneReExpanded.bodyClientH,
    },
    {
      colBox: doneExpanded.colBox,
      bodyBox: doneExpanded.bodyBox,
      bodyClientH: doneExpanded.bodyClientH,
    },
    "夹具/再展开：几何应与首次展开逐项相同",
  );

  // 折叠状态下的跳转揭示：宿主先置展开态 → 落点回 DOM → 高亮可见
  const reveal = fixtureRun.reveal;
  assert.ok(reveal, "夹具应产出揭示量取");
  assert.equal(
    reveal.targetInDomWhileCollapsed,
    false,
    "折叠时落点本不在 DOM（条件渲染）——揭示必须先展开",
  );
  assert.equal(reveal.ariaExpanded, "true", "跳转后已完成列应已展开（评审 #35-S1 二轮连带适配）");
  assert.equal(reveal.highlighted, true, "跳转落点应带高亮锚点");
  assert.equal(reveal.cardInsideBody, true, "跳转落点应落在列体可视区内");
  assert.equal(reveal.cardInViewport, true, "跳转落点应落在视口内（横向也应被滚到）");
  assert.equal(reveal.bodyCanScroll, true, "揭示后列体仍可滚动");
  const afterReveal = fixtureRun.measurements.find((entry) => entry.label === "after-reveal");
  assert.ok(afterReveal, "夹具应产出揭示后的量取");
  assertCommonLayout(afterReveal, "夹具/揭示后");
  console.log("FIXTURE_ASSERTIONS_OK");
}

/** 真实板形态：同一把尺子量真板；前提（列内容溢出）不成立时打印 SKIP 而不是空过。 */
async function runRealBoardCase(params: {
  css: string;
  boardJson: string;
  bundle: string;
}): Promise<void> {
  const measured = (await runBoardPaneInElectron({
    pageHtml: buildPageHtml({
      css: params.css,
      boardJson: params.boardJson,
      bundle: params.bundle,
    }),
    driver: layoutOnlyDriverSource(),
    label: "real-board",
  })) as Omit<Snapshot, "label">;
  const snapshot: Snapshot = { ...measured, label: "真实板" };
  console.log(`REAL_BOARD_MEASUREMENTS=${JSON.stringify(snapshot, null, 1)}`);
  assertCommonLayout(snapshot, "真实板");
  const done = columnOf(snapshot, "已完成");
  const available = done.colBox.h - (done.headerBox?.h ?? 0);
  if (done.contentH === null || done.contentH <= available) {
    console.log(
      `REAL_BOARD_SKIP 已完成列内容(${done.contentH})未超过可用高(${available})：本次不判定滚动行为（不空过）`,
    );
    return;
  }
  assertDoneColumnScrolls(snapshot, "真实板");
  console.log(
    `REAL_BOARD_ASSERTIONS_OK 已完成列 cardCount=${done.cardCount} contentH=${done.contentH} 可用高=${available} ` +
      `bodyClientH=${done.bodyClientH} bodyScrollH=${done.bodyScrollH} bodyCanScroll=${done.bodyCanScroll} ` +
      `bodyScrolledTo=${done.bodyScrolledTo} 列盒高=${done.colBox.h}`,
  );
}

async function main(): Promise<void> {
  const fixtureBoardJson = buildFixtureBoardJson();
  const realBoardPath = process.argv[2];
  const realBoardJson =
    realBoardPath !== undefined && realBoardPath.trim() !== ""
      ? readFileSync(path.resolve(realBoardPath), "utf8")
      : null;

  const bundle = await bundleBoardPaneClient();
  const css = await compileBoardPaneCss({
    boards: realBoardJson === null ? [fixtureBoardJson] : [fixtureBoardJson, realBoardJson],
  });
  console.log(
    `bundle bytes=${bundle.length} css bytes=${css.length} electron=${resolveElectronBinary()}`,
  );

  await runFixtureCase({ css, boardJson: fixtureBoardJson, bundle });
  if (realBoardJson === null) {
    console.log("REAL_BOARD_SKIP 未提供 board.json 快照路径（第 1 个参数）");
  } else {
    await runRealBoardCase({ css, boardJson: realBoardJson, bundle });
  }
  console.log("BOARD_LAYOUT_ASSERTIONS_OK");
}

await main();
