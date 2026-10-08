import assert from "node:assert/strict";
import test from "node:test";
import type { WorkItemViewRecord } from "@zcode/services";
import {
  WORK_ITEM_VIEW_ANCHOR_ID,
  applyWorkItemSurfaceIntentWithBaseline,
  normalizeWorkItemSurfaceForLaneDimension,
  workItemBoardReorderEnabled,
  workItemSortKeysForLaneDimension,
  workItemViewManageRows,
  workItemViewNameSubmitValue,
  workItemViewSharedOf,
  workItemViewVisibilityLocked,
  workItemViewVisibilityOf,
  workItemViewBaseline,
  workItemViewHasIncrement,
  workItemViewListAfterLoad,
  workItemViewSeed,
  workItemViewTabActions,
  workItemViewTabs,
} from "../src/squad/workItemViewsViewModel.js";
import { applyWorkItemSurfaceIntent } from "../src/squad/workItemSurfaceViewModel.js";

/* 工作项**保存视图**（阶段二 · T-P2-R6b）的纯判据：定义形状 / 首开 seed / baseline / 权限投影。

   为什么这些必须是纯函数（与 `workItemSurfaceViewModel` / `workItemSurfaceControlsViewModel`
   同一理由）：本包没有渲染测试设施，判据写进组件就等于不可测；而保存视图这一面的坏法全是**静默**的
   —— 首开 seed 漏一个字段（切换视图后列配置/排序留上一个视图的值）、本地调整**回写**定义、
   无权视图在条上照样可编辑、视图消失后仍停在默认标签上（界面显示一个不存在的视图）。

   期望值的独立真源：拆解卡 §T-P2-R6b 的验收 1-3 + 取证报告
   reports/2026-10-09-saved-views-multica-evidence.md 的 §3（baseline）/§5（facet 形状）/
   §8（权限 UI 形态）—— 下面用手写字面量钉住，不从实现反推。 */

/** 造一条保存视图（只给本组用例关心的字段；其余给一个显式的稳定值）。 */
function view(over: Partial<WorkItemViewRecord> = {}): WorkItemViewRecord {
  return {
    id: "view-1",
    workspaceKey: "ws",
    owner: { kind: "human", id: "me" },
    name: "视图甲",
    scopeType: "my",
    visibility: "private",
    definitionVersion: 1,
    query: {},
    display: {},
    revision: 3,
    createdAt: 1,
    updatedAt: 1,
    ...over,
  };
}

// ---------- ① 首开 seed：把 query + display 灌进 surface 状态（含列配置） ----------

/* 验收 1「切换视图全组合还原逐格（含列配置）」。期望值是**手写的完整状态**（不是从 seed 反推）：
   漏一个字段（例如把 `columns` 留在上一个视图的值上）在界面上只表现为"列还是旧的"，不报错。 */
test("首开 seed：query + display 逐格灌进 surface 状态（含列配置与分组维度）", () => {
  const seed = workItemViewSeed(
    view({
      query: { statusCategory: "started", priority: "high" },
      display: {
        viewMode: "table",
        grouping: "statusCategory",
        sortBy: "dueDate",
        sortDirection: "desc",
        hiddenColumns: ["creator", "labels"],
      },
    }),
  );
  assert.deepEqual(
    seed.surface,
    {
      view: "table",
      // 搜索词**不存**在定义里（multica 同款：query 无 free-text 键）⇒ 打开视图 = 搜索回到空。
      search: "",
      filter: { statusCategory: "started", priority: "high" },
      sort: { key: "dueDate", direction: "desc" },
      columns: { hidden: ["creator", "labels"] },
    },
    "seed 的字段集必须与 surface 状态**逐格**对齐（漏一格 = 切视图后那格留在上个视图的值上）",
  );
  assert.equal(seed.laneDimension, "statusCategory", "分组维度也在 display 里（泳道随视图还原）");
});

