import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { WorkItem } from "@zcode/shared";
import { ZCodeIntlProvider } from "../src/i18n/IntlProvider.js";
import { WorkItemsSurface } from "../src/squad/WorkItemsSurface.js";
import { workItemSurfaceDefaultState } from "../src/squad/workItemSurfaceViewModel.js";

/* 工作项**行内编辑**（阶段一轮 D，T-P1-R4）的**呈现与接线**守卫：真渲染 + 结构断言。

   与 `workItemInlineEditViewModel.test.ts` 的分工：那边钉判据（字段 → patch、失败文案、归档判据、
   文案键），这边钉「它怎么被用」—— 编辑器的 JSX 进 `renderRow` 单点、blur / Enter / Escape 三条
   键盘语义、失败就地提示且不清行、行内写只有一条路径（页面 `updateWorkItem`）、归档行不给入口。

   本包没有渲染测试设施，但**真渲染**（`react-dom/server` + 真 `ZCodeIntlProvider`）是既有先例
   （workItemProperties / workItemDetailPage 都这么做）—— 行内入口的「有 / 无」只有渲染出来才看得见。 */

const SRC_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "../src");
const readSource = (relativePath: string) => readFileSync(resolve(SRC_DIR, relativePath), "utf8");
/** 去掉注释再扫：注释里提到坏写法是**说明**，不是坏写法本身（照 workItemProperties 的既有做法）。 */
const stripComments = (source: string) =>
  source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

/** 造一条工作项（只给本组用例关心的字段）。 */
function wi(overrides: Partial<WorkItem> = {}): WorkItem {
  return {
    id: "wi-1",
    workspaceIdentity: "ws",
    workspacePath: "/w",
    title: "标题",
    body: "",
    status: "todo",
    assignee: { type: "user", id: "user" },
    labels: [],
    properties: {},
    position: 0,
    ...overrides,
  };
}

/** 页面把写路径交给宿主；这里只回答「写成功」（失败形态由页面的守卫钉住）。 */
const inlineEditSucceeds = async () => null;

function renderInlineBoard(workItems: WorkItem[]): string {
  const snapshot = {
    enabled: true,
    teamAgents: [],
    squads: [],
    workItems,
    runs: [],
    queuedRuns: [],
  };
  return renderToStaticMarkup(
    createElement(ZCodeIntlProvider, {
      initialLocale: "zh-CN" as const,
      children: createElement(WorkItemsSurface, {
        workItems,
        snapshot,
        discardableIds: new Set<string>(),
        busyWorkItemId: null,
        timelineExpandedWorkItemId: null,
        laneDimension: "none" as const,
        // T-P2-R1：渲染根从看板改为 **Surface 宿主**（行渲染/聚焦/编辑态都在宿主装配后交给行模块）。
        surface: workItemSurfaceDefaultState(),
        // T-P2-R3：宿主新增意图透传（table 的表头排序/列显隐消费它）；本用例只渲染。
        onSurfaceIntent: () => {},
        onEdit: () => {},
        onInlineEdit: inlineEditSucceeds,
        onReassign: () => {},
        onDiscard: () => {},
        onToggleTimeline: () => {},
        onOpenWorkItemDetail: () => {},
        workspacePath: "/w",
      }),
    }),
  );
}

/* 守卫｜标题入口的**有/无**由归档判据决定（同一份 writeDisabledReason）：
   普通行给标题编辑入口；归档行不给，并把原因写在只读标题上。
   变异：把入口无条件渲染 ⇒ 第二条必红；归档行也当可编辑 ⇒ 第一、二条必红。 */
test("真渲染｜标题行内入口：普通行给；归档行不给（附同一份判据的原因）", () => {
  const open = renderInlineBoard([wi({ title: "改我" })]);
  assert.ok(open.includes('data-testid="work-item-title-edit"'), "标题可点开编辑");
  assert.ok(open.includes("改我"), "非编辑态仍逐字显示标题（不是只剩输入框）");

  const archived = renderInlineBoard([wi({ archivedAt: 1 })]);
  assert.ok(
    !archived.includes('data-testid="work-item-title-edit"'),
    "归档行不给标题编辑入口（归档 = 只读）",
  );
  assert.ok(
    archived.includes("工作项已归档，不能行内编辑"),
    "归档行要说得出口为什么不能改（文案来自同一份判据）",
  );
});

