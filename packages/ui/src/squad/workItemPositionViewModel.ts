/* 工作项**手工次序（`position`）**的纯判据（阶段二 · T-P2-R6b）：拖拽落点 → position 值。

   为什么是纯函数层：拖拽这一面的坏法全是**静默**的 —— 中值算错（拖完回到原位，不报错）、
   只改本地序不写库（换个页面又变回去）、并列 position（新建行的默认是 `0`）时"取中值"算出
   一个与邻居相等的值 ⇒ 用户拖了、界面没动、也没有任何错误。

   形态取证（reports/2026-10-09-saved-views-multica-evidence.md §6）：
   · `position` 是**全库一段**的序（不是每视图/每泳道的快照），排序判据在 SQL 里
     （`ORDER BY position ASC, created_at ASC, id ASC`）—— 本层**不复制**那份 SQL 判据，
     只在给一份已按 repo 次序排好的行时按 `position` 重排（`workItemPositionOrder`）；
   · 手动序方向恒 ASC（服务端忽略方向）；
   · 「清位」= 写 0（R6s 裁定：列是 `REAL NOT NULL DEFAULT 0`，与新项的默认同值，语义自洽：
     manual 排序下全 0 = 没有手动序）；不造 `null`。

   本文件不 import React、不 import UI 原语、不碰 i18n 文案正文。 */

/** 「无手动序」的取值（写 0 = 回到默认态；**不是** null —— 列是 NOT NULL DEFAULT 0）。 */
export const WORK_ITEM_POSITION_CLEARED = 0;

/** 拖拽的落点计划：一次拖拽要么只动被拖的那一行，要么整列重排（并列 position 时）。 */
export type WorkItemPositionPlan =
  | { kind: "none" }
  | { kind: "set"; workItemId: string; position: number }
  | { kind: "resequence"; updates: Array<{ workItemId: string; position: number }> };

/** 一份参与拖拽的行（`id` + `position`；输入次序 = repo 给的次序）。 */
export type WorkItemPositionRow = { id: string; position: number };

/**
 * 拖拽落点 → position 计划（**唯一**一处算位置）。
 *
 * 落点语义照 `arrayMove`（把 active 摘下来插到 over 的位次上），值按邻居分三档：
 * · 落成**列首** ⇒ 新次序里后一个邻居的 position 减 1；
 * · 落成**列尾** ⇒ 新次序里前一个邻居的 position 加 1；
 * · 落在**中间** ⇒ 前后邻居的中值（`REAL` 原样落库，不做整数化 —— 整数化会把"在 A 与 B 之间"
 *   压成并列，拖拽后的次序不再是用户看到的次序）。
 *
 * 并列 / 倒挂的邻居（新建项 position 全是 0 时的常态）⇒ **整列重排**：新次序里第 i 行取
 * `base + i`（base = 列内最小 position），逐行与现值比较、**同值不写**。
 * 为什么必须重排而不是"再取一次中值"：两个相等的邻居之间不存在可用的中值，
 * 硬算出来的值等于邻居 ⇒ 重排后次序不变，而用户已经拖过了（静默吞掉动作）。
 *
 * `none` 的两种情形：落点就是自己（误触/原地放下）、目标不在这一列（跨列拖拽 v1 有意不做）
 * —— 都不写库（等值写会让每次误触都产生一次写盘与一次刷新）。
 */
export function workItemPositionPlan(input: {
  /** 这一列的行（repo 次序：`position ASC, created_at ASC, id ASC`）。 */
  rows: readonly WorkItemPositionRow[];
  activeId: string;
  overId: string;
}): WorkItemPositionPlan {
  const { rows, activeId, overId } = input;
  if (activeId === overId) return { kind: "none" };
  const from = rows.findIndex((row) => row.id === activeId);
  const to = rows.findIndex((row) => row.id === overId);
  if (from < 0 || to < 0) return { kind: "none" };

  const order = [...rows];
  const moved = order[from]!;
  order.splice(from, 1);
  order.splice(to, 0, moved);
  const index = to;
  const before = index > 0 ? order[index - 1]! : null;
  const after = index < order.length - 1 ? order[index + 1]! : null;

  if (before === null) return { kind: "set", workItemId: activeId, position: after!.position - 1 };
  if (after === null) return { kind: "set", workItemId: activeId, position: before.position + 1 };
  if (before.position < after.position) {
    return {
      kind: "set",
      workItemId: activeId,
      position: (before.position + after.position) / 2,
    };
  }

  const base = Math.min(...rows.map((row) => row.position));
  const updates = order
    .map((row, position) => ({ workItemId: row.id, position: base + position }))
    .filter(
      (update) => rows.find((row) => row.id === update.workItemId)!.position !== update.position,
    );
  return { kind: "resequence", updates };
}

/** 计划里的全部写入（`none` ⇒ 空数组；调用方与用例共用这一份"计划 → 写入"的投影）。 */
export function workItemPositionPlanUpdates(
  plan: WorkItemPositionPlan,
): Array<{ workItemId: string; position: number }> {
  if (plan.kind === "none") return [];
  if (plan.kind === "set") return [{ workItemId: plan.workItemId, position: plan.position }];
  return plan.updates;
}

/**
 * 按 `position` 重排后给出 id 次序（**"重进页面"的模拟**：只认落库的值，不认任何内存次序）。
 *
 * 输入必须是 repo 给的次序（同 position 的 tie-break 由 SQL 的 `created_at ASC, id ASC` 给），
 * `Array.prototype.sort` 是稳定的 ⇒ 同 position 的行保持输入次序，与 repo 的口径逐格一致。
 */
export function workItemPositionOrder(rows: readonly WorkItemPositionRow[]): string[] {
  return [...rows].sort((left, right) => left.position - right.position).map((row) => row.id);
}

/** 单条 position 写入口（页面注入的**唯一**写路径：`(update) => service.updateWorkItem(...)`）。 */
export type WorkItemPositionWriter = (update: {
  workItemId: string;
  position: number;
}) => Promise<unknown>;

/**
 * 执行计划：**逐条串行**经注入的写入口（单写者纪律 —— 不并发，次序与计划一致）。
 * 失败**不吞**：冒到调用方（页面据此给可见提示；静默吞掉等于界面说"拖好了"而库里没动）。
 */
export async function executeWorkItemPositionPlan(input: {
  plan: WorkItemPositionPlan;
  write: WorkItemPositionWriter;
}): Promise<void> {
  for (const update of workItemPositionPlanUpdates(input.plan)) {
    await input.write(update);
  }
}
