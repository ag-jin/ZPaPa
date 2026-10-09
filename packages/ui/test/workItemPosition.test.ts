import assert from "node:assert/strict";
import test from "node:test";
import {
  WORK_ITEM_POSITION_CLEARED,
  executeWorkItemPositionPlan,
  workItemBoardDrop,
  workItemPositionOrder,
  workItemPositionPlan,
  workItemPositionPlanUpdates,
  type WorkItemPositionPlan,
} from "../src/squad/workItemPositionViewModel.js";

/* 工作项**手工次序（position）**的纯判据（阶段二 · T-P2-R6b）：拖拽落点 → position 值。

   期望值的独立真源：拆解卡 §T-P2-R6b「position 拖拽合流」（值 = 前后邻居中值或列首列尾；
   清位 = 写 0；R6s 白名单已通）+ 服务面 repo 的次序口径
   （`ORDER BY position ASC, created_at ASC, id ASC` —— manual 次序的判据只在 SQL 里，本层
   不复制它，只**按 position 重排**并保持输入次序）。

   为什么这些必须是纯函数：拖拽的坏法全是静默的 —— 中值算错（拖完回到原位、看不出报错）、
   拖拽只改本地序不写库（换个页面又变回去）、并列 position（值相等）时算出"没有变化"的落点
   （用户的动作被静默吞掉）。 */

/** 一行（只给本组用例关心的两列：id 与 position）。 */
function row(id: string, position: number): { id: string; position: number } {
  return { id, position };
}

/** 把计划**落到**一份数据上（模拟"重进页面"：只认 position 值，不认任何内存次序）。 */
function applyPlan(
  rows: Array<{ id: string; position: number }>,
  plan: WorkItemPositionPlan,
): Array<{ id: string; position: number }> {
  return rows.map((entry) => {
    const update = workItemPositionPlanUpdates(plan).find(
      (candidate) => candidate.workItemId === entry.id,
    );
    return update === undefined ? entry : { ...entry, position: update.position };
  });
}

// ---------- ① 落点：前后邻居中值 / 列首 / 列尾 ----------

test("落点｜列内插到中间：取前后邻居的**中值**（落库后按 position 重排就是新次序）", () => {
  const rows = [row("a", 1), row("b", 2), row("c", 3)];
  const plan = workItemPositionPlan({ rows, activeId: "c", overId: "b" });
  assert.deepEqual(
    plan,
    { kind: "set", workItemId: "c", position: 1.5 },
    "c 落到 b 之前 ⇒ 取 a(1) 与 b(2) 的中值 1.5",
  );
  assert.deepEqual(
    workItemPositionOrder(applyPlan(rows, plan)),
    ["a", "c", "b"],
    "重进页面（只按 position 重排）就是用户拖出来的次序",
  );
});

test("落点｜列首 = 现有最小值 - 1、列尾 = 现有最大值 + 1（不取中值：没有前/后邻居）", () => {
  const rows = [row("a", 10), row("b", 20), row("c", 30)];
  assert.deepEqual(
    workItemPositionPlan({ rows, activeId: "c", overId: "a" }),
    { kind: "set", workItemId: "c", position: 9 },
    "落到列首 ⇒ 最小值 10 减 1",
  );
  assert.deepEqual(
    workItemPositionPlan({ rows, activeId: "a", overId: "c" }),
    { kind: "set", workItemId: "a", position: 31 },
    "落到列尾 ⇒ 最大值 30 加 1",
  );
  assert.deepEqual(
    workItemPositionOrder(
      applyPlan(rows, workItemPositionPlan({ rows, activeId: "c", overId: "a" })),
    ),
    ["c", "a", "b"],
    "列首落点重排后确实在最前",
  );
  assert.deepEqual(
    workItemPositionOrder(
      applyPlan(rows, workItemPositionPlan({ rows, activeId: "a", overId: "c" })),
    ),
    ["b", "c", "a"],
    "列尾落点重排后确实在最后",
  );
});

test("落点｜拖回原位 / 目标不认识 ⇒ 不产生任何写入（不是「写一个等值的 position」）", () => {
  const rows = [row("a", 1), row("b", 2)];
  assert.deepEqual(
    workItemPositionPlan({ rows, activeId: "a", overId: "a" }),
    { kind: "none" },
    "落点就是自己 ⇒ 不写库（等值写会让每次误触都产生一次写盘与一次刷新）",
  );
  assert.deepEqual(
    workItemPositionPlan({ rows, activeId: "a", overId: "不认识" }),
    { kind: "none" },
    "目标不在这一列（跨列拖拽 v1 不做）⇒ 不写库",
  );
  assert.deepEqual(workItemPositionPlanUpdates({ kind: "none" }), [], "空计划 = 零条写入");
});

