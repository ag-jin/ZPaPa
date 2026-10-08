import assert from "node:assert/strict";
import test from "node:test";
import { WORK_ITEM_STATUS_CATEGORY } from "@zcode/shared";
import type { WorkItem, WorkItemStatusCategory, WorkItemStatusKey } from "@zcode/shared";
import {
  WORK_ITEM_COLUMN_MESSAGE_IDS,
  WORK_ITEM_PRIORITY_FILTER_MESSAGE_IDS,
  WORK_ITEM_PRIORITY_FILTER_VALUES,
  WORK_ITEM_SORT_DIRECTIONS,
  WORK_ITEM_SORT_DIRECTION_MESSAGE_IDS,
  WORK_ITEM_SORT_KEYS,
  WORK_ITEM_SORT_MESSAGE_IDS,
  WORK_ITEM_STATUS_FILTER_VALUES,
  WORK_ITEM_STATUS_FILTER_MESSAGE_IDS,
  WORK_ITEM_SURFACE_COLUMNS,
  WORK_ITEM_VIEW_MODES,
  WORK_ITEM_VIEW_MODE_MESSAGE_IDS,
  applyWorkItemSurfaceIntent,
  visibleWorkItemColumns,
  workItemMatchesSearch,
  workItemSurfaceDefaultState,
  workItemSurfaceEmptyKind,
  workItemSurfaceHasActiveQuery,
  workItemSurfaceSearchText,
  workItemSurfaceVisibleItems,
  type WorkItemSurfaceState,
} from "../src/squad/workItemSurfaceViewModel.js";
import { flattenWorkItemBoard } from "../src/squad/workItemsViewModel.js";

/* 工作项 **Surface 视图模型**（阶段二 · T-P2-R1 接口冻结轮）的用例：视图模式 / 过滤 / 本地搜索 /
   排序 / 列配置 —— **判据全在纯函数**（组件里没有渲染测试设施，写进组件就等于不可测；而判据
   的坏法全是静默的：默认路径被顺手排序、搜索大小写口径两处各写一遍、闭集漏一个值）。

   期望值的**独立真源**：拆解卡 §阶段二 T-P2-R1 的验收 6 条（默认 = board + 无过滤/搜索/排序 ⇒
   与 `flattenWorkItemBoard` 逐格等价；搜索为内存匹配标题/标签/identifier；排序键与列目录是闭集）
   + 已完成阶段一的既有口径（只切根、子树随根、未设置不编造位次）。 */

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

const ids = (items: WorkItem[]) => items.map((item) => item.id);

// ---------- ① 默认路径零回归（承重验收 2） ----------

/* 默认状态由**拆解卡的验收口径**写死（不是从实现抄一份）：board + 无过滤 + 无搜索 + 无排序 +
   不隐藏任何列。默认值一改（例如把默认排序换成 priority），这条必红。 */
test("默认状态：board + 无过滤 + 无搜索 + 无排序 + 零隐藏列（逐字段钉住默认口径）", () => {
  assert.deepEqual(workItemSurfaceDefaultState(), {
    view: "board",
    search: "",
    filter: { statusCategory: "all", priority: "all" },
    sort: { key: "manual", direction: "asc" },
    columns: { hidden: [] },
  });
  assert.equal(
    workItemSurfaceHasActiveQuery(workItemSurfaceDefaultState()),
    false,
    "默认状态不算「有查询」：空结果态的判据与「清除筛选」的可点性都靠它",
  );
});

/* 承重验收 2：默认（board、无过滤、无搜索、无排序）⇒ 可见集与输入**逐格等价**，进而行集与
   `flattenWorkItemBoard` 逐格等价（既有锚点与行序零变化）。 */
