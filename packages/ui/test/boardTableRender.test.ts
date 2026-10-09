import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { BoardTableView, type BoardTableViewProps } from "../src/board/BoardTableView.js";
import {
  BOARD_TABLE_COLUMNS,
  DEFAULT_BOARD_TABLE_COLUMN_VISIBILITY,
  toggleBoardTableColumn,
  visibleBoardTableColumns,
} from "../src/board/boardTableViewModel.js";
import { buildBoardListRows, EMPTY_BOARD_LIST_CONTROLS } from "../src/board/boardViewsViewModel.js";
import { parseBoardJson, type BoardViewModel } from "../src/board/boardViewModel.js";
import { ZCodeIntlProvider } from "../src/i18n/IntlProvider.js";
import { STAGE_MATRIX_BOARD } from "./boardStageMatrixFixture.js";

/**
 * 表格视图的真渲染守卫（卡 #34）。
 *
 * 期望值的独立真源：契约 §13.5（表格：默认列 + 列可配置）、§13.2 表格列（段位/`lastRun`/`blockers`
 * 各格要求）、§6（行点击 → 弹窗；跳转落点高亮）、§3.3（最近执行四要素）与卡 #34 派发指令
 * （列 = 号/名称/段位/状态/最近执行/卡龄；行点击=打开弹窗；排序复用列表视图语义）。
 * 卡龄与列序逐字写死，不由实现回算。
 */

/** 卡龄基准：夹具 updatedAt 最新为 2026-10-09T15:30:00+08:00（#9）。 */
const NOW = Date.parse("2026-10-12T09:00:00+08:00");

function matrixBoard(): BoardViewModel {
  const outcome = parseBoardJson(JSON.stringify(STAGE_MATRIX_BOARD));
  if (outcome.kind !== "ready") throw new Error("七段位夹具必须是 v2 且 features 非空");
  return outcome.board;
}

function render(props: Partial<BoardTableViewProps> = {}, locale: "zh-CN" | "en-US" = "zh-CN") {
  return renderToStaticMarkup(
    createElement(ZCodeIntlProvider, {
      initialLocale: locale,
      children: createElement(BoardTableView, { board: matrixBoard(), now: NOW, ...props }),
    }),
  );
}

function attributeValue(markup: string, attribute: string): string {
  const match = new RegExp(`${attribute}="([^"]*)"`).exec(markup);
  assert.ok(match, `markup 里找不到 ${attribute}：\n${markup.slice(0, 400)}`);
  return match[1] ?? "";
}

/** 行/单元格锚点的顺序列表。 */
function anchors(markup: string, attribute: string): string[] {
  return [...markup.matchAll(new RegExp(`${attribute}="([^"]*)"`, "g"))].map(
    (match) => match[1] ?? "",
  );
}

/** 某一行（`<tr data-board-card=…>` 到 `</tr>`）：行序由排序决定，不能靠「两卡之间的切片」猜。 */
function rowOf(markup: string, id: string): string {
  const start = markup.indexOf(`data-board-card="${id}"`);
  assert.ok(start >= 0, `markup 里找不到行 ${id}`);
  const rowStart = markup.lastIndexOf("<tr", start);
  const rowEnd = markup.indexOf("</tr>", start);
  assert.ok(rowStart >= 0 && rowEnd > rowStart, `行 ${id} 结构不完整`);
  return markup.slice(rowStart, rowEnd);
}

test("表格：列头按配置渲染，默认十列（契约默认列 + 卡龄）", () => {
  const markup = render();
  assert.ok(markup.includes('data-board-view="table"'), "表格视图应有自己的根锚点");
  assert.deepEqual(anchors(markup, "data-board-column-header"), [...BOARD_TABLE_COLUMNS]);
  assert.ok(markup.includes(">号<"), "列头走词条（zh-CN 逐字）");
  assert.ok(markup.includes(">段位<") && markup.includes(">卡龄<"), "派发指令点名的列头都在");
  assert.ok(markup.includes(">责任管线<"), "契约 §13.5 的 assignees 列也在");
});