test("首开 seed：定义缺项/缺文档 ⇒ 缺的那一格回默认值（不是 undefined、不是上一个视图的值）", () => {
  const seed = workItemViewSeed(view({ query: {}, display: {} }));
  assert.deepEqual(
    seed.surface,
    {
      view: "board",
      search: "",
      filter: { statusCategory: "all", priority: "all" },
      sort: { key: "manual", direction: "asc" },
      columns: { hidden: [] },
    },
    "空定义 ⇒ 内建锚（默认态）逐格一致：默认视图是看板（与 R1 的默认状态同一份判据）",
  );
  assert.equal(seed.laneDimension, "none", "空定义 ⇒ 不分组（默认态）");
});

test("首开 seed：未知枚举成员丢弃（闭集外的值回落默认，不静默交给状态）", () => {
  const seed = workItemViewSeed(
    view({
      query: { statusCategory: "not-a-category", priority: "超紧急" },
      display: {
        viewMode: "gantt",
        grouping: "team",
        sortBy: "updatedAt",
        sortDirection: "sideways",
        hiddenColumns: ["creator", "不存在的列"],
      },
    }),
  );
  assert.deepEqual(
    seed.surface.filter,
    { statusCategory: "all", priority: "all" },
    "闭集外的 facet 值丢掉（界面按一个自己不认识的值渲染 = 一份没人能解释的状态）",
  );
  assert.equal(seed.surface.view, "board", "闭集外的视图名回落默认");
  assert.equal(seed.laneDimension, "none", "闭集外的分组维度回落默认");
  assert.deepEqual(seed.surface.sort, { key: "manual", direction: "asc" }, "闭集外的排序回落默认");
  assert.deepEqual(
    seed.surface.columns,
    { hidden: ["creator"] },
    "列配置逐枚过闭集：认识的留下、不认识的丢掉（不是整份丢掉）",
  );
});

test("首开 seed：每次返回**新对象**（状态是可变引用，共享一份常量迟早被某处就地改到）", () => {
  const record = view({ display: { hiddenColumns: ["labels"] } });
  const first = workItemViewSeed(record);
  const second = workItemViewSeed(record);
  assert.notEqual(first.surface, second.surface, "surface 是新对象");
  assert.notEqual(first.surface.columns, second.surface.columns, "嵌套的列配置也是新对象");
  assert.notEqual(
    first.surface.columns.hidden,
    second.surface.columns.hidden,
    "数组也要复制（就地 push 会改到别人手里那份）",
  );
});

// ---------- ② baseline：清空筛选回到视图条件、固定值锁定、增量判定 ----------

/* multica 的 baseline 是**客户端**概念（证据 §3）：`query → raw 快照`（"清空筛选"回视图条件，
   不是回全空）+ `Set`（视图固定值在过滤菜单里勾选且禁用）+ chips 只显增量。
   ZPaPa 没有 chips 条（零键增的例外名单里没有 chip 文案）⇒ 增量语义落在两处：
   ① 锁定维度（选择器置灰）；② 「清除筛选」的可点性 = 真有增量。 */

test("baseline｜locking：视图固定了的维度进锁定集，`all`（不约束）不算固定", () => {
  assert.deepEqual(
    workItemViewBaseline(
      view({
        query: { statusCategory: "started" },
        display: { sortBy: "manual", sortDirection: "asc" },
      }),
    ),
    {
      filter: { statusCategory: "started", priority: "all" },
      locked: { statusCategory: true, priority: false },
    },
    "固定值 = 定义里真的约束了那一维（`all` 是不约束，不是固定成「全部」）",
  );
  assert.deepEqual(
    workItemViewBaseline(view({ query: {}, display: {} })),
    {
      filter: { statusCategory: "all", priority: "all" },
      locked: { statusCategory: false, priority: false },
    },
    "空定义 ⇒ 不固定任何维度（内建锚的 baseline 是「全不约束」）",
  );
});

