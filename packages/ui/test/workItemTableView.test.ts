import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { WorkItem } from "@zcode/shared";
import type { IServiceAccessor, SquadSnapshot, SquadRunRecord } from "@zcode/services";
import { ZCodeIntlProvider } from "../src/i18n/IntlProvider.js";
import { ServiceProvider } from "../src/hooks/useServices.js";
import { squadDiscardableWorkItemIds } from "../src/squad/squadEntryViewModel.js";
import { WorkItemsSurface } from "../src/squad/WorkItemsSurface.js";
import {
  WORK_ITEM_SORT_KEYS,
  WORK_ITEM_SURFACE_COLUMNS,
  applyWorkItemSurfaceIntent,
  workItemSurfaceDefaultState,
  type WorkItemSurfaceColumnKey,
  type WorkItemSurfaceIntent,
  type WorkItemSurfaceState,
} from "../src/squad/workItemSurfaceViewModel.js";
import {
  WORK_ITEM_TABLE_TITLE_SORT_KEY,
  workItemTableColumnSortKey,
  workItemTableSortAria,
  workItemTableSortIntent,
} from "../src/squad/workItemTableViewModel.js";

/* 「table 视图：可配置列 + 排序表头 + 单元格」（阶段二 · T-P2-R3）的**判据与呈现**用例。
 *
 * 本文件盯的四条（卡面验收）：
 * ① 列配置是**会话内**状态、判据全在纯函数（组件只回传意图，不自己 setState）；
 * ② 表头排序**只回传 R1 的排序意图**（无第二份排序实现：表视图链上不得出现比较/排序代码）；
 * ③ 日期 / 优先级 / 标签 / 创建人 / identifier 的单元格渲染**复用既有单源**（零第二份格式化）；
 * ④ 无障碍：`aria-sort` 表头、行/列关联（`<th scope>` ↔ `<td>` 对齐）、键盘可达（原生命中按钮）。
 *
 * 期望值的独立真源：WAI-ARIA 的 `aria-sort` 取值（ascending / descending / none，是规范 token
 * 而不是本地化文案）+ R1 冻结的意图折叠语义（`applyWorkItemSurfaceIntent`：换键保留方向、
 * 换方向保留键）+ 冻结闭集（8 列 / 5 键）+ 本卡「表头不得自排」的纪律。
 */

/** 卡面冻结的列目录（8 枚；表头标签与列配置控件都从它来）。 */
const FROZEN_COLUMNS: WorkItemSurfaceColumnKey[] = [
  "identifier",
  "status",
  "priority",
  "assignee",
  "labels",
  "startDate",
  "dueDate",
  "creator",
];

// ---------- ① 列 → 排序键的映射（闭集内的**真子集**，不发明键） ----------

/* 表头只在「这一列有一个**冻结的**排序键」时才可排序：identifier / status / assignee / labels /
   creator 在冻结闭集里**没有**对应排序键，就地给它们造一个 = 零键增纪律的破口（键目录已冻结）；
   正确做法是登记后续，而不是顺手发明。 */
test("列 → 排序键：只有闭集里真有键的列可排序（title + priority / startDate / dueDate）", () => {
  assert.deepEqual(
    FROZEN_COLUMNS.filter((column) => workItemTableColumnSortKey(column) !== null),
    ["priority", "startDate", "dueDate"],
    "可排序列 = 冻结排序键闭集在列目录上的投影（不多不少）",
  );
  assert.equal(workItemTableColumnSortKey("priority"), "priority");
  assert.equal(workItemTableColumnSortKey("startDate"), "startDate");
  assert.equal(workItemTableColumnSortKey("dueDate"), "dueDate");
  for (const column of ["identifier", "status", "assignee", "labels", "creator"] as const) {
    assert.equal(
      workItemTableColumnSortKey(column),
      null,
      `${column} 没有冻结的排序键 ⇒ 表头只读（造一个新键 = 破零键增纪律）`,
    );
  }
  // 标题列不在列目录里（它是行的身份，不可隐藏），但它有冻结的排序键 title。
  assert.equal(WORK_ITEM_TABLE_TITLE_SORT_KEY, "title");
  assert.ok(
    WORK_ITEM_SORT_KEYS.includes(WORK_ITEM_TABLE_TITLE_SORT_KEY),
    "标题列的排序键必须来自冻结闭集",
  );
  for (const column of FROZEN_COLUMNS) {
    const key = workItemTableColumnSortKey(column);
    if (key !== null) {
      assert.ok(WORK_ITEM_SORT_KEYS.includes(key), `${column} 的排序键必须来自冻结闭集：${key}`);
    }
  }
  assert.deepEqual([...WORK_ITEM_SURFACE_COLUMNS], FROZEN_COLUMNS, "列目录本身不得被本视图改动");
});