test("表格：隐藏列同时消失（列头与单元格一起收），可见列序恒为闭集序", () => {
  const columns = toggleBoardTableColumn(
    toggleBoardTableColumn(DEFAULT_BOARD_TABLE_COLUMN_VISIBILITY, "assignees"),
    "attention",
  );
  const markup = render({ columns });
  assert.deepEqual(anchors(markup, "data-board-column-header"), [
    "no",
    "title",
    "stage",
    "status",
    "lastRun",
    "updatedAt",
    "age",
    "blockers",
  ]);
  const firstRow = rowOf(markup, "task:7");
  assert.deepEqual(anchors(firstRow, "data-board-cell"), [
    "no",
    "title",
    "stage",
    "status",
    "lastRun",
    "updatedAt",
    "age",
    "blockers",
  ]);
  assert.ok(!firstRow.includes("implementer"), "被隐藏列的单元格不渲染内容");
});

test("表格：行 = 列表视图同一管线（全卡平铺，顺序逐位一致）", () => {
  const rowIds = anchors(render(), "data-board-card");
  assert.deepEqual(
    rowIds,
    buildBoardListRows(matrixBoard()).map((node) => node.id),
    "过滤/排序与列表视图同源（attention 置顶 + updatedAt 倒序 + 已完成沉底）",
  );
  assert.equal(rowIds.length, 13, "6 特性 + 7 卡全部平铺");
  assert.ok(rowIds.includes("spec:preview-channel"), "特性节点也在表里");
  const filtered = anchors(
    render({ controls: { ...EMPTY_BOARD_LIST_CONTROLS, stage: "执行中" } }),
    "data-board-card",
  );
  assert.deepEqual(filtered, ["task:8", "spec:preview-channel"], "走同一过滤条件");
});

test("表格：单元格值（号/名称/段位/状态/最近执行/卡龄/阻碍/缺口）", () => {
  const markup = render();
  const row = rowOf(markup, "task:8");
  assert.ok(row.includes("ID-1.2"), "号列：ID-<label>");
  assert.ok(row.includes("让开关立刻生效（核心）"), "名称列");
  assert.ok(row.includes(">执行中<"), "段位列（词条文本）");
  assert.ok(row.includes(">进行中<"), "状态列（status 词条）");
  assert.ok(row.includes("停在 #8"), "最近执行列：四要素里的断点段");
  // #8 updatedAt=2026-10-09T14:20+08:00，now=2026-10-12T09:00+08:00 → 2 天。
  assert.ok(row.includes(">2 天<"), `卡龄列 = updatedAt 距今天数：${row.slice(0, 300)}`);
  assert.ok(row.includes(">执行中断可续 · 待合并（未回流）<"), "缺口列多码摘要");
  const card7 = rowOf(markup, "task:7");
  assert.ok(card7.includes(">受阻 1<"), "阻碍列 = 受阻 N");
  // #7 updatedAt=2026-10-09T14:05+08:00 → 2 天；#10 updatedAt=2026-10-09T09:00+08:00 → 恰好 3 天。
  assert.ok(card7.includes(">2 天<"), "卡龄列按各卡自己的 updatedAt");
  assert.ok(rowOf(markup, "task:10").includes(">3 天<"), "不同卡龄互不串行");
});

test("表格：行可点开弹窗（role=button + tabindex），跳转落点带高亮锚点", () => {
  const markup = render({ onOpenCard: () => {}, highlightCardId: "task:8" });
  const rows = [...markup.matchAll(/<tr[^>]*data-board-card="([^"]*)"[^>]*>/g)].map(
    (match) => match[0],
  );
  assert.equal(rows.length, 13, "每行都是可点行");
  for (const row of rows) {
    assert.ok(row.includes('role="button"'), `行应可点（无嵌套按钮的可点行）：${row}`);
    assert.ok(row.includes('tabindex="0"'), `行应可键盘聚焦：${row}`);
  }
  assert.ok(
    markup.includes('data-board-card="task:8"') &&
      /data-board-card="task:8"[^>]*data-board-card-highlight="true"/.test(markup),
    "命中跳转落点的行带高亮锚点",
  );
  assert.ok(
    !/data-board-card="task:7"[^>]*data-board-card-highlight/.test(markup),
    "其余行不带高亮锚点",
  );
  assert.ok(!render().includes("data-board-card-highlight"), "没有跳转时不挂高亮锚点");
});

