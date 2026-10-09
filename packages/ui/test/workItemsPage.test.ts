import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { WORK_ITEM_STATUS_KEYS, type WorkItem, type WorkItemStatusKey } from "@zcode/shared";
import type { SquadSnapshot } from "@zcode/services";
import {
  WORK_ITEM_STATUS_MESSAGE_IDS,
  flattenWorkItemBoard,
  groupWorkItemBoard,
  workItemCreateEnabled,
  workItemStatusMessageId,
} from "../src/squad/workItemsViewModel.js";
import { runReviewable } from "../src/squad/squadEntryViewModel.js";

/* 「工作项」一级入口（WorkItemsPage / WorkItemsBoard / SquadRunsReview）的用例：
   **纯逻辑 + 结构守卫**（ui 包没有渲染测试设施，这是本项目既定做法，见 squadEntryView.test.ts）。分工：
   ① 看板排树的纯函数逐格（空 / 单根 / 父子 / 孙 / 孤儿当根 / 父不在集合 / 环 / 顺序稳定）；
   ② 状态文案键集 = 六态（照 run 状态那条既有用例的形态）；
   ③ 新建可点性四格；
   ④ 结构守卫：侧栏入口、shell 接线与打开会话穿透、页面服务接线与"放弃整批必须二次确认"、
      设置卡终态。每条都写明变异方式，并在交付报告里逐条实测。 */

const SRC_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "../src");
const readSource = (relativePath: string) => readFileSync(resolve(SRC_DIR, relativePath), "utf8");

/** 造一条工作项（只给纯函数关心的字段）。 */
function wi(id: string, parentId?: string, status: WorkItemStatusKey = "todo"): WorkItem {
  return {
    id,
    workspaceIdentity: "id",
    workspacePath: "/w/a",
    ...(parentId === undefined ? {} : { parentId }),
    title: `标题 ${id}`,
    body: "",
    status,
    assignee: { type: "user", id: "user" },
    labels: [],
    properties: {},
    position: 0,
  };
}

// ---------- ① 看板排树（flattenWorkItemBoard） ----------

test("看板排树：空列表 ⇒ 空行集", () => {
  assert.deepEqual(flattenWorkItemBoard([]), []);
});

test("看板排树：单根 ⇒ 一行 depth=0，顺序原样", () => {
  const rows = flattenWorkItemBoard([wi("a")]);
  assert.deepEqual(
    rows.map((row) => [row.item.id, row.depth]),
    [["a", 0]],
  );
});

test("看板排树：父子 ⇒ 子紧随父（depth=1）；多个根按给定顺序", () => {
  const rows = flattenWorkItemBoard([wi("p1"), wi("c1", "p1"), wi("p2")]);
  assert.deepEqual(
    rows.map((row) => [row.item.id, row.depth]),
    [
      ["p1", 0],
      ["c1", 1],
      ["p2", 0],
    ],
    "同父下子项紧随其父；根之间按给定顺序（listByWorkspace 已排好序）",
  );
});

test("看板排树：孙项 depth=2（子项先于父项出现在输入里也不改行序）", () => {
  // 输入故意把孙、子放在父之前：行序由树决定，不由输入顺序决定（同一层内才看输入顺序）。
  const rows = flattenWorkItemBoard([wi("g1", "c1"), wi("c1", "p1"), wi("p1")]);
  assert.deepEqual(
    rows.map((row) => [row.item.id, row.depth]),
    [
      ["p1", 0],
      ["c1", 1],
      ["g1", 2],
    ],
    "父项在前，子项紧随，孙项 depth 继续加深",
  );
});

test("看板排树：孤儿当根 —— 父项不在集合里（例如父项已归档）时子项不消失", () => {
  // `listByWorkspace` 只列未归档项：父项归档后不在集合里，子项必须当根出现在看板上，
  // 而不是整条消失（数据仍在库里，界面却说没有，且不报错）。
  const rows = flattenWorkItemBoard([wi("child", "archived-parent")]);
  assert.deepEqual(
    rows.map((row) => [row.item.id, row.depth]),
    [["child", 0]],
    "父不在集合 ⇒ 子项当根（depth=0）",
  );
});