/* 守卫｜标题行内编辑的**三条语义**（multica 原文）：blur 提交 / Enter 提交 / Escape 恢复。
   三条都要在**同一个**编辑器实现里，且编辑态里的键盘事件**不冒泡**（行导航与全局快捷键不吃它们）。
   分层（max-lines 400 的硬约束，见 hook 文件头）：**呈现**（编辑器 JSX）在 renderRow 一处、
   **交互状态与键盘语义**在 `useWorkItemInlineEdit` 一处 —— 两处都只有一份实现。
   变异（M1）：删掉 Escape 分支 ⇒ 第三条必红；变异（M2）：删掉 stopPropagation ⇒ 第四条必红。 */
test("守卫｜标题行内编辑：blur / Enter 提交、Escape 恢复（不提交）、编辑态阻止冒泡", () => {
  // T-P2-R1：行渲染（含编辑器 JSX）在共用行模块 —— 单点口径是「跨三视图共用同一模块」。
  const board = readSource("squad/WorkItemRows.tsx");
  const hook = stripComments(readSource("squad/useWorkItemInlineEdit.ts"));
  assert.equal(
    (board.match(/data-testid="work-item-title-edit"/g) ?? []).length,
    1,
    "标题编辑入口单点（编辑器进行模块一份实现，不复制行 JSX）",
  );
  assert.equal((board.match(/data-testid="work-item-title-input"/g) ?? []).length, 1);
  assert.ok(
    board.includes("onBlur={() => inlineEdit.commitTitleEdit(item)}"),
    "blur = 提交（原文语义）",
  );
  assert.ok(
    board.includes("onKeyDown={(event) => inlineEdit.handleTitleKeyDown(item, event)}"),
    "编辑态的键盘语义走同一个处理器",
  );

  /* 键位 → 意图的**判据**在纯函数（`resolveWorkItemInlineTitleKeyIntent`，逐格用例在
     workItemInlineEditViewModel.test.ts）；本层只执行结论 —— 因此这里钉两件事：
     ① 回调把三格输入（键、组合态、原生 isComposing）**原样**交给那个判据；
     ② 三种意图各有归宿（commit ⇒ 提交、cancel ⇒ 取消、ignore ⇒ 直接返回）。
     变异（M5 复验口径）：摘掉判据里的组合期早退 ⇒ 那边逐格用例红；把本层对判据的调用删掉
     （自己重写一份 if-else）⇒ 第一条必红。 */
  const keydown = hook.slice(
    hook.indexOf("handleTitleKeyDown: (item, event) => {"),
    hook.indexOf("commitPriorityEdit: (item, selectValue) => {"),
  );
  assert.ok(
    keydown.includes("resolveWorkItemInlineTitleKeyIntent({") &&
      keydown.includes("key: event.key") &&
      keydown.includes("compositionActive: composingRef.current") &&
      keydown.includes("isComposing: event.nativeEvent.isComposing"),
    "键盘意图必须交给纯函数判据（键 + 组合态 + 原生 isComposing 三格输入都带上）",
  );
  assert.ok(keydown.includes('if (intent === "ignore") return;'), "ignore ⇒ 不吃这个键");
  assert.ok(
    keydown.includes('if (intent === "commit")') && keydown.includes("commitTitleEdit(item)"),
    "commit ⇒ 走同一个提交函数（两条路不各写一遍）",
  );
  assert.ok(
    keydown.includes("cancelTitleEdit()"),
    "cancel ⇒ 走取消路径（Escape 恢复原值，不是提交）",
  );
  assert.ok(
    keydown.includes("event.stopPropagation()"),
    "编辑态的键盘事件不冒泡（Escape / Enter 不喂给行导航与全局快捷键）",
  );
  assert.ok(
    !keydown.includes('event.key === "Enter"') && !keydown.includes('event.key === "Escape"'),
    "本层不得再自写一份键位判据（两份判据迟早分叉，且分叉不报错）",
  );

  const cancel = hook.slice(hook.indexOf("cancelTitleEdit = () => {"), hook.indexOf("return {"));
  assert.ok(cancel.includes("setTitleEdit(null)"), "取消 = 丢弃草稿、关掉编辑器（恢复原值）");
  assert.ok(
    !cancel.includes("onInlineEdit(") && !cancel.includes("submit("),
    "取消**不得**触发写入（Escape 恢复的是原值，不是「保存我按 Escape 时看到的东西」）",
  );
});

/* 守卫｜失败**不吞**：就地留下原因 + 草稿原样留着（不静默回退成旧值、不清行）。
   变异（M3）：失败分支也把编辑器关掉（或把草稿重置成 item.title）⇒ 第二条必红。 */
