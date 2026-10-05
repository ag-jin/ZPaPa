import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import type { Squad, TeamAgent } from "@zcode/shared";
import type { SquadSnapshot } from "@zcode/services";
import enUS from "../src/i18n/locales/en-US.js";
import zhCN from "../src/i18n/locales/zh-CN.js";
import {
  assigneeOptionValue,
  parseAssigneeValue,
  workItemAssigneeOptions,
} from "../src/squad/squadEntryViewModel.js";

/* 「改派」入口（看板行「改派」钮 → ReassignWorkItemDialog → 页面 → 服务面 `reassignWorkItem`）
   的用例：**纯逻辑 + 结构守卫**（ui 包没有渲染测试设施，这是本项目既定做法，见
   squadEntryView.test.ts / workItemsPage.test.ts）。分工：
   ① `assigneeOptionValue`（反解）：三格 + 未知 id 回落口径 + 与 `parseAssigneeValue` 的往返；
   ② 结构守卫：看板有改派钮（所有行、与编辑同级）、页面有对话框接线与提交路径（同值 ⇒「未变更」、
      busy 期间禁重复提交、失败经既有翻译）、对话框复用既有候选 / 解析（**不另写**）；
   ③ i18n 四键两语齐全。每条守卫都写明变异方式，并在交付报告里逐条实测。 */

const SRC_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "../src");
const readSource = (relativePath: string) => readFileSync(resolve(SRC_DIR, relativePath), "utf8");

// ---------- ① 反解（assignee → 选项 value） ----------

/* 三格：user / agent / squad 各自的编码（与 `workItemAssigneeOptions` 的 value 同源）。
   变异（M4）：把 squad 也解成 `agent:` 前缀（或把 user 解成 `agent:`）⇒ 本用例必红。 */
test("反解三格：user / agent / squad 解出候选里用的那种 value", () => {
  assert.equal(assigneeOptionValue({ type: "user", id: "user" }), "user");
  assert.equal(assigneeOptionValue({ type: "agent", id: "a1" }), "agent:a1");
  assert.equal(assigneeOptionValue({ type: "squad", id: "s1" }), "squad:s1");
});

/* 未知 id（对象不在快照里：智能体已归档 / 小队被删）的**回落口径**（本文件定义，写清）：
   仍按原编码返回，**不**回落成 `"user"`、也不改判成别的对象 —— value 表达的是「现在指给谁」这个
   事实；回落成 user 会让「打开对话框、原样提交」变成一次用户没要求的改派（库里真的会变、还会
   发派发事件）。对话框把当前值补进选项显示它；原样提交由服务面同值短路（assigned:false）。 */
test("反解未知 id：原样编码（不回落成 user、不静默换对象）", () => {
  assert.equal(assigneeOptionValue({ type: "agent", id: "ghost" }), "agent:ghost");
  assert.equal(assigneeOptionValue({ type: "squad", id: "ghost" }), "squad:ghost");
  assert.notEqual(
    assigneeOptionValue({ type: "agent", id: "ghost" }),
    "user",
    "未知 id 不得回落成 user（那是一次用户没要求的改派）",
  );
});

/* 往返：反解出的 value 必须被既有解析原样解回**同一个** assignee（两条编码同源；
   任一侧改了前缀/分隔符，这条必红）。 */
test("往返：parseAssigneeValue(assigneeOptionValue(x)) 原样还原 x", () => {
  for (const assignee of [
    { type: "user", id: "user" },
    { type: "agent", id: "a1" },
    { type: "squad", id: "s1" },
    { type: "agent", id: "ghost" },
  ] as const) {
    assert.deepEqual(parseAssigneeValue(assigneeOptionValue(assignee)), assignee);
  }
  // 反解出的值必须真的在**候选**里（三格都造齐的快照）——否则对话框初值时选不中任何一项。
  const snapshot: SquadSnapshot = {
    enabled: true,
    teamAgents: [{ id: "a1", name: "张三", enabled: true } as TeamAgent],
    squads: [{ id: "s1", name: "第 1 小队", enabled: true } as Squad],
    workItems: [],
    runs: [],
    queuedRuns: [],
  };
  const values = new Set(workItemAssigneeOptions(snapshot).map((option) => option.value));
  for (const assignee of [
    { type: "user", id: "user" },
    { type: "agent", id: "a1" },
    { type: "squad", id: "s1" },
  ] as const) {
    assert.ok(values.has(assigneeOptionValue(assignee)), `${assignee.type} 的反解值必须在候选里`);
  }
});

// ---------- ② 结构守卫：看板行 ----------

/* 守卫 a：看板行有「改派」钮（`data-testid="work-item-reassign"`）。
   变异：删掉钮（或把它挪进某个条件分支）⇒ 本用例必红。
   所有行都有（**含子项**）：钮在**行内动作簇**里、与编辑同级 —— 中间不得隔一个条件门。 */
test("守卫｜看板行有「改派」钮：在行内动作簇里、与编辑同级、所有行都给", () => {
  const board = readSource("squad/WorkItemsBoard.tsx");
  assert.equal(
    (board.match(/work-item-reassign/g) ?? []).length,
    1,
    "改派钮只该有一处（为别的形态另抄一份 = 同一语义两处实现）",
  );
  const editAt = board.indexOf('data-testid="work-item-edit"');
  const reassignAt = board.indexOf('data-testid="work-item-reassign"');
  const discardAt = board.indexOf('data-testid="work-item-discard"');
  assert.ok(editAt >= 0, "行内要有「编辑」钮（改派的同级参照）");
  assert.ok(reassignAt > editAt, "「改派」钮紧随「编辑」（同一行内动作簇）");
  assert.ok(discardAt > reassignAt, "「改派」与「编辑」并列在「放弃整批」之前");
  // 中间不得出现条件门（`? (`）：废弃按钮挂在 `discardableIds.has(item.id) ?` 上，改派**不**挂门。
  assert.ok(
    !board.slice(editAt, reassignAt).includes("? ("),
    "改派钮不得挂条件门（所有行都给，含子项 —— 与编辑同款）",
  );
  assert.ok(
    board.slice(reassignAt, discardAt).includes("disabled={busy}"),
    "有请求在飞时改派钮置灰",
  );
  assert.ok(board.includes("onReassign(item)"), "钮点击必须把意图交给页面（onReassign(item)）");
  assert.ok(board.includes("onReassign: (item: WorkItem) => void"), "onReassign 是看板的入参契约");
});

