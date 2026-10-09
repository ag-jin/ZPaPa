import assert from "node:assert/strict";
import test from "node:test";
import {
  WORK_ITEM_LABEL_MAX_COUNT,
  WORK_ITEM_LABEL_MAX_LENGTH,
  parseWorkItemLabels,
} from "../src/work-item.js";

/* 工作项**标签归一化**（欠账 #11 的 v1 半步，2026-10-07 裁定）的用例。

   为什么归一化必须是**共享纯函数**而不是各写一份：标签有**两个写入口**（建项 createWorkItem /
   编辑 updateWorkItem）与**一个表单预检**，三处各写一遍「怎么切、怎么去重、上限多少」迟早分叉，
   而分叉的表现是「表单说没问题、写入口拒绝」或反过来 —— 两处都不报错。

   为什么超限**响亮**（返回判别联合）而不是静默截断：静默截断让用户提交 11 个标签、界面显示 10 个，
   用户以为自己写进去了。判别联合把「为什么没收下」变成调用方能命名的结论（条数 / 单条长度）。 */

test("标签常量：条数上限 10、单条长度上限 32", () => {
  assert.equal(WORK_ITEM_LABEL_MAX_COUNT, 10);
  assert.equal(WORK_ITEM_LABEL_MAX_LENGTH, 32);
});

test("标签解析：按逗号与换行切分、trim、丢空串", () => {
  assert.deepEqual(parseWorkItemLabels(["  前端 , 紧急\n后端 ,, \n "]), {
    kind: "ok",
    labels: ["前端", "紧急", "后端"],
  });
});

test("标签解析：多个输入项各自参与切分（表单按行给、或整段给，同一判据）", () => {
  assert.deepEqual(parseWorkItemLabels(["a,b", "c"]), { kind: "ok", labels: ["a", "b", "c"] });
  assert.deepEqual(parseWorkItemLabels([]), { kind: "ok", labels: [] });
  assert.deepEqual(parseWorkItemLabels(["", "  ", "\n"]), { kind: "ok", labels: [] });
});

// 去重**保序**（首次出现为准）：顺序是用户的书写顺序，不是排序结果 —— 重排会让看板 chip 抖动。
test("标签解析：去重保序（首次出现为准）", () => {
  assert.deepEqual(parseWorkItemLabels(["b, a, b, a, c"]), { kind: "ok", labels: ["b", "a", "c"] });
});

// 大小写不折叠：`Bug` 与 `bug` 是两个标签 —— 折叠等于替用户改数据，且不可逆（原始大小写丢了）。
test("标签解析：大小写敏感（不折叠）", () => {
  assert.deepEqual(parseWorkItemLabels(["Bug,bug,BUG"]), {
    kind: "ok",
    labels: ["Bug", "bug", "BUG"],
  });
});

test("标签解析：内部空格保留（只 trim 两端）", () => {
  assert.deepEqual(parseWorkItemLabels(["  a b "]), { kind: "ok", labels: ["a b"] });
});

test("标签解析：条数上限两侧 —— 恰好 10 收下、11 响亮报 too_many", () => {
  const ten = Array.from({ length: 10 }, (_, index) => `t${index}`);
  assert.deepEqual(parseWorkItemLabels(ten), { kind: "ok", labels: ten });

  const eleven = Array.from({ length: 11 }, (_, index) => `t${index}`);
  assert.deepEqual(parseWorkItemLabels(eleven), { kind: "too_many", max: 10, count: 11 });
});

// 去重在**计数之前**：`a,a,a`（三个原文）只有一个标签，不得因此报「太多」。
test("标签解析：计数发生在去重之后（重复输入不占额度）", () => {
  const tenWithDuplicates = [...Array.from({ length: 10 }, (_, index) => `t${index}`), "t0", "t1"];
  assert.deepEqual(parseWorkItemLabels(tenWithDuplicates), {
    kind: "ok",
    labels: Array.from({ length: 10 }, (_, index) => `t${index}`),
  });
});

test("标签解析：单条长度两侧 —— 恰好 32 收下、33 响亮报 too_long（值原样回传）", () => {
  const exactly = "x".repeat(32);
  assert.deepEqual(parseWorkItemLabels([exactly]), { kind: "ok", labels: [exactly] });

  const tooLong = "y".repeat(33);
  assert.deepEqual(parseWorkItemLabels([tooLong]), { kind: "too_long", max: 32, value: tooLong });
});

// 长度按 **trim 之后**的值判定：两端空白不该把一个合法标签顶出上限（trim 是解析的一部分）。
test("标签解析：长度按 trim 后的值判定", () => {
  const value = "z".repeat(32);
  assert.deepEqual(parseWorkItemLabels([`   ${value}   `]), { kind: "ok", labels: [value] });
});

/* 两种超限**同时**命中时的优先级（本用例是**约定钉**，不是边角料）：函数必须给**一个**结论，
   且同一份输入永远给同一个结论。取 too_many 优先：条数是先被看清的事实，而「哪一条太长」在
   已超额的输入上不是用户此刻要解决的问题。 */
test("标签解析：同时命中两种超限 ⇒ 结论确定（too_many 优先）", () => {
  const elevenWithLong = [...Array.from({ length: 10 }, (_, index) => `t${index}`), "y".repeat(33)];
  assert.deepEqual(parseWorkItemLabels(elevenWithLong), {
    kind: "too_many",
    max: 10,
    count: 11,
  });
});

test("标签解析：纯函数不留状态（两次调用逐字相等，且不改输入数组）", () => {
  const raw = ["a, b", "c"];
  const snapshot = [...raw];
  assert.deepEqual(parseWorkItemLabels(raw), parseWorkItemLabels(raw));
  assert.deepEqual(raw, snapshot, "不得就地改写调用方给的数组");
});