test("默认路径：可见集与输入逐格等价（行序/内容），行集与 flattenWorkItemBoard 逐格等价", () => {
  const items = [
    wi("p1", { title: "批根" }),
    wi("c1", { parentId: "p1", title: "子项" }),
    wi("g1", { parentId: "c1", title: "孙项" }),
    wi("p2", { title: "另一棵树" }),
    wi("orphan", { parentId: "gone", title: "孤儿（父已归档）" }),
  ];
  const visible = workItemSurfaceVisibleItems({ items, state: workItemSurfaceDefaultState() });
  assert.deepEqual(
    ids(visible),
    ids(items),
    "默认路径不重排、不删行（行序仍由 flattenWorkItemBoard 给）",
  );
  assert.deepEqual(
    flattenWorkItemBoard(visible).map((row) => [row.item.id, row.depth]),
    flattenWorkItemBoard(items).map((row) => [row.item.id, row.depth]),
    "默认行集与 flattenWorkItemBoard 逐格等价（深度与行序都不变）",
  );
});

/* 空结果态与"还没有工作项"是**两态**（R4 验收 2 的判据在此冻结）：空块由宿主渲染，判据在这里。 */
test("空态判据：无数据 ⇒ none；有数据但被筛掉 ⇒ filtered；有可见行 ⇒ 不空", () => {
  assert.equal(workItemSurfaceEmptyKind({ total: 0, visible: 0 }), "none");
  assert.equal(workItemSurfaceEmptyKind({ total: 5, visible: 0 }), "filtered");
  assert.equal(workItemSurfaceEmptyKind({ total: 5, visible: 3 }), null);
  assert.equal(
    workItemSurfaceEmptyKind({ total: 1, visible: 1 }),
    null,
    "只有一条也要正常渲染（不给空态）",
  );
});

// ---------- ② 本地搜索（承重验收 3） ----------

/** 只改搜索的最小状态构造（其余取默认）。 */
function searchState(search: string): WorkItemSurfaceState {
  return { ...workItemSurfaceDefaultState(), search };
}

/* 搜索是**内存匹配**：标题 + 标签 + identifier 展示文本（Q3 裁定）；大小写与 trim 口径单源
   （`workItemSurfaceSearchText`）、**不依赖 i18n**（不按界面语言折叠）。空查询 = 不过滤。 */
test("搜索匹配：标题 / 标签 / identifier 文本三处命中；大小写与首尾空格不敏感", () => {
  const item = wi("wi-1", {
    title: "修复 登录 闪烁",
    labels: ["Regression", "P1"],
    identifierSeq: 12,
  });
  // 期望值来自 Q3 裁定与 identifier 的展示口径（前缀 + 序号，独立写出，不调实现拼接）。
  for (const query of [
    "修复",
    "登录",
    "regression",
    "REGRESSION",
    "  p1  ",
    "#12",
    "#12".slice(0, 3),
    "12",
  ]) {
    assert.equal(workItemMatchesSearch(item, query), true, `「${query}」应当命中`);
  }
  for (const query of ["没有的东西", "#13", "regressed", "P2"]) {
    assert.equal(workItemMatchesSearch(item, query), false, `「${query}」不应命中`);
  }
  assert.equal(
    workItemMatchesSearch(item, "regress"),
    true,
    "匹配是**子串**匹配（不是整词/前缀）：本地搜索的口径如此，别写成前缀比较",
  );
  assert.equal(workItemMatchesSearch(item, ""), true, "空查询 = 不过滤（默认路径）");
  assert.equal(workItemMatchesSearch(item, "   "), true, "纯空白同样不算查询");
  assert.equal(
    workItemMatchesSearch(wi("wi-2", { identifierSeq: 3 }), "#3"),
    true,
    "没有标签也能按编号搜到（identifier 是标识符，搜不到会让「按编号找人」失效）",
  );
});

/* 归一化单源：trim + 小写（不按 locale 折叠 —— 搜索结果不该随界面语言变化）。 */
test("搜索归一化：只做 trim + 小写（不做 locale 折叠、不丢中间空格）", () => {
  assert.equal(workItemSurfaceSearchText("  Bug 修复  "), "bug 修复");
  assert.equal(workItemSurfaceSearchText("BUG"), "bug");
  assert.equal(workItemSurfaceSearchText(""), "");
});

/* 树单元口径（与泳道「只切根」同源）：树内任一行命中 ⇒ 整棵树留下（批是行的视觉单元）；
   命中子项也留下批根，否则子项会脱离批根、批入口跟着错位。 */
