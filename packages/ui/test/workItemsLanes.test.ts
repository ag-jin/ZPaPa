import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  WORK_ITEM_STATUS_CATEGORY,
  type Squad,
  type TeamAgent,
  type WorkItem,
  type WorkItemStatusCategory,
  type WorkItemStatusKey,
} from "@zcode/shared";
import enUS from "../src/i18n/locales/en-US.js";
import zhCN from "../src/i18n/locales/zh-CN.js";
import {
  WORK_ITEM_STATUS_CATEGORY_MESSAGE_IDS,
  flattenWorkItemBoard,
  groupWorkItemBoard,
  workItemLaneAssigneeName,
} from "../src/squad/workItemsViewModel.js";

/* 「看板泳道」（欠账 #15，2026-10-07 裁定 Q2/Q3/Q4）的用例：分组纯函数逐格 + 结构守卫 + i18n 成对。

   本轮的**核心约束**（拆解 §5.1，两条被否决的方案在这里被钉死）：
   · 泳道**只切根**、子树整体随根落位 —— 按行自身状态分组会把一个批次劈成几条泳道（否决）；
   · 状态维度只认 **4 category**，不认 6 键 —— category 才是机器判定依据（键只是标签）。

   为什么分组也要在纯函数里：看板是「树 + 分组」两个投影的合成，组件里算 = 不可测；
   而判据分叉不报错（错的泳道看起来只是「分组有点怪」）。 */

// ---------- 夹具 ----------

const wi = (
  id: string,
  parentId?: string,
  status: WorkItemStatusKey = "todo",
  assignee: WorkItem["assignee"] = { type: "user", id: "user" },
): WorkItem => ({
  id,
  workspaceIdentity: "id",
  workspacePath: "/w/a",
  ...(parentId === undefined ? {} : { parentId }),
  title: `标题 ${id}`,
  body: "",
  status,
  assignee,
  labels: [],
  properties: {},
  position: 0,
});

const agent = (id: string, name: string): TeamAgent => ({
  id,
  name,
  systemPrompt: "s",
  skills: [],
  memoryScope: "project",
  enabled: true,
});

const squad = (id: string, name: string): Squad => ({
  id,
  name,
  leaderAgentId: "ta-1",
  members: [],
  instructions: {},
  enabled: true,
});

const roster = {
  teamAgents: [agent("ta-1", "队长"), agent("ta-2", "队员")],
  squads: [squad("sq-1", "小队甲")],
};

const plan = (
  items: WorkItem[],
  dimension: Parameters<typeof groupWorkItemBoard>[0]["dimension"],
) =>
  groupWorkItemBoard({ items, dimension, roster }).map((lane) => ({
    key: lane.key,
    count: lane.count,
    rows: lane.rows.map((row) => [row.item.id, row.depth]),
  }));

// ---------- ① none：与 flattenWorkItemBoard 逐格等价 ----------

/* 变异（L1-3 的纯函数半边）：把 `none` 分支改成「按输入顺序平铺」（不走 DFS）⇒ 下面第一、二条必红。 */
test("分组｜none 与 flattenWorkItemBoard 逐格等价（父子 / 孙 / 孤儿当根 / 重复 id 全覆写）", () => {
  const items = [wi("p1"), wi("c1", "p1"), wi("g1", "c1"), wi("p2"), wi("orphan", "gone")];
  const lanes = plan(items, "none");
  assert.equal(lanes.length, 1, "none = 单条（看板不画泳道头，DOM 逐字保留现状）");
  assert.deepEqual(
    lanes[0]!.rows,
    flattenWorkItemBoard(items).map((row) => [row.item.id, row.depth]),
    "none 的行序与深度必须与 flattenWorkItemBoard 逐格相同（同一份 DFS 实现）",
  );
  assert.equal(lanes[0]!.count, 5);
});

test("分组｜none 在坏数据下也等价（环与重复 id 不丢行、不死循环）", () => {
  const items = [wi("a", "b"), wi("b", "a"), wi("dup"), wi("dup", "p1"), wi("p1")];
  assert.deepEqual(
    plan(items, "none")[0]!.rows,
    flattenWorkItemBoard(items).map((row) => [row.item.id, row.depth]),
  );
});

test("分组｜空输入 ⇒ 空数组（任何维度都不造空泳道：空态由看板的空态分支负责）", () => {
  assert.deepEqual(groupWorkItemBoard({ items: [], dimension: "none", roster }), []);
  assert.deepEqual(groupWorkItemBoard({ items: [], dimension: "statusCategory", roster }), []);
  assert.deepEqual(groupWorkItemBoard({ items: [], dimension: "assignee", roster }), []);
});

