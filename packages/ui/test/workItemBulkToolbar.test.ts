import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { WorkItem } from "@zcode/shared";
import type { SquadSnapshot, SquadRunRecord } from "@zcode/services";
import { ZCodeIntlProvider } from "../src/i18n/IntlProvider.js";
import zhCN from "../src/i18n/locales/zh-CN.js";
import { squadDiscardableWorkItemIds } from "../src/squad/squadEntryViewModel.js";
import { WorkItemsPageActions } from "../src/squad/WorkItemsPageActions.js";
import { WorkItemsSurface } from "../src/squad/WorkItemsSurface.js";
import type { WorkItemBulkToolbarProps } from "../src/squad/WorkItemBulkToolbar.js";
import { WORK_ITEM_PRIORITY_CLEAR_VALUE } from "../src/squad/workItemInlineEditViewModel.js";
import {
  workItemSurfaceDefaultState,
  type WorkItemSurfaceState,
  type WorkItemViewMode,
} from "../src/squad/workItemSurfaceViewModel.js";

/* 「多选行 ⇒ 批量动作工具栏」（阶段二 · T-P2-R5）的**行选择控件**呈现与结构守卫。

   三条（都按本域既有做法：真渲染 + 全 src 树源码守卫）：
   ① **行勾选件由行模块单点产出**（照 R3 接缝：像 `actions` 一样由行模块产出，经 `table:{cells}`
      交给视图放进表格首列）—— 视图/单元格模块**不得**自带第二份（复制一份 = 两处的可用判据迟早分叉）；
   ② **默认（未进入批量模式）DOM 零变化**：`selection` 缺席时行结构与今天**逐槽相同** ——
      React 把「这一层的孩子数」编进 `useId`，多一个槽位（哪怕渲染成 null）就会让 Radix 的
      `aria-controls` 漂移、R1 的逐字节基线红（实测见本轮报告「结构纪律」一节）；
   ③ 表格布局下勾选件落在**首列**：`<th data-column="select">` ↔ `<td data-column="select">` 对齐。

   期望值的独立真源：R3 报告 §8 的接缝（行模块产出、经 `table:{cells}` 交视图）+
   本卡验收（多选行 ⇒ 工具栏）+ 两语 locale 正文（`bulk.selectRow` 的 `{title}` 占位符）。 */

const SRC_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "../src");
const readSource = (relativePath: string) => readFileSync(resolve(SRC_DIR, relativePath), "utf8");
const stripComments = (source: string) =>
  source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

/** 全 `src` 树的源码文件（守卫要的是「全树恰一处」，不是「某个文件里恰一处」）。 */
function listSourceFiles(): string[] {
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.(ts|tsx)$/.test(entry.name)) files.push(full);
    }
  };
  walk(SRC_DIR);
  return files.sort();
}
let sourceSnapshot: Array<{ file: string; source: string }> | null = null;
const relativeSourceFiles = () =>
  (sourceSnapshot ??= listSourceFiles().map((file) => ({
    file: file.slice(SRC_DIR.length + 1),
    source: stripComments(readFileSync(file, "utf8")),
  })));
const filesUsing = (needle: string) =>
  relativeSourceFiles()
    .filter((entry) => entry.source.includes(needle))
    .map((entry) => entry.file);
const countIn = (file: string, needle: string) =>
  stripComments(readSource(file)).split(needle).length - 1;

/** 造一条工作项（只给本组用例关心的字段）。 */
function wi(id: string, over: Partial<WorkItem> = {}): WorkItem {
  return {
    id,
    workspaceIdentity: "ws",
    workspacePath: "/w/a",
    title: `标题 ${id}`,
    body: "",
    status: "todo",
    assignee: { type: "user", id: "user" },
    labels: [],
    properties: {},
    position: 0,
    ...over,
  };
}

/** 只给 `isSquadBatchRoot` 关心的那一个字段。 */
const run = (parentWorkItemId: string) => ({ parentWorkItemId }) as unknown as SquadRunRecord;

const ITEMS: WorkItem[] = [
  wi("wi-root", { title: "批根标题" }),
  wi("wi-child", { parentId: "wi-root", title: "子项标题" }),
  wi("wi-other", { title: "另一棵树" }),
];

