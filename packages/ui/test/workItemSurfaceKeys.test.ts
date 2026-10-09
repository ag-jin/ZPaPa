import assert from "node:assert/strict";
import test from "node:test";
import enUS from "../src/i18n/locales/en-US.js";
import zhCN from "../src/i18n/locales/zh-CN.js";
import {
  WORK_ITEM_COLUMN_MESSAGE_IDS,
  WORK_ITEM_PRIORITY_FILTER_MESSAGE_IDS,
  WORK_ITEM_SORT_DIRECTION_MESSAGE_IDS,
  WORK_ITEM_SORT_MESSAGE_IDS,
  WORK_ITEM_STATUS_FILTER_MESSAGE_IDS,
  WORK_ITEM_VIEW_MODE_MESSAGE_IDS,
} from "../src/squad/workItemSurfaceViewModel.js";

/* **阶段二键目录冻结**（T-P2-R1 的交付物之一，承重验收 6）。

   为什么单独一个用例文件：阶段二的并行组（PG-4a = {R2, R4}，R3 随后）成立的前提是
   「文案键与本轮一次落定」—— 否则三条并行作业都会去改 `locales` 这个**串行点**文件而互相踩。
   本文件是那份「已冻结清单」的可执行版本：**新增键 ⇒ 这里与两语 locale 都必须显式更新**，
   而不是某一轮顺手加一枚没人复验的键。

   ⚠️ 纪律（handoff 给 R2-R5）：**不得再加键**。确实缺键时按阻塞上报（主会话裁定一次），
   不要就地加 —— 就地加等于把并行方案的前提拆掉，且没有第二双眼睛看过那枚键。

   期望值来源：拆解卡 §阶段二 T-P2-R1 的验收 6（视图名 / 列标题 / 过滤·搜索·排序标签 / 空结果态）
   + 本文件与 `workItemSurfaceViewModel` 的闭集映射（键 id 由**闭集**推导，不是手抄）。 */

/** 本阶段**新增**的键（逐条具名：键目录冻结轮之后，加一枚键就得显式改这份清单与两语 locale）。 */
const FROZEN_NEW_MESSAGE_IDS: string[] = [
  // 视图（视图切换控件 + 三视图的锚点文案）
  "squad.workItems.view.label",
  "squad.workItems.view.board",
  "squad.workItems.view.list",
  "squad.workItems.view.table",
  // 过滤（facet 分组标签、`all` 选项、清除入口）
  "squad.workItems.filter.label",
  "squad.workItems.filter.all",
  "squad.workItems.filter.clear",
  // 搜索
  "squad.workItems.search.label",
  "squad.workItems.search.placeholder",
  "squad.workItems.search.clear",
  // 排序（键 + 方向）
  "squad.workItems.sort.label",
  "squad.workItems.sort.manual",
  "squad.workItems.sort.priority",
  "squad.workItems.sort.startDate",
  "squad.workItems.sort.dueDate",
  "squad.workItems.sort.title",
  "squad.workItems.sort.asc",
  "squad.workItems.sort.desc",
  // 列（列目录标签 + 三枚缺的列标题；其余列标题复用既有字段键）
  "squad.workItems.columns.label",
  "squad.workItems.field.identifier",
  "squad.workItems.field.status",
  "squad.workItems.field.assignee",
  // 空结果态（与既有 `squad.workItems.empty` 那两枚**分开**：两态不能共用一句话）
  "squad.workItems.filteredEmpty",
  "squad.workItems.filteredEmptyHint",
  // 批量工具栏（T-P2-R5 用；本轮冻结以避免 R5 再碰 locales 这个串行点）
  "squad.workItems.bulk.label",
  "squad.workItems.bulk.selected",
  "squad.workItems.bulk.selectRow",
  "squad.workItems.bulk.clear",
  "squad.workItems.bulk.apply",
  "squad.workItems.bulk.result",
];

