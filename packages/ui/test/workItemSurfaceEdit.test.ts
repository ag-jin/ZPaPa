import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
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

/* 守卫｜对话框装配层把**条目自己**的三项作为编辑初值。
   变异：initial 只给 title/body/labels ⇒ 本守卫必红；后果同标签那一处（编辑即清空）。 */
test("守卫｜编辑对话框的初值来自条目本身（含三项 Surface 字段）", () => {
  const assembly = readSource("squad/WorkItemsPageDialogs.tsx");
  const initial = /initial=\{\{([^}]*)\}\}/.exec(assembly);
  assert.ok(initial, "编辑对话框必须给 initial");
  for (const field of ["title", "body", "labels", "priority", "startDate", "dueDate"]) {
    assert.ok(initial[1]!.includes(`${field}:`), `initial 缺 ${field}`);
  }
});
