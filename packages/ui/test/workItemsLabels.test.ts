import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import enUS from "../src/i18n/locales/en-US.js";
import zhCN from "../src/i18n/locales/zh-CN.js";
import { workItemLabelChips, workItemPropertyValueText } from "../src/squad/workItemsViewModel.js";

/* 工作项**标签**（欠账 #11 的 v1 后半，2026-10-07 裁定）在 UI 面的用例：
   chip 截断投影逐格 + 三处呈现 / 一处编辑的结构守卫 + 两语文案成对。

   本文件不重复 shared 的解析规则（`parseWorkItemLabels` 的逐格用例在
   `packages/shared/test/workItemLabels.test.ts`）：UI 侧只钉「它怎么被用」——
   预检在表单、归一化结果进请求、呈现不截断（详情页）与截断（看板行）。 */

const SRC_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "../src");
const readSource = (relativePath: string) => readFileSync(resolve(SRC_DIR, relativePath), "utf8");
/* 概览区自 T-P1-R2 起独立成模块（`WorkItemDetailOverview.tsx`）⇒ 概览的三个守卫（chip 复用 /
   标签区 / 属性区）的扫描面 = 页面 + 概览模块。**只扩面**：判据与切片方式一字不动，
   否则守卫会变成在「搬走后的页面」上找已经不是它的那几行（块切片取到空串 = 静默失效）。 */
const readDetailSurface = () =>
  readSource("squad/WorkItemDetailPage.tsx") + readSource("squad/WorkItemDetailOverview.tsx");
const SERVICES_SRC_DIR = resolve(SRC_DIR, "../../services/src");
const readServicesSource = (relativePath: string) =>
  readFileSync(resolve(SERVICES_SRC_DIR, relativePath), "utf8");

// ---------- ① 看板行的 chip 截断投影 ----------

// 投影是**纯函数**（ui 包没有渲染测试设施，这是本项目既定做法）：0 / 1 / 恰好 3 / 4 / 5 逐格。
// 变异：把 `slice(0, max)` 换成整表返回（不截断）⇒ 第三条与第四条必红。
test("标签 chip 投影：0 / 1 / 恰好 3 个全显示、4 个 ⇒ 显示 3 +「+1」、5 个 ⇒「+2」", () => {
  assert.deepEqual(workItemLabelChips([]), { shown: [], hiddenCount: 0 });
  assert.deepEqual(workItemLabelChips(["a"]), { shown: ["a"], hiddenCount: 0 });
  assert.deepEqual(workItemLabelChips(["a", "b", "c"]), {
    shown: ["a", "b", "c"],
    hiddenCount: 0,
  });
  assert.deepEqual(workItemLabelChips(["a", "b", "c", "d"]), {
    shown: ["a", "b", "c"],
    hiddenCount: 1,
  });
  assert.deepEqual(workItemLabelChips(["a", "b", "c", "d", "e"]), {
    shown: ["a", "b", "c"],
    hiddenCount: 2,
  });
});

test("标签 chip 投影：上限可注入（默认 3），且不改写入参", () => {
  const labels = ["a", "b"];
  assert.deepEqual(workItemLabelChips(labels, 1), { shown: ["a"], hiddenCount: 1 });
  assert.deepEqual(workItemLabelChips(labels), { shown: ["a", "b"], hiddenCount: 0 });
  assert.deepEqual(labels, ["a", "b"], "投影是只读投影，不得就地改写调用方的数组");
});

// ---------- ② 结构守卫：看板行 ----------

/* 守卫 a：看板行渲染 chip（标题之后）+「+N」，且 chip 只有**一处**定义（两个面共用它）。
   变异：把 chip 的 class 常量复制一份到详情页（各自一套外观）⇒ 第二/三条必红。 */