function snapshotWith(workItems: WorkItem[], runs: SquadRunRecord[] = []): SquadSnapshot {
  return {
    enabled: true,
    teamAgents: [],
    squads: [],
    workItems,
    runs,
    queuedRuns: [],
  } as unknown as SquadSnapshot;
}

/** 经**真宿主**渲染：页面 → 宿主 → 视图 → 共用行模块。 */
function renderView(
  view: WorkItemViewMode,
  selection?: {
    selectedIds: ReadonlySet<string>;
    disabled: boolean;
    onToggle: (workItemId: string) => void;
  },
): string {
  const surface: WorkItemSurfaceState = { ...workItemSurfaceDefaultState(), view };
  const snapshot = snapshotWith(ITEMS, [run("wi-root")]);
  return renderToStaticMarkup(
    createElement(ZCodeIntlProvider, {
      initialLocale: "zh-CN" as const,
      children: createElement(WorkItemsSurface, {
        workItems: ITEMS,
        snapshot,
        discardableIds: squadDiscardableWorkItemIds(snapshot),
        busyWorkItemId: null,
        timelineExpandedWorkItemId: null,
        laneDimension: "none",
        surface,
        onSurfaceIntent: () => {},
        selection,
        onEdit: () => {},
        onInlineEdit: async () => null,
        onReassign: () => {},
        onDiscard: () => {},
        onToggleTimeline: () => {},
        onOpenWorkItemDetail: () => {},
        workspacePath: "/w/a",
      }),
    }),
  );
}

const t = (id: string, values?: Record<string, string | number>): string => {
  const text = zhCN[id] ?? `MISSING:${id}`;
  return values === undefined
    ? text
    : text.replace(/\{(\w+)\}/g, (_, key: string) => String(values[key]));
};

/** 勾选件本身的标签（不限定标签名：`Checkbox` 原语渲染成 `role="checkbox"` 的按钮，
    断言只认**锚点 + ARIA 语义**，不认原语的实现标签）。 */
const selectTags = (markup: string) =>
  [...markup.matchAll(/<[a-z]+[^>]*data-testid="work-item-select"[^>]*>/g)].map(
    (match) => match[0],
  );

// ---------- ① 行勾选件：列表视图行首（渲染证据） ----------

test("行勾选件（list）：每行行首一枚，可及名称带标题、勾选态来自选择集", () => {
  const markup = renderView("list", {
    selectedIds: new Set(["wi-child"]),
    disabled: false,
    onToggle: () => {},
  });
  const tags = selectTags(markup);
  assert.equal(tags.length, ITEMS.length, "每条可见行一枚勾选件（行数 = 控件数）");
  assert.equal(
    (markup.match(/data-work-item-id=/g) ?? []).length,
    ITEMS.length,
    "行锚点数不变（勾选件不复制行）",
  );
  for (const item of ITEMS) {
    assert.ok(
      tags.some((tag) =>
        tag.includes(`aria-label="${t("squad.workItems.bulk.selectRow", { title: item.title })}"`),
      ),
      `${item.id} 的勾选件可及名称 = 「选择「标题」」（读屏听到的是哪一行，而不是一排同名复选框）`,
    );
  }
  const checked = tags.filter((tag) => tag.includes('aria-checked="true"'));
  assert.equal(
    checked.length,
    1,
    "只有被选中的那一行是勾选态（ARIA 语义断言，不认原语的样式 token）",
  );
  assert.ok(checked[0]!.includes('aria-label="选择「子项标题」"'), "勾选态落在选择集里的那一条上");
  for (const tag of tags) {
    assert.ok(tag.includes('role="checkbox"'), "勾选件必须带 role=checkbox（读屏知道这是什么）");
  }
  assert.ok(
    markup.indexOf('data-testid="work-item-select"') < markup.indexOf("批根标题"),
    "勾选件在行首（标题之前）：批量选择是行的第一个可操作点",
  );
});

test("行勾选件：批量写在飞 ⇒ 一律置灰（去重：写一半又改选择集没有意义）", () => {
  const markup = renderView("list", {
    selectedIds: new Set(["wi-root"]),
    disabled: true,
    onToggle: () => {},
  });
  for (const tag of selectTags(markup)) {
    assert.ok(
      /\sdisabled(?:=""|="true"|[\s/>])/.test(tag),
      "在飞期间勾选件置灰（避免写一半改选择集）",
    );
  }
});