// ---------- ② 表头点击 → R1 意图（唯一折叠实现；不在这里排序） ----------

/* 期望值不重算：点完之后的**状态**由 R1 的折叠函数给出（另一份实现），这里只断言意图本身。 */
test("表头点击 → 意图：异列换键并保留方向；同列切方向（来回是幂等往返）", () => {
  const base = { key: "manual" as const, direction: "asc" as const };
  assert.deepEqual(
    workItemTableSortIntent({ current: base, key: "dueDate" }),
    { kind: "setSortKey", key: "dueDate" },
    "点另一列 = 换排序键（方向由 R1 的折叠语义保留）",
  );
  assert.deepEqual(
    workItemTableSortIntent({ current: { key: "dueDate", direction: "desc" }, key: "priority" }),
    { kind: "setSortKey", key: "priority" },
    "在降序里换一列：意图仍只是「换键」—— 方向不在这里决定",
  );
  assert.deepEqual(
    workItemTableSortIntent({ current: { key: "priority", direction: "asc" }, key: "priority" }),
    { kind: "setSortDirection", direction: "desc" },
    "点当前排序列 = 切方向",
  );
  assert.deepEqual(
    workItemTableSortIntent({ current: { key: "priority", direction: "desc" }, key: "priority" }),
    { kind: "setSortDirection", direction: "asc" },
  );
});

test("表头点击 → 意图：经 R1 的折叠后状态逐格符合（换键保方向 / 换方向保键 / 往返回到原状）", () => {
  const start: WorkItemSurfaceState = {
    ...workItemSurfaceDefaultState(),
    sort: { key: "title", direction: "desc" },
  };
  const switched = applyWorkItemSurfaceIntent(
    start,
    workItemTableSortIntent({ current: start.sort, key: "dueDate" }),
  );
  assert.deepEqual(
    switched.sort,
    { key: "dueDate", direction: "desc" },
    "换列保留用户已选的方向（R1 折叠语义）",
  );
  const toggled = applyWorkItemSurfaceIntent(
    switched,
    workItemTableSortIntent({ current: switched.sort, key: "dueDate" }),
  );
  assert.deepEqual(
    toggled.sort,
    { key: "dueDate", direction: "asc" },
    "再点同一列 = 反向（顺序仍然只有一个所有者：R1 的排序投影）",
  );
});

// ---------- ③ aria-sort（规范 token；非当前列 = none） ----------

test("aria-sort：当前列按方向给 ascending / descending，其余可排序列给 none", () => {
  const asc = { key: "priority" as const, direction: "asc" as const };
  assert.equal(workItemTableSortAria({ sort: asc, key: "priority" }), "ascending");
  assert.equal(workItemTableSortAria({ sort: asc, key: "dueDate" }), "none");
  const desc = { key: "priority" as const, direction: "desc" as const };
  assert.equal(workItemTableSortAria({ sort: desc, key: "priority" }), "descending");
  assert.equal(
    workItemTableSortAria({ sort: desc, key: "title" }),
    "none",
    "手动顺序（manual）下任何列都不是当前排序列 ⇒ none",
  );
});

/* ---------------- 渲染夹具 / 解析（经**真宿主**：页面 → 宿主 → table 视图 → 共用行模块） ---------------- */

const SRC_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "../src");
const readSource = (relativePath: string) => readFileSync(resolve(SRC_DIR, relativePath), "utf8");
const stripComments = (source: string) =>
  source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

/** 造一条工作项（只给本组用例关心的字段）。 */
function wi(over: Partial<WorkItem>): WorkItem {
  return {
    id: "wi-1",
    workspaceIdentity: "ws",
    workspacePath: "/w/a",
    title: "标题",
    body: "",
    status: "todo",
    assignee: { type: "user", id: "user" },
    labels: [],
    properties: {},
    position: 0,
    ...over,
  };
}

