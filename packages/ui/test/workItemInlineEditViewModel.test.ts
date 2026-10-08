import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { WORK_ITEM_PRIORITY_KEYS } from "@zcode/shared";
import enUS from "../src/i18n/locales/en-US.js";
import zhCN from "../src/i18n/locales/zh-CN.js";
import {
  WORK_ITEM_INLINE_EDIT_ERROR_MESSAGE_IDS,
  WORK_ITEM_INLINE_TITLE_REQUIRED_MESSAGE_ID,
  WORK_ITEM_PRIORITY_CLEAR_VALUE,
  resolveWorkItemInlinePriorityEdit,
  resolveWorkItemInlineTitleEdit,
  workItemInlineEditUnavailableReason,
  workItemInlineEditUnchanged,
  workItemInlinePrioritySelectValue,
} from "../src/squad/workItemInlineEditViewModel.js";
import { WORK_ITEM_SURFACE_FIELD_ERROR_MESSAGE_IDS } from "../src/squad/workItemPropertiesViewModel.js";

/* 工作项**行内编辑**（阶段一轮 D，T-P1-R4）的**判据**逐格用例：字段 → patch 归一化、
   失败文案、「没动过」、归档判据、文案键目录。

   作为**独立文件**的理由：这几件事全是纯函数（不 import React、不碰 DOM），可以逐格钉死；
   而「它怎么被用」（编辑器进 renderRow、blur/Enter/Escape、写路径只有一条）在
   `workItemInlineEditRow.test.ts` —— 判据与接线是两件可以分别回退的事，守卫跟着语义走
   （照轮 C 把 `workItemProperties` 与 `workItemSurfaceEdit` 分开的先例）。 */

const SRC_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "../src");
const readSource = (relativePath: string) => readFileSync(resolve(SRC_DIR, relativePath), "utf8");
/** 去掉注释再扫：注释里提到坏写法是**说明**，不是坏写法本身（照 workItemProperties 的既有做法）。 */
const stripComments = (source: string) =>
  source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

/** 本轮新增的文案键（由闭集与映射**推导**，不是手抄：漏一个键这条用例就红）。 */
const WORK_ITEM_INLINE_EDIT_MESSAGE_IDS: string[] = [
  WORK_ITEM_INLINE_TITLE_REQUIRED_MESSAGE_ID,
  ...Object.values(WORK_ITEM_INLINE_EDIT_ERROR_MESSAGE_IDS),
  "squad.workItemDetail.inlineEdit.disabled.archived",
  "squad.workItemDetail.inlineEdit.disabled.readFailed",
];

/* 守卫｜标题归一化：trim 后落 patch（与表单同一个取值口径），空标题**响亮拒**并指名文案。
   变异：把空标题也当合法（或返回未 trim 的原文）⇒ 第一 / 二条必红。 */
test("行内标题：trim 后落 patch；空白标题 ⇒ 非 ok 且指名文案（不静默丢掉一次点击）", () => {
  assert.deepEqual(resolveWorkItemInlineTitleEdit("  改个错别字  "), {
    kind: "ok",
    patch: { title: "改个错别字" },
  });
  const blank = resolveWorkItemInlineTitleEdit("   ");
  assert.equal(blank.kind, "invalid", "纯空白 = 没有标题（表单的 canSubmit 同一条口径）");
  assert.equal(
    blank.kind === "invalid" ? blank.messageId : null,
    WORK_ITEM_INLINE_EDIT_ERROR_MESSAGE_IDS.title,
    "失败文案来自字段 → 文案的穷尽映射",
  );
});

/* 守卫｜优先级归一化：闭集四档原样落 patch、空白 ⇒ 清回未设置（`null`）、闭集外 ⇒ 指名文案。
   两条硬约束：
   ① **patch 只带 priority** —— 行内改优先级必须不碰起始/截止日期（带上它们 = 把用户没动过的日期清成空）；
   ② 失败文案**复用轮 C 的映射**（同一个字段同一句话，不另起一份）。
   变异：把 parseWorkItemSurfaceFields 的整体 patch 原样返回 ⇒ 第一条必红。 */
test("行内优先级：闭集四档只落 priority；空白 ⇒ 清回未设置；闭集外 ⇒ 复用轮 C 文案", () => {
  for (const key of WORK_ITEM_PRIORITY_KEYS) {
    const resolution = resolveWorkItemInlinePriorityEdit(key);
    assert.equal(resolution.kind, "ok", `${key} 是闭集内的档位`);
    assert.deepEqual(resolution.patch, { priority: key });
    assert.deepEqual(
      Object.keys(resolution.patch),
      ["priority"],
      "patch 只带 priority（带上日期 ⇒ 行内改优先级会把没动过的日期清掉）",
    );
  }
  assert.deepEqual(resolveWorkItemInlinePriorityEdit(""), {
    kind: "ok",
    patch: { priority: null },
  });
  const invalid = resolveWorkItemInlinePriorityEdit("P0");
  assert.equal(invalid.kind, "invalid");
  assert.deepEqual(
    invalid.kind === "invalid" ? { field: invalid.field, value: invalid.value } : null,
    { field: "priority", value: "P0" },
  );
  assert.equal(
    invalid.kind === "invalid" ? invalid.messageId : null,
    WORK_ITEM_SURFACE_FIELD_ERROR_MESSAGE_IDS.priority,
    "失败文案复用轮 C 的字段 → 文案映射（不另起一份）",
  );
});

