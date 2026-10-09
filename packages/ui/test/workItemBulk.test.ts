import assert from "node:assert/strict";
import test from "node:test";
import {
  WORK_ITEM_LABEL_MAX_COUNT,
  WORK_ITEM_LABEL_MAX_LENGTH,
  type WorkItem,
} from "@zcode/shared";
import { SQUAD_DISPATCH_DISABLED_CODE } from "@zcode/services";
import {
  WORK_ITEM_BULK_FIELDS,
  WORK_ITEM_BULK_FIELD_MESSAGE_IDS,
  applyWorkItemBulkDraftIntent,
  executeWorkItemBulkEdit,
  workItemBulkClearSelection,
  workItemBulkDefaultDraft,
  workItemBulkPlan,
  workItemBulkReconcileSelection,
  workItemBulkSelectable,
  workItemBulkSelectionAfterApply,
  workItemBulkSelectionEquals,
  workItemBulkToggleSelection,
  resolveWorkItemBulkEdit,
} from "../src/squad/workItemBulkViewModel.js";
import { WORK_ITEM_PRIORITY_CLEAR_VALUE } from "../src/squad/workItemInlineEditViewModel.js";

/* 工作项**批量工具栏**（阶段二 · T-P2-R5）的纯判据：选择集口径 / 可批量字段 / 结果汇总。

   为什么这些必须是纯函数（与 `workItemSurfaceViewModel` / `workItemSurfaceControlsViewModel`
   同一理由）：本包没有渲染测试设施，判据写进组件就等于不可测；而批量这一面的坏法全是**静默**的 ——
   选择集在过滤/搜索变化后仍留着用户**看不见的行**（点"应用到已选"会改到屏幕外的数据）、
   行选择控件的可用判据与行内编辑各写一份（归档行在一处能选、在另一处不能写，两边都不报错）。

   期望值的独立真源：拆解卡 §阶段二 T-P2-R5 的验收 1/2 + R4 的置灰口径 + 行内编辑既有的
   「归档行不给写入口」（`workItemInlineEditUnavailableReason`）—— 下面用手写字面量钉住，
   不从实现反推。 */

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

// ---------- ① 可批量写的行：判据复用「这一行给不给写入口」 ----------

/* 归档行不给批量写入口 —— 判据**复用**行内编辑那一份（`workItemInlineEditUnavailableReason`
   → `writeDisabledReason`），本轮不写第二份 `archivedAt !== undefined`。
   变异：本地重写归档判据（或漏掉它）⇒ 本用例第二条必红：界面给得出、服务面必拒（写库未命中
   ⇒ 响亮抛），失败会被当成"操作失败"而不是"这行不能改"。 */
test("可批量写的行：未归档可写；已归档不可写（与行内编辑入口同一份判据）", () => {
  assert.equal(
    workItemBulkSelectable(wi("wi-open")),
    true,
    "普通行可写（批量写与行内编辑同一条写路径）",
  );
  assert.equal(
    workItemBulkSelectable(wi("wi-archived", { archivedAt: 7 })),
    false,
    "归档行不可写：服务面 updateWorkItem 对归档行响亮抛，界面不该给一个必然失败的勾选件",
  );
});

// ---------- ② 选择集：勾选 / 取消 / 清空（保序） ----------