test("baseline｜「清除筛选」回到**视图条件**而非全空（清空筛选 ≠ 把我配好的视图重置）", () => {
  const baseline = workItemViewBaseline(
    view({ query: { statusCategory: "started", priority: "high" }, display: {} }),
  );
  // 本地叠加了增量：搜索 + 把 priority 改低。
  const local = applyWorkItemSurfaceIntent(
    applyWorkItemSurfaceIntent(workItemViewSeed(view()).surface, {
      kind: "setPriorityFilter",
      value: "low",
    }),
    { kind: "setSearch", search: "甲" },
  );
  assert.deepEqual(
    applyWorkItemSurfaceIntentWithBaseline(local, { kind: "clearQuery" }, baseline),
    {
      ...local,
      search: "",
      filter: { statusCategory: "started", priority: "high" },
    },
    "清空筛选回到视图自身条件（全空会让用户以为这个视图「清了」就是没有任何条件）",
  );
  // 没有视图打开（baseline = null）⇒ R1 的原语义逐格保留（clearQuery = 搜索 + 两维回 all）。
  assert.deepEqual(
    applyWorkItemSurfaceIntentWithBaseline(local, { kind: "clearQuery" }, null),
    applyWorkItemSurfaceIntent(local, { kind: "clearQuery" }),
    "没有视图时 clearQuery 仍走 R1 的折叠（本层不改变既有语义）",
  );
});

test("baseline｜非 clearQuery 的意图原样委托 R1 的折叠（本层只加一道视图语义）", () => {
  const baseline = workItemViewBaseline(
    view({ query: { statusCategory: "started" }, display: {} }),
  );
  const state = workItemViewSeed(view()).surface;
  for (const intent of [
    { kind: "setView", view: "list" },
    { kind: "setSearch", search: "乙" },
    { kind: "setPriorityFilter", value: "low" },
    { kind: "toggleColumn", column: "creator" },
  ] as const) {
    assert.deepEqual(
      applyWorkItemSurfaceIntentWithBaseline(state, intent, baseline),
      applyWorkItemSurfaceIntent(state, intent),
      `${intent.kind} 必须与 R1 的折叠逐格一致（视图语义只在 clearQuery 那一格）`,
    );
  }
});

test("baseline｜增量判定：无增量（搜索空 + facet 等于视图条件）⇒ 不算有查询", () => {
  const baseline = workItemViewBaseline(
    view({ query: { statusCategory: "started", priority: "high" }, display: {} }),
  );
  const seeded = workItemViewSeed(
    view({ query: { statusCategory: "started", priority: "high" }, display: {} }),
  ).surface;
  assert.equal(
    workItemViewHasIncrement(seeded, baseline),
    false,
    "打开视图本身不是增量（视图固定值只锁定、不显示成「用户加的筛选」）",
  );
  assert.equal(
    workItemViewHasIncrement(
      applyWorkItemSurfaceIntent(seeded, { kind: "setSearch", search: "甲" }),
      baseline,
    ),
    true,
    "搜索词是增量",
  );
  assert.equal(
    workItemViewHasIncrement(
      applyWorkItemSurfaceIntent(seeded, { kind: "setPriorityFilter", value: "low" }),
      baseline,
    ),
    true,
    "改了没被固定的那一维 ⇒ 增量",
  );
  assert.equal(
    workItemViewHasIncrement(
      applyWorkItemSurfaceIntent(seeded, { kind: "setSearch", search: "   " }),
      baseline,
    ),
    false,
    "只有空格不算增量（与 R1 的 `workItemSurfaceSearchText` 同一把尺子）",
  );
});

// ---------- ③ 首开 seed 之后本地调整**不回写**；重开回定义态 ----------

