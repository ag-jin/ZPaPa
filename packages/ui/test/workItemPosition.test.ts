import assert from "node:assert/strict";
import test from "node:test";
import {
  WORK_ITEM_POSITION_CLEARED,
  executeWorkItemPositionPlan,
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