test("守卫｜行渲染标签 chip 与「+N」；chip 定义只有一处（详情页复用同一个组件）", () => {
  // T-P2-R1：行渲染（含标签 chip）抽到共用行模块 —— 断言不变，只换被读的文件（口径：跨三视图共用）。
  // 2026-10-09（看板形态重排）：chip 的**组件与样式常量**随卡片形态重构搬进**行零件**
  // （`workItemRowParts.tsx`，行模块 400 行硬线），行模块仍消费它并原样转出；判据与强度不变。
  const board = readSource("squad/WorkItemRows.tsx");
  const chipParts = readSource("squad/workItemRowParts.tsx");
  assert.ok(board.includes("workItemLabelChips("), "看板行必须走纯函数投影（截断规则一处实现）");
  assert.ok(chipParts.includes('data-testid="work-item-label"'), "chip 的 testid 锚点");
  assert.ok(chipParts.includes('data-testid="work-item-label-more"'), "「+N」的 testid 锚点");
  assert.equal(
    (chipParts.match(/const WORK_ITEM_LABEL_CHIP_CLASSNAME/g) ?? []).length,
    1,
    "chip 的样式常量只有**一处定义**（各写一份外观 = 两个面迟早长得不一样）",
  );
  const detail = readDetailSurface();
  assert.ok(
    detail.includes("WorkItemLabelChip") && !detail.includes("WORK_ITEM_LABEL_CHIP_CLASSNAME"),
    "详情页必须复用共用行模块的 chip 组件，不得自带第二份样式",
  );
});

/* 守卫 b：chip 是**中性**呈现，不得借用语义状态色（DESIGN §11.3 / core semantic colors：
   状态只由语义色表达；标签是描述，不是状态 —— 用绿色 chip 会让「这个标签」读成「这件事成了」）。
   变异：把 chip 的样式常量改成含 `destructive` / `success` / `warning` / `brand` 的 token ⇒ 本守卫必红。 */
test("守卫｜标签 chip 只用中性 token，不含任何语义状态色", () => {
  // 2026-10-09：常量随行词汇件搬进行零件（见上一条的口径说明）—— 判据不变。
  const board = readSource("squad/workItemRowParts.tsx");
  const match = /const WORK_ITEM_LABEL_CHIP_CLASSNAME\s*=\s*([\s\S]*?);/.exec(board);
  assert.ok(match, "chip 的样式常量必须存在且可被文本断言（一处定义）");
  const classname = match[1]!;
  assert.ok(classname.includes("border-border"), "中性边框 token");
  assert.ok(classname.includes("text-foreground-subtlest"), "弱化文字 token");
  for (const semantic of [
    "destructive",
    "success",
    "warning",
    "brand",
    "text-emerald",
    "bg-green",
  ]) {
    assert.ok(
      !classname.includes(semantic),
      `标签 chip 不得出现语义色 token「${semantic}」—— 标签不是状态，状态只由语义色表达`,
    );
  }
});

// ---------- ③ 结构守卫：详情页概览 ----------

/* 守卫 c：详情页的标签**只来自协作读模型**（`state.read.workItem`）。
   变异（M1-5）：改成从 `getSnapshot().workItems` 取 —— 归档行不在快照的 listByWorkspace 口径里，
   于是「已归档但仍有标签」的工作项在详情页会看不到标签，且**不报错**。 */
test("守卫｜详情页标签只来自协作读模型（归档行才看得到），且不截断", () => {
  const detail = readDetailSurface();
  assert.ok(
    detail.includes("workItem.labels.map("),
    "标签必须来自本地解构出的 workItem（= state.read.workItem，协作读模型含归档行）",
  );
  const block = detail.slice(
    detail.indexOf('data-testid="work-item-detail-labels"'),
    detail.indexOf("</section>", detail.indexOf('data-testid="work-item-detail-labels"')),
  );
  assert.ok(block.length > 0, "标签区必须存在（testid 锚点）");
  for (const forbidden of ["snapshot", "roster", "workItemLabelChips"]) {
    assert.ok(
      !block.includes(forbidden),
      `标签区不得出现「${forbidden}」：详情页是全量呈现（不受看板行的 3 个上限约束），` +
        "也不得改用名册/快照取值",
    );
  }
  assert.ok(
    detail.includes("squad.workItemDetail.overview.labelsEmpty"),
    "空标签要给一句「无标签」—— 字段是新加的，什么都不显示会被读成「页面坏了」",
  );
});