test("守卫｜提交失败：就地提示且保留用户输入（不清行、不静默回退）", () => {
  const board = readSource("squad/WorkItemRows.tsx");
  const hook = stripComments(readSource("squad/useWorkItemInlineEdit.ts"));
  const parts = stripComments(readSource("squad/WorkItemInlineEditParts.tsx"));
  const submit = hook.slice(hook.indexOf("const submit = ("), hook.indexOf("commitTitleEdit,"));
  assert.ok(submit.includes("setFailure({"), "失败要有就地原因（交回给行渲染）");
  /* 失败**保留用户输入**的结构判据：写回调里 `clearDraft()` 只准出现一次（成功分支）——
     失败分支再收一次草稿，就等于把用户刚打的字静默丢掉（界面看起来像改成功了）。 */
  const writeCallback = submit.slice(
    submit.indexOf(".then((feedback) => {"),
    submit.indexOf(".finally("),
  );
  assert.ok(writeCallback.length > 0, "写回调必须存在且可被断言");
  assert.equal(
    (writeCallback.match(/clearDraft\(\)/g) ?? []).length,
    1,
    "只有成功分支收草稿；失败分支保留用户输入（不清行、不静默回退）",
  );
  assert.ok(
    (writeCallback.match(/setFailure\(\{/g) ?? []).length === 1,
    "失败归宿只此一处（不散在两处各写一遍）",
  );
  assert.ok(
    board.includes("<WorkItemInlineEditFailureLine failure={inlineFailure} />"),
    "就地原因由唯一那份零件渲染（行模块只挂载一次）",
  );
  assert.ok(
    parts.includes('data-testid="work-item-inline-edit-error"'),
    "就地原因的稳定锚点在零件里（e2e 依赖）",
  );
  assert.equal(
    (parts.match(/data-testid="work-item-inline-edit-error"/g) ?? []).length,
    1,
    "失败文案只有一处呈现（两个字段共用一个零件）",
  );
});

/* 守卫｜写路径**单点**：行内提交只把纯函数产出的 patch 交给页面回调；服务调用/请求拼装都留在页面。
   变异（M4）：在看板/hook 里直接调服务（或在回调里重拼字段名）⇒ 本条必红。 */
test("守卫｜行内写只经页面回调：看板与 hook 零服务调用、零请求拼装", () => {
  const board = stripComments(readSource("squad/WorkItemRows.tsx"));
  const host = stripComments(readSource("squad/WorkItemsSurface.tsx"));
  const list = stripComments(readSource("squad/WorkItemListView.tsx"));
  const table = stripComments(readSource("squad/WorkItemTableView.tsx"));
  const hook = stripComments(readSource("squad/useWorkItemInlineEdit.ts"));
  for (const source of [board, host, list, table, hook]) {
    for (const forbidden of [
      "updateWorkItem",
      "createWorkItem",
      "reassignWorkItem",
      "discardBatch",
      "resolveSquadRuntimeService",
    ]) {
      assert.ok(!source.includes(forbidden), `不得出现 ${forbidden}（写路径只有页面一条）`);
    }
  }
  assert.ok(
    hook.includes("onInlineEdit(item, patch)"),
    "提交必须把**纯函数产出的 patch** 交给页面回调（不在组件里重拼字段名）",
  );
});

/* 守卫｜优先级 picker 的**有/无**与三种形态（真渲染）：有值 = 轮 C 的徽标即入口；未设置 = 中性占位
   （不给入口就永远设不上这一档）；归档 = 只读徽标（能看不能改）。
   变异：未设置时不给入口 ⇒ 第二条必红；归档行也给入口 ⇒ 第三条必红。 */
test("真渲染｜优先级行内 picker：有值/未设置都给入口，归档行只读", () => {
  const set = renderInlineBoard([wi({ priority: "urgent" })]);
  assert.ok(set.includes('data-testid="work-item-priority-picker"'), "有值时徽标可点开 picker");
  assert.ok(set.includes('data-testid="work-item-priority"'), "有值仍是轮 C 的徽标锚点（不换锚）");
  assert.ok(!set.includes('data-testid="work-item-priority-unset"'), "有值时不画「未设置」占位");

  const unset = renderInlineBoard([wi()]);
  assert.ok(
    unset.includes('data-testid="work-item-priority-picker"'),
    "未设置也要有入口（否则这一档永远设不上）",
  );
  assert.ok(
    unset.includes('data-testid="work-item-priority-unset"'),
    "未设置显示占位（中性 chip）",
  );
  assert.ok(
    !unset.includes('data-testid="work-item-priority"'),
    "未设置不得留下「有值」的徽标锚（那个锚的含义就是有值）",
  );

  const archived = renderInlineBoard([wi({ archivedAt: 1, priority: "urgent" })]);
  assert.ok(!archived.includes('data-testid="work-item-priority-picker"'), "归档行不给 picker");
  assert.ok(archived.includes('data-testid="work-item-priority"'), "归档行仍显示档位（只读）");
});

/* 守卫｜picker **单点**：入口、四档列表、清除项各只出现一次（复制一份 = 两处选项迟早分叉，
   而分叉的表现是「界面给的档位，判据不认」）。档位文案走轮 C 的穷尽映射，不另造一份。
   变异（M5）：把四档列表抄到第二处（例如给徽标另写一个菜单）⇒ 第一 / 二条必红。 */
test("守卫｜优先级 picker 单点：四档 + 清除各一处、文案走轮 C 映射、不用空串 item 值", () => {
  const board = readSource("squad/WorkItemRows.tsx");
  const parts = stripComments(readSource("squad/WorkItemInlineEditParts.tsx"));
  assert.equal(
    (parts.match(/data-testid="work-item-priority-picker"/g) ?? []).length,
    1,
    "picker 入口单点（全树只此一处呈现）",
  );
  assert.equal((parts.match(/WORK_ITEM_PRIORITY_KEYS\.map\(/g) ?? []).length, 1, "四档只列一次");
  for (const needle of ["WORK_ITEM_PRIORITY_MESSAGE_IDS[key]", "WORK_ITEM_PRIORITY_CLEAR_VALUE"]) {
    assert.ok(parts.includes(needle), `picker 必须走 ${needle}`);
  }
  for (const needle of [
    "<WorkItemPriorityPicker",
    "inlineEdit.commitPriorityEdit(item, value)",
    "inlineEdit.priorityValueOf(item)",
    "WORK_ITEM_PRIORITY_BADGE_CLASSNAME",
  ]) {
    assert.ok(board.includes(needle), `picker 的挂载必须走 ${needle}`);
  }
  assert.equal(
    (parts.match(/data-testid="work-item-priority-clear"/g) ?? []).length,
    1,
    "「清除」项单点",
  );
  assert.ok(
    !/value=""/.test(parts + board),
    "不得用空串做 item 值（@radix-ui 的 item 会直接抛：空串是它保留给 placeholder 的）",
  );
});

/* 守卫｜页面侧：行内编辑的**单条**写路径 = 既有 `updateWorkItem` + 写成功后以服务回读刷新。
   三条一起钉（缺一条都是静默的坏法）：
   ① patch 由纯函数产出、**原样**并入请求（重拼字段名 = 界面改 A、库里改 B）；
   ② **无乐观更新**：写成功之后才 reload（先 reload 或本地改列表 = 界面领先于库）；
   ③ 失败原样交回看板（行内就地提示；不吞错、不假装成功）。
   变异：把行内路径改成先改本地状态再写库 ⇒ 第三条必红。 */
test("守卫｜WorkItemsPage：行内编辑走既有 updateWorkItem + 写成功后才回读刷新", () => {
  const page = readSource("squad/WorkItemsPage.tsx");
  assert.ok(page.includes("onInlineEdit={submitInlineEdit}"), "看板的行内提交接回页面");
  const submit = page.slice(
    page.indexOf("const submitInlineEdit"),
    page.indexOf("const createDisabled"),
  );
  assert.ok(submit.includes(".updateWorkItem("), "唯一写方法 = updateWorkItem");
  assert.ok(
    submit.includes("{ id: item.id, patch }"),
    "patch 由纯函数产出、原样并入请求（不重拼字段名）",
  );
  for (const forbidden of ["createWorkItem", "reassignWorkItem", "discardBatch", "setSnapshot("]) {
    assert.ok(
      !submit.includes(forbidden),
      `行内路径不得出现 ${forbidden}（第二写路径 / 乐观更新）`,
    );
  }
  const writeIndex = submit.indexOf(".updateWorkItem(");
  const reloadIndex = submit.indexOf("await reload()");
  assert.ok(
    writeIndex > 0 && reloadIndex > writeIndex,
    "**写成功之后**才以服务回读刷新（无乐观更新）",
  );
  assert.ok(submit.includes("squadEntryErrorFeedback(error)"), "失败原样交回（不吞错）");
  assert.ok(submit.includes("return null"), "成功回 null（看板据此收起草稿）");
});