test("未进入批量模式（selection 缺席）：行结构零变化 —— 三个视图都不出现勾选件与选择列", () => {
  for (const view of ["board", "list", "table"] as const) {
    const markup = renderView(view);
    assert.ok(
      !markup.includes('data-testid="work-item-select"'),
      `${view} 默认不进入批量模式 ⇒ 不得出现勾选件（默认可选 = 默认界面的行为变化）`,
    );
    assert.ok(!markup.includes('data-column="select"'), `${view} 默认不得出现选择列/格`);
  }
});

// ---------- ② 看板视图：进入批量模式后同样可多选（同一份行模块，不另做一套） ----------

test("行勾选件（board）：进入批量模式后同样按行给出（与 list 同一份行模块）", () => {
  const markup = renderView("board", {
    selectedIds: new Set(),
    disabled: false,
    onToggle: () => {},
  });
  assert.equal(
    selectTags(markup).length,
    ITEMS.length,
    "看板行也拿到勾选件（批量不是某个视图的特权）",
  );
});

// ---------- ③ 表格布局：勾选件落在**首列**（表头与行逐项对齐） ----------

test("表格首列：<th data-column=select> ↔ 每行首个 <td data-column=select>，列身份逐项对齐", () => {
  const markup = renderView("table", {
    selectedIds: new Set(["wi-root"]),
    disabled: false,
    onToggle: () => {},
  });
  const headers = [...markup.matchAll(/<th [^>]*data-column="([^"]+)"/g)].map((match) => match[1]!);
  assert.deepEqual(
    headers.slice(0, 2),
    ["select", "title"],
    "选择列在**首列**（标题列紧随其后）—— 表格的列身份仍由 `data-column` 单一表达",
  );
  const rows = [...markup.matchAll(/<tr data-work-item-id="([^"]+)"[^>]*>([\s\S]*?)<\/tr>/g)].map(
    (match) => ({
      id: match[1]!,
      cells: [...match[2]!.matchAll(/<td[^>]*data-column="([^"]+)"/g)].map((cell) => cell[1]!),
      selectCount: (match[2]!.match(/data-testid="work-item-select"/g) ?? []).length,
    }),
  );
  assert.equal(rows.length, ITEMS.length, "每条可见行一个 <tr>");
  for (const row of rows) {
    assert.deepEqual(row.cells, headers, `行 ${row.id} 的 <td data-column> 与表头逐项对齐`);
    assert.equal(row.selectCount, 1, `行 ${row.id} 的勾选件恰一枚（且在自己的行里，不串行）`);
  }
  assert.equal(
    (markup.match(/<td[^>]*data-column="select"/g) ?? []).length,
    ITEMS.length,
    "选择格数 = 行数（勾选件只在选择格里）",
  );
});

test("表格首列：勾选件缺席时整列消失（不得留一个空列 —— 空 `<td>` 会占位）", () => {
  const markup = renderView("table");
  assert.ok(!markup.includes('data-column="select"'), "默认表格没有选择列");
  assert.ok(
    (markup.match(/<td[^>]*data-column="title"/g) ?? []).length === ITEMS.length,
    "标题格仍是每行的第一个数据格",
  );
});

// ---------- ④ 结构守卫：行勾选件单点 + 行单点仍成立 ----------

