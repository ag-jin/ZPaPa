import assert from "node:assert/strict";
import test from "node:test";
import {
  WORK_ITEM_PRIORITY_KEYS,
  WORK_ITEM_PRIORITY_RANK,
  resolveWorkItemPriority,
  resolveWorkItemPriorityRank,
  workItemPriorityErrorMessage,
  workItemPrioritySchema,
} from "../src/work-item.js";

/* 工作项**优先级**（Surface 对齐 · 阶段一 R1 / 0018；用户裁定 Q4，2026-10-08）的用例。

   裁定原文：优先级是**闭集** `urgent / high / medium / low`，`NULL = 未设置` —— 与任何显式键
   都**不是**同一态（两态会污染过滤/排序：界面把「没人定过优先级」显示成某个具体档位时，
   用户看到的是库里没有的事实）。

   为什么闭集 + rank 必须是共享纯函数：阶段二要在 list/table 两视图上**排序/过滤**，两个视图
   各写一份顺序或各写一份校验，迟早分叉；而分叉的表现是「两个视图排序结果不同」且不报错。

   为什么判据是 `Record<WorkItemPriorityKey, number>`（穷尽映射）：加一枚键时编译期就在这里
   报缺失（与 `WORK_ITEM_STATUS_CATEGORY` 同款纪律）—— 数组式顺序表加键不会报错，只会静默漏排。 */

test("优先级闭集：恰 4 枚，顺序为裁定顺序 urgent → high → medium → low", () => {
  assert.deepEqual([...WORK_ITEM_PRIORITY_KEYS], ["urgent", "high", "medium", "low"]);
});

test("优先级 rank：数值序 = 裁定顺序（越紧急越小），且穷尽闭集每一枚键", () => {
  assert.deepEqual(
    Object.keys(WORK_ITEM_PRIORITY_RANK).sort(),
    [...WORK_ITEM_PRIORITY_KEYS].sort(),
  );
  assert.deepEqual(
    WORK_ITEM_PRIORITY_KEYS.map((key) => WORK_ITEM_PRIORITY_RANK[key]),
    [0, 1, 2, 3],
  );
});

// 未设置没有位次：`null` 不是「排最后」也不是「排最前」——消费方（阶段二排序）自己决定
// 未设置排在哪，本层不编造一个默认位次。
test("优先级 rank 解析：闭集键给出位次，未设置（undefined / null）给 null", () => {
  assert.equal(resolveWorkItemPriorityRank("urgent"), 0);
  assert.equal(resolveWorkItemPriorityRank("low"), 3);
  assert.equal(resolveWorkItemPriorityRank(undefined), null);
  assert.equal(resolveWorkItemPriorityRank(null), null);
});

test("优先级解析：闭集内 4 枚原样收下；未设置（undefined / null）⇒ 未设置", () => {
  for (const key of WORK_ITEM_PRIORITY_KEYS) {
    assert.deepEqual(resolveWorkItemPriority(key), { kind: "ok", priority: key });
  }
  assert.deepEqual(resolveWorkItemPriority(undefined), { kind: "ok", priority: null });
  assert.deepEqual(resolveWorkItemPriority(null), { kind: "ok", priority: null });
});

// 闭集外**响亮**拒绝（不静默折算成某个档位、不落成未设置）：`none` / 空串 / 大小写变体 /
// 带空白 / 非字符串都必须走 invalid —— 写成「看不懂就当未设置」会让用户的选择凭空消失。
test("优先级解析：闭集外一律 invalid（含 none / 空串 / 大小写变体 / 空白 / 非字符串）", () => {
  for (const raw of ["none", "", "  ", "URGENT", "urgent ", " medium", "highest", 3, true]) {
    assert.deepEqual(resolveWorkItemPriority(raw), { kind: "invalid", value: String(raw) });
  }
});

test("优先级错误文案：说明非法值并列出闭集（响亮，不吞）", () => {
  const message = workItemPriorityErrorMessage({ kind: "invalid", value: "none" });
  assert.match(message, /none/);
  for (const key of WORK_ITEM_PRIORITY_KEYS) assert.match(message, new RegExp(key));
});

// schema 只管「闭集内 / 闭集外」这一件事；「未设置」由领域模型的 `.optional()` 承载
//（与 workItemStatusSchema 同款：schema 本体不替字段决定可缺省性）。
test("优先级 schema：闭集键可解析；闭集外、大小写变体与 undefined 一律拒绝", () => {
  for (const key of WORK_ITEM_PRIORITY_KEYS)
    assert.equal(workItemPrioritySchema.safeParse(key).success, true);
  assert.equal(workItemPrioritySchema.safeParse("none").success, false);
  assert.equal(workItemPrioritySchema.safeParse("URGENT").success, false);
  assert.equal(workItemPrioritySchema.safeParse(undefined).success, false);
});