test("选择集：勾选追加在末尾、再勾取消、清空回空数组（勾选顺序 = 呈现/写入顺序）", () => {
  const first = workItemBulkToggleSelection({ selected: [], workItemId: "b" });
  assert.deepEqual(first, ["b"], "首次勾选 = 单元素");
  const second = workItemBulkToggleSelection({ selected: first, workItemId: "a" });
  assert.deepEqual(second, ["b", "a"], "追加在末尾（不排序：勾选顺序是用户的操作顺序）");
  assert.deepEqual(
    workItemBulkToggleSelection({ selected: second, workItemId: "b" }),
    ["a"],
    "再勾一次 = 取消，其余项**保持原序**（不因为移除而重排）",
  );
  assert.deepEqual(
    workItemBulkToggleSelection({
      selected: workItemBulkToggleSelection({ selected: second, workItemId: "b" }),
      workItemId: "b",
    }),
    ["a", "b"],
    "往返一次回到同一**集合**（开关语义）；次序按「追加在末尾」那条规则走 —— " +
      "取消后再勾等于重新勾选一次，落在末尾（不记忆旧位次：记忆会让结果列表与操作顺序对不上）",
  );
  assert.deepEqual(workItemBulkClearSelection(), [], "清空 = 空数组");
  const input = ["b", "a"];
  workItemBulkToggleSelection({ selected: input, workItemId: "c" });
  assert.deepEqual(input, ["b", "a"], "入参不得被就地改写（React 状态是可变引用）");
});

// ---------- ③ 选择集在过滤/搜索变化时的口径（承重验收 2） ----------

/* **口径（显式钉住）**：选择集**收敛到当前可见集 ∩ 可写行**，不保留屏幕外的 id。
   为什么不是「保留、等它回来」：批量写会落到用户**看不见的行**上（"应用到已选"改到了被筛掉的
   数据），而且没有人会知道；为什么不整份清空：同一份可见集在快照回读后**内容不变**，
   整份清空会让用户刚勾好的一批在每次刷新后无声消失（重勾一遍，且不知道为什么）。

   期望值手写（独立于实现）：可见 = {b, c}、已选 = {a, b, d} ⇒ 收敛 = {b}。 */
test("选择集收敛：留可见 ∩ 可写、丢屏幕外的 id、保序（跨过滤不漂移）", () => {
  const visible = [wi("b"), wi("c"), wi("d")];
  assert.deepEqual(
    workItemBulkReconcileSelection({ selected: ["a", "b", "d"], visible }),
    ["b", "d"],
    "被筛掉（a 不在可见集里）⇒ 收敛掉；仍可见的保持原文次序",
  );
  assert.deepEqual(
    workItemBulkReconcileSelection({ selected: ["d", "b", "c"], visible }),
    ["d", "b", "c"],
    "顺序 = 选择集自己的次序（不按可见集重排：勾选顺序是操作事实）",
  );
  assert.deepEqual(
    workItemBulkReconcileSelection({ selected: ["a"], visible }),
    [],
    "全被筛掉 ⇒ 空（绝不能带着屏幕外的 id 去写库）",
  );
  assert.deepEqual(
    workItemBulkReconcileSelection({ selected: ["b", "c"], visible: [] }),
    [],
    "「无匹配」态下选择集为空（批量入口此时没有作用对象）",
  );
  assert.deepEqual(
    workItemBulkReconcileSelection({
      selected: ["b", "c"],
      visible: [wi("b", { archivedAt: 3 }), wi("c")],
    }),
    ["c"],
    "归档行即使可见也收敛掉（可写判据与勾选件同一份：归档不给写入口）",
  );
  assert.deepEqual(
    workItemBulkReconcileSelection({ selected: ["b"], visible }),
    ["b"],
    "可见集不变 ⇒ 选择集逐字不变（快照回读/后台刷新不该让用户重新勾一遍）",
  );
  const selected = ["b", "a"];
  workItemBulkReconcileSelection({ selected, visible });
  assert.deepEqual(selected, ["b", "a"], "纯函数：入参不得被就地改写");
});

// ---------- ④ 可批量字段：闭集 + 文案（零键增：全部复用既有键） ----------

/* v1 范围由 Q7 裁定：**只覆盖内容型字段**（优先级 / 标签 / 日期）。
   改派与状态**不在**闭集里 —— 改派 = 新派发（会产生 N 次 run / 配额 / 事件），批量状态要逐条
   CAS，两者都要独立裁定。变异：把 status / assignee 塞进闭集 ⇒ 本用例第一条必红。 */