// ---------- ② 结构守卫：页面 ----------

/* 守卫 b：页面接线四件 —— 状态、对话框、提交经服务面、两种结论各有其词。
   变异：删 `reassignWorkItem(` 调用 / 把同值结论也报成「已改派」⇒ 对应断言必红。 */
test("守卫｜WorkItemsPage 有改派状态与对话框接线，提交经 reassignWorkItem（同值 ⇒ 未变更）", () => {
  const page = readSource("squad/WorkItemsPage.tsx");
  assert.ok(
    page.includes("useState<WorkItem | null>(null)"),
    "改派目标是一个页面状态（WorkItem | null）",
  );
  assert.ok(page.includes("setReassignTarget(item)"), "看板的 onReassign 必须落到页面状态");
  assert.ok(page.includes("<WorkItemsPageDialogs"), "页面必须接线对话框装配组件");
  const dialogs = readSource("squad/WorkItemsPageDialogs.tsx");
  assert.ok(dialogs.includes("<ReassignWorkItemDialog"), "必须渲染改派对话框");
  assert.ok(page.includes("reassignWorkItem("), "提交必须经服务面 reassignWorkItem");
  assert.ok(
    page.includes('"squad.workItems.reassigned"') &&
      page.includes('"squad.workItems.reassignUnchanged"'),
    "assigned 的两个结论各有其词（true ⇒ 已改派；false ⇒ 未变更）",
  );
  assert.ok(page.includes("squadEntryErrorFeedback("), "失败经既有翻译（含门禁拒绝，不吞错）");
  // busy 期间禁重复提交（照 submitDialog 的前置判断形态）。
  const submitAt = page.indexOf("const submitReassign");
  const submitRegion = page.slice(submitAt, submitAt + 2_000);
  assert.ok(submitRegion.includes("busyWorkItemId !== null"), "提交前必须挡掉 busy 期间的重复提交");
  // 语义不揉脏：改派不走 runAction（后者成功即 setDialog(null)，且没有 assigned:false 这一种结论）。
  assert.ok(
    !/runAction\(\s*item\.id,\s*\(service\) => service\.reassignWorkItem/.test(page),
    "改派不得经 runAction（它没有「未变更」这一种结论）",
  );
});

/* 守卫 c：对话框**复用**既有候选与解析，不得另写一份。
   变异：在对话框里重造候选数组（例如自拼 `agent:` 前缀）⇒ 本用例必红。 */
test("守卫｜ReassignWorkItemDialog 用既有 workItemAssigneeOptions / parseAssigneeValue / assigneeOptionValue", () => {
  const dialog = readSource("squad/ReassignWorkItemDialog.tsx");
  assert.ok(
    dialog.includes("workItemAssigneeOptions("),
    "候选必须来自既有 workItemAssigneeOptions",
  );
  assert.equal(
    (dialog.match(/parseAssigneeValue\(/g) ?? []).length,
    1,
    "取值只经既有 parseAssigneeValue（恰一处）",
  );
  assert.equal(
    (dialog.match(/assigneeOptionValue\(/g) ?? []).length,
    1,
    "初值只经反解 assigneeOptionValue（恰一处）",
  );
  assert.ok(
    !dialog.includes("`agent:") && !dialog.includes('"agent:'),
    "不得自拼 agent: 前缀（第二份编码迟早与候选漂移，而漂移不报错）",
  );
  // 壳与原语复用（与三个创建 / 编辑表单同款）。
  assert.ok(dialog.includes("<CreateDialogShell"), "复用 squadDialogParts 的对话框壳");
  assert.ok(dialog.includes("<Field"), "复用 Field 原语");
  assert.ok(dialog.includes('titleId="squad.workItems.reassignTitle"'), "标题文案键");
  assert.ok(dialog.includes('submitLabelId="squad.workItems.reassign"'), "提交按钮文案键（改派）");
  // 本组件不执行任何服务调用（执行只在页面）。
  assert.ok(!dialog.includes("reassignWorkItem("), "对话框只回意图，不执行服务调用");
});

// ---------- ③ i18n ----------

/* spec §11.4：所有新文案必须两语齐全，只写一种语言时另一种语言直接显示裸 key。
   变异：删任一语的一条 ⇒ 本用例必红。 */
test("改派四键两语齐全（zh-CN / en-US）", () => {
  for (const key of [
    "squad.workItems.reassign",
    "squad.workItems.reassignTitle",
    "squad.workItems.reassigned",
    "squad.workItems.reassignUnchanged",
  ]) {
    assert.ok(zhCN[key], `zh-CN 缺少 ${key}`);
    assert.ok(enUS[key], `en-US 缺少 ${key}`);
  }
  // 复用既有键：取消与「指派给 / 我」（对话框的按钮与字段文案不带第二份）。
  for (const key of [
    "squad.common.cancel",
    "squad.common.assignee",
    "squad.common.assignee.user",
  ]) {
    assert.ok(zhCN[key] && enUS[key], `既有键 ${key} 必须在（对话框复用它们）`);
  }
});
