import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { WORK_ITEM_PRIORITY_KEYS } from "@zcode/shared";
import { ZCodeIntlProvider } from "../src/i18n/IntlProvider.js";
import enUS from "../src/i18n/locales/en-US.js";
import zhCN from "../src/i18n/locales/zh-CN.js";
import {
  WorkItemPriorityField,
  workItemPriorityFieldInput,
  workItemPrioritySelectOptions,
} from "../src/squad/WorkItemPriorityField.js";
import { WORK_ITEM_PRIORITY_CLEAR_VALUE } from "../src/squad/workItemInlineEditViewModel.js";
import { workItemInlinePrioritySelectValue } from "../src/squad/workItemInlineEditViewModel.js";
import {
  WORK_ITEM_SURFACE_FIELD_ERROR_MESSAGE_IDS,
  workItemSurfaceFieldErrorMessageId,
} from "../src/squad/workItemPropertiesViewModel.js";

/* 工作项三层 Surface 字段（priority / startDate / dueDate）的**编辑面**守卫（阶段一轮 C）。

   分工与 `workItemsLabels.test.ts` 同款：纯函数逐格在 `workItemProperties.test.ts`（判据单源），
   本文件只钉「它怎么被用」——表单预检 → 页面透传 → 服务面白名单这一条链上的每一环，都是
   **结构上会静默失效**的那种（漏一个字段不报错，只表现为「编辑一次、库里没变」）。

   为什么拆成独立文件而不是塞进 `workItemProperties.test.ts`：呈现面（四族字段怎么画）与编辑面
   （怎么改）是两件可以分别回退的事，守卫文件跟着语义走，评审时一眼看得出哪一半在动。 */

const SRC_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "../src");
const readSource = (relativePath: string) => readFileSync(resolve(SRC_DIR, relativePath), "utf8");
/** 去掉注释再扫：注释里提到坏写法是**说明**，不是坏写法本身（照 workItemInlineEditRow 的既有做法）。 */
const stripComments = (source: string) =>
  source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

/** 真渲染优先级字段（真 ZCodeIntlProvider，zh-CN；受控值由用例给）。 */
function renderPriorityField(value: string): string {
  return renderToStaticMarkup(
    createElement(ZCodeIntlProvider, {
      initialLocale: "zh-CN" as const,
      children: createElement(WorkItemPriorityField, { value, onChange: () => {} }),
    }),
  );
}

/* 守卫｜表单单点预检：非 ok 就地显示文案并**拦下提交**（照标签的守卫写）。
   变异：把预检删掉直接提交 ⇒ 前三条必红；服务面还会响亮抛，用户看到的是「失败」而不是
   「哪一项的哪一段不对」。 */
test("守卫｜表单预检：非 ok 就地显示文案并拦下提交（三字段各有自己的文案键）", () => {
  const dialogs = readSource("squad/SquadCreateDialogs.tsx");
  assert.ok(dialogs.includes("parseWorkItemSurfaceFields("), "表单必须用同一个纯函数预检");
  const guardIndex = dialogs.indexOf('surfaceFields.kind !== "ok"');
  assert.ok(guardIndex > 0, "必须有「非 ok」分支");
  const branch = dialogs.slice(guardIndex, guardIndex + 600);
  assert.ok(branch.includes("setSurfaceFieldsError("), "非 ok 必须留下可见文案");
  assert.ok(/return;/.test(branch), "非 ok 必须拦下提交（return 在 onSubmit 里）");
  assert.ok(
    dialogs.includes("workItemSurfaceFieldErrorMessageId("),
    "文案由字段 → 文案 id 的穷尽映射给出（不共用一个「输入非法」）",
  );
  assert.ok(
    dialogs.includes('data-testid="work-item-surface-fields-error"'),
    "错误文案要有 testid 锚点（可被 e2e 断言）",
  );
  // 三个字段各自的文案键必须真的指向 i18n 族（键集穷尽由纯函数用例钉住）。
  assert.deepEqual(Object.keys(WORK_ITEM_SURFACE_FIELD_ERROR_MESSAGE_IDS).sort(), [
    "dueDate",
    "priority",
    "startDate",
  ]);
  for (const field of ["priority", "startDate", "dueDate"] as const) {
    assert.ok(workItemSurfaceFieldErrorMessageId(field).startsWith("squad.workItems."));
  }
});

/* 守卫｜提交形状：三项字段**两支都必带**（可选 = 编辑漏传 = 服务面读成「没提这个字段」而保留旧值，
   界面与库随即不一致），且编辑必须回填。

   变异：把 edit 支的三项改成可选（或删掉回填）⇒ 第一/三条必红。 */