test("搜索投影：命中的树整体留下（含未命中的批根与兄弟项），未命中的树整体消失", () => {
  const items = [
    wi("batch", { title: "批根" }),
    wi("child", { parentId: "batch", title: "命中这一条" }),
    wi("sibling", { parentId: "batch", title: "兄弟项" }),
    wi("other", { title: "另一棵树" }),
  ];
  const visible = workItemSurfaceVisibleItems({ items, state: searchState("命中") });
  assert.deepEqual(
    ids(visible),
    ["batch", "child", "sibling"],
    "子项命中 ⇒ 整棵批树留下（批根与兄弟项都在）；另一棵树整体消失",
  );
  assert.deepEqual(
    flattenWorkItemBoard(visible).map((row) => [row.item.id, row.depth]),
    [
      ["batch", 0],
      ["child", 1],
      ["sibling", 1],
    ],
    "留下的树仍由同一份 DFS 给行序与深度（本层不重排、不重算父子）",
  );
});

test("搜索投影：全部不命中 ⇒ 空可见集（宿主据此给「无匹配」态，而不是「还没有工作项」）", () => {
  const items = [wi("a", { title: "甲" }), wi("b", { title: "乙" })];
  const visible = workItemSurfaceVisibleItems({ items, state: searchState("查不到") });
  assert.deepEqual(visible, []);
  assert.equal(
    workItemSurfaceEmptyKind({ total: items.length, visible: visible.length }),
    "filtered",
    "有数据但被筛掉 ⇒ filtered（两态文案分开）",
  );
});

// ---------- ③ 过滤 facet（承重验收 1/3） ----------

/** 只改过滤 facet 的最小状态构造（其余取默认）。 */
function filterState(over: Partial<WorkItemSurfaceState["filter"]>): WorkItemSurfaceState {
  const base = workItemSurfaceDefaultState();
  return { ...base, filter: { ...base.filter, ...over } };
}

/* 状态 facet 认 **category**（机器判据）而不是 6 键：in_progress / in_review / blocked 三键
   都落在 `started` 里 —— 按键名判会让其中两个静默落错筛选结果（与泳道同一条口径）。 */
test("状态 facet：按 category 判定（6 键各自落进 WORK_ITEM_STATUS_CATEGORY 指出的那一档）", () => {
  const items = (Object.keys(WORK_ITEM_STATUS_CATEGORY) as WorkItemStatusKey[]).map((status) =>
    wi(`wi-${status}`, { status }),
  );
  for (const category of ["unstarted", "started", "done", "closed"] as WorkItemStatusCategory[]) {
    const visible = workItemSurfaceVisibleItems({
      items,
      state: filterState({ statusCategory: category }),
    });
    assert.deepEqual(
      ids(visible),
      items
        .filter((item) => WORK_ITEM_STATUS_CATEGORY[item.status] === category)
        .map((item) => item.id),
      `facet=${category} 的可见集必须由 category 判定给出`,
    );
  }
  assert.deepEqual(
    ids(workItemSurfaceVisibleItems({ items, state: filterState({ statusCategory: "all" }) })),
    ids(items),
    "all = 不筛",
  );
});

/* 优先级 facet：四档精确相等；**`unset` 是独立选项**（NULL = 未设置与「显式选了某一档」不是同一态，
   不单列就永远查不出存量行）；闭集外的值不当任何一档用。 */
test("优先级 facet：四档精确相等、unset 只收未设置、all 不筛", () => {
  const items = [
    wi("urgent", { priority: "urgent" }),
    wi("high", { priority: "high" }),
    wi("medium", { priority: "medium" }),
    wi("low", { priority: "low" }),
    wi("unset-a"),
    wi("unset-b"),
  ];
  assert.deepEqual(
    ids(workItemSurfaceVisibleItems({ items, state: filterState({ priority: "unset" }) })),
    ["unset-a", "unset-b"],
    "unset 只收未设置（存量行占多数，查不出这一态等于过滤不了）",
  );
  for (const key of ["urgent", "high", "medium", "low"] as const) {
    assert.deepEqual(
      ids(workItemSurfaceVisibleItems({ items, state: filterState({ priority: key }) })),
      [key],
      `facet=${key} 只收这一档`,
    );
  }
  assert.deepEqual(
    ids(workItemSurfaceVisibleItems({ items, state: filterState({ priority: "all" }) })),
    ids(items),
  );
});