test("可批量字段闭集：恰四枚内容型字段，且文案键全部复用既有键（零键增）", () => {
  assert.deepEqual(
    [...WORK_ITEM_BULK_FIELDS],
    ["priority", "labels", "startDate", "dueDate"],
    "v1 只覆盖内容型字段（改派 / 状态不在闭集里：那是独立裁定）",
  );
  assert.deepEqual(
    Object.keys(WORK_ITEM_BULK_FIELD_MESSAGE_IDS).sort(),
    [...WORK_ITEM_BULK_FIELDS].sort(),
    "字段闭集 == 文案映射键集（漏一枚 ⇒ 那一项没有话可说）",
  );
  assert.deepEqual(
    [...new Set(Object.values(WORK_ITEM_BULK_FIELD_MESSAGE_IDS))].sort(),
    [
      "squad.workItems.dueDate",
      "squad.workItems.labels",
      "squad.workItems.priority",
      "squad.workItems.startDate",
    ],
    "字段名复用既有词汇（同一概念一句话；批量面的键已在 R1 冻结，本阶段零键增）",
  );
});

// ---------- ④b 取值草稿（页面持有；工具栏是受控的） ----------

/* 换字段必须**重置取值**：从「优先级 = 低」切到「标签」，若把 `low` 原样带过去，用户会看到
   自己从没输入过的标签被加到了整批行上 —— 而界面没有任何异常（这是最典型的静默坏法）。
   取值草稿的折叠只有这一处实现（工具栏不自持状态：自持 = 第二份真相，R6 的命名视图也读不到它）。 */
test("取值草稿：换字段 ⇒ 重置为该字段初值；改值 ⇒ 只动值；不改入参", () => {
  const draft = { field: "priority" as const, value: "low" };
  assert.deepEqual(
    applyWorkItemBulkDraftIntent(draft, { kind: "setValue", value: "urgent" }),
    { field: "priority", value: "urgent" },
    "改值只动值（字段不变）",
  );
  assert.deepEqual(
    applyWorkItemBulkDraftIntent(draft, { kind: "setField", field: "labels" }),
    { field: "labels", value: "" },
    "换到标签 ⇒ 取值重置为空文本（不把上一字段的 `low` 当成要加的标签）",
  );
  assert.deepEqual(
    applyWorkItemBulkDraftIntent(
      { field: "labels", value: "回归" },
      { kind: "setField", field: "priority" },
    ),
    { field: "priority", value: WORK_ITEM_PRIORITY_CLEAR_VALUE },
    "换回优先级 ⇒ 取值重置为哨兵（未设置：不把 `回归` 当成档位）",
  );
  assert.deepEqual(draft, { field: "priority", value: "low" }, "纯函数：不改入参");
});

/* 选择集同步的**收敛判据**：页面把状态对齐到投影后的有效集时用它判断"要不要改状态"
   （每帧都 setState 一个新数组 = 无谓重渲染，且会自激成死循环）。 */
test("选择集相等判据：逐项同序才算相等（长度不同 / 次序不同 / 内容不同都不算）", () => {
  assert.equal(workItemBulkSelectionEquals([], []), true);
  assert.equal(workItemBulkSelectionEquals(["a", "b"], ["a", "b"]), true);
  assert.equal(workItemBulkSelectionEquals(["a", "b"], ["b", "a"]), false, "次序不同 ⇒ 不算相等");
  assert.equal(workItemBulkSelectionEquals(["a"], ["a", "b"]), false);
  assert.equal(workItemBulkSelectionEquals(["a", "b"], ["a", "c"]), false);
});

// ---------- ⑤ 取值归一化：判据单源（复用行内编辑/表单那两份纯函数） ----------
/* 取值 → patch 的归一化**不在这里重写**：优先级的闭集判据走 `parseWorkItemSurfaceFields`
   （→ shared 的 `resolveWorkItemPriority`），日期的日历日判据走同一份（→ `resolveWorkItemDateOnly`），
   标签的切分/去重/上限走 shared 的 `parseWorkItemLabels`。本层只做「控件原文 ↔ patch」的翻译。
   变异：在批量面自己写一份闭集/日期正则 ⇒ 与表单分叉（表单收下、批量拒收，或反过来）。 */