/** 本阶段**复用**的既有键（facet 选项与部分列标题）—— 复用也必须真的存在且两语齐全。 */
const REUSED_MESSAGE_IDS: string[] = [
  "squad.workItems.lane.statusCategory.unstarted",
  "squad.workItems.lane.statusCategory.started",
  "squad.workItems.lane.statusCategory.done",
  "squad.workItems.lane.statusCategory.closed",
  "squad.workItems.priority.urgent",
  "squad.workItems.priority.high",
  "squad.workItems.priority.medium",
  "squad.workItems.priority.low",
  "squad.workItems.priority.unset",
  "squad.workItems.priority",
  "squad.workItems.labels",
  "squad.workItems.startDate",
  "squad.workItems.dueDate",
  "squad.workItems.creator",
];

/* ---------- 破例段之二（R-P2 项目绑定 · UI 轮） ----------

   背景：用户裁定「项目绑定完整做」，UI 轮要在三处表达项目（拾取器 / 分组列 / 过滤 + 卡片 chip）
   并在拾取器里内联新建项目 —— 原 30 枚冻结清单与 views 破例段里一枚都没有。派发单给的额度是
   **≤10 枚**，本段用 **8 枚**（每枚都有落点）：
   · `project`（拾取器 / 过滤 / 表头 / 列配置共用一句）；
   · `project.none`（无项目：下拉选项 + 分组列 + 过滤开关共用一句）；
   · `project.new`（拾取器里的「新建项目…」入口）；
   · `project.shortCode` / `shortCodePlaceholder`（内联表单的两枚标签/占位）；
   · `project.shortCodeInvalid` / `project.nameRequired`（两枚预检句，成对：坏在哪一项说哪一项）；
   · `lane.dimension.project`（Group by 的第四档）。
   **不允许的第 9、10 枚留给后续轮**：本段断言「恰 8 枚 + locale 里 project.* 也恰好这 7 枚」。 */
const PROJECT_BINDING_MESSAGE_IDS: string[] = [
  "squad.workItems.project",
  "squad.workItems.project.none",
  "squad.workItems.project.new",
  "squad.workItems.project.shortCode",
  "squad.workItems.project.shortCodePlaceholder",
  "squad.workItems.project.shortCodeInvalid",
  "squad.workItems.project.nameRequired",
  "squad.workItems.lane.dimension.project",
];

test("键目录冻结｜破例段之二（R-P2 项目绑定）：恰 8 枚（额度 10）、不与前两段重号、两语齐备", () => {
  assert.equal(
    new Set(PROJECT_BINDING_MESSAGE_IDS).size,
    PROJECT_BINDING_MESSAGE_IDS.length,
    "本段不得有重复键",
  );
  assert.equal(PROJECT_BINDING_MESSAGE_IDS.length, 8, "R-P2 新增键数（派发单额度 ≤10）");
  assert.ok(
    PROJECT_BINDING_MESSAGE_IDS.length <= 10,
    "越过派发单给的 10 枚额度 ⇒ 这里必红（先上报、再决定加不加）",
  );
  for (const id of PROJECT_BINDING_MESSAGE_IDS) {
    assert.ok(
      !FROZEN_NEW_MESSAGE_IDS.includes(id) && !VIEW_BAR_EXCEPTION_MESSAGE_IDS.includes(id),
      `${id} 不得与前两段重号（三段各管一段历史）`,
    );
  }
  for (const key of PROJECT_BINDING_MESSAGE_IDS) {
    const zh = zhCN[key];
    const en = enUS[key];
    assert.ok(zh, `zh-CN 缺 ${key}`);
    assert.ok(en, `en-US 缺 ${key}`);
    assert.equal(placeholders(zh), placeholders(en), `${key} 的占位符两语必须一致`);
  }
});

test("键目录冻结｜破例段之二用满且不越界：两语 locale 里的 project.* 键**恰好**这 7 枚", () => {
  for (const [localeName, locale] of [
    ["zh-CN", zhCN],
    ["en-US", enUS],
  ] as const) {
    const declared = Object.keys(locale).filter((key) => key.startsWith("squad.workItems.project."));
    assert.deepEqual(
      [...declared].sort(),
      [
        "squad.workItems.project.nameRequired",
        "squad.workItems.project.new",
        "squad.workItems.project.none",
        "squad.workItems.project.shortCode",
        "squad.workItems.project.shortCodeInvalid",
        "squad.workItems.project.shortCodePlaceholder",
      ].sort(),
      `${localeName} 的 project.* 键集必须与破例段逐枚一致（多的 = 越界加键，少的 = 用了裸 key）`,
    );
  }
});

