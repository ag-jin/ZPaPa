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
  // 闭集映射指向的键必须恰好是「新增 ∪ 复用」——漏一枚（映射指向一个没人核对的键）或
  // 多一枚（清单里有键没人用）都在这里现形。
  const declared = new Set([...FROZEN_NEW_MESSAGE_IDS, ...REUSED_MESSAGE_IDS]);
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