test("取值归一化：优先级哨兵 ⇒ 清回未设置、日期空白 ⇒ 清空、坏值**指名**字段（文案键单源）", () => {
  assert.deepEqual(
    workItemBulkDefaultDraft(),
    { field: "priority", value: WORK_ITEM_PRIORITY_CLEAR_VALUE },
    "草稿初值 = 优先级 + **哨兵**（Radix 的 Select 不认空串，且空串 ≠ 未设置）",
  );
  for (const field of ["labels", "startDate", "dueDate"] as const) {
    assert.equal(
      applyWorkItemBulkDraftIntent(workItemBulkDefaultDraft(), { kind: "setField", field }).value,
      "",
      `${field} 的初值是空文本（= 未设置 / 还没输入）`,
    );
  }
  assert.deepEqual(resolveWorkItemBulkEdit({ field: "priority", value: "urgent" }), { kind: "ok" });
  assert.deepEqual(
    resolveWorkItemBulkEdit({ field: "priority", value: WORK_ITEM_PRIORITY_CLEAR_VALUE }),
    { kind: "ok" },
    "哨兵 = 清回未设置（与行内 picker 同一个哨兵常量，两套哨兵会让选中态飘）",
  );
  assert.deepEqual(
    resolveWorkItemBulkEdit({ field: "startDate", value: "" }),
    { kind: "ok" },
    "日期空白 = 清空这一项（与表单「清空输入」同一条口径）",
  );
  assert.deepEqual(resolveWorkItemBulkEdit({ field: "dueDate", value: "2026-12-31" }), {
    kind: "ok",
  });
  assert.deepEqual(
    resolveWorkItemBulkEdit({ field: "startDate", value: "2026-02-30" }),
    {
      kind: "invalid",
      field: "startDate",
      value: "2026-02-30",
      messageId: "squad.workItems.startDateInvalid",
    },
    "坏日历日：指名是哪一项坏了（文案键复用表单那一枚，不共用一个「输入非法」）",
  );
  assert.deepEqual(
    resolveWorkItemBulkEdit({ field: "dueDate", value: "2026/12/31" }),
    {
      kind: "invalid",
      field: "dueDate",
      value: "2026/12/31",
      messageId: "squad.workItems.dueDateInvalid",
    },
    "形状不对（`YYYY/MM/DD`）同样指名 dueDate",
  );
  assert.deepEqual(
    resolveWorkItemBulkEdit({ field: "labels", value: "   " }),
    { kind: "empty" },
    "标签输入为空 ⇒ **没有可应用的内容**（按钮置灰；这不是错误，不该报一句「非法」）",
  );
  assert.deepEqual(
    resolveWorkItemBulkEdit({ field: "labels", value: "P1" }),
    { kind: "ok" },
    "一个标签即可应用",
  );
  assert.deepEqual(
    resolveWorkItemBulkEdit({ field: "labels", value: "x".repeat(WORK_ITEM_LABEL_MAX_LENGTH + 1) }),
    {
      kind: "invalid",
      field: "labels",
      value: "x".repeat(WORK_ITEM_LABEL_MAX_LENGTH + 1),
      messageId: "squad.workItems.labelsTooLong",
      values: { max: WORK_ITEM_LABEL_MAX_LENGTH },
    },
    "单条超长：文案带上限（复用既有键，不静默截断 —— 截断后用户以为写进去了）",
  );
});

// ---------- ⑥ 逐条 patch：按选择次序算，同值行不写（服务面空 patch 会响亮抛） ----------

/* 逐条算出的 patch 形状直接就是服务面 `updateWorkItem` 白名单的子集（页面原样并入请求，
   中间不再有一次字段名映射）；同值行**不写**（服务面「空 patch ⇒ 响亮抛」，而且每次路过都写
   一次库在日志里与真实修改一模一样）。
   期望值手写：以 A / B / C 三条为例，见下逐条断言。 */