test("看板排树：同父下多个子项保持给定顺序", () => {
  const rows = flattenWorkItemBoard([wi("p"), wi("c2", "p"), wi("c1", "p"), wi("c3", "p")]);
  assert.deepEqual(
    rows.map((row) => row.item.id),
    ["p", "c2", "c1", "c3"],
    "子项之间按给定顺序（不重排、不按 id 排序）",
  );
});

test("看板排树：环（互指）不死循环、不重复输出、行不丢", () => {
  // 防御性用例（**不是判据**）：库里理论上不允许成环（WorkItemService.validateParent 沿父链查环），
  // 但纯函数不得因坏数据死循环（一个 hover 就能把界面卡死）。断言：终止 + id 唯一 + 不丢行。
  const rows = flattenWorkItemBoard([wi("a", "b"), wi("b", "a")]);
  const ids = rows.map((row) => row.item.id);
  assert.equal(new Set(ids).size, ids.length, "不得重复输出（visited 拦第二次进入）");
  assert.deepEqual(
    [...ids].sort(),
    ["a", "b"],
    "坏数据也不静默丢行（无根可达时按给定顺序当根补足）",
  );
});

test("看板排树：可从根到达的环 ⇒ 根正常展开，环在第二次遇到时停", () => {
  const rows = flattenWorkItemBoard([wi("root"), wi("c", "root"), wi("d", "c"), wi("c2", "d")]);
  // c2 的父是 d，d 的父是 c，c 的父是 root —— c2 是 d 的子项（depth 3），不是环。
  // 真环：再补一个自指的坏行（e 的父是自己，且从 root 不可达）。
  const withSelfCycle = flattenWorkItemBoard([
    wi("root"),
    wi("c", "root"),
    wi("d", "c"),
    wi("e", "e"),
  ]);
  assert.deepEqual(
    rows.map((row) => [row.item.id, row.depth]),
    [
      ["root", 0],
      ["c", 1],
      ["d", 2],
      ["c2", 3],
    ],
  );
  const selfIds = withSelfCycle.map((row) => row.item.id);
  assert.equal(new Set(selfIds).size, selfIds.length, "自指行也只输出一次");
  assert.ok(selfIds.includes("e"), "自指行仍要有归宿（当根补足），不得消失");
});

test("看板排树：顺序稳定 —— 同一输入两次输出逐项相同", () => {
  const items = [wi("p1"), wi("c1", "p1"), wi("g1", "c1"), wi("c2", "p1"), wi("p2"), wi("x")];
  const first = flattenWorkItemBoard(items);
  const second = flattenWorkItemBoard(items);
  assert.deepEqual(
    first.map((row) => [row.item.id, row.depth]),
    second.map((row) => [row.item.id, row.depth]),
    "同一份数据两次渲染的行序不漂移（否则界面看起来像「有人在动数据」）",
  );
  assert.deepEqual(
    first.map((row) => row.item.id),
    ["p1", "c1", "g1", "c2", "p2", "x"],
    "深度优先前序：子项紧随其父，孙项紧随其子父",
  );
});

// ---------- ② 状态文案（照运行状态那条既有用例的形态） ----------