/* 守卫｜「没动过」判据：blur 只是路过（点进标题又点走）不该产生一次写入。
   判据只比**被编辑的那一个字段**：拿整条条目去比，改优先级会被标题的差异干扰。
   变异：删掉这个判据（每次 blur 都写）⇒ 第三条（清除本来没设置的档位）必红。 */
test("没动过：同值提交不写库（清除一个本来就没设置的档位也算没动过）", () => {
  assert.equal(workItemInlineEditUnchanged({ title: "a" }, { title: "a" }), true);
  assert.equal(workItemInlineEditUnchanged({ title: "a" }, { title: "b" }), false);
  assert.equal(workItemInlineEditUnchanged({ title: "a" }, { priority: null }), true);
  assert.equal(
    workItemInlineEditUnchanged({ title: "a", priority: "low" }, { priority: "low" }),
    true,
    "改优先级时只看优先级（标题差异与它无关）",
  );
  assert.equal(
    workItemInlineEditUnchanged({ title: "a", priority: "low" }, { priority: null }),
    false,
  );
  assert.equal(
    workItemInlineEditUnchanged({ title: "a", priority: "low" }, { priority: "high" }),
    false,
  );
});

/* 守卫｜picker 的取值映射：未设置 ⇒ **哨兵值**，领域里的「清回未设置」仍是 `null`。
   为什么需要哨兵：@radix-ui 的 item 把空串保留给 placeholder（`<SelectItem value="">`
   会直接抛），所以「未设置」在 UI 取值域里必须有一个非空取值；它**不进库**（patch 里是 null）。
   变异：把哨兵去掉、改用空串 ⇒ 第一 / 五条必红（且真机上打开 picker 直接抛）。 */
test("picker 取值：未设置 ⇒ 哨兵值；resolver 把哨兵读成「清回未设置」", () => {
  assert.equal(workItemInlinePrioritySelectValue(undefined), WORK_ITEM_PRIORITY_CLEAR_VALUE);
  assert.equal(workItemInlinePrioritySelectValue(null), WORK_ITEM_PRIORITY_CLEAR_VALUE);
  assert.equal(workItemInlinePrioritySelectValue("high"), "high");
  assert.ok(
    !(WORK_ITEM_PRIORITY_KEYS as readonly string[]).includes(WORK_ITEM_PRIORITY_CLEAR_VALUE),
    "哨兵不得与任何一个档位键相撞",
  );
  assert.deepEqual(resolveWorkItemInlinePriorityEdit(WORK_ITEM_PRIORITY_CLEAR_VALUE), {
    kind: "ok",
    patch: { priority: null },
  });
});

/* 守卫｜两语文案成对（R10 口径）：本轮新增的键逐条两语齐 + 占位符成对。
   变异：只加 zh-CN ⇒ 第一条必红；en-US 漏掉 {value} 占位符 ⇒ 第二条必红。 */
test("守卫｜行内编辑的文案键两语成对（含归档不可用的原因族）", () => {
  const placeholders = (value: string) =>
    [...value.matchAll(/\{(\w+)\}/g)]
      .map((match) => match[1])
      .sort()
      .join(",");
  for (const key of WORK_ITEM_INLINE_EDIT_MESSAGE_IDS) {
    const zh = zhCN[key];
    const en = enUS[key];
    assert.ok(zh, `zh-CN 缺键 ${key}`);
    assert.ok(en, `en-US 缺键 ${key}`);
    assert.equal(placeholders(zh), placeholders(en), `${key} 的占位符两语不成对`);
  }
  assert.deepEqual(
    Object.keys(WORK_ITEM_INLINE_EDIT_ERROR_MESSAGE_IDS).sort(),
    ["priority", "title"],
    "字段 → 文案映射的键集 == 闭集（少一个键 ⇒ 那个字段坏掉时没有话可说）",
  );
  assert.equal(
    WORK_ITEM_INLINE_EDIT_ERROR_MESSAGE_IDS.priority,
    WORK_ITEM_SURFACE_FIELD_ERROR_MESSAGE_IDS.priority,
    "优先级的失败文案指向轮 C 的同一个键（不抄一个同值字符串：抄出来的两份会各自漂移）",
  );
});

/* 守卫｜归档判据：行内编辑不可用的原因**复用详情写面同一份判据**（`writeDisabledReason`）。
   为什么这条重要：归档 = 只读（本仓没有「取消归档」）。各面各写一份 `archivedAt !== undefined`，
   迟早在某一面上漏掉一格 —— 而漏掉的表现是「行内入口亮着、点了必失败」。
   变异：把归档判据改成模块内自己比较 `archivedAt` ⇒ 结构断言必红；把归档行也当可编辑 ⇒ 第一条必红。 */
test("归档判据：行内编辑不可用的原因复用 writeDisabledReason（本模块不写第二份归档判据）", () => {
  assert.equal(
    workItemInlineEditUnavailableReason({ archivedAt: 1 }),
    "squad.workItemDetail.inlineEdit.disabled.archived",
    "归档 ⇒ 与详情四个写面同一族的原因文案（同一份判据只换面名）",
  );
  assert.equal(workItemInlineEditUnavailableReason({}), null, "未归档 ⇒ 无理由（给入口）");
  const vm = stripComments(readSource("squad/workItemInlineEditViewModel.ts"));
  assert.ok(
    vm.includes('writeDisabledReason("inlineEdit"'),
    "必须调用 writeDisabledReason（不是自己比较 archivedAt）",
  );
  assert.ok(
    !/archivedAt\s*(?:[!=]==?)/.test(vm) && !vm.includes(".archivedAt"),
    "本模块不得**判断** archivedAt（入参形状可以写这个字段名，判据必须留给 writeDisabledReason）",
  );
});