// ---------- ② 并列 position（新建行的默认 0）⇒ 重排整列，而不是算出一个"没有变化"的值 ----------

/* 这一格是本轮最容易漏的：positions 全是 0（`REAL NOT NULL DEFAULT 0`，新建项都是 0）时，
   "取中值"会算出 0 —— 与邻居相等 ⇒ 重排后次序没变（用户拖了，界面没动，也不报错）。 */
test("落点｜邻居 position 相等（并列）⇒ 重排整列（每行取 base + 序号），拖拽仍然真的生效", () => {
  const rows = [row("a", 0), row("b", 0), row("c", 0)];
  const plan = workItemPositionPlan({ rows, activeId: "c", overId: "b" });
  assert.deepEqual(
    plan,
    {
      kind: "resequence",
      updates: [
        { workItemId: "c", position: 1 },
        { workItemId: "b", position: 2 },
      ],
    },
    "并列 ⇒ 重排（a 已经是 0 ⇒ 同值不写；c/b 拿到 1/2）",
  );
  assert.deepEqual(
    workItemPositionOrder(applyPlan(rows, plan)),
    ["a", "c", "b"],
    "并列 position 下的拖拽同样落成新次序（中值法在这里会算出 0 = 静默吞掉用户的动作）",
  );
});

test("落点｜重排基准取列内最小值（不把整列搬到 0 附近：与其它列的 position 区间保持独立）", () => {
  const rows = [row("a", 100), row("b", 100), row("c", 100)];
  const plan = workItemPositionPlan({ rows, activeId: "c", overId: "b" });
  assert.deepEqual(
    workItemPositionPlanUpdates(plan),
    [
      { workItemId: "c", position: 101 },
      { workItemId: "b", position: 102 },
    ],
    "新次序 [a, c, b]：a 已是基准 100（同值不写），c/b 各取 +1 / +2 —— 基准仍是列内最小值" +
      "（不是把整列搬到 0 附近），重排后的值两两不同（这正是「重排」与「再取一次中值」的区别）",
  );
  assert.deepEqual(
    workItemPositionOrder(applyPlan(rows, plan)),
    ["a", "c", "b"],
    "重进页面（只按 position 重排）就是用户拖出来的新次序",
  );
});

// ---------- ③ 执行：逐条串行经唯一写入口（拖拽真的落库） ----------

test("执行｜逐条串行调用写入口（次序稳定），失败**不吞**（响亮交给调用方）", async () => {
  const calls: Array<{ workItemId: string; position: number }> = [];
  await executeWorkItemPositionPlan({
    plan: {
      kind: "resequence",
      updates: [
        { workItemId: "c", position: 1 },
        { workItemId: "b", position: 2 },
      ],
    },
    write: async (update) => {
      calls.push(update);
    },
  });
  assert.deepEqual(
    calls,
    [
      { workItemId: "c", position: 1 },
      { workItemId: "b", position: 2 },
    ],
    "按计划次序逐条写（单写者纪律：不并发、不重排）",
  );

  await assert.rejects(
    executeWorkItemPositionPlan({
      plan: { kind: "set", workItemId: "a", position: 1.5 },
      write: async () => {
        throw new Error("写失败");
      },
    }),
    /写失败/,
    "写失败必须冒出来（拖拽失败要能看见；静默吞掉 = 界面显示「拖好了」而库里没动）",
  );
});

test("清位值｜「无手动序」的取值是 0（列是 REAL NOT NULL DEFAULT 0；不造 null）", () => {
  assert.equal(WORK_ITEM_POSITION_CLEARED, 0, "清位 = 写 0（R6s 裁定的语义：与新建项的默认同值）");
});

// ---------- ④ 落点处理（DOM 事件的 active/over → 找泳道 → 计划 → 交回写路径） ----------

/* 为什么这一段必须存在（T-P2-V §8 缺口 1，M10 实证）：`handleDragEnd` 的这四步 —— 取事件的
   active/over id → 找被拖行所在的泳道 → 纯函数算计划 → 非 `none` 时交回写路径 —— 当时**零自动化
   覆盖**：把整段短路后 ui 整包仍然全绿。拖拽这一面的坏法又全是**静默**的（落到别的列却写了一个
   位置值、误触也写一次盘、计划算出来了却没有交回写路径）。

   本段钉住提纯后的唯一实现：输入 = 事件的 active/over id + **泳道映射**（每列的行），输出 = 计划或
   `none`；写库只能经注入的 `onPlan` **恰一次**（`none` ⇒ 一次都不调）。期望值的独立真源：拆解卡
   §T-P2-R6b「position 拖拽合流」（列内落点 = 邻居中值 / 列首列尾；跨列 v1 有意不做 = `none`）+
   上面 ①-③ 已钉住的 `workItemPositionPlan` 语义（本段只钉「找泳道」与「交回写路径」，位置值不重算）。 */