// ---------- ② statusCategory：4 条固定泳道（含空泳道） ----------

/* 变异（L1-1）：分组改用**6 键**（`root.item.status`）⇒ 第一条的泳道集合必红（会多出 in_review 等）。 */
test("分组｜statusCategory：固定 4 条泳道（骨架不随数据跳动），空的保留为 0", () => {
  const lanes = plan([wi("done-1", undefined, "done")], "statusCategory");
  assert.deepEqual(
    lanes.map((lane) => [lane.key, lane.count]),
    [
      ["unstarted", 0],
      ["started", 0],
      ["done", 1],
      ["closed", 0],
    ],
    "顺序是固定骨架 unstarted → started → done → closed；空泳道显示 0（不消失）",
  );
});

/* 变异（L1-2，**核心**）：按**行自身**状态落位 ⇒ 子项 c1（in_progress）会掉进 started 泳道，
   第一条断言（c1 在 root 的泳道里）必红；按 6 键分组同样在这里暴露。 */
test("分组｜statusCategory 只切根：子项状态与根不同，也留在根的泳道里（深度不变）", () => {
  const items = [
    wi("root", undefined, "todo"),
    wi("child", "root", "in_progress"),
    wi("grand", "child", "done"),
    wi("other", undefined, "in_progress"),
  ];
  const lanes = plan(items, "statusCategory");
  assert.deepEqual(
    lanes[0]!.rows,
    [
      ["root", 0],
      ["child", 1],
      ["grand", 2],
    ],
    "根在 unstarted ⇒ 整棵子树跟着它",
  );
  assert.deepEqual(lanes[1]!.rows, [["other", 0]], "另一个根按自己的 category 落位");
  assert.deepEqual(lanes[2]!.rows, [], "done 泳道是空的：子项 grand 虽是 done，也不自成泳道");
});

test("分组｜statusCategory：同一泳道内多个根按输入顺序（不重排）", () => {
  const lanes = plan(
    [wi("b", undefined, "in_progress"), wi("a", undefined, "in_progress")],
    "statusCategory",
  );
  assert.deepEqual(
    lanes[1]!.rows,
    [
      ["b", 0],
      ["a", 0],
    ],
    "泳道内次序 = 输入次序（repo 已排好）",
  );
});

/* category 是机器判据：6 个状态键必须各自落到它的 category 泳道；写死键名会让
   in_review / blocked 这类「看起来像别的 category」的键静默落错泳道。 */
test("分组｜6 个状态键各自落进 WORK_ITEM_STATUS_CATEGORY 指出的泳道", () => {
  const items = (Object.keys(WORK_ITEM_STATUS_CATEGORY) as WorkItemStatusKey[]).map((status) =>
    wi(`wi-${status}`, undefined, status),
  );
  const lanes = groupWorkItemBoard({ items, dimension: "statusCategory", roster });
  for (const lane of lanes) {
    const expected = items.filter(
      (item) => WORK_ITEM_STATUS_CATEGORY[item.status] === (lane.key as WorkItemStatusCategory),
    );
    assert.deepEqual(
      lane.rows.map((row) => row.item.id),
      expected.map((item) => item.id),
      `泳道 ${lane.key} 的内容必须由 category 判定给出`,
    );
  }
});

// ---------- ③ assignee：user 首条 + 首现顺序 ----------

test("分组｜assignee：`user` 固定第一条，agent / squad 按首现顺序，无空泳道", () => {
  const items = [
    wi("a", undefined, "todo", { type: "agent", id: "ta-2" }),
    wi("b", undefined, "todo", { type: "user", id: "user" }),
    wi("c", undefined, "todo", { type: "squad", id: "sq-1" }),
    wi("d", undefined, "todo", { type: "agent", id: "ta-2" }),
  ];
  assert.deepEqual(
    plan(items, "assignee").map((lane) => [lane.key, lane.count]),
    [
      ["user", 1],
      ["agent:ta-2", 2],
      ["squad:sq-1", 1],
    ],
    "我第一条（固定），其余按首次出现的对象顺序 —— 不按名字/locale 排序（那是另一个真相源）",
  );
});