// ---------- ④ 结构守卫：编辑面（表单 → 页面 → 服务面） ----------

/* 守卫 d：表单用**同一函数**预检；非 ok ⇒ 显示文案且**不提交**（不得静默截断后提交）。
   变异（M1-2 的 UI 半边）：把预检改成「直接提交 labelsText」⇒ 前两条必红；服务面还会响亮抛，
   于是用户看到的是「失败」而不是「哪里超了」。 */
test("守卫｜表单单点预检：非 ok 显示文案并拦下提交（不静默截断后提交）", () => {
  const dialogs = readSource("squad/SquadCreateDialogs.tsx");
  assert.ok(dialogs.includes("parseWorkItemLabels("), "表单必须用 shared 的同一判据预检");
  const guardIndex = dialogs.indexOf('parsedLabels.kind !== "ok"');
  assert.ok(guardIndex > 0, "必须有「非 ok」分支");
  const branch = dialogs.slice(guardIndex, guardIndex + 400);
  assert.ok(branch.includes("setLabelsError("), "非 ok 必须留下可见文案");
  assert.ok(/return;/.test(branch), "非 ok 必须**拦下提交**（return 在 onSubmit 里）");
  assert.ok(
    dialogs.includes("squad.workItems.labelsTooMany") &&
      dialogs.includes("squad.workItems.labelsTooLong"),
    "两种超限各有自己的文案（条数 / 长度），不得共用一句「输入非法」",
  );
  assert.ok(
    dialogs.includes('data-testid="work-item-labels-error"'),
    "错误文案要有 testid 锚点（可被 e2e 断言）",
  );
});

test("守卫｜表单提交形状：create 与 edit 两支都带 labels（类型上就带得走）", () => {
  const dialogs = readSource("squad/SquadCreateDialogs.tsx");
  const typeDecl = dialogs.slice(
    dialogs.indexOf("export type WorkItemDialogSubmitInput"),
    dialogs.indexOf("export function WorkItemDialog"),
  );
  assert.equal(
    (typeDecl.match(/labels: string\[\]/g) ?? []).length,
    2,
    "create 支与 edit 支各带 labels —— 编辑不带标签会让「改标题」顺手清空标签",
  );
  assert.ok(
    dialogs.includes("initial?.labels"),
    "编辑必须回填既有标签（不回填 ⇒ 提交时把库里的标签清成空）",
  );
  const restore = dialogs.indexOf("initial?.labels");
  assert.ok(
    dialogs.slice(Math.max(0, restore - 200), restore).includes("useState"),
    "回填要走状态初值（受控输入）",
  );
});

/* 守卫 e：页面把归一化后的标签并进两个请求（create 走入参、edit 走 patch）。
   变异：edit 只传 title/body ⇒ 第二条必红（那是「编辑一次把标签清空」的形态）。 */
test("守卫｜WorkItemsPage 把 labels 并进 create 与 edit 两条请求", () => {
  const page = readSource("squad/WorkItemsPage.tsx");
  const createCall = page.slice(
    page.indexOf("service.createWorkItem("),
    page.indexOf("squad.workItems.created"),
  );
  assert.ok(createCall.includes("labels: input.labels"), "create 必须带上标签");
  const editCall = page.slice(
    page.indexOf("service.updateWorkItem("),
    page.indexOf("squad.workItems.updated"),
  );
  assert.ok(
    editCall.includes("labels: input.labels"),
    "edit 必须带上标签（不带 = 把库里已有的标签清空）",
  );
});

/* 守卫 f：对话框装配层把**条目自己**的标签作为编辑初值。
   变异：initial 只给 title/body ⇒ 本守卫必红；后果同守卫 d（编辑即清空标签）。 */