test("不回写｜本地调整后再打开同一视图：状态回到**定义**（本地只是种子之上的叠加）", () => {
  const record = view({
    query: { statusCategory: "started", priority: "all" },
    display: {
      viewMode: "list",
      grouping: "statusCategory",
      sortBy: "title",
      sortDirection: "asc",
    },
  });
  const opened = workItemViewSeed(record);
  const locallyAdjusted = applyWorkItemSurfaceIntent(
    applyWorkItemSurfaceIntent(opened.surface, { kind: "setView", view: "table" }),
    { kind: "toggleColumn", column: "creator" },
  );
  assert.notDeepEqual(locallyAdjusted, opened.surface, "本地确实改了（前提成立）");
  assert.deepEqual(
    workItemViewSeed(record).surface,
    opened.surface,
    "重开回定义态：本地调整只活在这一轮打开期间，定义（服务端那份）一个字没动",
  );
  assert.deepEqual(record.query, { statusCategory: "started", priority: "all" });
  assert.deepEqual(record.display, {
    viewMode: "list",
    grouping: "statusCategory",
    sortBy: "title",
    sortDirection: "asc",
  });
});

// ---------- ④ 视图条投影：内建锚 + 可见视图 + 权限（编辑禁用 / 删除不渲染） ----------

test("视图条｜标签投影：内建锚恒第一枚（不可隐藏不可删）+ 保存视图同列，归属取读面的 ownedByViewer", () => {
  const tabs = workItemViewTabs({
    views: [
      view({ id: "view-mine", name: "我的", ownedByViewer: true }),
      view({
        id: "view-shared",
        name: "别人的共享",
        owner: { kind: "human", id: "other" },
        visibility: "workspace",
        ownedByViewer: false,
      }),
    ],
  });
  assert.deepEqual(
    tabs.map((tab) => [tab.id, tab.name, tab.builtin, tab.ownership]),
    [
      [WORK_ITEM_VIEW_ANCHOR_ID, "", true, "unknown"],
      ["view-mine", "我的", false, "mine"],
      ["view-shared", "别人的共享", false, "other"],
    ],
    "内建锚在第一枚（默认落地态），保存视图按列表次序（created_at ASC，repo 给的），" +
      "ownership = 归属三态（管理权的唯一判据）= 读面带回的 `ownedByViewer`",
  );
  assert.equal(tabs[0]!.nameId, "squad.workItems.filter.all", "内建锚的文案复用既有的「全部」键");
  assert.deepEqual(workItemViewTabActions(tabs[1]!), { canManage: true }, "自己的视图：可编辑可删");
  assert.deepEqual(
    workItemViewTabActions(tabs[2]!),
    { canManage: false },
    "别人的共享视图：看得见但改不动（编辑置灰、删除不渲染）—— T-P2-V §9-2「权限镜像未点亮」的那一格",
  );
  // 读面**没带回归属**（记录没有这一位）⇒ 不可判定：界面按「服务面是权威」渲染，不猜一个 owner 出来。
  const unknown = workItemViewTabs({ views: [view({ id: "view-x" })] });
  assert.deepEqual(
    unknown.map((tab) => tab.ownership),
    ["unknown", "unknown"],
    "归属缺席 ⇒ 不可判定（D1-A 的既定纪律：UI 不自造身份）",
  );
  assert.deepEqual(
    workItemViewTabActions(unknown[1]!),
    { canManage: null },
    "不可判定 ⇒ canManage = null（调用方按「服务面是权威」处理，不是按「不是我的」处理）",
  );
  assert.deepEqual(
    workItemViewTabActions(tabs[0]!),
    { canManage: false },
    "内建锚不是一条可管理的记录（它是默认落地态，没有编辑/删除面）",
  );
});

/* `(kind, id)` 两列的 owner 比对**不再在 UI 侧**（T-P2-V §9-2 的修补：UI 没有身份链，自造一份比对
   就等于第二份判据）—— 判据上移到读面：repo 按注入身份现场算 `ownedByViewer`，服务面列表逐行带回。
   相应的逐格用例在 services 侧（`workItemViewService.test.ts` B1b + `workItemViewRepo.test.ts` 的
   listVisible 归属用例），本文件只钉「投影消费这一位」。 */

// ---------- ⑤ 视图消失（删 / 无权）⇒ 退出到默认标签 + 提示 ----------