/* 两个 facet 与搜索是**同一行的合取**（facet ∧ 搜索），再按树取并集：
   命中判定必须落在**同一行**上 —— 「根满足 facet、子项满足搜索」不算命中（否则筛选条件会被
   另一行的命中悄悄绕过）。 */
test("过滤合取：facet 与搜索必须落在同一行上，再按树单元取并集", () => {
  const items = [
    wi("batch", { title: "批根", priority: "urgent" }),
    wi("child", { parentId: "batch", title: "看这里", priority: "low" }),
    wi("other", { title: "看这里", priority: "urgent" }),
    wi("noise", { title: "无关", priority: "urgent" }),
  ];
  const state: WorkItemSurfaceState = {
    ...filterState({ priority: "urgent" }),
    search: "看这里",
  };
  assert.deepEqual(
    ids(workItemSurfaceVisibleItems({ items, state })),
    ["other"],
    "batch 的根满足 facet 但子项满足搜索（不同行）⇒ 整棵 batch 不命中；other 同一行两条件都满足",
  );
});

test("过滤生效即算「有查询」：facet 非 all ⇒ hasActiveQuery=true（搜索原文仍是空）", () => {
  assert.equal(workItemSurfaceHasActiveQuery(filterState({ priority: "unset" })), true);
  assert.equal(workItemSurfaceHasActiveQuery(filterState({ statusCategory: "done" })), true);
  assert.equal(workItemSurfaceHasActiveQuery(searchState("  ")), false, "纯空白不算查询");
});

// ---------- ④ 排序（承重验收 4：排序键是闭集） ----------

/** 只改排序的最小状态构造（其余取默认）。 */
function sortState(key: WorkItemSurfaceState["sort"]["key"], direction: "asc" | "desc" = "asc") {
  const base = workItemSurfaceDefaultState();
  return { ...base, sort: { key, direction } };
}

/* 排序排的是**根**（与过滤同一条「树单元」纪律）：子树随根落位、深度不变 ——
   按行排序会把子项从批根里甩出去（批不再是一行的视觉单元），且「行序」会同时有两份判据。 */
test("排序：只排根（子树随根落位、深度不变），`manual` = 输入次序（默认零加工）", () => {
  const items = [
    wi("root-b", { title: "b 批", priority: "low" }),
    wi("child-of-b", { parentId: "root-b", title: "a 子" }),
    wi("root-a", { title: "a 批", priority: "urgent" }),
    wi("child-of-a", { parentId: "root-a", title: "b 子" }),
  ];
  assert.deepEqual(
    ids(workItemSurfaceVisibleItems({ items, state: sortState("manual") })),
    ["root-b", "child-of-b", "root-a", "child-of-a"],
    "manual 保持输入次序（既有行序，不得被顺手规范化）",
  );
  assert.deepEqual(
    ids(workItemSurfaceVisibleItems({ items, state: sortState("title") })),
    ["root-a", "child-of-a", "root-b", "child-of-b"],
    "按标题升序排根：子树整体随根走（child-of-a 跟着 root-a）",
  );
  assert.deepEqual(
    flattenWorkItemBoard(workItemSurfaceVisibleItems({ items, state: sortState("title") })).map(
      (row) => [row.item.id, row.depth],
    ),
    [
      ["root-a", 0],
      ["child-of-a", 1],
      ["root-b", 0],
      ["child-of-b", 1],
    ],
    "深度仍由同一份 DFS 给（本层不重算父子）",
  );
});

/* 标题排序是**码位序**（`<` / `>`），不是拼音序/locale 序：本仓对泳道顺序有同款纪律
   （顺序不得随界面语言或运行环境漂移）。这条把「中文按码位而不是拼音」显式钉住 ——
   想要拼音序就得引入 collator（= 另一份 locale 真相源），那是另一个裁定，不在本轮口径内。 */
test("排序：标题用码位序（乙 U+4E59 排在 甲 U+7532 之前），不做拼音/locale 折叠", () => {
  const items = [wi("jia", { title: "甲" }), wi("yi", { title: "乙" })];
  assert.deepEqual(
    ids(workItemSurfaceVisibleItems({ items, state: sortState("title") })),
    ["yi", "jia"],
    "码位序：乙（U+4E59）< 甲（U+7532）；拼音序（jiǎ < yǐ）需要 collator，不在本轮口径内",
  );
});