test("守卫｜编辑对话框的初值来自条目本身（title / body / labels 三者齐）", () => {
  const assembly = readSource("squad/WorkItemsPageDialogs.tsx");
  const initial = /initial=\{\{([^}]*)\}\}/.exec(assembly);
  assert.ok(initial, "编辑对话框必须给 initial");
  for (const field of ["title", "body", "labels"]) {
    assert.ok(
      initial[1]!.includes(`${field}:`),
      `initial 缺 ${field}（缺 labels = 编辑即清空标签）`,
    );
  }
});

/* 守卫 f2：properties 的 v1 是**只读呈现**（#11 的范围表；2026-10-07 裁定 Q1）：
   零写者字段（`create` 恒写 `{}`）**不做编辑器**，但也必须**可看** —— 值域无类型契约，
   故非字符串值原样显示 JSON 文本（不猜类型、不做控件）。
   变异：把 properties 块改成只渲染字符串值（丢掉对象/数字）⇒ 第一条必红。 */
test("守卫｜详情页只读呈现 properties：键值对全量、非字符串值原样 JSON 文本、空则不渲染", () => {
  const detail = readDetailSurface();
  assert.ok(
    detail.includes('data-testid="work-item-detail-properties"'),
    "属性区必须存在（v1 = 只读可看；零写者不等于零呈现）",
  );
  assert.ok(
    detail.includes("workItemPropertyValueText("),
    "值的呈现走纯函数（非字符串值 → JSON 文本；判据可被 node:test 钉住）",
  );
  assert.ok(
    !detail.includes("properties: {") && !detail.includes("setProperties"),
    "v1 不得出现 properties 写路径（零写者字段不做编辑器）",
  );
  const block = detail.slice(
    detail.indexOf('data-testid="work-item-detail-properties"'),
    detail.indexOf("</section>", detail.indexOf('data-testid="work-item-detail-properties"')),
  );
  for (const forbidden of ["snapshot", "roster"]) {
    assert.ok(
      !block.includes(forbidden),
      `属性区不得出现「${forbidden}」：与标签同源，取自 state.read.workItem（协作读模型含归档行）`,
    );
  }
  assert.ok(
    /Object\.entries\(workItem\.properties\)/.test(block),
    "键值对由 properties 全量展开（不挑键、不截断）",
  );
});

test("属性值文本：字符串原样、其余原样 JSON 文本（不猜类型）", () => {
  assert.equal(workItemPropertyValueText("已经是一个字符串"), "已经是一个字符串");
  assert.equal(workItemPropertyValueText(42), "42");
  assert.equal(workItemPropertyValueText(true), "true");
  assert.equal(workItemPropertyValueText(null), "null");
  assert.equal(workItemPropertyValueText({ a: 1 }), '{"a":1}');
  assert.equal(workItemPropertyValueText([1, "b"]), '[1,"b"]');
});

// ---------- ⑤ 结构守卫：服务面（标签不进 WHERE / 不分叉规则） ----------
/* 守卫 g：标签是**纯描述**（v1）：不得按它过滤或排序 —— 一旦进 SQL，标签就成了第二套机器判据。
   变异：给 `listByWorkspace` 加 `AND labels LIKE ?` ⇒ 本守卫必红。
   （判据落在 WHERE / ORDER BY 的上下文里，而不是「文件里出现 labels= 」：更新 SET 里的
   `labels=?` 是**写**，与「按标签过滤」是两件事。） */
test("守卫｜services 的 workitem 域内不存在按 labels 的 WHERE / ORDER BY", () => {
  for (const file of [
    "workitem/workItemRepo.ts",
    "workitem/squadRuntimeService.ts",
    "workitem/workItemService.ts",
  ]) {
    const source = readServicesSource(file);
    assert.ok(!/WHERE[\s\S]{0,160}?labels/i.test(source), `${file} 不得在 WHERE 里出现 labels`);
    assert.ok(!/ORDER BY[\s\S]{0,120}?labels/i.test(source), `${file} 不得按 labels 排序`);
  }
});