/** 只给 `isSquadBatchRoot` 关心的那一个字段（渲染不读 run 的其它列）。 */
const run = (parentWorkItemId: string) => ({ parentWorkItemId }) as unknown as SquadRunRecord;

function snapshotWith(workItems: WorkItem[], runs: SquadRunRecord[]): SquadSnapshot {
  return {
    enabled: true,
    teamAgents: [
      {
        id: "ta-1",
        name: "队员",
        systemPrompt: "s",
        skills: [],
        memoryScope: "project",
        enabled: true,
        color: "blue",
      },
    ] as SquadSnapshot["teamAgents"],
    squads: [],
    workItems,
    runs,
    queuedRuns: [],
  };
}

/** 一棵两层批树：批根带满全部可配置字段（单元格断言要用），子项只有标题。 */
const TABLE: WorkItem[] = [
  wi({
    id: "wi-root",
    title: "批根标题",
    status: "in_progress",
    priority: "high",
    identifierSeq: 12,
    startDate: "2026-01-01",
    dueDate: "2026-12-31",
    creator: { kind: "human", id: "u-1", displayName: "本地用户" },
    labels: ["甲", "乙", "丙", "丁"],
    assignee: { type: "agent", id: "ta-1" },
  }),
  wi({ id: "wi-child", parentId: "wi-root", title: "子项标题" }),
];

/** 经**真宿主**渲染 table 视图（走的就是页面 → 宿主 → 视图 → 共用行模块那条链）。 */
function renderTable(
  input: {
    items?: WorkItem[];
    runs?: SquadRunRecord[];
    surface?: Partial<WorkItemSurfaceState>;
  } = {},
): { markup: string; intents: WorkItemSurfaceIntent[] } {
  const items = input.items ?? TABLE;
  const runs = input.runs ?? [run("wi-root")];
  const snapshot = snapshotWith(items, runs);
  const surface: WorkItemSurfaceState = {
    ...workItemSurfaceDefaultState(),
    view: "table",
    ...input.surface,
  };
  const intents: WorkItemSurfaceIntent[] = [];
  const markup = renderToStaticMarkup(
    createElement(ZCodeIntlProvider, {
      initialLocale: "zh-CN" as const,
      children: createElement(WorkItemsSurface, {
        workItems: items,
        snapshot,
        discardableIds: squadDiscardableWorkItemIds(snapshot),
        busyWorkItemId: null,
        timelineExpandedWorkItemId: null,
        laneDimension: "none",
        surface,
        onEdit: () => {},
        onInlineEdit: async () => null,
        onReassign: () => {},
        onDiscard: () => {},
        onToggleTimeline: () => {},
        onOpenWorkItemDetail: () => {},
        onSurfaceIntent: (intent) => {
          intents.push(intent);
        },
        workspacePath: "/w/a",
      }),
    }),
  );
  return { markup, intents };
}

/** 打开 testid 元素的整个开标签（用来断言「锚点挂在哪个元素上」）。 */
function openingTagOf(markup: string, testId: string): string {
  return new RegExp(`<[a-z]+[^>]*data-testid="${testId}"[^>]*>`).exec(markup)?.[0] ?? "";
}

/** 表头单元（`data-column` = 面的列身份：`title` / 目录列 / `actions`）。 */
function headerCells(markup: string): Array<{ column: string; open: string; text: string }> {
  return [...markup.matchAll(/<th ([^>]*data-column="([^"]+)"[^>]*)>([\s\S]*?)<\/th>/g)].map(
    (match) => ({ column: match[2]!, open: match[1]!, text: match[3]! }),
  );
}

// ---------- ④ 容器与表头（真渲染） ----------

test("table 视图容器：锚点与 data-view=table 挂在自己的容器上，且是真 <table> 壳（窄屏横向滚动）", () => {
  const { markup } = renderTable();
  const container = openingTagOf(markup, "work-items-table-view");
  assert.ok(container.length > 0, "table 视图有自己的容器锚点");
  assert.ok(container.includes('data-view="table"'), "容器带 data-view=table（面的标记）");
  assert.ok(
    !container.startsWith("<ul"),
    "锚点不再借共用行列表的 ul（面锚点不耦合共用模块的内部结构 —— 与 R2 的 list 同一条理由）",
  );
  assert.ok(markup.includes("<table"), "真表格：行/列关联交给原生 table 语义（不给 li 硬贴 role）");
  assert.ok(markup.includes("<thead"), "表头是真 thead");
  assert.ok(
    markup.includes("overflow-x-auto"),
    "窄屏横向滚动容器（列多时不压扁列；移动端形态归阶段三，登记人工演示）",
  );
});