/* 优先级排序走 shared 的位次（越紧急越小）；**未设置没有位次**（shared 裁定），呈现层的决定是
   「未设置永远排在最后，两个方向一致」—— 给它编一个位次就是把「没人定过」当成某一档。 */
test("排序：优先级按位次（紧急在前），未设置无论方向都排在最后", () => {
  const items = [
    wi("low", { priority: "low" }),
    wi("unset-a"),
    wi("urgent", { priority: "urgent" }),
    wi("high", { priority: "high" }),
    wi("unset-b"),
  ];
  assert.deepEqual(
    ids(workItemSurfaceVisibleItems({ items, state: sortState("priority") })),
    ["urgent", "high", "low", "unset-a", "unset-b"],
    "升序：urgent → high → low，未设置最后（并列保持输入次序 = 稳定排序）",
  );
  assert.deepEqual(
    ids(workItemSurfaceVisibleItems({ items, state: sortState("priority", "desc") })),
    ["low", "high", "urgent", "unset-a", "unset-b"],
    "降序：档位倒过来，**未设置仍在最后**（它没有位次，不参与反向比较）",
  );
});

/* 日期排序：`YYYY-MM-DD` 字典序 = 时间序（阶段一的日期原语裁定）；未设置的日期同样永远最后。 */
test("排序：起始/截止日期按字典序（= 时间序），未设置的日期永远最后", () => {
  const items = [
    wi("late", { dueDate: "2026-12-01" }),
    wi("none"),
    wi("early", { dueDate: "2026-01-05" }),
    wi("mid", { dueDate: "2026-03-09" }),
  ];
  assert.deepEqual(
    ids(workItemSurfaceVisibleItems({ items, state: sortState("dueDate") })),
    ["early", "mid", "late", "none"],
    "字典序 = 时间序（不 new Date、不做时刻换算）",
  );
  assert.deepEqual(
    ids(workItemSurfaceVisibleItems({ items, state: sortState("startDate") })),
    ["late", "none", "early", "mid"],
    "startDate 全未设置 ⇒ 只剩输入次序（并列 = 稳定排序，不得重排）",
  );
});

test("排序：确定性 —— 同一输入两次调用逐项相同（稳定排序，不因并列抖动）", () => {
  const items = [
    wi("a", { title: "same" }),
    wi("b", { title: "same" }),
    wi("c", { title: "zhi" }),
    wi("d", { title: "same" }),
  ];
  assert.deepEqual(
    ids(workItemSurfaceVisibleItems({ items, state: sortState("title") })),
    ids(workItemSurfaceVisibleItems({ items, state: sortState("title") })),
    "两次调用逐字一致",
  );
  assert.deepEqual(
    ids(workItemSurfaceVisibleItems({ items, state: sortState("title") })),
    ["a", "b", "d", "c"],
    "同名三项（same）保持输入次序（稳定）；zhi 在最后",
  );
});

test("排序与过滤叠加：先筛树、再排根（顺序对结果无影响，行集仍是同一份）", () => {
  const items = [
    wi("b", { title: "beta", priority: "urgent" }),
    wi("a", { title: "alpha", priority: "urgent" }),
    wi("c", { title: "gamma" }),
  ];
  const state: WorkItemSurfaceState = {
    ...filterState({ priority: "urgent" }),
    sort: { key: "title", direction: "asc" },
  };
  assert.deepEqual(ids(workItemSurfaceVisibleItems({ items, state })), ["a", "b"]);
  assert.deepEqual(
    ids(
      workItemSurfaceVisibleItems({
        items,
        state: { ...state, sort: { key: "title", direction: "desc" } },
      }),
    ),
    ["b", "a"],
    "降序翻转（两项都有标题，不涉及「未设置」的排位规则）",
  );
});

// ---------- ⑤ 列目录与意图折叠（承重验收 1/4/6） ----------