/** 一条泳道：`[id, position]` 逐行手写（position 是落库值，不按行序号现算）。 */
function lane(...rows: Array<[string, number]>): Array<{ id: string; position: number }> {
  return rows.map(([id, position]) => ({ id, position }));
}

/** 跑一次落点处理，并记录**交回写路径**的那些计划（恰一次 = 长度 1；`none` = 长度 0）。 */
function drop(input: {
  activeId: string;
  overId: string | null;
  lanes: Array<Array<{ id: string; position: number }>>;
}): { plan: WorkItemPositionPlan; handed: WorkItemPositionPlan[] } {
  const handed: WorkItemPositionPlan[] = [];
  const plan = workItemBoardDrop({ ...input, onPlan: (planned) => handed.push(planned) });
  return { plan, handed };
}

test("落点处理｜列内落点：计划按落点语义给，且交回写路径**恰一次**（页面是唯一写入口）", () => {
  const lanes = [lane(["a", 2], ["b", 4], ["c", 6]), lane(["x", 2], ["y", 4])];
  const expected: WorkItemPositionPlan = { kind: "set", workItemId: "c", position: 1 };
  assert.deepEqual(
    drop({ activeId: "c", overId: "a", lanes }).plan,
    expected,
    "c 落到列首 a 之前 ⇒ 位置 = a 的 2 减 1（与 ① 同一份落点语义：本层只找泳道）",
  );
  assert.deepEqual(
    drop({ activeId: "c", overId: "a", lanes }).handed,
    [expected],
    "非 none 的计划**恰一次**交回写路径（本层不写库）",
  );
  /* 并列 position（新建项的默认 0）⇒ 计划里是多条写入，但**只交付一次**
     （逐条串行落库由写路径 `executeWorkItemPositionPlan` 负责，不在这里逐条调）。 */
  const tied = drop({ activeId: "c", overId: "b", lanes: [lane(["a", 0], ["b", 0], ["c", 0])] });
  assert.deepEqual(
    tied.plan,
    {
      kind: "resequence",
      updates: [
        { workItemId: "c", position: 1 },
        { workItemId: "b", position: 2 },
      ],
    },
    "并列邻居 ⇒ 整列重排（不是算出一个「没有变化」的中值）",
  );
  assert.deepEqual(tied.handed, [tied.plan], "多条写入的计划同样只交付一次（不逐条调写路径）");
});

test("落点处理｜跨列落点：none 且**不写**（v1 不做跨列 = 不发明「拖过去就改状态」）", () => {
  const lanes = [lane(["a", 2], ["b", 4]), lane(["x", 2], ["y", 4])];
  const dropped = drop({ activeId: "a", overId: "x", lanes });
  assert.deepEqual(dropped.plan, { kind: "none" }, "目标在**别的**泳道 ⇒ 计划 none");
  assert.deepEqual(
    dropped.handed,
    [],
    "一次都不调写路径（写一个等值的 position 只是多一次写盘与一次刷新）",
  );
});

test("落点处理｜落点不可用：over 缺席 / 目标不在任何泳道 / 被拖行不在任何泳道 / 落点是自己 ⇒ none 不写", () => {
  const lanes = [lane(["a", 2], ["b", 4]), lane(["x", 2], ["y", 4])];
  const cases: Array<{ label: string; activeId: string; overId: string | null }> = [
    { label: "指针没落在任何行上（over = null）", activeId: "a", overId: null },
    { label: "目标不在任何泳道（DOM 给了未知 id）", activeId: "a", overId: "不认识" },
    { label: "被拖行不在任何泳道（行在两次渲染之间消失）", activeId: "已消失", overId: "a" },
    { label: "落点就是自己（误触 / 原地放下）", activeId: "a", overId: "a" },
  ];
  for (const { label, activeId, overId } of cases) {
    const dropped = drop({ activeId, overId, lanes });
    assert.deepEqual(dropped.plan, { kind: "none" }, `${label} ⇒ 计划 none`);
    assert.deepEqual(dropped.handed, [], `${label} ⇒ 零次写入`);
  }
});