test("守卫｜提交形状：create 与 edit 两支都带 priority / startDate / dueDate 且编辑有回填", () => {
  const dialogs = readSource("squad/SquadCreateDialogs.tsx");
  const typeDecl = dialogs.slice(
    dialogs.indexOf("export type WorkItemDialogSubmitInput"),
    dialogs.indexOf("export function WorkItemDialog"),
  );
  for (const field of ["priority", "startDate", "dueDate"]) {
    assert.equal(
      (typeDecl.match(new RegExp(`${field}:`, "g")) ?? []).length,
      2,
      `create 支与 edit 支各带 ${field} —— 编辑不带会让「改标题」顺手清空这一项`,
    );
    assert.ok(
      dialogs.includes(`initial?.${field}`),
      `编辑必须回填 ${field}（不回填 ⇒ 提交时把库里的值清成空）`,
    );
  }
  const restore = dialogs.indexOf("initial?.startDate");
  assert.ok(
    dialogs.slice(Math.max(0, restore - 240), restore).includes("useState"),
    "回填要走状态初值（受控输入）",
  );
});

/* 守卫｜页面把三项字段并进**两条**请求（create 走入参、edit 走 patch）。
   变异：edit 只传 title/body/labels ⇒ 第二条必红（那是「编辑一次、库里没变」的形态）。 */
test("守卫｜WorkItemsPage 把三项 Surface 字段并进 create 与 edit 两条请求", () => {
  const page = readSource("squad/WorkItemsPage.tsx");
  const createCall = page.slice(
    page.indexOf("service.createWorkItem("),
    page.indexOf("squad.workItems.created"),
  );
  const editCall = page.slice(
    page.indexOf("service.updateWorkItem("),
    page.indexOf("squad.workItems.updated"),
  );
  for (const field of ["priority", "startDate", "dueDate"]) {
    assert.ok(createCall.includes(`${field}: input.${field}`), `create 必须带上 ${field}`);
    assert.ok(
      editCall.includes(`${field}: input.${field}`),
      `edit 必须带上 ${field}（不带 = 服务面读成「没提这个字段」而保留旧值）`,
    );
  }
});

/* 守卫｜编辑对话框的初值来自条目本身（含三项 Surface 字段）。
   变异：initial 只给 title/body/labels ⇒ 本守卫必红；后果同标签那一处（编辑即清空）。 */
test("守卫｜编辑对话框的初值来自条目本身（含三项 Surface 字段）", () => {
  const assembly = readSource("squad/WorkItemsPageDialogs.tsx");
  const initial = /initial=\{\{([^}]*)\}\}/.exec(assembly);
  assert.ok(initial, "编辑对话框必须给 initial");
  for (const field of ["title", "body", "labels", "priority", "startDate", "dueDate"]) {
    assert.ok(initial[1]!.includes(`${field}:`), `initial 缺 ${field}`);
  }
});

/* ---------- 轮 D 缺陷修复（Surface 阶段一轮 D 发现、本轮顺手修）：优先级下拉的「未设置」取值 ----------

   缺陷：工作项对话框的优先级下拉用了 `<SelectItem value="">` —— Radix 的 Select 把**空串**保留给
   「没有选中」（placeholder），`SelectItem` 拿到空串会**直接抛**
   `A <Select.Item /> must have a value prop that is not an empty string`，
   于是「打开优先级下拉」这一步真机上必崩。行内 picker 在轮 D 已用哨兵值 `__unset__` 修过
   （`WORK_ITEM_PRIORITY_CLEAR_VALUE`），对话框这一份当时没跟上 —— 同一个缺陷的第二处。

   本轮把「选项表」提成**单源纯函数**（`workItemPrioritySelectOptions`）并让对话框字段复用它：
   ① 选项取值全员非空（抛的那个条件在测试里可判，不再只是「源码里看着对」）；
   ② 下拉的受控值同样是哨兵（真渲染里没有 Radix 的 `data-placeholder`）；
   ③ 提交口径仍走既有纯函数（哨兵 → 表单原文的空串 → `parseWorkItemSurfaceFields` 读成 null）。 */

test("守卫｜优先级下拉选项表：取值全员非空（Radix 抛的条件）+ 哨兵唯一 + 四档齐全 + 两语齐", () => {
  const options = workItemPrioritySelectOptions();
  assert.equal(
    options.filter((option) => option.value === WORK_ITEM_PRIORITY_CLEAR_VALUE).length,
    1,
    "「未设置」恰一项（两份 = 两个哨兵，选中态会飘）",
  );
  assert.equal(
    options[0]?.value,
    WORK_ITEM_PRIORITY_CLEAR_VALUE,
    "「未设置」是首项（不是插在中间）",
  );
  assert.deepEqual(
    options.slice(1).map((option) => option.value),
    [...WORK_ITEM_PRIORITY_KEYS],
    "其余恰为 shared 的四档（顺序原样，展示次序不随实现重排）",
  );
  for (const option of options) {
    assert.ok(
      option.value.length > 0,
      `Radix Select 的 item 取值不得为空串（打开即抛）：${option.messageId}`,
    );
  }
  for (const option of options) {
    assert.ok((zhCN[option.messageId] ?? "").length > 0, `zh 缺 ${option.messageId}`);
    assert.ok((enUS[option.messageId] ?? "").length > 0, `en 缺 ${option.messageId}`);
  }
});