test("守卫｜行勾选件单点（全 src 树）：勾选件与勾选回调只在行模块的零件里产出", () => {
  assert.deepEqual(
    filesUsing('data-testid="work-item-select"'),
    ["squad/workItemRowParts.tsx"],
    "行选择控件只能出现在**行模块的零件**里（`WorkItemRows` 是它唯一的消费方；第二处 = 有人复制了" +
      "行级控件：可用判据/锚点从此两处，而分叉不报错）",
  );
  assert.equal(
    countIn("squad/workItemRowParts.tsx", 'data-testid="work-item-select"'),
    1,
    "勾选件锚点在行零件里恰一处",
  );
  /* 消费方只有行模块一处：视图/单元格模块**不得**自带（R3 的 M6 守门变异就是这条）。
     针带尾空格：`<WorkItemRowSelect` 会误命中 `<WorkItemRowSelection …>` 这种类型字面量。 */
  assert.deepEqual(
    filesUsing("<WorkItemRowSelect "),
    ["squad/WorkItemRows.tsx"],
    "勾选件只有行渲染模块在挂载（视图/单元格模块不得自带第二份行级控件）",
  );
  for (const file of [
    "squad/WorkItemListView.tsx",
    "squad/WorkItemTableView.tsx",
    "squad/WorkItemTableCell.tsx",
    "squad/WorkItemsBoard.tsx",
    "squad/WorkItemsSurface.tsx",
  ]) {
    const source = stripComments(readSource(file));
    assert.ok(
      !source.includes('data-testid="work-item-select"') &&
        !source.includes('type="checkbox"') &&
        !source.includes("Checkbox"),
      `${file} 不得自带第二份行选择控件（行级控件由行模块单点产出）`,
    );
  }
  assert.deepEqual(
    filesUsing("data-work-item-id"),
    ["squad/WorkItemRows.tsx"],
    "行锚点仍只在共用行模块（本轮的加法没有复制行渲染）",
  );
  assert.equal(
    countIn("squad/WorkItemRows.tsx", "rowFocus.registerRow("),
    1,
    "聚焦注册接线仍恰一处（行级控件的加法不得顺手复制注册）",
  );
});

/* 行选择控件的可用判据**复用**行内编辑那一份（`workItemInlineEditUnavailableReason` /
   `workItemBulkSelectable`）：行链上不得出现第二份归档判据。 */
test("守卫｜行勾选件复用可写判据：行链与批量 viewmodel 都不写第二份归档判据", () => {
  const parts = stripComments(readSource("squad/workItemRowParts.tsx"));
  assert.ok(
    parts.includes("workItemBulkSelectable("),
    "行勾选件的可用判据来自批量 viewmodel（单一判据：与行内编辑入口同一份结论）",
  );
  for (const file of [
    "squad/WorkItemRows.tsx",
    "squad/workItemRowParts.tsx",
    "squad/WorkItemTableView.tsx",
  ]) {
    const source = stripComments(readSource(file));
    assert.ok(
      !source.includes("archivedAt"),
      `${file} 不得自己判归档（判据单源在 workItemInlineEditUnavailableReason）`,
    );
  }
});

/* ---------------- 工具栏（控件带里的批量条）：真渲染 ---------------- */

/** 真渲染控件带（页面里就是这一块）：`bulk` 由用例给 —— 批量工具栏是**受控**的（草稿与结果都在页面）。 */
function renderActions(
  over: {
    bulk?: Partial<WorkItemBulkToolbarProps>;
    targetAvailable?: boolean;
    loading?: boolean;
    createDisabled?: boolean;
  } = {},
): string {
  const { bulk = {}, targetAvailable = true, loading = false, createDisabled = false } = over;
  return renderToStaticMarkup(
    createElement(ZCodeIntlProvider, {
      initialLocale: "zh-CN" as const,
      children: createElement(WorkItemsPageActions, {
        targetAvailable,
        loading,
        createDisabled,
        laneDimension: "none",
        onLaneDimensionChange: () => {},
        surface: workItemSurfaceDefaultState(),
        onSurfaceIntent: () => {},
        t: (id: string) => zhCN[id] ?? `MISSING:${id}`,
        onReload: () => {},
        onCreate: () => {},
        bulk: {
          active: false,
          selectedCount: 0,
          draft: { field: "priority", value: WORK_ITEM_PRIORITY_CLEAR_VALUE },
          applying: false,
          result: null,
          onToggleActive: () => {},
          onClear: () => {},
          onDraftIntent: () => {},
          onApply: () => {},
          ...bulk,
        },
      }),
    }),
  );
}

/** 取出带某个 testid 的那个标签本身（SSR markup 是扁平字符串；锚点到下一个 `>` 即元素末尾）。 */
function tagWithTestId(markup: string, testId: string): string {
  const index = markup.indexOf(`data-testid="${testId}"`);
  assert.ok(index >= 0, `markup 里找不到 ${testId}`);
  return markup.slice(markup.lastIndexOf("<", index), markup.indexOf(">", index));
}