// 工作项状态文案必须**穷尽**：`Record<WorkItemStatusKey, string>` 让漏一个状态变成编译错误；
// 这条用例再把「键集 = 六态」钉住，防止有人把 Record 改成 Partial 而没被发现。
test("工作项状态文案覆盖六个状态，且键集与共享层一致", () => {
  assert.deepEqual(Object.keys(WORK_ITEM_STATUS_MESSAGE_IDS).sort(), [
    "blocked",
    "cancelled",
    "done",
    "in_progress",
    "in_review",
    "todo",
  ]);
  assert.deepEqual(
    Object.keys(WORK_ITEM_STATUS_MESSAGE_IDS).sort(),
    [...WORK_ITEM_STATUS_KEYS].sort(),
    "键集必须与 @zcode/shared 的状态全集一致（加一个状态这里必须跟着动）",
  );
  for (const [status, messageId] of Object.entries(WORK_ITEM_STATUS_MESSAGE_IDS)) {
    assert.ok(messageId.startsWith("squad.workItems.status."), messageId);
    assert.equal(workItemStatusMessageId(status as WorkItemStatusKey), messageId);
  }
});

// ---------- ③ 新建可点性（四格穷举） ----------

function snapshotWith(workItems: WorkItem[]): SquadSnapshot {
  return { enabled: true, teamAgents: [], squads: [], workItems, runs: [], queuedRuns: [] };
}

// 新建按钮可点性（四格穷举）：快照未取到（加载中/失败）时**置灰** —— 对话框的指派人 / 父项
// 候选来自快照，读不到就开不出有选择的表单（「点得开但通往死路」比置灰更糟）；按钮始终渲染。
// 变异：把 `snapshot !== null` 从 workItemCreateEnabled 里去掉 ⇒ 第三格必红。
test("新建可点性：无目标 / 快照未取到 / 有目标有快照 —— 四格逐条断言", () => {
  const snapshot = snapshotWith([]);
  assert.deepEqual(
    [
      workItemCreateEnabled({ hasTarget: false, snapshot: null }),
      workItemCreateEnabled({ hasTarget: false, snapshot }),
      workItemCreateEnabled({ hasTarget: true, snapshot: null }),
      workItemCreateEnabled({ hasTarget: true, snapshot }),
    ],
    [false, false, false, true],
    "只有「有目标 + 已取到快照」才可点（快照为 null ⇒ 置灰，不给自己一条死路）",
  );
});

// ---------- ④ 结构守卫（逐条可变异） ----------

/* 守卫 a：侧栏「工作项」入口。
   变异（U1：去显隐）：把入口外层的 `{showSquadEntries ? (… ) : null}` 去掉（入口无条件渲染）
   ⇒ 最后一个断言必红（条件块中途闭合 = 入口裸奔）。 */