test("表头：标题列在首、目录 8 列按目录顺序、动作列在尾；文案全部来自冻结键", () => {
  const { markup } = renderTable();
  assert.deepEqual(
    headerCells(markup).map((cell) => cell.column),
    ["title", ...WORK_ITEM_SURFACE_COLUMNS, "actions"],
    "列序 = 标题 + 目录顺序 + 动作（列目录是唯一真源，视图不重排）",
  );
  const labelOf = (column: string) =>
    headerCells(markup)
      .find((cell) => cell.column === column)!
      .text.replace(/<[^>]*>/g, "")
      .trim();
  // 期望值来自两语 locale 文件（独立真源），不是从实现里抄。
  assert.equal(labelOf("title"), "标题");
  assert.equal(labelOf("identifier"), "编号");
  assert.equal(labelOf("status"), "状态");
  assert.equal(labelOf("priority"), "优先级");
  assert.equal(labelOf("assignee"), "指派");
  assert.equal(labelOf("labels"), "标签");
  assert.equal(labelOf("startDate"), "起始");
  assert.equal(labelOf("dueDate"), "截止");
  assert.equal(labelOf("creator"), "创建人");
  assert.equal(labelOf("actions"), "", "动作列不造文案（零键增：没有「操作」这枚冻结键）");
});

test("表头排序：可排序列给原生 button + aria-sort；不可排序列只读且**不带** aria-sort", () => {
  const { markup } = renderTable({ surface: { sort: { key: "priority", direction: "asc" } } });
  const cells = headerCells(markup);
  const sortable = ["title", "priority", "startDate", "dueDate"];
  for (const cell of cells) {
    const isSortable = sortable.includes(cell.column);
    assert.equal(
      cell.open.includes('aria-sort="'),
      isSortable,
      `${cell.column}：aria-sort 只给可排序列（不可排序列整块省掉该属性）`,
    );
    assert.equal(
      cell.text.includes("<button"),
      isSortable,
      `${cell.column}：只有可排序列的表头是按钮（键盘可达 = 原生命中，不吃 Tab）`,
    );
  }
  const ariaOf = (column: string) =>
    /aria-sort="([^"]+)"/.exec(cells.find((cell) => cell.column === column)!.open)?.[1] ?? null;
  assert.equal(ariaOf("priority"), "ascending", "当前列按方向给规范 token");
  assert.equal(ariaOf("title"), "none", "其余可排序列给 none（可排但不是当前列）");
  assert.equal(ariaOf("dueDate"), "none");
  assert.equal(ariaOf("identifier"), null, "不可排序列没有 aria-sort（没有排序这回事）");
});