test("视图消失｜列表回读后当前视图不在列表里 ⇒ 退回内建锚并**报一次**缺失", () => {
  const listed = view({ id: "view-1" });
  assert.deepEqual(
    workItemViewListAfterLoad({ views: [listed], activeViewId: "view-1" }),
    { views: [listed], activeViewId: "view-1", missing: false },
    "仍在列表里 ⇒ 打开态不变（列表回读不得重置正在看的视图）",
  );
  assert.deepEqual(
    workItemViewListAfterLoad({ views: [listed], activeViewId: "view-gone" }),
    { views: [listed], activeViewId: null, missing: true },
    "被删 / 无权（list 已滤）⇒ 退出到默认标签，并让调用方提示一次",
  );
  assert.deepEqual(
    workItemViewListAfterLoad({ views: [listed], activeViewId: null }),
    { views: [listed], activeViewId: null, missing: false },
    "本来就没打开视图 ⇒ 不提示（默认标签不是「消失的视图」）",
  );
});

// ---------- ⑥ 手动顺序只在 statusCategory 分组下暴露（lane=assignee 不给 Manual） ----------

test("手动顺序｜可用排序档：assignee 分组不给 Manual，其余分组（含不分组）全给", () => {
  assert.deepEqual(
    workItemSortKeysForLaneDimension("assignee"),
    ["priority", "startDate", "dueDate", "title"],
    "按指派分组不暴露 Manual（position 是全库一段、不按 assignee 分列，拖拽改序在这一维没有意义）",
  );
  for (const dimension of ["none", "statusCategory"] as const) {
    assert.deepEqual(
      workItemSortKeysForLaneDimension(dimension),
      ["manual", "priority", "startDate", "dueDate", "title"],
      `${dimension} 分组保留 Manual（R1 的默认档，也是不分组下的既有行序）`,
    );
  }
});

test("手动顺序｜hydrate：切到 assignee 分组时手动档**强制回落**（控件里没有的档不能留在状态里）", () => {
  const manual = workItemViewSeed(view()).surface;
  assert.equal(manual.sort.key, "manual", "默认态是手动档（前提成立）");
  assert.deepEqual(
    normalizeWorkItemSurfaceForLaneDimension(manual, "assignee").sort,
    { key: "startDate", direction: "desc" },
    "回落档取清单里语义最近的时间档（multica 是 created_at desc；本仓没有 created_at 排序键 ⇒ " +
      "取 startDate + 倒序，同为「新的在前」）—— 否则下拉会显示一个它自己列不出来的值",
  );
  assert.deepEqual(
    normalizeWorkItemSurfaceForLaneDimension(manual, "statusCategory"),
    manual,
    "statusCategory 分组不会被动到（手动档在它那里可用）",
  );
  const chosen = applyWorkItemSurfaceIntent(manual, { kind: "setSortKey", key: "title" });
  assert.deepEqual(
    normalizeWorkItemSurfaceForLaneDimension(chosen, "assignee"),
    chosen,
    "已经选了非手动档 ⇒ 原样保留（回落只发生在「档位不可用」这一格）",
  );
});

test("手动顺序｜拖拽只在「看板 + statusCategory 分组 + 手动档 + 有写入口」时启用", () => {
  const base = {
    view: "board",
    laneDimension: "statusCategory",
    sortKey: "manual",
    hasWriter: true,
  } as const;
  assert.equal(workItemBoardReorderEnabled(base), true, "看板 + 状态分组 + 手动档 ⇒ 可拖拽");
  assert.equal(
    workItemBoardReorderEnabled({ ...base, laneDimension: "assignee" }),
    false,
    "按指派分组不给拖拽（验收 5）",
  );
  assert.equal(
    workItemBoardReorderEnabled({ ...base, laneDimension: "none" }),
    false,
    "不分组时没有「列内」可言（position 次序在单列里就是全局序，改它等于没有落点）",
  );
  assert.equal(
    workItemBoardReorderEnabled({ ...base, view: "list" }),
    false,
    "list / table 视图不接线拖拽（行模块的把手只由看板注入）",
  );
  assert.equal(
    workItemBoardReorderEnabled({ ...base, sortKey: "title" }),
    false,
    "排序不是手动档时拖拽会让界面次序与写下的 position 对不上（禁止「拖了看不出变化」）",
  );
  assert.equal(
    workItemBoardReorderEnabled({ ...base, hasWriter: false }),
    false,
    "页面没接写入口 ⇒ 不给把手（点得动但写不下去的入口比没有更糟）",
  );
});