/* 列目录是**闭集**：目录数组与文案映射的键集必须一致（少一枚 ⇒ 表格少一列或界面上多一个裸 key）。
   本阶段只列**服务面真有的**字段（project / progress / updated 没有数据面 ⇒ 不造空列）。 */
test("列目录：闭集与文案映射键集一致，只有领域对象上真有的字段", () => {
  assert.deepEqual(
    [...WORK_ITEM_SURFACE_COLUMNS].sort(),
    ["assignee", "creator", "dueDate", "identifier", "labels", "priority", "startDate", "status"],
    "八列（phase-2 可配置列的范围由这条钉住；加列必须同时改目录与文案映射）",
  );
  assert.deepEqual(
    Object.keys(WORK_ITEM_COLUMN_MESSAGE_IDS).sort(),
    [...WORK_ITEM_SURFACE_COLUMNS].sort(),
    "目录 == 文案映射键集（漏一个 ⇒ 那一列表头没有话可说）",
  );
  for (const messageId of Object.values(WORK_ITEM_COLUMN_MESSAGE_IDS)) {
    assert.ok(messageId.startsWith("squad.workItems."), messageId);
  }
});

test("列配置：可见列 = 目录顺序减去隐藏集（隐藏顺序不影响输出顺序）", () => {
  assert.deepEqual(
    visibleWorkItemColumns({ hidden: [] }),
    [...WORK_ITEM_SURFACE_COLUMNS],
    "默认零隐藏 ⇒ 目录全量（顺序即目录顺序）",
  );
  assert.deepEqual(
    visibleWorkItemColumns({ hidden: ["creator", "identifier"] }),
    ["status", "priority", "assignee", "labels", "startDate", "dueDate"],
    "隐藏两列：输出仍是目录顺序（不是隐藏集顺序），且恰好少这两列",
  );
  assert.deepEqual(
    visibleWorkItemColumns({ hidden: [...WORK_ITEM_SURFACE_COLUMNS] }),
    [],
    "全隐藏 ⇒ 空（表格视图自行决定「一列不剩」时的空态，本函数不替它兜底）",
  );
});

/* 意图折叠（纯函数）：控件带（R4）只回传**意图**，状态迁移只有这一处实现 ——
   两处各写一遍 setState 迟早让「清除筛选」漏掉一个 facet。 */
test("意图折叠：视图 / 搜索 / facet / 排序 / 列显隐逐项落状态（不改无关字段）", () => {
  const base = workItemSurfaceDefaultState();
  assert.equal(applyWorkItemSurfaceIntent(base, { kind: "setView", view: "table" }).view, "table");
  assert.equal(
    applyWorkItemSurfaceIntent(base, { kind: "setSearch", search: "  Foo  " }).search,
    "  Foo  ",
    "搜索原文**原样**落状态（trim/大小写只在匹配时归一化一处）",
  );
  assert.equal(
    applyWorkItemSurfaceIntent(base, { kind: "setStatusFilter", value: "started" }).filter
      .statusCategory,
    "started",
  );
  assert.equal(
    applyWorkItemSurfaceIntent(base, { kind: "setPriorityFilter", value: "unset" }).filter.priority,
    "unset",
  );
  assert.deepEqual(
    applyWorkItemSurfaceIntent(base, { kind: "setSortKey", key: "dueDate" }).sort,
    { key: "dueDate", direction: "asc" },
    "换排序键保留方向（用户只改了「按什么排」）",
  );
  assert.deepEqual(
    applyWorkItemSurfaceIntent(base, { kind: "setSortDirection", direction: "desc" }).sort,
    { key: "manual", direction: "desc" },
    "换方向保留键",
  );
  const hiddenOne = applyWorkItemSurfaceIntent(base, { kind: "toggleColumn", column: "creator" });
  assert.deepEqual(hiddenOne.columns.hidden, ["creator"], "toggle 一次 = 隐藏");
  assert.deepEqual(
    applyWorkItemSurfaceIntent(hiddenOne, { kind: "toggleColumn", column: "creator" }).columns
      .hidden,
    [],
    "再 toggle = 显示（幂等的往返）",
  );
  // 无关字段不得被顺手改掉：逐项断言，防止「用默认状态整体替换」这种静默覆盖。
  const mutated = applyWorkItemSurfaceIntent(
    { ...base, view: "list", sort: { key: "title", direction: "desc" } },
    { kind: "setSearch", search: "x" },
  );
  assert.equal(mutated.view, "list");
  assert.deepEqual(mutated.sort, { key: "title", direction: "desc" });
});