test("列配置：控件只回传意图（aria-pressed 反映显隐），隐藏列从表头消失且**不重排**其余列", () => {
  const config = renderTable().markup;
  const hiddenNow = renderTable({ surface: { columns: { hidden: ["labels", "creator"] } } }).markup;
  // 控件本身：一枚控件/列，按下态 = 该列可见（隐藏集是**会话内**状态，来自 R1 的意图折叠）。
  const group = /<div[^>]*role="group"[^>]*aria-label="显示列"[^>]*>/.exec(config)?.[0] ?? "";
  assert.ok(group.length > 0, "列配置控件带（标签用冻结键 squad.workItems.columns.label）");
  assert.equal(
    (config.match(/data-testid="work-items-column-toggle-/g) ?? []).length,
    WORK_ITEM_SURFACE_COLUMNS.length,
    "目录 8 列各一枚开关（控件集 = 目录，不多不少）",
  );
  for (const column of WORK_ITEM_SURFACE_COLUMNS) {
    const toggle =
      openingTagOf(config, `work-items-column-toggle-${column}`) +
      config.slice(config.indexOf(`data-testid="work-items-column-toggle-${column}"`));
    assert.ok(toggle.includes('aria-pressed="true"'), `${column} 默认可见 = 按下态 true`);
  }
  const hiddenToggle =
    openingTagOf(hiddenNow, "work-items-column-toggle-labels") +
    hiddenNow.slice(hiddenNow.indexOf('data-testid="work-items-column-toggle-labels"'));
  assert.ok(
    hiddenToggle.includes('aria-pressed="false"'),
    "被隐藏的列 = 未按下（状态来自页面持有的列配置）",
  );
  // 渲染结果：隐藏列整列消失，其余列**次序不变**（可见列 = 目录顺序减去隐藏集）。
  assert.deepEqual(
    headerCells(hiddenNow).map((cell) => cell.column),
    ["title", "identifier", "status", "priority", "assignee", "startDate", "dueDate", "actions"],
    "隐藏 labels/creator 后：这两列消失，其余列仍在目录顺序上",
  );
  assert.ok(hiddenNow.includes("批根标题"), "行仍在（列配置只改列，不改行）");
});

test("守卫｜列配置判据在纯函数：table 视图链不得出现 .filter( / .sort( / 第二份排序实现", () => {
  const view = stripComments(readSource("squad/WorkItemTableView.tsx"));
  assert.ok(
    view.includes("visibleWorkItemColumns("),
    "可见列必须走 R1 的纯函数（组件里自己 filter 隐藏集 = 第二个判据点）",
  );
  for (const forbidden of [".filter(", ".sort(", "localeCompare(", "sort((left", "sort((a"]) {
    assert.ok(!view.includes(forbidden), `table 视图不得出现 ${forbidden}（排序只有 R1 一份实现）`);
  }
  assert.ok(
    !view.includes("toggleColumn") || view.includes('kind: "toggleColumn"'),
    "列显隐只能回传 R1 的 toggleColumn 意图（组件不自己 setState）",
  );
  assert.ok(
    !view.includes("useState"),
    "列配置是页面持有的会话内状态：视图自带 useState = 第二状态源（R6 的命名视图还原会漏掉它）",
  );
});

// ---------- ⑤ 行与单元格（真渲染；行元素仍由共用行模块渲染） ----------

/** 每行的 `(id, depth, 单元格列序)`：从渲染结果里读，不从实现里抄。 */
function rowFacts(markup: string): Array<{ id: string; depth: number; cells: string[] }> {
  return [
    ...markup.matchAll(/<tr data-work-item-id="([^"]+)" data-depth="(\d+)"[^>]*>([\s\S]*?)<\/tr>/g),
  ].map((match) => ({
    id: match[1]!,
    depth: Number(match[2]),
    cells: [...match[3]!.matchAll(/<td[^>]*data-column="([^"]+)"/g)].map((cell) => cell[1]!),
  }));
}

test("行结构：每行仍是共用行模块的一个行元素（锚点/深度），列序与表头逐项对齐", () => {
  const { markup } = renderTable();
  const rows = rowFacts(markup);
  assert.deepEqual(
    rows.map((row) => [row.id, row.depth]),
    [
      ["wi-root", 0],
      ["wi-child", 1],
    ],
    "行序与深度仍来自 flattenWorkItemBoard（DFS）：真表格不改行序投影",
  );
  for (const row of rows) {
    assert.deepEqual(
      row.cells,
      ["title", ...WORK_ITEM_SURFACE_COLUMNS, "actions"],
      "每行的 `<td data-column>` = 表头 `<th data-column>` 逐项对齐（行/列关联）",
    );
  }
  assert.deepEqual(
    headerCells(markup).map((cell) => cell.column),
    rows[0]!.cells,
    "表头与行的列身份**逐项相同**（少了/多了列在这里现形）",
  );
  assert.equal(
    (markup.match(/data-work-item-id=/g) ?? []).length,
    2,
    "每条可见项恰一个行锚点（复制锚点 = 全树守卫红）",
  );
});

test("缩进与行级入口：标题格承载缩进与「打开详情」覆盖层；动作列给编辑/改派（批根另给时间线/放弃）", () => {
  const { markup } = renderTable();
  const titleCells = [
    ...markup.matchAll(/<td[^>]*data-column="title"[^>]*style="padding-left:(\d+)px"/g),
  ].map((match) => Number(match[1]));
  assert.deepEqual(titleCells, [8, 20], "缩进沿用 depth*12+8 的既有手法（表格里落在标题格上）");
  assert.ok(
    markup.includes('data-testid="work-item-row-open-detail"'),
    "行级「打开详情」仍是透明覆盖层（整行 button 与行内按钮嵌套非法）",
  );
  for (const testId of [
    "work-item-edit",
    "work-item-reassign",
    "work-item-timeline-toggle",
    "work-item-discard",
  ]) {
    assert.ok(markup.includes(`data-testid="${testId}"`), `动作列缺 ${testId}`);
  }
});

test("单元格只读：表格里没有行内编辑器（标题输入/优先级 picker 都不出现，写路径仍只有对话框）", () => {
  const { markup } = renderTable();
  for (const testId of [
    "work-item-title-edit",
    "work-item-title-input",
    "work-item-priority-picker",
    "work-item-priority-unset",
  ]) {
    assert.ok(
      !markup.includes(`data-testid="${testId}"`),
      `table 的单元格是只读呈现（${testId} 属于行内编辑，本阶段登记后续）`,
    );
  }
  assert.ok(markup.includes('data-testid="work-item-edit"'), "编辑仍可达：走对话框那条既有写路径");
});

test("单元格单源：identifier / 状态 / 优先级 / 指派 / 标签 / 起止 / 创建人逐格来自既有单源", () => {
  const { markup } = renderTable();
  const rowOf = (id: string) =>
    new RegExp(`<tr data-work-item-id="${id}"[\\s\\S]*?</tr>`).exec(markup)?.[0] ?? "";
  const cellText = (rowMarkup: string, column: string) => {
    const match = new RegExp(`<td[^>]*data-column="${column}"[^>]*>([\\s\\S]*?)</td>`).exec(
      rowMarkup,
    );
    return (match?.[1] ?? "").replace(/<[^>]*>/g, "").trim();
  };
  const root = rowOf("wi-root");
  assert.equal(
    cellText(root, "identifier"),
    "#12",
    "identifier 走 workItemIdentifierText（前缀不入库）",
  );
  assert.equal(cellText(root, "status"), "进行中", "状态走 6 键文案的穷尽映射");
  assert.equal(cellText(root, "priority"), "高", "优先级走徽标组件（闭集四档文案）");
  assert.equal(cellText(root, "assignee"), "队员", "指派走名册解析（同一份 resolveAssigneeName）");
  assert.ok(
    cellText(root, "labels").includes("甲") && cellText(root, "labels").includes("+1"),
    "标签走同一份截断投影（3 + N）",
  );
  assert.equal(cellText(root, "startDate"), "2026-01-01", "日历日期**逐字**呈现（边界日）");
  assert.equal(cellText(root, "dueDate"), "2026-12-31", "边界日：任何时刻换算都会在这里差一天");
  assert.equal(
    cellText(root, "creator"),
    "本地用户",
    "创建人走 workItemCreatorText（有留痕用留痕）",
  );
  // 未设置不给占位说法（空单元格 = 没有事实，不是「未知」）。
  const child = rowOf("wi-child");
  assert.equal(cellText(child, "identifier"), "", "子项没有序号 ⇒ 空单元格（不编一个空编号）");
  assert.equal(cellText(child, "priority"), "", "未设置优先级 ⇒ 空单元格（不写「未设置」）");
  assert.equal(cellText(child, "startDate"), "", "未设置起始日期 ⇒ 空单元格");
  assert.equal(
    cellText(child, "creator"),
    "",
    "存量行没有创建人事实 ⇒ 空单元格（不编「未知/系统」）",
  );
});

test("时间线：展开态是**独立一行**（colspan = 标题 + 可见列 + 动作），且不复制行锚点", () => {
  const { markup } = renderTable();
  /* 展开态会真的挂载时间线分区（它 `useServices()`）：静态渲染不进 effect，故只给一个空访问器
     —— 这条用例判的是**表格结构**（展开行怎么摆），时间线自身的内容有它自己的用例。 */
  const expanded = renderToStaticMarkup(
    createElement(ZCodeIntlProvider, {
      initialLocale: "zh-CN" as const,
      children: createElement(ServiceProvider, {
        services: {} as IServiceAccessor,
        children: createElement(WorkItemsSurface, {
          workItems: TABLE,
          snapshot: snapshotWith(TABLE, [run("wi-root")]),
          discardableIds: squadDiscardableWorkItemIds(snapshotWith(TABLE, [run("wi-root")])),
          busyWorkItemId: null,
          timelineExpandedWorkItemId: "wi-root",
          laneDimension: "none",
          surface: { ...workItemSurfaceDefaultState(), view: "table" },
          onEdit: () => {},
          onInlineEdit: async () => null,
          onReassign: () => {},
          onDiscard: () => {},
          onToggleTimeline: () => {},
          onOpenWorkItemDetail: () => {},
          onSurfaceIntent: () => {},
          workspacePath: "/w/a",
        }),
      }),
    }),
  );
  assert.ok(!markup.includes('data-testid="work-items-timeline-row"'), "未展开时没有时间线行");
  assert.ok(
    expanded.includes('data-testid="work-items-timeline-row"'),
    "展开态渲染为独立一行（`<td>` 里塞时间线会破坏表格结构）",
  );
  const timelineRow =
    /<tr[^>]*data-testid="work-items-timeline-row"[\s\S]*?<\/tr>/.exec(expanded)?.[0] ?? "";
  assert.match(
    timelineRow,
    /colspan="10"/i,
    "跨全部列：标题 1 + 可见列 8 + 动作 1（大小写不敏感：HTML 属性名不区分大小写）",
  );
  assert.ok(
    !timelineRow.includes("data-work-item-id"),
    "时间线行不得再挂一个行锚点（锚点只属于那一行）",
  );
  assert.equal(
    (expanded.match(/data-work-item-id=/g) ?? []).length,
    TABLE.length,
    "行锚点数不因展开而变（聚焦注册表键集 = 可见集）",
  );
});

test("守卫｜单元格零第二份实现：锚点仍只在共用行模块，新模块复用行词汇且不写本地格式化", () => {
  const rows = stripComments(readSource("squad/WorkItemRows.tsx"));
  const cells = stripComments(readSource("squad/WorkItemTableCell.tsx"));
  const view = stripComments(readSource("squad/WorkItemTableView.tsx"));
  assert.equal(
    (rows.match(/data-work-item-id=\{item\.id\}/g) ?? []).length,
    1,
    "行锚点仍恰一处（表格的行元素由共用模块渲染，视图/单元格模块都不得自带）",
  );
  for (const source of [cells, view]) {
    assert.ok(!source.includes("data-work-item-id"), "单元格/视图不得写行锚点");
    for (const forbidden of ["new Date(", "Date.parse(", "toISOString(", "toLocaleDateString("]) {
      assert.ok(!source.includes(forbidden), `不得出现 ${forbidden}（日期零换算）`);
    }
  }
  for (const single of [
    "workItemIdentifierText(",
    "workItemStatusMessageId(",
    "workItemDateText(",
    "workItemCreatorText(",
    "workItemLabelChips(",
    "resolveAssigneeName(",
  ]) {
    assert.ok(cells.includes(single), `单元格必须走单源 ${single}`);
  }
  assert.ok(
    cells.includes("WorkItemLabelChip") && cells.includes("WorkItemPriorityBadge"),
    "标签 chip 与优先级徽标复用行词汇的组件（不抄第二份外观）",
  );
  assert.ok(
    !cells.includes("WORK_ITEM_LABEL_CHIP_CLASSNAME") &&
      !cells.includes("WORK_ITEM_PRIORITY_BADGE_CLASSNAME") &&
      !/border-border px-1\.5 py-0\.5/.test(cells),
    "单元格不得自带第二份 chip/徽标样式常量",
  );
  assert.ok(
    rows.includes("table.cells(row, actions)") && rows.includes("HTMLElement"),
    "行模块的表格布局是**加法**：容器元素参数化（ref 类型放宽到 HTMLElement）+ 单元格由视图给、动作簇由行模块传进去",
  );
  /* 动作簇**只有一份**（在行模块里），表格的动作格只接收它：单元格模块自带一枚动作按钮
     = 第二份动作簇（同一语义两处实现，改一处漏一处）。变异（M-动作复制）必红。 */
  for (const actionTestId of [
    "work-item-edit",
    "work-item-reassign",
    "work-item-discard",
    "work-item-timeline-toggle",
  ]) {
    assert.ok(
      !cells.includes(actionTestId),
      `单元格模块不得自带 ${actionTestId}（动作簇由行模块传进来）`,
    );
  }
});