test("表格：只读展示（不给 onOpenCard 时不挂交互 props，锚点仍在）", () => {
  const markup = render();
  assert.ok(markup.includes('data-board-card="task:8"'), "卡片锚点在（跳转仍需定位）");
  assert.ok(!markup.includes('role="button"'), "没有打开回调 → 行不宣称可点");
});

test("表格：过滤后无行给空态文案（与列表视图同一条词条）", () => {
  const markup = render({
    controls: { ...EMPTY_BOARD_LIST_CONTROLS, stage: "阻塞", status: "cancelled" },
  });
  assert.ok(!markup.includes("data-board-card="), "无行时不渲染任何卡片");
  const empty = /data-board-table-empty=""[^>]*>([^<]*)</.exec(markup);
  assert.ok(empty, "空结果应给空态锚点");
  assert.equal((empty[1] ?? "").trim(), "没有符合当前过滤条件的节点。");
});

test("表格：列配置控件的锚点（每列一个开关，勾选态 = 当前可见性）", () => {
  const columns = toggleBoardTableColumn(DEFAULT_BOARD_TABLE_COLUMN_VISIBILITY, "lastRun");
  const markup = render({ columns });
  const toggles = [...markup.matchAll(/data-board-column-toggle="([^"]*)"/g)].map(
    (match) => match[1],
  );
  assert.deepEqual(toggles, [...BOARD_TABLE_COLUMNS], "每列一个开关（闭集全覆盖）");
  const lastRunToggle = /<input[^>]*data-board-column-toggle="lastRun"[^>]*>/.exec(markup);
  assert.ok(lastRunToggle, "最近执行列的开关应渲染");
  assert.ok(!lastRunToggle[0].includes("checked"), "被隐藏的列开关为未勾选");
  assert.ok(markup.includes('data-board-column-config-count="9"'), "摘要显示可见列数");
});

test("表格：英文界面列头与配置控件走英文词条（不漏中文）", () => {
  const markup = render({}, "en-US");
  const headers = [...markup.matchAll(/data-board-column-header="[^"]*"[^>]*>([^<]*)</g)].map(
    (match) => (match[1] ?? "").trim(),
  );
  assert.deepEqual(headers, [
    "ID",
    "Name",
    "Stage",
    "Status",
    "Pipeline",
    "Last run",
    "Updated",
    "Age",
    "Blockers",
    "Gaps",
  ]);
  for (const header of headers) {
    assert.ok(!/[\u4e00-\u9fff]/.test(header), `en-US 列头漏了中文：${header}`);
  }
  assert.ok(markup.includes("Columns"), "列配置控件走英文词条");
  assert.ok(markup.includes(">2 d<"), "卡龄文案走英文词条");
});

test("表格：可见列顺序不受列配置的实现细节影响（配置只表达显示/隐藏）", () => {
  const columns = { ...DEFAULT_BOARD_TABLE_COLUMN_VISIBILITY, stage: false, status: false };
  assert.deepEqual(visibleBoardTableColumns(columns), [
    "no",
    "title",
    "assignees",
    "lastRun",
    "updatedAt",
    "age",
    "blockers",
    "attention",
  ]);
  assert.deepEqual(anchors(render({ columns }), "data-board-column-header"), [
    "no",
    "title",
    "assignees",
    "lastRun",
    "updatedAt",
    "age",
    "blockers",
    "attention",
  ]);
  assert.equal(attributeValue(render({ columns }), "data-board-column-config-count"), "8");
});