test("守卫｜侧栏「工作项」入口恰一处、紧跟「小队」之后、挂同一个显隐判据", () => {
  const sidebar = readSource("WorkspaceSidebar.tsx");
  assert.equal(
    (sidebar.match(/work-items-sidebar-open/g) ?? []).length,
    1,
    "工作项入口按钮只该有一处（为别的形态另抄一份 = 同一语义两处实现）",
  );
  const workItemsIndex = sidebar.indexOf("work-items-sidebar-open");
  assert.ok(
    workItemsIndex > sidebar.indexOf("ai-team-sidebar-squads"),
    "「工作项」在 AI Team 分组之后（既有 Work 语义位置不重排）",
  );
  assert.equal(
    (sidebar.match(/showSquadEntries = squadEntryVisible\(settings\)/g) ?? []).length,
    1,
    "显隐判据变量只此一处：给工作项再造一个判据变量 = 同一语义两处实现",
  );
  assert.equal(
    (sidebar.match(/\{showSquadEntries \? \(/g) ?? []).length,
    3,
    "三个显隐条件（收件箱 / AI Team 分组 / 工作项）都要挂同一个显隐条件",
  );
  // 入口必须真的在**自己的**条件块内：从最近一个条件起点到入口之间不得出现条件闭合。
  const gate = sidebar.lastIndexOf("{showSquadEntries ? (", workItemsIndex);
  assert.ok(gate >= 0, "工作项入口必须挂在 showSquadEntries 的条件里");
  assert.ok(
    !sidebar.slice(gate, workItemsIndex).includes(") : null}"),
    "工作项入口必须在 showSquadEntries 条件块内（条件中途就闭合了 = 入口裸奔）",
  );
  assert.ok(
    sidebar.includes("workspace.openWorkItems"),
    "入口文案键 workspace.openWorkItems（两语齐全）",
  );
});

/* 守卫 b：主视图接线。
   变异（U2：漏 work-items 判据）：① 删掉 `workspaceMainView === "work-items"` 分支 ⇒ 红；
   ② 全页视图判据里漏掉 work-items ⇒ 红（那会让工作项页多出一层 header / 终端面板）。 */
test("守卫｜shell 有 work-items 分支且渲染 WorkItemsPage；全页判据含 work-items", () => {
  const layout = readSource("app-shell/WorkspaceShellLayout.tsx");
  assert.ok(
    layout.includes('workspaceMainView === "work-items" ?'),
    "装饰视图必须有 work-items 分支",
  );
  assert.ok(layout.includes("<WorkItemsPage"), "work-items 分支必须渲染 WorkItemsPage");
  assert.match(
    layout,
    /<WorkItemsPage\s+workspacePath=\{workspaceAbsPath\}\s+workspaceIdentity=\{workspaceIdentity\}/,
    "目标 workspace 由 shell 传入（与 SquadAgentsPage / SquadsPage 同款 props 形态）",
  );
  assert.ok(
    layout.includes('scope="work-items-page"'),
    "工作项页要有独立的 ScopedErrorBoundary scope（崩溃不连坐）",
  );
  const predicate = layout.slice(
    layout.indexOf("const isFullPageMainView ="),
    layout.indexOf("const shouldRenderMainViewHeader ="),
  );
  assert.ok(
    predicate.includes('workspaceMainView === "work-items"'),
    "全页视图判据漏了 work-items（漏一个 = 该入口多一层 header 或终端面板，且不报错）",
  );
  assert.ok(
    // B5.1（S4）把该判据从「只看板」扩到「看板 + 工作项详情页」：详情页同属这个侧栏入口，
    // 漏掉详情 ⇒ 进详情后侧栏失焦（静默）。断言相应加宽为**两个视图都覆盖**（比原来更强，不是放宽）。
    layout.includes(
      'workspaceMainView === "work-items" || workspaceMainView === "work-item-detail"',
    ),
    "侧栏入口的高亮态由同一个主视图判据给出（B5.1 起含工作项详情页）",
  );
  // 打开会话穿透：照 AutomationsSection 的形态经 shell 既有的 handleSelectTaskInChat
  //（目标就是本页的 workspace）—— 页面自己不拼导航。变异：删掉 onOpenSession ⇒ 红。
  const pageTag = layout.slice(
    layout.indexOf("<WorkItemsPage"),
    layout.indexOf("/>", layout.indexOf("<WorkItemsPage")),
  );
  assert.ok(pageTag.includes("onOpenSession={(sessionId) =>"), "必须把 onOpenSession 传给页面");
  assert.ok(
    pageTag.includes("handleSelectTaskInChat("),
    "会话穿透必须复用 shell 既有的 handleSelectTaskInChat（不另造导航）",
  );
  for (const needle of ["workspaceAbsPath", "sessionId", "workspaceIdentity"]) {
    assert.ok(pageTag.includes(needle), `onOpenSession 接线必须带 ${needle}`);
  }
});

/* 守卫 c：页面服务接线 + 放弃整批必须二次确认（照既有 executeSquadDiscard 守卫写）。
   变异（U3：放弃整批不经确认对话框）：把确认对话框删掉、让按钮直接执行（页面里出现
   `discardBatch(` 调用）⇒ 本用例必红。 */
test("守卫｜WorkItemsPage 走响亮取数通路，写动作齐全，放弃整批经二次确认对话框", () => {
  const page = readSource("squad/WorkItemsPage.tsx");
  assert.ok(page.includes("resolveSquadRuntimeService("), "取数必须经 resolveSquadRuntimeService");
  assert.ok(
    !page.includes("services.squadRuntimeService"),
    "页面不得直接读 services.squadRuntimeService（那条路会把「服务没接上」静默成 undefined）",
  );
  for (const call of ["createWorkItem(", "updateWorkItem(", "reviewMemberRun("]) {
    assert.ok(page.includes(call), `页面必须接上 ${call}（缺一个就是缺一件功能）`);
  }
  assert.ok(
    !/discardBatch\s*\(/.test(page),
    "页面不得直接调用 discardBatch：执行只能经 executeSquadDiscard",
  );
  assert.ok(page.includes("executeSquadDiscard("), "执行必须经视图模型的唯一入口");
  assert.ok(page.includes("requestSquadDiscard("), "点「放弃整批」只能进入待确认态");
  assert.ok(page.includes("<WorkItemsPageDialogs"), "必须渲染工作项对话框装配组件");
  const dialogs = readSource("squad/WorkItemsPageDialogs.tsx");
  const dialogWiring = page.slice(page.indexOf("<WorkItemsPageDialogs"));
  assert.ok(dialogs.includes("<SquadDiscardDialog"), "必须渲染二次确认对话框");
  assert.ok(dialogs.includes("onConfirm={onConfirmDiscard}"), "确认动作不得在装配层变成 no-op");
  assert.ok(
    dialogWiring.includes("onConfirmDiscard") && dialogWiring.includes("runDiscard()"),
    "确认动作必须回到页面唯一执行路径",
  );
  assert.ok(dialogWiring.includes("onSubmitReassign={submitReassign}"), "改派提交必须回到页面编排");
  assert.ok(
    page.includes("squadDiscardableWorkItemIds("),
    "「放弃整批」入口的判据必须走纯函数（与服务面重驱同一份定义 isSquadBatchRoot）",
  );
  // 新建按钮的置灰判据必须走纯函数（workItemCreateEnabled：有目标 + 已取到快照）。
  assert.ok(
    page.includes("workItemCreateEnabled("),
    "新建按钮的置灰判据必须走纯函数 workItemCreateEnabled",
  );
  // 测试锚点（后续 e2e 依赖；顺手钉住防被误删）。
  assert.ok(page.includes('data-testid="work-items-page"'), "页根 testid 不得改名");
  assert.ok(page.includes('data-testid="work-items-create"'), "新建按钮 testid 不得改名");
  // T-P2-R1：行锚点与行动作随行渲染抽到共用行模块（三视图共用）。
  const board = readSource("squad/WorkItemRows.tsx");
  assert.ok(board.includes("data-work-item-id"), "行上要有 data-work-item-id");
  for (const testid of ["work-item-edit", "work-item-discard"]) {
    assert.ok(board.includes(testid), `行内动作 testid ${testid} 不得缺（锚点）`);
  }
  assert.ok(
    readSource("squad/WorkItemsBoard.tsx").includes("flattenWorkItemBoard("),
    "看板行序必须走纯函数 flattenWorkItemBoard",
  );
  assert.ok(
    readSource("squad/WorkItemsSurface.tsx").includes("workItemSurfaceVisibleItems("),
    "宿主必须用纯函数投影（过滤/搜索/排序判据不得写进组件）",
  );
  const review = readSource("squad/SquadRunsReview.tsx");
  assert.ok(review.includes("data-run-id"), "运行行上要有 data-run-id");
  for (const testid of ["run-approve", "run-reject", "run-open-session"]) {
    assert.ok(review.includes(testid), `运行行动作 testid ${testid} 不得缺（锚点）`);
  }
});

/* 守卫 d：确认对话框必须**说清后果**并是 destructive 变体（照既有同款守卫，键名随本轮改名）。 */
test("守卫｜放弃整批的确认对话框说清后果、destructive、且不执行任何服务调用", () => {
  const dialog = readSource("squad/SquadDiscardDialog.tsx");
  assert.ok(
    dialog.includes("squad.discard.description"),
    "确认文案必须说明后果（删哪些分支、工作树会被清、该批判为放弃）",
  );
  assert.ok(dialog.includes('variant="destructive"'), "破坏性动作必须是 destructive 变体");
  assert.ok(!/discardBatch\s*\(/.test(dialog), "对话框只回意图，不执行任何服务调用");
});

/* 守卫 e：「打开会话」只在 run.sessionId 非空时给出。
   变异：把按钮挪出 `sessionId ?` 条件（无条件显示）⇒ 第二/三断言必红。 */
test("守卫｜「打开会话」只在 run.sessionId 非空时给出（没有会话就没有可打开的东西）", () => {
  const review = readSource("squad/SquadRunsReview.tsx");
  assert.ok(review.includes("const sessionId = run.sessionId;"), "会话 id 必须取自 run 台账");
  const gate = review.indexOf("{sessionId ? (");
  const button = review.indexOf('data-testid="run-open-session"');
  assert.ok(gate >= 0, "必须有 sessionId 非空的判断分支");
  assert.ok(button > gate, "按钮必须在 sessionId 非空的条件下（不得无条件渲染）");
  assert.ok(
    review.indexOf("onOpenSession(sessionId)") > button,
    "按钮点击必须把 sessionId 交给 onOpenSession",
  );
});

/* 守卫 e2（controller 审查发现项，闭合 spec §17 登记）：通过 / 打回只给**有可裁决产出**的 run。
   变异：把 approve/reject 挪出 `runReviewable(run) ?` 条件（无条件显示）⇒ 本守卫必红。 */
test("守卫｜通过 / 打回只在 runReviewable（produced / rejected）时给出", () => {
  const review = readSource("squad/SquadRunsReview.tsx");
  const gate = review.indexOf("{runReviewable(run) ? (");
  const approve = review.indexOf('data-testid="run-approve"');
  const reject = review.indexOf('data-testid="run-reject"');
  assert.ok(gate >= 0, "必须有 runReviewable 判断分支");
  assert.ok(approve > gate, "通过按钮必须在可审查条件下（不得无条件渲染）");
  assert.ok(reject > approve, "打回按钮同样在可审查条件下");
});

test("运行可审查性：produced / rejected 可审，其余三态（open / merged / discarded）一律不可", () => {
  assert.equal(runReviewable({ status: "produced" }), true);
  assert.equal(runReviewable({ status: "rejected" }), true);
  assert.equal(runReviewable({ status: "open" }), false, "还在跑的 run 没有可裁决的产出");
  assert.equal(runReviewable({ status: "merged" }), false);
  assert.equal(runReviewable({ status: "discarded" }), false);
});

/* 守卫 g（L1 泳道回归，2026-10-07；默认值口径 2026-10-09 用户裁定）：**显式「不分组」**路径的
   既有锚点、行序与 DOM 形状零回归 —— 「默认改按阶段分组」不等于「把不分组这条路径改掉」。
   变异：不分组也套泳道壳（或 `none` 分支不再与 flatten 等价）⇒ 第一 / 四 / 五条必红；
   默认维度改回 `none`（或不再按阶段分组）⇒ 下面第二条断言必红。 */
test("守卫｜显式「不分组」路径零回归：单 ul + 既有行锚点 + none 与 flatten 逐格等价", () => {
  /* T-P2-R1 口径更新：行渲染抽到共用行模块后，「单 ul + 行序」的判据改为
     ① 看板的不分组分支把 `flattenWorkItemBoard(workItems)` 交给共用行列表，并给既有锚点
        `work-items-list`（DOM 逐字保留由 workItemsSurfaceRender 的逐字节对照承担）；
     ② 宿主默认视图 = board，且默认状态下投影**原样返回输入**（默认路径零加工）。 */
  const board = readSource("squad/WorkItemsBoard.tsx");
  const rows = readSource("squad/WorkItemRows.tsx");
  assert.ok(board.includes('testId="work-items-list"'), "不分组仍是单 ul（锚点在共用列表上）");
  assert.ok(
    board.includes("rows={flattenWorkItemBoard(workItems)}"),
    "不分组把 flattenWorkItemBoard 的结果交给共用行列表（行序判据不变）",
  );
  assert.ok(
    rows.includes("<ul className={LIST_CLASSNAME} data-testid={testId}>"),
    "容器仍是那个单 ul（由共用列表实现，锚点由消费方给）",
  );
  const page = readSource("squad/WorkItemsPage.tsx");
  assert.ok(
    page.includes('useState<WorkItemLaneDimension>("statusCategory")'),
    "默认维度必须是 statusCategory（用户 2026-10-09 裁定「默认按阶段进行分组」；「不分组」保留为可选项）",
  );
  assert.ok(
    page.includes("useState<WorkItemSurfaceState>(workItemSurfaceDefaultState)"),
    "默认 Surface 状态走纯函数（默认视图 = board + 无查询：默认状态一改这里必红）",
  );
  const actions = readSource("squad/WorkItemsPageActions.tsx");
  assert.ok(
    actions.includes('data-testid="work-items-lane-dimension"'),
    "分组选择器常驻动作行（不是藏起来的设置项）",
  );
  /* T-P2-R6b 口径更新：接线目标从直连 setter 改为页面的 `changeLaneDimension`
     （换维度时顺带把排序档归一到新维度下可用的档）—— "组件不持有第二份维度状态"这条判据不变。 */
  assert.ok(
    page.includes("onLaneDimensionChange={viewsBridge.changeLaneDimension}"),
    "选择器与页面状态同源（组件不持有第二份维度状态）",
  );
  // 等价性回归（纯函数层）：`none` 的输出与 flattenWorkItemBoard 逐格相同。
  const items = [wi("p"), wi("c", "p"), wi("orphan", "gone")];
  assert.deepEqual(
    groupWorkItemBoard({ items, dimension: "none", roster: { teamAgents: [], squads: [] } })[0]
      ?.rows,
    flattenWorkItemBoard(items),
    "none 分支不得改变行序与深度（同一份 DFS 实现）",
  );
});

/* 守卫 f：设置卡**终态**（本轮收尾）：只留总开关 + 一行指引，不再渲染任何小队视图。
   变异（U4：设置区回加卡片）：把 `<SquadMinimalView />` 加回 ExperimentsSection ⇒ 必红。
   旧组件文件也必须已删（`SquadEntryLists` 同理）——「删名不删实」由 existsSync 咬红。 */
test("守卫｜设置卡只留总开关 + 一行指引（不再渲染任何小队视图）", () => {
  const section = readSource("settings/ExperimentsSection.tsx");
  assert.ok(!section.includes("SquadMinimalView"), "设置卡不得再渲染 SquadMinimalView（已退役）");
  assert.ok(!section.includes("WorkItemDialog"), "设置卡不得再渲染工作项表单（它在工作项页）");
  assert.ok(
    section.includes("squad.common.settingsMovedHint"),
    "必须留一行指引：原处找不到入口会看起来像「功能没了」",
  );
  assert.ok(
    section.includes("settings.experiments.squadToggle.label"),
    "总开关仍在（只是不再挂任何视图）",
  );
  assert.equal(
    existsSync(resolve(SRC_DIR, "squad/SquadMinimalView.tsx")),
    false,
    "SquadMinimalView 已删（视图全搬到侧栏一级入口）",
  );
  assert.equal(
    existsSync(resolve(SRC_DIR, "squad/SquadEntryLists.tsx")),
    false,
    "SquadEntryLists 已删（两段列表已被 WorkItemsBoard / SquadRunsReview 替代）",
  );
});