const placeholders = (value: string) =>
  [...value.matchAll(/\{(\w+)\}/g)]
    .map((match) => match[1])
    .sort()
    .join(",");

test("键目录冻结｜新增键恰 30 枚、无重复，且与闭集映射（新增 ∪ 复用）逐项一致", () => {
  assert.equal(
    new Set(FROZEN_NEW_MESSAGE_IDS).size,
    FROZEN_NEW_MESSAGE_IDS.length,
    "冻结清单自身不得有重复键（重复会让「恰 N 枚」失去意义）",
  );
  assert.equal(FROZEN_NEW_MESSAGE_IDS.length, 30, "新增键规模（加键 ⇒ 这里必须显式改）");
  for (const id of [...FROZEN_NEW_MESSAGE_IDS, ...REUSED_MESSAGE_IDS]) {
    assert.ok(id.startsWith("squad.workItems."), `${id} 必须在本面的命名空间下`);
  }
  // 闭集映射指向的键必须恰好是「新增 ∪ 复用 ∪ 两段破例」——漏一枚（映射指向一个没人核对的键）或
  // 多一枚（清单里有键没人用）都在这里现形。
  const declared = new Set([
    ...FROZEN_NEW_MESSAGE_IDS,
    ...REUSED_MESSAGE_IDS,
    ...VIEW_BAR_EXCEPTION_MESSAGE_IDS,
    ...PROJECT_BINDING_MESSAGE_IDS,
  ]);
  for (const [what, values] of [
    ["视图名", Object.values(WORK_ITEM_VIEW_MODE_MESSAGE_IDS)],
    ["排序键", Object.values(WORK_ITEM_SORT_MESSAGE_IDS)],
    ["排序方向", Object.values(WORK_ITEM_SORT_DIRECTION_MESSAGE_IDS)],
    ["状态 facet", Object.values(WORK_ITEM_STATUS_FILTER_MESSAGE_IDS)],
    ["优先级 facet", Object.values(WORK_ITEM_PRIORITY_FILTER_MESSAGE_IDS)],
    ["列标题", Object.values(WORK_ITEM_COLUMN_MESSAGE_IDS)],
  ] as const) {
    for (const id of values) {
      assert.ok(declared.has(id), `${what} 映射指向了未冻结的键 ${id}`);
    }
  }
});

test("键目录冻结｜新增键两语齐全、占位符成对（缺一枚 = 界面上出现裸 key）", () => {
  for (const key of FROZEN_NEW_MESSAGE_IDS) {
    const zh = zhCN[key];
    const en = enUS[key];
    assert.ok(zh, `zh-CN 缺键 ${key}`);
    assert.ok(en, `en-US 缺键 ${key}`);
    assert.equal(placeholders(zh), placeholders(en), `${key} 的占位符两语必须一致`);
    assert.ok(zh.length > 0 && en.length > 0, `${key} 不得为空串`);
  }
});

/* 复用既有键的 facet 选项与列标题：它们**不属于**新键，但仍必须两语齐全 ——
   「复用」不是「假设它存在」（复用到一个不存在的键 = 界面上出现裸 key）。 */
test("键目录冻结｜复用的既有键两语齐全（复用不是「假设它存在」）", () => {
  for (const key of REUSED_MESSAGE_IDS) {
    assert.ok(zhCN[key], `zh-CN 缺被复用的键 ${key}`);
    assert.ok(enUS[key], `en-US 缺被复用的键 ${key}`);
  }
});

/* 两态文案必须**不同**（R4 验收 2：无匹配 vs 还没有工作项）—— 共用一句话会让「筛掉了什么」
   和「本来就没有」变成同一件事。 */
test("键目录冻结｜「无匹配」与「还没有工作项」是两套不同的文案", () => {
  for (const locale of [zhCN, enUS]) {
    assert.notEqual(locale["squad.workItems.filteredEmpty"], locale["squad.workItems.empty"]);
    assert.notEqual(
      locale["squad.workItems.filteredEmptyHint"],
      locale["squad.workItems.emptyHint"],
    );
  }
});