/* 守卫 h：归一化的**规则**只有一处实现（shared 纯函数），repo 内不得有第二份去重/截断。
   变异：在 repo 里补一份「去重 + 截断到 10 条」⇒ 本守卫必红（且那种实现正是静默半截写入）。 */
test("守卫｜归一化只有一处实现：shared 的 parseWorkItemLabels（repo 不做第二份）", () => {
  const repo = readServicesSource("workitem/workItemRepo.ts");
  assert.ok(
    !repo.includes("parseWorkItemLabels("),
    "repo 不得**调**归一化函数：那会让「写之前过闸」变成「写的时候顺手改值」，拒绝分支就没了",
  );
  assert.ok(
    !/labels[\s\S]{0,80}\.slice\(0,\s*\d+\)/.test(repo),
    "repo 不得截断标签条数（静默截断 = 用户以为全写进去了）",
  );
  // 两个写入口都调同一个函数：建项（workItemService）与编辑（squadRuntimeService）。
  assert.ok(readServicesSource("workitem/workItemService.ts").includes("parseWorkItemLabels("));
  assert.ok(readServicesSource("workitem/squadRuntimeService.ts").includes("parseWorkItemLabels("));
  // 编辑路径必须**先归一化再写**（先写后校验 = 拒绝时库里已被改坏）。
  const runtime = readServicesSource("workitem/squadRuntimeService.ts");
  const updateBody = runtime.slice(
    runtime.indexOf("async updateWorkItem(target, input)"),
    runtime.indexOf("async recordLeaderRun(target, input)"),
  );
  assert.ok(
    updateBody.includes("parseWorkItemLabels(") &&
      updateBody.indexOf("parseWorkItemLabels(") < updateBody.indexOf("updateContent("),
    "归一化必须在写之前（顺序反了：被拒的编辑已经落库）",
  );
});

/* 守卫 i：`updateContent` 的 SET 白名单不得含状态/指派/归档列（源文本 + 行为用例双保险；
   行为用例在 services 的 workItemContentUpdate.test.ts 与 workItemLabels.test.ts）。 */
test("守卫｜updateContent 的 SET 白名单只认 title / body / labels", () => {
  const repo = readServicesSource("workitem/workItemRepo.ts");
  const body = repo.slice(
    repo.indexOf("updateContent(id, patch)"),
    repo.indexOf("updateStatus(id, next, expect)"),
  );
  const pushed = [...body.matchAll(/assignments\.push\("([a-z_]+)=\?"\)/g)].map(
    (match) => match[1],
  );
  assert.deepEqual(
    pushed,
    ["title", "body", "labels", "priority", "start_date", "due_date", "position"],
    "白名单集合是闭集，且顺序稳定（0018 扩三内容字段；R6 再扩 position —— REAL 原样、未给不动现值；creator/identifier_seq 仍在白名单外）",
  );
  for (const column of [
    "status",
    "assignee_type",
    "assignee_id",
    "archived_at",
    "creator_kind",
    "identifier_seq",
  ]) {
    assert.ok(!pushed.includes(column), `白名单不得含 ${column}`);
  }
});

// ---------- ⑥ 两语文案成对 ----------

test("守卫｜标签相关文案两语成对（含占位符一致）", () => {
  const placeholders = (value: string) =>
    [...value.matchAll(/\{(\w+)\}/g)]
      .map((match) => match[1])
      .sort()
      .join(",");
  for (const key of [
    "squad.workItems.labels",
    "squad.workItems.labelsPlaceholder",
    "squad.workItems.labelsTooMany",
    "squad.workItems.labelsTooLong",
    "squad.workItems.labelsMore",
    "squad.workItemDetail.overview.labels",
    "squad.workItemDetail.overview.labelsEmpty",
    "squad.workItemDetail.overview.properties",
  ]) {
    const zh = zhCN[key];
    const en = enUS[key];
    assert.ok(zh, `中文缺 ${key}`);
    assert.ok(en, `英文缺 ${key}`);
    assert.equal(placeholders(zh), placeholders(en), `${key} 的占位符两语必须一致`);
  }
});