/* 「清除筛选」：清搜索 + 两个 facet 回 `all`，**不动**视图 / 排序 / 列配置 ——
   用户点的是「把这个筛选条件去掉」，不是「把我刚配好的视图重置」。 */
test("意图折叠：清除查询只清搜索与 facet（视图/排序/列配置原样保留）", () => {
  const dirty: WorkItemSurfaceState = {
    view: "table",
    search: "foo",
    filter: { statusCategory: "done", priority: "unset" },
    sort: { key: "dueDate", direction: "desc" },
    columns: { hidden: ["labels"] },
  };
  const cleared = applyWorkItemSurfaceIntent(dirty, { kind: "clearQuery" });
  assert.deepEqual(cleared, {
    view: "table",
    search: "",
    filter: { statusCategory: "all", priority: "all" },
    sort: { key: "dueDate", direction: "desc" },
    columns: { hidden: ["labels"] },
  });
  assert.equal(workItemSurfaceHasActiveQuery(cleared), false, "清完就不再算「有查询」");
});

/* 折叠是**纯**的：不改入参（改状态对象本身 = React 看不出变化，界面不重渲染且不报错）。 */
test("意图折叠是纯函数：不改入参状态（引用与字段都原样）", () => {
  const base = workItemSurfaceDefaultState();
  const snapshot = JSON.stringify(base);
  applyWorkItemSurfaceIntent(base, { kind: "setView", view: "list" });
  applyWorkItemSurfaceIntent(base, { kind: "toggleColumn", column: "status" });
  applyWorkItemSurfaceIntent(base, { kind: "clearQuery" });
  assert.equal(JSON.stringify(base), snapshot, "入参状态不得被就地改写");
});

// ---------- ⑥ 闭集穷尽（承重验收 4） ----------

test("闭集：视图 / 排序键 / 方向 / facet 取值与各自的文案映射键集一致", () => {
  assert.deepEqual([...WORK_ITEM_VIEW_MODES], ["board", "list", "table"]);
  assert.deepEqual(
    Object.keys(WORK_ITEM_VIEW_MODE_MESSAGE_IDS).sort(),
    [...WORK_ITEM_VIEW_MODES].sort(),
  );
  assert.deepEqual(
    [...WORK_ITEM_SORT_KEYS],
    ["manual", "priority", "startDate", "dueDate", "title"],
  );
  assert.deepEqual(
    Object.keys(WORK_ITEM_SORT_MESSAGE_IDS).sort(),
    [...WORK_ITEM_SORT_KEYS].sort(),
    "排序键 == 文案映射键集（R3 的排序表头与 R4 的选择器都消费它）",
  );
  assert.deepEqual([...WORK_ITEM_SORT_DIRECTIONS], ["asc", "desc"]);
  assert.deepEqual(
    Object.keys(WORK_ITEM_SORT_DIRECTION_MESSAGE_IDS).sort(),
    [...WORK_ITEM_SORT_DIRECTIONS].sort(),
  );
  assert.deepEqual(
    [...WORK_ITEM_STATUS_FILTER_VALUES],
    ["all", "unstarted", "started", "done", "closed"],
    "状态 facet 只有 4 个 category + all（不认 6 键）",
  );
  assert.deepEqual(
    Object.keys(WORK_ITEM_STATUS_FILTER_MESSAGE_IDS).sort(),
    [...WORK_ITEM_STATUS_FILTER_VALUES].sort(),
  );
  assert.deepEqual(
    [...WORK_ITEM_PRIORITY_FILTER_VALUES],
    ["all", "urgent", "high", "medium", "low", "unset"],
    "优先级 facet = all + 闭集四档 + unset（未设置是独立一态）",
  );
  assert.deepEqual(
    Object.keys(WORK_ITEM_PRIORITY_FILTER_MESSAGE_IDS).sort(),
    [...WORK_ITEM_PRIORITY_FILTER_VALUES].sort(),
  );
});