/* ---------- 破例段（T-P2-R6b，主会话第 251 轮裁定） ----------

   背景：第 251 轮的拆解**漏排了 saved views**（R4 把保存视图划出 out-of-scope，阶段二无施工轮），
   补排的 R6 卡对「零键增」纪律**显式破例**：视图条 / 保存对话框 / 删除确认 / 消失提示需要文案，
   原 30 枚冻结清单里一枚都没有。破例额**定死 12 枚**（卡与简报同一份清单，不得再超）。

   这一段的判据与上面基础段同款（两语齐备 / 占位符成对 / 枚枚有落点），只多一条「**不得超**」：
   变异（顺手加第 13 枚 views 键）⇒ 本用例红。 */

/** 破例段（**12 枚**：卡上列出的最小集；第 12 枚 `shared` 见下面注释）。 */
const VIEW_BAR_EXCEPTION_MESSAGE_IDS: string[] = [
  "squad.workItems.views.label",
  "squad.workItems.views.new",
  "squad.workItems.views.save",
  "squad.workItems.views.saveAs",
  "squad.workItems.views.edit",
  "squad.workItems.views.delete",
  "squad.workItems.views.deleteConfirmTitle",
  "squad.workItems.views.deleteConfirmBody",
  "squad.workItems.views.manage",
  "squad.workItems.views.namePlaceholder",
  /* ⚠️ 卡上写「12 枚」但逐条只列了 11 枚（`label/save/namePlaceholder/delete/deleteConfirmTitle/
     deleteConfirmBody/edit/saveAs/manage/new/missingToast`）。第 12 枚取 `shared`：可见性控件
     必须在对话框里表达（二值 ⇒ 单枚勾选文案，而不是两枚选项标签），否则"共享给工作区"这件事
     在界面上说不出来（服务面支持 visibility=workspace 却没有入口）。**总数仍是 12，未超上限**；
     这处对账差异已登记给 T-P2-V（第 251 轮裁定原文与实列枚数的差额）。 */
  "squad.workItems.views.shared",
  "squad.workItems.views.missingToast",
];

test("键目录冻结｜破例段（第 251 轮）：views 键恰 12 枚、不与基础段重号、两语齐备", () => {
  assert.equal(
    new Set(VIEW_BAR_EXCEPTION_MESSAGE_IDS).size,
    VIEW_BAR_EXCEPTION_MESSAGE_IDS.length,
    "破例段自身不得有重复键",
  );
  assert.equal(VIEW_BAR_EXCEPTION_MESSAGE_IDS.length, 12, "破例额**定死 12 枚**（超 ⇒ 这里必红）");
  for (const id of VIEW_BAR_EXCEPTION_MESSAGE_IDS) {
    assert.ok(
      !FROZEN_NEW_MESSAGE_IDS.includes(id),
      `${id} 不得与基础冻结段重号（两段各管一段历史，重号会让"30 枚"失去意义）`,
    );
  }
  for (const key of VIEW_BAR_EXCEPTION_MESSAGE_IDS) {
    const zh = zhCN[key];
    const en = enUS[key];
    assert.ok(zh, `zh-CN 缺破例句 ${key}`);
    assert.ok(en, `en-US 缺破例句 ${key}`);
    assert.equal(placeholders(zh), placeholders(en), `${key} 的占位符两语必须一致`);
    assert.ok(zh.length > 0 && en.length > 0, `${key} 不得为空串`);
  }
});

test("键目录冻结｜破例段用满且不越界：两语 locale 里的 views.* 键**恰好**是这 12 枚", () => {
  for (const [localeName, locale] of [
    ["zh-CN", zhCN],
    ["en-US", enUS],
  ] as const) {
    const declared = Object.keys(locale).filter((key) => key.startsWith("squad.workItems.views."));
    assert.deepEqual(
      [...declared].sort(),
      [...VIEW_BAR_EXCEPTION_MESSAGE_IDS].sort(),
      `${localeName} 的 views.* 键集必须与破例段逐枚一致（多的 = 越界加键，少的 = 用了裸 key）`,
    );
  }
});