test("逐条 patch（优先级/日期）：按选择次序、只给变了的行、同值行进 unchanged", () => {
  const items = [
    wi("a", { priority: "urgent", startDate: "2026-01-01" }),
    wi("b", { priority: "low" }),
    wi("c"),
  ];
  assert.deepEqual(
    workItemBulkPlan({
      items,
      selectedIds: ["c", "a", "b"],
      edit: { field: "priority", value: "low" },
    }),
    {
      targets: [
        { id: "c", title: "标题 c", patch: { priority: "low" } },
        { id: "a", title: "标题 a", patch: { priority: "low" } },
      ],
      unchangedIds: ["b"],
      precheckFailures: [],
    },
    "写序 = 选择次序；b 本来就是 low ⇒ 不写（不是失败）；未设置的 c 也要写",
  );
  assert.deepEqual(
    workItemBulkPlan({
      items,
      selectedIds: ["a", "c"],
      edit: { field: "priority", value: WORK_ITEM_PRIORITY_CLEAR_VALUE },
    }),
    {
      targets: [{ id: "a", title: "标题 a", patch: { priority: null } }],
      unchangedIds: ["c"],
      precheckFailures: [],
    },
    "哨兵 ⇒ patch 里是 null（清回未设置；`undefined` 才是「没提这个字段」）；c 本来就没设置 ⇒ 不写",
  );
  assert.deepEqual(
    workItemBulkPlan({ items, selectedIds: ["a", "c"], edit: { field: "startDate", value: "" } }),
    {
      targets: [{ id: "a", title: "标题 a", patch: { startDate: null } }],
      unchangedIds: ["c"],
      precheckFailures: [],
    },
    "日期空白 = 清空这一项（a 有起始日期 ⇒ 写 null；c 本来就没有 ⇒ 同值不写）",
  );
  assert.deepEqual(
    workItemBulkPlan({
      items,
      selectedIds: ["a", "a"],
      edit: { field: "dueDate", value: "2026-03-09" },
    }).targets,
    [
      { id: "a", title: "标题 a", patch: { dueDate: "2026-03-09" } },
      { id: "a", title: "标题 a", patch: { dueDate: "2026-03-09" } },
    ],
    "选择集是**次序**不是集合（同一 id 出现两次就按两次算）—— 去重是选择集自己的不变式（toggle 保证），" +
      "规划层不做第二次去重（第二处去重 = 两处口径，行为随入口漂移）",
  );
});

test("逐条 patch（标签）：**加**语义逐行合并、已存在的行不动、超上限的行逐条预检失败", () => {
  const saturated = Array.from({ length: WORK_ITEM_LABEL_MAX_COUNT }, (_, i) => `L${i}`);
  const items = [
    wi("a", { labels: ["Bug", "P1"] }),
    wi("b", { labels: ["P1"] }),
    wi("c", { labels: saturated }),
  ];
  assert.deepEqual(
    workItemBulkPlan({
      items,
      selectedIds: ["a", "b", "c"],
      edit: { field: "labels", value: "P1, 回归" },
    }),
    {
      targets: [
        { id: "a", title: "标题 a", patch: { labels: ["Bug", "P1", "回归"] } },
        { id: "b", title: "标题 b", patch: { labels: ["P1", "回归"] } },
      ],
      unchangedIds: [],
      precheckFailures: [
        {
          workItemId: "c",
          title: "标题 c",
          messageId: "squad.workItems.labelsTooMany",
          values: { max: WORK_ITEM_LABEL_MAX_COUNT, count: WORK_ITEM_LABEL_MAX_COUNT + 2 },
        },
      ],
    },
    "标签是**加**：逐行合并去重（a 已有 P1 ⇒ 只加「回归」）；c 顶着上限再加两条 ⇒ 逐条预检失败" +
      "（不写库、也不静默丢标签 —— 两条新标签一条都不能悄悄少）",
  );
  assert.deepEqual(
    workItemBulkPlan({ items, selectedIds: ["a"], edit: { field: "labels", value: "Bug,P1" } })
      .unchangedIds,
    ["a"],
    "两个标签都已在行上 ⇒ 不写（合并结果与现状逐项相同）",
  );
  const selectedIds = ["a"];
  workItemBulkPlan({ items, selectedIds, edit: { field: "labels", value: "回归" } });
  assert.deepEqual(selectedIds, ["a"], "纯函数：不改入参");
});