// ---------- ⑦ 表单判据（名字 / 可见性）与管理面板投影 ----------

test("表单｜名字：trim 后取 1..80 **码点**（与服务面同一把尺子），空白/超长 ⇒ 不可提交", () => {
  assert.equal(workItemViewNameSubmitValue("  我的视图  "), "我的视图", "首尾空白不进定义");
  assert.equal(
    workItemViewNameSubmitValue("   "),
    null,
    "只有空白 ⇒ 不可提交（不是「叫空格的名字」）",
  );
  assert.equal(workItemViewNameSubmitValue(""), null, "空名 ⇒ 不可提交");
  assert.equal(
    workItemViewNameSubmitValue("甲".repeat(80)),
    "甲".repeat(80),
    "80 个码点（不是 UTF-16 长度）恰好合法 —— 与 DDL 的 length(name) 同一把尺子",
  );
  assert.equal(workItemViewNameSubmitValue("甲".repeat(81)), null, "81 个码点 ⇒ 不可提交");
  assert.equal(
    workItemViewNameSubmitValue("😀".repeat(80)),
    "😀".repeat(80),
    "代理对（emoji）按码点计：80 个 emoji 合法（按 UTF-16 会误判成 160 ⇒ 用户存不下服务面允许的名字）",
  );
});

test("表单｜可见性：勾选 = workspace 共享；`my` 档的视图恒私有（控件不出现，而不是出现后被拒）", () => {
  assert.equal(workItemViewVisibilityOf(true), "workspace", "勾选共享 ⇒ visibility=workspace");
  assert.equal(workItemViewVisibilityOf(false), "private", "不勾 ⇒ private（服务端缺省同值）");
  assert.equal(workItemViewSharedOf("workspace"), true);
  assert.equal(workItemViewSharedOf("private"), false);
  assert.equal(
    workItemViewVisibilityLocked({ scopeType: "my", shared: false }),
    true,
    "my 档（我的视角）恒私有 ⇒ 可见性控件**不渲染**（服务面 patch 会响亮拒绝非 private）",
  );
  assert.equal(
    workItemViewVisibilityLocked({ scopeType: "workspace", shared: true }),
    false,
    "workspace 档的视图可以在私有/共享之间改",
  );
});

test("管理面板｜行投影：每行带记录 + 标签 + 管理权（三处共用同一份判据）", () => {
  const mine = view({ id: "view-mine", name: "我的", ownedByViewer: true });
  const other = view({
    id: "view-other",
    name: "别人的",
    owner: { kind: "human", id: "other" },
    visibility: "workspace",
    ownedByViewer: false,
  });
  assert.deepEqual(
    workItemViewManageRows({ views: [mine, other] }).map((row) => [
      row.view.id,
      row.tab.name,
      row.canManage,
    ]),
    [
      ["view-mine", "我的", true],
      ["view-other", "别人的", false],
    ],
    "管理面板只列**可见**视图（list 已滤），每行给出管理权（编辑禁用 / 删除不渲染的判据）：" +
      "他人的共享视图 = false —— R6b 已实现的那两个 UI 分支由此从不可达变为可达",
  );
  assert.deepEqual(
    workItemViewManageRows({ views: [view({ id: "view-x" })] }).map((row) => row.canManage),
    [null],
    "读面没带回归属 ⇒ canManage = null（面板同样按「服务面是权威」处理）",
  );
});