/* ⚠️ `disabled` 属性必须按**属性**判：Tailwind 的 class 里有 `disabled:cursor-not-allowed` 变体
   （裸 includes 会把"置灰"用例变成恒真）。 */
const hasDisabledAttr = (tag: string): boolean => /[\s"']disabled(?:=""|="true"|[\s/>])/.test(tag);

test("批量工具栏｜入口**常驻**：未开启时只有入口按钮（其余控件不该占位）", () => {
  const idle = renderActions();
  const toggle = tagWithTestId(idle, "work-items-bulk-toggle");
  assert.ok(
    idle.includes(`>${t("squad.workItems.bulk.label")}</button>`),
    "入口文案 = 冻结键正文（裸 key 是这一面最典型的静默坏法）",
  );
  assert.ok(toggle.includes('aria-pressed="false"'), "未开启 = 未按下（开关语义）");
  for (const testId of [
    "work-items-bulk-count",
    "work-items-bulk-clear",
    "work-items-bulk-field",
    "work-items-bulk-priority",
    "work-items-bulk-value",
    "work-items-bulk-apply",
    "work-items-bulk-result",
  ]) {
    assert.ok(
      !idle.includes(`data-testid="${testId}"`),
      `未开启批量模式时不得出现 ${testId}（一堆用不上的控件会把动作行挤满）`,
    );
  }
});

test("批量工具栏｜开启：计数、清除、字段与取值控件、应用钮都在（可点性随选中数）", () => {
  const active = renderActions({
    bulk: { active: true, selectedCount: 2 },
  });
  assert.ok(active.includes('aria-pressed="true"'), "开启 = 按下态（同一个按钮切换，键盘可达）");
  assert.ok(
    active.includes(t("squad.workItems.bulk.selected", { count: 2 })),
    "计数文案带 {count}（正文来自冻结键）",
  );
  assert.ok(active.includes('role="group"'), "批量条是一组控件（读屏听到归属）");
  for (const testId of [
    "work-items-bulk-count",
    "work-items-bulk-clear",
    "work-items-bulk-field",
    "work-items-bulk-priority",
    "work-items-bulk-apply",
  ]) {
    assert.ok(active.includes(`data-testid="${testId}"`), `开启后缺 ${testId}`);
  }
  assert.ok(
    !hasDisabledAttr(tagWithTestId(active, "work-items-bulk-clear")),
    "有选中项 ⇒ 「清除选择」可点",
  );
  assert.ok(
    !hasDisabledAttr(tagWithTestId(active, "work-items-bulk-apply")),
    "有选中项且取值可用 ⇒ 「应用到已选」可点",
  );

  const none = renderActions({ bulk: { active: true, selectedCount: 0 } });
  assert.ok(
    hasDisabledAttr(tagWithTestId(none, "work-items-bulk-clear")),
    "没有选中项 ⇒ 「清除选择」置灰（点了也没东西可清）",
  );
  assert.ok(
    hasDisabledAttr(tagWithTestId(none, "work-items-bulk-apply")),
    "没有选中项 ⇒ 「应用到已选」置灰（不是「点了没反应」）",
  );

  const flying = renderActions({ bulk: { active: true, selectedCount: 2, applying: true } });
  assert.ok(
    hasDisabledAttr(tagWithTestId(flying, "work-items-bulk-apply")),
    "写请求在飞 ⇒ 应用钮置灰（去重：写一半又发起一次没有意义）",
  );
});

test("批量工具栏｜取值控件随字段切换：优先级是下拉（哨兵 + 四档），标签/日期是文本输入", () => {
  const priority = renderActions({ bulk: { active: true, selectedCount: 1 } });
  const fieldTag = tagWithTestId(priority, "work-items-bulk-field");
  /* 字段下拉的可及名称是「族 + 当前值」（R4 的既有手法：「批量字段」这一枚键不存在（零键增））。
     `SelectValue` 的可见正文不在 SSR 里渲染（Radix 的既有行为），故以**名称**为准：
     它随当前字段走，等于把「下拉现在说的是哪个字段」钉住了。 */
  assert.ok(
    fieldTag.includes(
      `aria-label="${t("squad.workItems.bulk.label")} ${t("squad.workItems.priority")}"`,
    ),
    "字段下拉的可及名称 = 「批量操作 优先级」（族 + 当前值：与取值控件不同名）",
  );
  const priorityTag = tagWithTestId(priority, "work-items-bulk-priority");
  assert.ok(
    priorityTag.includes(`aria-label="${t("squad.workItems.priority")}"`),
    "取值控件的可及名称 = 字段名（两个下拉因此不同名）",
  );
  assert.ok(
    !/\sdata-placeholder=/.test(priorityTag),
    '默认取值是**哨兵**（非空串）：Radix 只在 value === "" 时打 data-placeholder —— ' +
      "空串是它保留给 placeholder 的，选中态会飘（行 D 的缺陷形态）",
  );
  assert.ok(
    !priority.includes('data-testid="work-items-bulk-value"'),
    "同屏不得同时挂两种取值控件",
  );

  const labels = renderActions({
    bulk: { active: true, selectedCount: 1, draft: { field: "labels", value: "" } },
  });
  const valueTag = tagWithTestId(labels, "work-items-bulk-value");
  assert.ok(
    valueTag.includes(`aria-label="${t("squad.workItems.labels")}"`),
    "标签字段 ⇒ 文本输入（名 = 字段名）",
  );
  assert.ok(
    tagWithTestId(labels, "work-items-bulk-field").includes(
      `aria-label="${t("squad.workItems.bulk.label")} ${t("squad.workItems.labels")}"`,
    ),
    "换到标签 ⇒ 字段下拉的名称跟着换成「批量操作 标签」（文案映射走闭集单源）",
  );
  assert.ok(!labels.includes('data-testid="work-items-bulk-priority"'), "两种取值控件不同屏");
  assert.ok(
    hasDisabledAttr(tagWithTestId(labels, "work-items-bulk-apply")),
    "标签输入为空 ⇒ 「应用到已选」置灰（没有可应用的内容；这不是错误，故不该报错）",
  );
  assert.ok(
    !labels.includes('data-testid="work-items-bulk-invalid"'),
    "空标签**不是**非法输入（empty ≠ invalid）",
  );

  const dates = renderActions({
    bulk: { active: true, selectedCount: 1, draft: { field: "dueDate", value: "" } },
  });
  assert.ok(
    tagWithTestId(dates, "work-items-bulk-value").includes(
      `placeholder="${t("squad.workItems.datePlaceholder")}"`,
    ),
    "日期取值给形状提示（`YYYY-MM-DD` 文本，不用平台日期控件）",
  );
});

test("批量工具栏｜非法取值：就地说明「哪一项的哪个值不对」，并拦下应用", () => {
  const markup = renderActions({
    bulk: {
      active: true,
      selectedCount: 1,
      draft: { field: "startDate", value: "2026-02-30" },
    },
  });
  assert.ok(
    markup.includes(t("squad.workItems.startDateInvalid", { value: "2026-02-30" })),
    "就地文案指名是哪一项的哪个值（文案键复用表单那一枚，不共用一个「输入非法」）",
  );
  assert.ok(
    hasDisabledAttr(tagWithTestId(markup, "work-items-bulk-apply")),
    "非法取值 ⇒ 应用钮置灰（不把一个必然失败的请求发出去）",
  );
});

test("批量工具栏｜结果**逐条**可见：总数之外每一条失败各自带标题与原因（部分失败不被掩盖）", () => {
  const markup = renderActions({
    bulk: {
      active: true,
      selectedCount: 2,
      applying: false,
      result: {
        okCount: 2,
        failures: [
          {
            workItemId: "wi-c",
            title: "坏掉的那条",
            messageId: "squad.common.operationFailed",
            detail: "写 wi-c 失败",
          },
          {
            workItemId: "wi-d",
            title: "标签满了的那条",
            messageId: "squad.workItems.labelsTooMany",
            values: { max: 10, count: 11 },
          },
        ],
      },
    },
  });
  assert.ok(
    markup.includes(t("squad.workItems.bulk.result", { ok: 2, failed: 2 })),
    "结果汇总用冻结键的正文（{ok}/{failed} 都真的替换掉）",
  );
  assert.equal(
    (markup.match(/data-testid="work-items-bulk-failure"/g) ?? []).length,
    2,
    "**逐条**失败行：两条失败就是两条（折成一个总数 ⇒ 本断言必红）",
  );
  for (const need of [
    "坏掉的那条",
    "写 wi-c 失败",
    "标签满了的那条",
    t("squad.workItems.labelsTooMany", { max: 10, count: 11 }),
  ]) {
    assert.ok(markup.includes(need), `结果里缺「${need}」—— 部分失败被总数掩盖了`);
  }
});

// ---------- ⑤ 取数不可用：入口不消失、置灰 + 原因（复用 R4 判据） ----------

test("批量工具栏｜取数不可用：入口**不消失**，与其它控件**同一句**置灰原因", () => {
  const noWorkspace = renderActions({
    targetAvailable: false,
    createDisabled: true,
    bulk: { active: true, selectedCount: 1 },
  });
  const toggle = tagWithTestId(noWorkspace, "work-items-bulk-toggle");
  assert.ok(hasDisabledAttr(toggle), "无工作区 ⇒ 批量入口置灰（而不是消失）");
  assert.ok(
    toggle.includes(`title="${t("squad.common.noWorkspace")}"`),
    "置灰原因复用 workItemSurfaceControlsDisabledReason 的结论（与其它控件同一句）",
  );
  assert.ok(
    noWorkspace.includes(t("squad.common.noWorkspace")),
    "原因真的渲染出来了（正文，不是 key）",
  );
  const failed = renderActions({ createDisabled: true, bulk: { active: true, selectedCount: 1 } });
  assert.ok(
    tagWithTestId(failed, "work-items-bulk-toggle").includes(
      `title="${t("squad.workItems.loadFailed")}"`,
    ),
    "读取失败 ⇒ 说失败（与其它控件同一句）",
  );
});

// ---------- ⑥ 结构守卫：受控 + 零键增 + 接线（页面单条写路径） ----------

test("守卫｜批量工具栏**受控**：不自持状态、不调服务、判据全在纯函数层", () => {
  const toolbar = stripComments(readSource("squad/WorkItemBulkToolbar.tsx"));
  for (const forbidden of [
    "useState",
    "useEffect",
    "resolveSquadRuntimeService",
    "updateWorkItem",
    "createWorkItem",
    ".filter(",
    ".sort(",
  ]) {
    assert.ok(!toolbar.includes(forbidden), `批量工具栏不得出现 ${forbidden}`);
  }
  assert.ok(
    toolbar.includes("resolveWorkItemBulkEdit(") &&
      !toolbar.includes("applyWorkItemBulkDraftIntent"),
    "取值判据走纯函数；草稿折叠在页面（本组件只回传意图，不在本地折叠草稿）",
  );
  assert.ok(
    toolbar.includes("onDraftIntent(") && toolbar.includes("onClick={onApply}"),
    "控件只回传意图（onDraftIntent / onApply）",
  );
});

test("守卫｜零键增：批量面新文件里出现的文案键全部来自冻结清单或既有键", () => {
  const allowed = new Set([
    // R1 冻结的批量六键
    "squad.workItems.bulk.label",
    "squad.workItems.bulk.selected",
    "squad.workItems.bulk.selectRow",
    "squad.workItems.bulk.clear",
    "squad.workItems.bulk.apply",
    "squad.workItems.bulk.result",
    // 复用既有键（字段名 / 三枚写入判据 / 标签上限 / 单条错误词汇）
    "squad.workItems.priority",
    "squad.workItems.labels",
    "squad.workItems.startDate",
    "squad.workItems.dueDate",
    "squad.workItems.priorityInvalid",
    "squad.workItems.startDateInvalid",
    "squad.workItems.dueDateInvalid",
    "squad.workItems.labelsTooMany",
    "squad.workItems.labelsTooLong",
    "squad.workItems.datePlaceholder",
  ]);
  const seen = new Set<string>();
  for (const file of ["squad/WorkItemBulkToolbar.tsx", "squad/workItemBulkViewModel.ts"]) {
    const source = stripComments(readSource(file));
    for (const match of source.matchAll(/"(squad\.[A-Za-z0-9_.]+)"/g)) {
      seen.add(match[1]!);
      assert.ok(
        allowed.has(match[1]!),
        `${file} 用了清单外的键 ${match[1]}（零键增：缺键按阻塞上报）`,
      );
    }
  }
  for (const required of ["squad.workItems.bulk.result", "squad.workItems.labelsTooMany"]) {
    assert.ok(seen.has(required), `零键增扫描必须真的覆盖到 ${required}（否则本条是空跑）`);
  }
  // 控件带（冻结文件）里不得出现批量键字面量：批量面的词汇全在新模块里（R4 的零键增扫描口径不受影响）。
  assert.ok(
    !stripComments(readSource("squad/WorkItemsPageActions.tsx")).includes('"squad.workItems.bulk.'),
    "控件带不得就地使用批量键（那会让 R4 的零键增扫描看到清单外的键）",
  );
});

test("守卫｜接线：页面注入写路径、状态机在 hook、控件带只挂载工具栏（宿主透传行选择）", () => {
  const page = stripComments(readSource("squad/WorkItemsPage.tsx"));
  const hook = stripComments(readSource("squad/useWorkItemBulk.ts"));
  const band = stripComments(readSource("squad/WorkItemsPageActions.tsx"));
  const host = stripComments(readSource("squad/WorkItemsSurface.tsx"));
  for (const needle of ["useWorkItemBulk({", "bulk={bulk.toolbar}", "selection={bulk.selection}"]) {
    assert.ok(page.includes(needle), `页面接线缺 ${needle}（漏一处 = 批量面静默失活）`);
  }
  for (const needle of [
    "workItemBulkReconcileSelection(",
    "workItemBulkToggleSelection(",
    "workItemBulkSelectionAfterApply(",
    "workItemBulkSelectionEquals(",
    "workItemBulkPlan(",
    "executeWorkItemBulkEdit(",
    "await reload()",
  ]) {
    assert.ok(hook.includes(needle), `批量状态机缺 ${needle}（收敛 / 逐条执行 / 回读刷新各一处）`);
  }
  assert.ok(
    band.includes("<WorkItemBulkToolbar") &&
      band.includes("disabledReason={controlsDisabledReason}"),
    "控件带只挂载批量工具栏并复用同一份置灰原因",
  );
  const envStart = host.indexOf("const environment");
  const env = host.slice(envStart, host.indexOf("onOpenSession,", envStart));
  assert.ok(env.includes("selection,"), "宿主把行选择透传进行环境（漏了 ⇒ 模式开着但没有勾选件）");
});

/* 承重验收 1 的接线面：批量写**逐条**经既有单条写入口 `updateWorkItem`；批量状态机不碰服务。
   反向断言（变异 M-直写：页面把 writer 换成空实现 / 状态机自己调服务 ⇒ 本用例必红）。 */
test("守卫｜批量写逐条经 updateWorkItem：写调用只在页面，批量状态机零服务调用", () => {
  const page = stripComments(readSource("squad/WorkItemsPage.tsx"));
  /* 切片的两个锚点是**本页的声明边界**（写入口 → 改派提交）：批量写只在这段里，
     别的写动作（改派 / 新建 / 放弃）在段外。 */
  const write = page.slice(
    page.indexOf("const writeBulkRow"),
    page.indexOf("const submitReassign"),
  );
  assert.ok(
    write.includes("updateWorkItem(target, {") &&
      write.includes("id: row.id") &&
      write.includes("patch: row.patch"),
    "写调用必须是单条写入口，且 patch 原样并入（不重拼字段名）",
  );
  assert.ok(
    write.includes("useWorkItemBulk({") && write.includes("write: writeBulkRow"),
    "逐条执行由状态机按次序调用这个写入口",
  );
  for (const forbidden of [
    "createWorkItem",
    "reassignWorkItem",
    "discardBatch",
    "setSnapshot(",
    ".squadRuntimeService",
    "Promise.all",
  ]) {
    assert.ok(!write.includes(forbidden), `批量写段不得出现 ${forbidden}`);
  }
  for (const file of [
    "squad/WorkItemBulkToolbar.tsx",
    "squad/workItemBulkViewModel.ts",
    "squad/useWorkItemBulk.ts",
  ]) {
    const source = stripComments(readSource(file));
    for (const forbidden of ["updateWorkItem", "resolveSquadRuntimeService", "@zcode/services"]) {
      assert.ok(!source.includes(forbidden), `${file} 不得出现 ${forbidden}（写路径只有页面一条）`);
    }
  }
});