/* 选择集里若有**不在 items 里**的 id（理论上不会：收敛已保证选择集 ⊆ 可见集），规划层**不写**它
   —— 宁可不写，也绝不写一行当前看不见的数据（这是批量最危险的静默漂移）。 */
test("逐条 patch：选择集里的陌生 id 直接跳过（不写看不见的行）", () => {
  const plan = workItemBulkPlan({
    items: [wi("a")],
    selectedIds: ["ghost", "a"],
    edit: { field: "priority", value: "high" },
  });
  assert.deepEqual(
    plan.targets,
    [{ id: "a", title: "标题 a", patch: { priority: "high" } }],
    "只有 a 被写",
  );
  assert.deepEqual(plan.unchangedIds, [], "陌生的 id 不冒充「同值」");
});

test("逐条 patch：坏取值 ⇒ 规划层拒绝给出任何 target（不预检失败、也不半截写入）", () => {
  const plan = workItemBulkPlan({
    items: [wi("a")],
    selectedIds: ["a"],
    edit: { field: "startDate", value: "不是日期" },
  });
  assert.deepEqual(
    plan,
    { targets: [], unchangedIds: [], precheckFailures: [] },
    "取值没归一化成功就没有可写的东西（拦在提交之前；服务面仍会响亮拒，但我们不让它到那一步）",
  );
});

// ---------- ⑦ 执行：逐条、**串行**、经注入的单条写入口；结果逐条可见（承重验收 1） ----------

/* 为什么执行次序也钉在纯逻辑层：`Promise.all` 与逐条 `await` 的**界面表现只在失败时不同** ——
   一次批量写发出 N 个并发请求，服务面（单文件 SQLite 写事务）会串行化它们，而界面上"逐条结果"
   与请求次序对不上；更要紧的是「一条失败就中断后面的行」会让用户以为整批都没动
   （实际前面几条已经写进去了）。 */

/** 假写入口：记录调用次序与**并发度**（同时几条在飞），按脚本抛错。 */
function makeWriter(failIds: readonly string[] = [], delayMs = 1) {
  const calls: string[] = [];
  let inFlight = 0;
  let maxInFlight = 0;
  return {
    calls,
    maxInFlight: () => maxInFlight,
    write: async (target: { id: string }) => {
      calls.push(target.id);
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      inFlight -= 1;
      if (failIds.includes(target.id)) throw new Error(`写 ${target.id} 失败`);
    },
  };
}

/** 三条待写 + 一条同值（b）：`unchangedIds` 也要进结果口径。 */
function threeRowPlan() {
  return workItemBulkPlan({
    items: [wi("a"), wi("b", { priority: "low" }), wi("c"), wi("d")],
    selectedIds: ["a", "b", "c", "d"],
    edit: { field: "priority", value: "low" },
  });
}

test("执行：串行逐条经写入口（同时只有一条在飞），写序 = 勾选序", async () => {
  const plan = threeRowPlan();
  assert.deepEqual(
    plan.targets.map((target) => target.id),
    ["a", "c", "d"],
    "夹具自检：b 同值 ⇒ 不在写计划里",
  );
  const writer = makeWriter();
  await executeWorkItemBulkEdit({ plan, write: writer.write });
  assert.deepEqual(writer.calls, ["a", "c", "d"], "逐条调用、次序 = 计划次序（= 勾选次序）");
  assert.equal(
    writer.maxInFlight(),
    1,
    "**串行**：同一时刻只有一条在飞（`Promise.all` 会让界面上的逐条结果与请求次序对不上）",
  );
});