test("守卫｜表单口径的翻译：哨兵 ⇒ 空串（= 未设置）、档位原样（服务面仍读 null / 档位）", () => {
  assert.equal(
    workItemPriorityFieldInput(WORK_ITEM_PRIORITY_CLEAR_VALUE),
    "",
    "哨兵回落到表单口径的空串（`parseWorkItemSurfaceFields` 把空白读成「清空这一项」）",
  );
  assert.equal(workItemPriorityFieldInput("high"), "high", "档位原样传给纯函数判据");
  assert.equal(
    workItemInlinePrioritySelectValue(undefined),
    WORK_ITEM_PRIORITY_CLEAR_VALUE,
    "未设置的工作项 ⇒ 下拉初值就是哨兵（不空串）",
  );
});

test("真渲染｜优先级字段：受控值是哨兵时**没有** placeholder 语义（空串才会带上 data-placeholder）", () => {
  /* 只认**属性**形态（`data-placeholder=`）：Triggger 的 class 里本来就有
     `data-placeholder:text-…` 这个 Tailwind 变体 token，裸 includes 会把它误判成属性。 */
  const hasPlaceholderAttribute = (markup: string) => /\sdata-placeholder=/.test(markup);
  const unset = renderPriorityField(WORK_ITEM_PRIORITY_CLEAR_VALUE);
  assert.ok(
    unset.includes('data-testid="work-item-priority-select"'),
    "字段真的渲染出下拉触发器（真 ZCodeIntlProvider，不是结构断言）",
  );
  assert.ok(
    !hasPlaceholderAttribute(unset),
    '受控值不是空串 —— Radix 只在 value === "" 时打 data-placeholder 属性；' +
      "退回空串（修复前）这一条必红",
  );
  const set = renderPriorityField("high");
  assert.ok(set.includes('data-testid="work-item-priority-select"'), "有档位时同样渲染触发器");
  assert.ok(!hasPlaceholderAttribute(set), "有档位时同样不得落进 placeholder 语义");
  /* 反证：空串确实会打上该属性（否则上面的断言只是"没渲染出来"的假绿）。 */
  assert.ok(
    hasPlaceholderAttribute(renderPriorityField("")),
    "空串受控值 ⇒ Radix 打 data-placeholder（本断言让上面那条有区分力）",
  );
});

/* 表单本身的两处接线：占位选项必须用**哨兵常量**（不得再有字面量空串），且哨兵 → 表单口径
   的翻译恰在一处（第二份翻译 = 两套「未设置」语义，提交时静默写错值）。
   变异：把哨兵常量换回 `value=""` ⇒ 第一条必红。 */
test('守卫｜对话框优先级字段：用哨兵常量 + 翻译恰一处 + 无 `value=""`（注释已剥离）', () => {
  const dialogs = stripComments(readSource("squad/SquadCreateDialogs.tsx"));
  assert.ok(
    !/SelectItem\s+value=""/.test(dialogs),
    '不得出现 <SelectItem value="">（Radix 打开即抛；行内 picker 在轮 D 已修，这里是第二处）',
  );
  assert.equal(
    (dialogs.match(/workItemPriorityFieldInput\(/g) ?? []).length,
    1,
    "哨兵 → 表单口径的翻译恰一处（第二份 = 两套「未设置」语义）",
  );
  assert.equal(
    (dialogs.match(/workItemInlinePrioritySelectValue\(/g) ?? []).length,
    1,
    "下拉初值走同一份映射（未设置 ⇒ 哨兵）",
  );
  assert.equal(
    (dialogs.match(/<WorkItemPriorityField/g) ?? []).length,
    1,
    "优先级字段恰挂载一次（字段本体在独立模块里，对话框不抄第二份下拉）",
  );
  const field = stripComments(readSource("squad/WorkItemPriorityField.tsx"));
  assert.equal(
    (field.match(/workItemPrioritySelectOptions\(\)\.map\(/g) ?? []).length,
    1,
    "选项表由纯函数单源给出（字段里不手抄第二份四档）",
  );
  assert.ok(field.includes("WORK_ITEM_PRIORITY_CLEAR_VALUE"), "「未设置」项用共享哨兵常量");
});