test("分组｜assignee：子树随根落位（子项指派给别的对象也不自成泳道）", () => {
  const items = [
    wi("root", undefined, "todo", { type: "user", id: "user" }),
    wi("child", "root", "todo", { type: "agent", id: "ta-2" }),
  ];
  const lanes = plan(items, "assignee");
  assert.deepEqual(
    lanes.map((lane) => lane.key),
    ["user"],
    "泳道集合只看根",
  );
  assert.deepEqual(lanes[0]!.rows, [
    ["root", 0],
    ["child", 1],
  ]);
});

test("分组｜assignee：未知 id 原样成泳道（不合并、不消失），无数据的对象不产生空泳道", () => {
  const items = [wi("a", undefined, "todo", { type: "agent", id: "gone-agent" })];
  assert.deepEqual(
    plan(items, "assignee").map((lane) => lane.key),
    ["agent:gone-agent"],
  );
  const lanes = groupWorkItemBoard({ items, dimension: "assignee", roster });
  assert.deepEqual(
    workItemLaneAssigneeName(roster, { type: "agent", id: "gone-agent" }),
    { name: "gone-agent", known: false },
    "名册里没有 ⇒ 显示 id + 一个「已不在名册」后缀（不显示空 —— 空会被读成「没指派」）",
  );
  assert.deepEqual(
    lanes.map((lane) => lane.count),
    [1],
  );
});

// ---------- ④ 确定性 ----------

/* 变异（L1-4）：泳道顺序改成按名册名 / locale 排序 ⇒ 第二条必红（它构造的正是「名字序 ≠ 首现序」）。 */
test("分组｜确定性：两次调用逐字一致；泳道顺序按**首现**而不是按名字排序", () => {
  const items = [
    wi("a", undefined, "todo", { type: "agent", id: "ta-2" }), // 名字「队员」
    wi("b", undefined, "todo", { type: "user", id: "user" }),
    wi("c", undefined, "todo", { type: "agent", id: "ta-1" }), // 名字「队长」
  ];
  assert.deepEqual(plan(items, "assignee"), plan(items, "assignee"), "两次调用逐字相同");
  assert.deepEqual(
    plan(items, "assignee").map((lane) => lane.key),
    ["user", "agent:ta-2", "agent:ta-1"],
    "首现先后决定泳道次序（队员先出现 ⇒ 排在队长之前）；按名字/locale 排序会让顺序随改名漂移",
  );
  assert.deepEqual(plan(items, "statusCategory"), plan(items, "statusCategory"));
});

test("分组｜确定性：泳道内项的先后变化（同泳道内）不改变泳道顺序", () => {
  const items = [
    wi("a", undefined, "todo", { type: "agent", id: "ta-1" }),
    wi("b", undefined, "todo", { type: "user", id: "user" }),
    wi("c", undefined, "todo", { type: "agent", id: "ta-1" }),
  ];
  const swapped = [items[0]!, items[2]!, items[1]!];
  assert.deepEqual(
    plan(swapped, "assignee").map((lane) => lane.key),
    plan(items, "assignee").map((lane) => lane.key),
    "同泳道内换序只改行内次序，不改泳道次序",
  );
  assert.deepEqual(
    groupWorkItemBoard({ items: swapped, dimension: "assignee", roster })
      .find((lane) => lane.key === "agent:ta-1")!
      .rows.map((row) => row.item.id),
    ["a", "c"],
    "泳道内次序 = 输入次序（本函数不重排）",
  );
});

// ---------- ⑤ 泳道名（category 文案穷尽 + 指派名回落） ----------

test("分组｜category 泳道名穷尽 4 值（加 category 会编译失败）", () => {
  assert.deepEqual(Object.keys(WORK_ITEM_STATUS_CATEGORY_MESSAGE_IDS).sort(), [
    "closed",
    "done",
    "started",
    "unstarted",
  ]);
  for (const messageId of Object.values(WORK_ITEM_STATUS_CATEGORY_MESSAGE_IDS)) {
    assert.ok(messageId.startsWith("squad.workItems.lane.statusCategory."), messageId);
  }
});

test("指派泳道名：user 为 null（由本地化文案补）、已知对象给名字、未知回落 id", () => {
  assert.deepEqual(workItemLaneAssigneeName(roster, { type: "user", id: "user" }), {
    name: null,
    known: true,
  });
  assert.deepEqual(workItemLaneAssigneeName(roster, { type: "agent", id: "ta-2" }), {
    name: "队员",
    known: true,
  });
  assert.deepEqual(workItemLaneAssigneeName(roster, { type: "squad", id: "sq-1" }), {
    name: "小队甲",
    known: true,
  });
  assert.deepEqual(workItemLaneAssigneeName(roster, { type: "squad", id: "gone" }), {
    name: "gone",
    known: false,
  });
});