test("执行：一条失败不中断其余，结果**逐条**保留原因（部分失败不得被总数掩盖）", async () => {
  const writer = makeWriter(["c"]);
  const result = await executeWorkItemBulkEdit({ plan: threeRowPlan(), write: writer.write });
  assert.deepEqual(writer.calls, ["a", "c", "d"], "c 失败后 d 仍要写（不是整批中止）");
  assert.equal(result.okCount, 3, "成功 = a + d + 本来就同值的 b（目标值已就位的项数）");
  assert.deepEqual(
    result.failures,
    [
      {
        workItemId: "c",
        title: "标题 c",
        messageId: "squad.common.operationFailed",
        detail: "写 c 失败",
      },
    ],
    "失败逐条：哪一条、为什么（文案键走 squadEntryErrorFeedback 的既有口径 + 原始细节不吞）",
  );
});

test("执行：门禁关闭的失败逐条给「已关闭」的原因（不是笼统的「操作失败」）", async () => {
  const writer = {
    calls: 0,
    write: async () => {
      writer.calls += 1;
      throw Object.assign(new Error("dispatch disabled"), { code: SQUAD_DISPATCH_DISABLED_CODE });
    },
  };
  const result = await executeWorkItemBulkEdit({
    plan: workItemBulkPlan({
      items: [wi("a"), wi("b")],
      selectedIds: ["a", "b"],
      edit: { field: "dueDate", value: "2026-03-09" },
    }),
    write: writer.write,
  });
  assert.equal(writer.calls, 2, "两条都试过（逐条）");
  assert.deepEqual(
    result.failures.map((failure) => failure.messageId),
    ["squad.common.dispatchDisabled", "squad.common.dispatchDisabled"],
    "稳定码翻译复用既有口径（与单条写同一句话）",
  );
});

test("执行：预检失败（标签超上限）也逐条进结果，且不折成一个总数", async () => {
  const saturated = Array.from({ length: WORK_ITEM_LABEL_MAX_COUNT }, (_, i) => `L${i}`);
  const plan = workItemBulkPlan({
    items: [wi("a"), wi("b", { labels: saturated }), wi("c")],
    selectedIds: ["a", "b", "c"],
    edit: { field: "labels", value: "回归" },
  });
  const writer = makeWriter();
  const result = await executeWorkItemBulkEdit({ plan, write: writer.write });
  assert.deepEqual(writer.calls, ["a", "c"], "预检失败的行不写库（其余照写）");
  assert.equal(result.okCount, 2, "a / c 目标值已就位");
  assert.deepEqual(
    result.failures,
    [
      {
        workItemId: "b",
        title: "标题 b",
        messageId: "squad.workItems.labelsTooMany",
        values: { max: WORK_ITEM_LABEL_MAX_COUNT, count: WORK_ITEM_LABEL_MAX_COUNT + 1 },
      },
    ],
    "预检失败同样逐条呈现（不是「失败 1 项」了事）",
  );
});

test("执行后：只有失败的行留在选择集里（成功行退出，重试不必重新勾）", async () => {
  const plan = workItemBulkPlan({
    items: [wi("a"), wi("b"), wi("c")],
    selectedIds: ["a", "b", "c"],
    edit: { field: "priority", value: "high" },
  });
  const result = await executeWorkItemBulkEdit({ plan, write: makeWriter(["b"]).write });
  assert.deepEqual(
    workItemBulkSelectionAfterApply({
      selected: ["a", "b", "c"],
      failedIds: result.failures.map((failure) => failure.workItemId),
    }),
    ["b"],
    "失败的那条留在选择集里（下一动作通常是重试它）；成功行退出",
  );
  assert.deepEqual(
    workItemBulkSelectionAfterApply({ selected: ["a", "b"], failedIds: [] }),
    [],
    "全成功 ⇒ 选择集清空",
  );
});
