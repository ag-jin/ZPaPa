import assert from "node:assert/strict";
import test from "node:test";
import {
  isWorkItemDateOnly,
  resolveWorkItemDateOnly,
  workItemDateErrorMessage,
  workItemDateOnlySchema,
} from "../src/work-item.js";

/* 工作项**日历日期**（起始 / 截止；Surface 对齐 · 阶段一 R1 / 0018；用户裁定 Q5，2026-10-08）的用例。

   裁定原文：日期原语是 `TEXT 'YYYY-MM-DD'` —— **日历日期，不是时刻**。两条纪律：
   ① 值**原样**存取（不经过任何时刻转换）：`new Date("2026-10-08")` 按 UTC 解析，在东八区读回会
      差一天；纯函数只做**字符串**校验与透传，杜绝这类漂移；
   ② 格式合法**不等于**日期存在：`2026-02-29`（2026 不是闰年）与 `2026-04-31` 必须拒绝 ——
      正则放行不存在的日期，会让「10 月 32 日」这种值悄悄进库，排序/展示时才现形。

   闰年判据用日历事实（独立来源：格里高利历）：能被 4 整除且（不能被 100 整除或能被 400 整除）。 */

test("日期校验：合法 YYYY-MM-DD 收下（含闰年 2 月 29 日与百年闰 2000）", () => {
  for (const value of ["2026-10-08", "2024-02-29", "2000-02-29", "1999-12-31", "0001-01-01"]) {
    assert.equal(isWorkItemDateOnly(value), true, `${value} 应合法`);
  }
});

test("日期校验：非 YYYY-MM-DD 形状一律拒绝（补零、分隔符、时刻后缀、空白）", () => {
  for (const value of [
    "",
    "2026-1-1",
    "26-01-01",
    "2026/10/08",
    "2026-10-08T00:00:00Z",
    "2026-10-08 ",
    " 2026-10-08",
    "2026-10-8",
    "20261008",
  ]) {
    assert.equal(isWorkItemDateOnly(value), false, `${value} 应被拒（形状）`);
  }
});

test("日期校验：月份 00 / 13 与日 00 拒绝", () => {
  for (const value of ["2026-00-10", "2026-13-01", "2026-10-00"]) {
    assert.equal(isWorkItemDateOnly(value), false, `${value} 应被拒（越界）`);
  }
});

test("日期校验：小月与大月按真实天数判定（4/6/9/11 月 31 日拒绝，31 日月 31 日收下）", () => {
  for (const value of ["2026-04-31", "2026-06-31", "2026-09-31", "2026-11-31"]) {
    assert.equal(isWorkItemDateOnly(value), false, `${value} 应被拒（小月无 31 日）`);
  }
  for (const value of ["2026-01-31", "2026-03-31", "2026-05-31", "2026-07-31", "2026-12-31"]) {
    assert.equal(isWorkItemDateOnly(value), true, `${value} 应合法`);
  }
  assert.equal(isWorkItemDateOnly("2026-04-30"), true);
});

// 闰年判据（独立来源：格里高利历）：2024 是闰年、2023 不是、2000 是（能被 400 整除）、
// 1900 **不是**（能被 100 整除但不能被 400 整除）。
test("日期校验：2 月 29 日只在该年是闰年时收下（2024 收 / 2023 拒 / 2000 收 / 1900 拒）", () => {
  assert.equal(isWorkItemDateOnly("2024-02-29"), true);
  assert.equal(isWorkItemDateOnly("2023-02-29"), false);
  assert.equal(isWorkItemDateOnly("2000-02-29"), true);
  assert.equal(isWorkItemDateOnly("1900-02-29"), false);
});

test("日期解析：合法值**原样**透传（不做任何时刻/时区换算），未设置给 null", () => {
  assert.deepEqual(resolveWorkItemDateOnly("2026-10-08"), { kind: "ok", date: "2026-10-08" });
  // 边界日期不得被「本地时区」挪动一天：原样进出。
  assert.deepEqual(resolveWorkItemDateOnly("2026-01-01"), { kind: "ok", date: "2026-01-01" });
  assert.deepEqual(resolveWorkItemDateOnly("2026-12-31"), { kind: "ok", date: "2026-12-31" });
  assert.deepEqual(resolveWorkItemDateOnly(undefined), { kind: "ok", date: null });
  assert.deepEqual(resolveWorkItemDateOnly(null), { kind: "ok", date: null });
});

test("日期解析：坏日期一律 invalid 并回传原文（不静默落成未设置）", () => {
  assert.deepEqual(resolveWorkItemDateOnly("2026-02-29"), {
    kind: "invalid",
    value: "2026-02-29",
  });
  assert.deepEqual(resolveWorkItemDateOnly("2026-10-08T00:00:00Z"), {
    kind: "invalid",
    value: "2026-10-08T00:00:00Z",
  });
  assert.deepEqual(resolveWorkItemDateOnly(20261008), { kind: "invalid", value: "20261008" });
});

test("日期错误文案：说明非法值并给出正确形状（响亮，不吞）", () => {
  const message = workItemDateErrorMessage({ kind: "invalid", value: "2026-02-29" });
  assert.match(message, /2026-02-29/);
  assert.match(message, /YYYY-MM-DD/);
});

test("日期 schema：合法形状 + 真实日历都要过；越界日期与坏形状拒绝", () => {
  assert.equal(workItemDateOnlySchema.safeParse("2026-10-08").success, true);
  assert.equal(workItemDateOnlySchema.safeParse("2024-02-29").success, true);
  assert.equal(workItemDateOnlySchema.safeParse("2026-02-29").success, false);
  assert.equal(workItemDateOnlySchema.safeParse("2026-1-1").success, false);
});