// ---------- ⑥ 结构守卫 ----------

const SRC_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "../src");
const readSource = (relativePath: string) => readFileSync(resolve(SRC_DIR, relativePath), "utf8");

/* 守卫 a（L1-5，**核心**，T-P2-R1 口径更新）：行渲染**单点**。
   旧口径是「`WorkItemsBoard` 内恰一处 renderRow」；阶段二起三个视图（board / list / table）与
   看板的两个分支（不分组 / 泳道）都渲染**同一批行**，所以口径改为：
   **行模块里各恰一处，且四个消费点全部走共用列表组件**。
   复制一份行渲染能通过 typecheck，却会让 `rowElementsRef` 在其中一条路径上静默不注册 ⇒
   收件箱「打开工作项」的聚焦/高亮失败且不报错。
   变异：把行 JSX 复制一份给某个视图/分支用 ⇒ 第一、二、三条必红。 */
test("守卫｜行渲染单点（口径更新）：锚点与聚焦注册各恰一处，且看板两分支与三视图共用同一模块", () => {
  const board = readSource("squad/WorkItemsBoard.tsx");
  const rows = readSource("squad/WorkItemRows.tsx");
  assert.equal(
    (rows.match(/data-work-item-id=\{item\.id\}/g) ?? []).length,
    1,
    "行 JSX 只能有一处（复制一份行渲染 = 聚焦/高亮在某条路径上静默失效）",
  );
  assert.equal(
    (rows.match(/rowElementsRef\.current\.set\(/g) ?? []).length,
    1,
    "行 DOM 引用注册只此一处（所有视图共用它）",
  );
  // 看板的两个分支都要走共用列表（不得自己 map 出行），三视图模块也各自消费它。
  assert.equal(
    (board.match(/<WorkItemRowList/g) ?? []).length,
    2,
    "不分组与泳道两个分支共用同一个列表组件（两次挂载、同一份实现）",
  );
  for (const file of [
    "squad/WorkItemsSurface.tsx",
    "squad/WorkItemListView.tsx",
    "squad/WorkItemTableView.tsx",
  ]) {
    assert.ok(
      readSource(file).includes("WorkItemRow"),
      `${file} 必须消费共用行模块（三视图共用同一模块）`,
    );
  }
  const listTag = board.indexOf('data-testid="work-items-list"');
  const laneTag = board.indexOf('data-testid="work-items-lane"');
  assert.ok(listTag > 0 && laneTag > 0, "none 分支与泳道分支都要有各自的容器锚点");
  const rowsTag = rows.indexOf("data-testid={testId}");
  assert.ok(rowsTag > 0, "行列表的 testid 由消费方给（容器锚点仍是各视图的属性）");
});

test("守卫｜none 分支保留现状 DOM（单 ul），泳道分支带 data-lane-key；泳道不做折叠", () => {
  const board = readSource("squad/WorkItemsBoard.tsx");
  assert.ok(
    board.includes('laneDimension === "none"'),
    "必须显式分叉：不分组走现状 DOM，不得把现状也塞进泳道壳",
  );
  assert.ok(board.includes("data-lane-key={lane.key}"), "泳道容器要带 lane key 锚点");
  for (const forbidden of ["collapsed", "laneExpanded", "setLaneCollapsed"]) {
    assert.ok(!board.includes(forbidden), `泳道 v1 不做折叠（${forbidden} 说明有人顺手加了）`);
  }
  /* 批根判据的输入只算一次（T-P2-R1：随行列表实现搬进 `WorkItemRowList`，每张列表算一次，
     仍**不在行内**重算）；变异：搬进行渲染里 ⇒ 每行各算一遍（行数 × run 数的无谓重复）。 */
  const board2 = readSource("squad/WorkItemRows.tsx");
  assert.equal(
    (board2.match(/snapshot\.runs\.map\(/g) ?? []).length,
    1,
    "runParentWorkItemIds 只算一次（在 WorkItemRowList 里，不在行内逐行重算）",
  );
  assert.ok(
    board2.includes("const runParentWorkItemIds = useMemo("),
    "那份输入在行列表里一次算好（memo 挂在列表上）",
  );
});

test("守卫｜维度是闭集、默认不分组、选择器接线到 Actions 与 Board", () => {
  const viewModel = readSource("squad/workItemsViewModel.ts");
  assert.ok(
    viewModel.includes('"none" | "statusCategory" | "assignee"'),
    "维度集合是闭集（加维度必须改类型 ⇒ 编译期拖出全部消费点）",
  );
  assert.ok(
    !/statusCategory[\s\S]{0,200}(in_review|blocked)\b/.test(viewModel),
    "状态分组只认 4 category，不得出现 6 键字面量",
  );
  const page = readSource("squad/WorkItemsPage.tsx");
  assert.ok(
    page.includes('useState<WorkItemLaneDimension>("none")'),
    "默认维度是 none（给出泳道 ≠ 换掉看板：既有用户看到的界面零变化）",
  );
  assert.ok(page.includes("laneDimension={laneDimension}"), "页面把维度传给看板");
  /* T-P2-R6b 口径更新：选择器接线从 `setLaneDimension` 直连改成页面的 `changeLaneDimension`
     （**换维度要先把排序档归一到新维度下可用的档** —— 手动档在按指派分组下不可用）。
     断言因此要求：接线到页面那一处 + 那一处真的调归一纯函数（不得在组件里自己归一）。 */
  assert.ok(
    page.includes("onLaneDimensionChange={viewsBridge.changeLaneDimension}"),
    "选择器接线回页面状态",
  );
  assert.ok(
    readSource("squad/useWorkItemsViewsBridge.ts").includes(
      "normalizeWorkItemSurfaceForLaneDimension(",
    ),
    "换维度必须经归一纯函数（否则控件里会留一个它自己列不出来的排序档）",
  );
  const actions = readSource("squad/WorkItemsPageActions.tsx");
  assert.ok(actions.includes('data-testid="work-items-lane-dimension"'), "选择器 testid 锚点");
  /* T-P2-R6b 口径更新：维度文案映射从 Actions 文件搬到**词汇层**（`workItemsViewModel`）——
     保存视图的 display 摘要（T-P2-R6b 的对话框）也要按它渲染用户能读的词，两份映射迟早分叉。
     断言因此分两处：键在词汇层**齐三档**，且选择器**真的消费**那一份映射（不抄第二份）。 */
  const vocabulary = readSource("squad/workItemsViewModel.ts");
  for (const option of [
    "squad.workItems.lane.dimension.none",
    "squad.workItems.lane.dimension.statusCategory",
    "squad.workItems.lane.dimension.assignee",
  ]) {
    assert.ok(vocabulary.includes(option), `维度文案必须给「${option}」这一项`);
  }
  assert.ok(
    actions.includes("WORK_ITEM_LANE_DIMENSION_MESSAGE_IDS"),
    "选择器必须消费词汇层那一份映射（不得自带第二份维度文案）",
  );
});

test("守卫｜workItemsViewModel 只有一份根判据 / DFS（不得出现第二份 parentId 判据）", () => {
  const viewModel = readSource("squad/workItemsViewModel.ts");
  assert.ok(
    (viewModel.match(/item\.parentId === undefined \|\| !byId\.has\(item\.parentId\)/g) ?? [])
      .length === 1,
    "根判据只此一处（分组与压平共用同一份实现）",
  );
});

// ---------- ⑦ i18n 成对 ----------

test("守卫｜泳道文案两语成对（含占位符一致）", () => {
  const placeholders = (value: string) =>
    [...value.matchAll(/\{(\w+)\}/g)]
      .map((match) => match[1])
      .sort()
      .join(",");
  for (const key of [
    "squad.workItems.lane.dimension",
    "squad.workItems.lane.dimension.none",
    "squad.workItems.lane.dimension.statusCategory",
    "squad.workItems.lane.dimension.assignee",
    "squad.workItems.lane.statusCategory.unstarted",
    "squad.workItems.lane.statusCategory.started",
    "squad.workItems.lane.statusCategory.done",
    "squad.workItems.lane.statusCategory.closed",
    "squad.workItems.lane.assignee.user",
    "squad.workItems.lane.assignee.unknownSuffix",
    "squad.workItems.lane.count",
  ]) {
    const zh = zhCN[key];
    const en = enUS[key];
    assert.ok(zh, `中文缺 ${key}`);
    assert.ok(en, `英文缺 ${key}`);
    assert.equal(placeholders(zh), placeholders(en), `${key} 的占位符两语必须一致`);
  }
});
