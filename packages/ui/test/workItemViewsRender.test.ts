import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { WorkItem } from "@zcode/shared";
import type { SquadSnapshot, WorkItemViewRecord } from "@zcode/services";
import { ZCodeIntlProvider } from "../src/i18n/IntlProvider.js";
import enUS from "../src/i18n/locales/en-US.js";
import zhCN from "../src/i18n/locales/zh-CN.js";
import { WorkItemViewsBar } from "../src/squad/WorkItemViewsBar.js";
import { WorkItemsPageActions } from "../src/squad/WorkItemsPageActions.js";
import { WorkItemsSurface } from "../src/squad/WorkItemsSurface.js";
import {
  workItemViewBaseline,
  normalizeWorkItemSurfaceForLaneDimension,
  workItemBoardReorderEnabled,
  workItemSortKeysForLaneDimension,
  workItemViewDialogProjection,
  workItemViewTabs,
} from "../src/squad/workItemViewsViewModel.js";
import {
  applyWorkItemSurfaceIntent,
  workItemSurfaceDefaultState,
  type WorkItemSurfaceIntent,
  type WorkItemSurfaceState,
} from "../src/squad/workItemSurfaceViewModel.js";
import type { WorkItemPositionPlan } from "../src/squad/workItemPositionViewModel.js";
import type { WorkItemLaneDimension } from "../src/squad/workItemsViewModel.js";

/* 保存视图（阶段二 · T-P2-R6b）的**呈现与接线**守卫（真渲染 + 全 src 树源码扫描）。

   三条本轮必须成立的事：
   ① 视图条与三个对话框的**权限三态**按纯函数的结论投影（非我的：编辑禁用、删除不渲染）；
   ② **lane=assignee 无 Manual**、且拖拽把手只在「看板 + statusCategory + 手动档 + 有写入口」出现
      （四格逐格钉住 —— 少一格就是"拖了没落点"或"给了一个点了没反应的入口"）；
   ③ 写路径**单点**：四个视图 RPC 只在页面的接线处与状态机的三条流里出现一次，本地意图折叠
      （`workItemSurfaceViewModel`）**碰不到**它们 —— 这就是验收 2「本地调整不回写定义」的结构判据。

   期望值的独立真源：拆解卡 §T-P2-R6b 的验收 1/2/3/5 + 取证报告 §8（权限 UI 形态）。 */

const SRC_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "../src");
const readSource = (relativePath: string) => readFileSync(resolve(SRC_DIR, relativePath), "utf8");
const stripComments = (source: string) =>
  source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

/** 文案真源：zh-CN 正文（断言渲染出的**正文**，不是 key —— 裸 key 是这一面最典型的静默坏法）。 */
const t = (id: string): string => zhCN[id] ?? `MISSING:${id}`;

const hasDisabledAttr = (tag: string): boolean => /[\s"']disabled(?:=""|="true"|[\s/>])/.test(tag);
/** 取出带某个 testid 的那个**标签本身**（SSR markup 是扁平字符串；锚点到下一个 `>` 即元素末尾）。 */
function tagWithTestId(markup: string, testId: string): string {
  const index = markup.indexOf(`data-testid="${testId}"`);
  assert.ok(index >= 0, `markup 里找不到 ${testId}`);
  return markup.slice(markup.lastIndexOf("<", index), markup.indexOf(">", index));
}

function view(over: Partial<WorkItemViewRecord> = {}): WorkItemViewRecord {
  return {
    id: "view-1",
    workspaceKey: "ws",
    owner: { kind: "human", id: "me" },
    name: "视图甲",
    scopeType: "my",
    visibility: "private",
    definitionVersion: 1,
    query: {},
    display: {},
    revision: 3,
    createdAt: 1,
    updatedAt: 1,
    ...over,
  };
}

function wi(over: Partial<WorkItem>): WorkItem {
  return {
    id: "wi-1",
    workspaceIdentity: "ws",
    workspacePath: "/w/a",
    title: "标题",
    body: "",
    status: "todo",
    assignee: { type: "user", id: "user" },
    labels: [],
    properties: {},
    position: 0,
    ...over,
  };
}

const snapshotWith = (workItems: WorkItem[]): SquadSnapshot =>
  ({
    enabled: true,
    teamAgents: [],
    squads: [],
    workItems,
    runs: [],
    queuedRuns: [],
  }) as unknown as SquadSnapshot;

// ---------- ① 视图条：内建锚 + 保存视图同列 + 当前高亮 ----------

function renderBar(over: {
  views?: WorkItemViewRecord[];
  activeViewId?: string | null;
  busy?: boolean;
  disabled?: boolean;
  onOpen?: (id: string | null) => void;
}): string {
  const {
    views = [view()],
    activeViewId = null,
    busy = false,
    disabled = false,
    onOpen = () => {},
  } = over;
  return renderToStaticMarkup(
    createElement(ZCodeIntlProvider, {
      initialLocale: "zh-CN" as const,
      children: createElement(WorkItemViewsBar, {
        tabs: workItemViewTabs({ views }),
        activeViewId,
        busy,
        disabled,
        onOpen,
        onNew: () => {},
        onManage: () => {},
      }),
    }),
  );
}

test("视图条｜内建锚在第一枚（复用「全部」文案）+ 保存视图同列 + 当前项 aria-pressed", () => {
  const idle = renderBar({});
  assert.ok(idle.includes(t("squad.workItems.filter.all")), "内建锚的正文来自既有的「全部」键");
  assert.ok(idle.includes("视图甲"), "保存视图按名字上条");
  assert.equal((idle.match(/data-testid="work-item-view-tab"/g) ?? []).length, 2, "锚 + 一条视图");
  assert.equal(
    tagWithTestId(idle, "work-item-view-tab").includes('aria-pressed="true"'),
    true,
    "没打开视图 ⇒ 内建锚是当前项（默认落地态就是它）",
  );
  const opened = renderBar({ activeViewId: "view-1" });
  assert.ok(
    opened.includes(`data-view-id="view-1" data-active="true"`),
    "打开的视图高亮（aria-pressed 不靠颜色编码）",
  );
  assert.ok(
    renderBar({}).includes(`aria-label="${t("squad.workItems.views.label")}"`),
    "视图条与 [⧉] 菜单都带可及名称（视图）",
  );
});

test("视图条｜入口常驻：没有读写面时只置灰、不消失（与刷新/新建同一条姿态）", () => {
  const markup = renderBar({ disabled: true });
  assert.ok(markup.includes('data-testid="work-item-views-bar"'), "条本身仍渲染");
  assert.ok(
    hasDisabledAttr(tagWithTestId(markup, "work-item-views-menu")),
    "菜单置灰（没有目标就没有可读写的视图）",
  );
});

// ---------- ② 三个对话框：投影逐格（纯函数）+ 权限三态的呈现规则（源码守卫） ----------

/* 对话框是 Radix 的 **portal** 容器：`renderToStaticMarkup` 不渲染 portal ⇒ 用例改为
   ① 纯函数层的投影逐格钉（标题 / 名字初值 / 可见性初值与锁死）；
   ② 呈现规则用源码守卫（本仓对对话框的既有做法：`SquadDiscardDialog` 的形状守卫同款）——
      这两条合起来覆盖"无权时编辑禁用、删除不渲染"与"删除说清后果"。 */

function dialogProjection(dialog: Parameters<typeof workItemViewDialogProjection>[0]) {
  return workItemViewDialogProjection(dialog);
}

/** 对话框的 draft = 定义快照（本组用例只关心投影，故给一份"空定义"的完整文档）。 */
function emptyDraft() {
  return {
    query: {
      statusCategory: "all" as const,
      priority: "all" as const,
      /* R-P2：项目维也在 query 文档里（空数组 + 开关关 = 这一维不筛）。 */
      projectIds: [],
      includeNoProject: false,
    },
    display: {
      viewMode: "board" as const,
      grouping: "none" as const,
      sortBy: "manual" as const,
      sortDirection: "asc" as const,
      hiddenColumns: [],
    },
  };
}

test("对话框投影｜标题随入口变：菜单新建 = new、从某条另存为 = saveAs、编辑 = edit", () => {
  assert.deepEqual(
    dialogProjection({ kind: "create", sourceViewId: null, draft: emptyDraft() }),
    {
      titleId: "squad.workItems.views.new",
      initialName: "",
      initialShared: false,
      visibilityLocked: false,
    },
    "菜单「新建视图」：空名、私有（不勾共享）、可见性可改",
  );
  assert.deepEqual(
    dialogProjection({ kind: "create", sourceViewId: "view-src", draft: emptyDraft() }),
    {
      titleId: "squad.workItems.views.saveAs",
      initialName: "",
      initialShared: false,
      visibilityLocked: false,
    },
    "从某条视图「另存为」：标题 = 另存为（复制它的定义）",
  );
  assert.deepEqual(
    dialogProjection({
      kind: "edit",
      view: view({ name: "视图甲", scopeType: "workspace", visibility: "workspace" }),
      draft: emptyDraft(),
    }),
    {
      titleId: "squad.workItems.views.edit",
      initialName: "视图甲",
      initialShared: true,
      visibilityLocked: false,
    },
    "编辑：名字回填（不回填 = 一编辑就改名）、共享态回填",
  );
  assert.deepEqual(
    dialogProjection({
      kind: "edit",
      view: view({ scopeType: "my", visibility: "private" }),
      draft: emptyDraft(),
    }).visibilityLocked,
    true,
    "`my` 档恒私有 ⇒ 可见性控件不渲染（不给一个必然被服务面拒的开关）",
  );
});

test("对话框呈现（源码守卫）｜危险钮 destructive + 说明文案 + 权限三态只此一处", () => {
  const dialogs = stripComments(readSource("squad/WorkItemViewDialogs.tsx"));
  assert.ok(
    dialogs.includes("workItemViewDialogProjection("),
    "标题/初值必须走纯函数的投影（组件不自己判一遍该显示哪个标题）",
  );
  assert.ok(
    dialogs.includes('variant="destructive"') &&
      dialogs.includes("squad.workItems.views.deleteConfirmTitle") &&
      dialogs.includes("squad.workItems.views.deleteConfirmBody"),
    "删除确认：destructive 变体 + 说清后果的两句文案（照 SquadDiscardDialog 的守卫口径）",
  );
  assert.ok(
    dialogs.includes("disabled={pending || row.canManage === false}"),
    "非我所有的行：编辑**禁用**（禁用不是消失）",
  );
  assert.ok(
    dialogs.includes("{row.canManage === false ? null : (") &&
      dialogs.includes('data-testid="work-item-view-manage-delete"'),
    "非我所有的行：删除**不渲染**（multica §8；置灰的删除钮会被读成故障）",
  );
  assert.ok(
    dialogs.includes('data-testid="work-item-view-manage-save-as"'),
    "另存为照给（非 owner 的入口 —— multica 的 Save as）",
  );
  assert.ok(
    !dialogs.includes("WorkItemView") || !dialogs.includes("resolveSquadRuntimeService"),
    "对话框不执行任何服务调用（只回传意图）",
  );
});

// ---------- ③ 排序档位：lane=assignee 无 Manual（验收 5） ----------

function renderActions(over: {
  laneDimension?: WorkItemLaneDimension;
  surface?: WorkItemSurfaceState;
  baseline?: ReturnType<typeof workItemViewBaseline> | null;
  /** 项目清单（R-P2）：注入后项目过滤控件有清单可列（缺省 = 还没读到 ⇒ 只给「无项目」一档）。 */
  projects?: readonly { id: string; name: string; shortCode: string }[];
}): string {
  const {
    laneDimension = "none",
    surface = workItemSurfaceDefaultState(),
    baseline = null,
    projects,
  } = over;
  return renderToStaticMarkup(
    createElement(ZCodeIntlProvider, {
      initialLocale: "zh-CN" as const,
      children: createElement(WorkItemsPageActions, {
        targetAvailable: true,
        loading: false,
        createDisabled: false,
        laneDimension,
        onLaneDimensionChange: () => {},
        surface,
        onSurfaceIntent: () => {},
        baseline,
        ...(projects === undefined
          ? {}
          : {
              workItemProjects: {
                projects,
                createProject: async () => ({
                  kind: "failed" as const,
                  feedback: { tone: "error" as const, messageId: "squad.common.operationFailed" },
                }),
                reload: async () => {},
              },
            }),
        t,
        onReload: () => {},
        bulk: {
          active: false,
          selectedCount: 0,
          draft: { field: "priority", value: "__unset__" },
          applying: false,
          result: null,
          onToggleActive: () => {},
          onClear: () => {},
          onDraftIntent: () => {},
          onApply: () => {},
        },
        onCreate: () => {},
      }),
    }),
  );
}

test("排序档位（验收 5）｜lane=assignee 无 Manual：档位清单由纯函数给，控件只消费", () => {
  /* 逐档判据在 `workItemViews.test.ts`（纯函数）；这里钉**呈现侧的接线**：
     Radix 的 SelectContent 是 portal（SSR 里没有选项正文）⇒ 用源码守卫证明"控件消费那一份判据"，
     而不是把档位清单在组件里再铺一遍（变异：改回直接铺 WORK_ITEM_SORT_KEYS ⇒ 本用例红）。 */
  const actions = stripComments(readSource("squad/WorkItemsPageActions.tsx"));
  assert.ok(
    actions.includes("workItemSortKeysForLaneDimension(laneDimension).map("),
    "档位清单必须来自纯函数（含分组维度入参）",
  );
  assert.ok(
    !actions.includes("WORK_ITEM_SORT_KEYS"),
    "控件不得直接铺全量档位（那会把 Manual 泄漏进按指派分组 —— 验收 5）",
  );
  assert.deepEqual(
    workItemSortKeysForLaneDimension("assignee"),
    ["priority", "startDate", "dueDate", "title"],
    "同一份判据的反面逐档钉住（与 workItemViews.test.ts 同一枚函数）",
  );
  /* R-P2：按**项目**分组同样不给 Manual（position 是「全库一段」的序，项目列不是它的落点；
     拖拽本身也只在 statusCategory 开放）—— 用户派发单点名的「回落逻辑已有」在这里可执行化。 */
  assert.deepEqual(
    workItemSortKeysForLaneDimension("project"),
    ["priority", "startDate", "dueDate", "title"],
    "按项目分组也不给 Manual（加了它 = 一个拖不动的档位留在控件里）",
  );
  assert.deepEqual(
    normalizeWorkItemSurfaceForLaneDimension(
      { ...workItemSurfaceDefaultState(), sort: { key: "manual", direction: "asc" } },
      "project",
    ).sort,
    { key: "startDate", direction: "desc" },
    "切到按项目分组时手动档**回落**到最近似的时间档（既有回落逻辑，未新增判据）",
  );
  assert.equal(
    workItemBoardReorderEnabled({
      view: "board",
      laneDimension: "project",
      sortKey: "manual",
      hasWriter: true,
    }),
    false,
    "拖拽启用判据不变：只有 statusCategory + 手动档才给把手（项目列没有 Manual 拖拽）",
  );
});

// ---------- ③b 项目过滤（R-P2）：触发器 + 过滤态 chips 回显 + 锁定 ----------

/* 形态/语义真源：multica A4（多选 + 独立「无项目」开关）与用户派发单的「过滤态 chips 回显」。
   变异：把 chips 换成只读文本（点不掉）⇒ 第一条必红；拿掉锁定 ⇒ 第三条必红。 */
test("项目过滤｜触发器常驻 + 共用了置灰原因；视图固定项目维 ⇒ 控件锁定", () => {
  const plain = renderActions({ projects: [{ id: "p-alpha", name: "阿尔法", shortCode: "ALP" }] });
  const trigger = tagWithTestId(plain, "work-items-project-filter");
  assert.ok(trigger.length > 0, "项目过滤入口常驻动作行（缺数据只置灰，不消失）");
  assert.ok(trigger.includes("项目"), "触发器带「项目」文案（可及名称同源）");
  assert.ok(
    !hasDisabledAttr(trigger),
    "有目标 + 快照就绪 ⇒ 可用（与状态/优先级同一份置灰判据的结论）",
  );
  /* 菜单内容在**关闭态**不进 SSR markup（Radix 的 presence）⇒ 选项清单的判据在纯函数
     `workItemProjectFilterOptions`（独立用例逐格钉住）；这里只钉入口与回显。 */
  assert.ok(
    !plain.includes('data-testid="work-items-project-filter-chip"'),
    "没勾任何项目 ⇒ 没有 chip（空 chip 行是噪音）",
  );

  const selected = renderActions({
    projects: [{ id: "p-alpha", name: "阿尔法", shortCode: "ALP" }],
    surface: applyWorkItemSurfaceIntent(workItemSurfaceDefaultState(), {
      kind: "toggleProjectFilter",
      projectId: "p-alpha",
    }),
  });
  assert.equal(
    (selected.match(/data-testid="work-items-project-filter-chip"/g) ?? []).length,
    1,
    "勾了一个项目 ⇒ 恰一枚 chip（回显）",
  );
  assert.ok(selected.includes("阿尔法"), "chip 显示项目名（不是 id）");
  assert.ok(
    selected.includes('data-testid="work-items-project-filter-active"'),
    "触发器给「这一维生效了」的记号",
  );

  const noneOnly = renderActions({
    surface: applyWorkItemSurfaceIntent(workItemSurfaceDefaultState(), {
      kind: "toggleNoProjectFilter",
    }),
  });
  assert.ok(
    noneOnly.includes('data-testid="work-items-project-filter-chip-none"') &&
      noneOnly.includes("无项目"),
    "「无项目」开关也回显成一枚 chip（与项目 chip 分开：它不是一个项目）",
  );

  const locked = renderActions({
    baseline: workItemViewBaseline(view({ query: { projectIds: ["p-alpha"] } })),
    projects: [{ id: "p-alpha", name: "阿尔法", shortCode: "ALP" }],
  });
  assert.ok(
    hasDisabledAttr(tagWithTestId(locked, "work-items-project-filter")),
    "视图固定了项目维 ⇒ 该控件锁定（与另两维同款；固定值不是用户能随手改的）",
  );
});

// ---------- ④ baseline：固定值锁定 + 清除筛选的可点性 ----------

test("baseline（验收 ...）｜视图固定值锁定置灰；「清除筛选」只在有增量时可点", () => {
  const record = view({ query: { statusCategory: "started" } });
  const baseline = workItemViewBaseline(record);
  const seeded = {
    ...workItemSurfaceDefaultState(),
    filter: {
      statusCategory: "started" as const,
      priority: "all" as const,
      projectIds: [],
      includeNoProject: false,
    },
  };
  const locked = renderActions({ surface: seeded, baseline });
  assert.ok(
    hasDisabledAttr(tagWithTestId(locked, "work-items-status-filter")),
    "视图固定了状态 ⇒ 该维勾选且禁用（固定值不是用户能随手改的）",
  );
  assert.ok(
    !hasDisabledAttr(tagWithTestId(locked, "work-items-priority-filter")),
    "没被固定的那一维照常可改（它才是增量）",
  );
  assert.ok(
    hasDisabledAttr(tagWithTestId(locked, "work-items-filter-clear")),
    "没有增量 ⇒ 清除筛选置灰（视图固定值不是增量：打开视图就让清除钮常亮毫无意义）",
  );
  const incremented = renderActions({
    surface: applyWorkItemSurfaceIntent(seeded, { kind: "setSearch", search: "甲" }),
    baseline,
  });
  assert.ok(
    !hasDisabledAttr(tagWithTestId(incremented, "work-items-filter-clear")),
    "有增量（搜索）⇒ 清除筛选可点（点了回到视图条件）",
  );

  /* R-P2：项目 facet 与另两维**同一套**增量/锁定语义（勾一个视图没固定的项目 = 增量；
     视图固定了项目维 ⇒ 该控件锁定）。 */
  const projectIncrement = applyWorkItemSurfaceIntent(seeded, {
    kind: "toggleProjectFilter",
    projectId: "p-1",
  });
  const withProject = renderActions({ surface: projectIncrement, baseline });
  assert.ok(
    !hasDisabledAttr(tagWithTestId(withProject, "work-items-filter-clear")),
    "勾了一个项目 ⇒ 有增量（清除筛选可点）",
  );
  const lockedBaseline = workItemViewBaseline(view({ query: { projectIds: ["p-1"] } }));
  assert.ok(lockedBaseline.locked.project, "视图固定了项目维 ⇒ 该维算固定（锁定判据与另两维同款）");
});

// ---------- ⑤ 拖拽把手：四格判据（验收 4/5） ----------

function renderBoard(over: {
  laneDimension: WorkItemLaneDimension;
  surface?: WorkItemSurfaceState;
  onReorder?: (plan: WorkItemPositionPlan) => void;
}): string {
  const items = [wi({ id: "wi-a", title: "甲" }), wi({ id: "wi-b", title: "乙" })];
  const surface = over.surface ?? workItemSurfaceDefaultState();
  return renderToStaticMarkup(
    createElement(ZCodeIntlProvider, {
      initialLocale: "zh-CN" as const,
      children: createElement(WorkItemsSurface, {
        workItems: items,
        snapshot: snapshotWith(items),
        discardableIds: new Set<string>(),
        busyWorkItemId: null,
        timelineExpandedWorkItemId: null,
        laneDimension: over.laneDimension,
        surface,
        onSurfaceIntent: () => {},
        onEdit: () => {},
        onInlineEdit: async () => null,
        onReassign: () => {},
        onDiscard: () => {},
        onToggleTimeline: () => {},
        onOpenWorkItemDetail: () => {},
        workspacePath: "/w/a",
        ...(over.onReorder === undefined ? {} : { onReorderPosition: over.onReorder }),
      }),
    }),
  );
}

const withSort = (intent: WorkItemSurfaceIntent): WorkItemSurfaceState =>
  applyWorkItemSurfaceIntent(workItemSurfaceDefaultState(), intent);

test("拖拽把手（验收 4/5）｜只在「看板 + statusCategory + 手动档 + 有写入口」时出现", () => {
  assert.ok(
    renderBoard({ laneDimension: "statusCategory", onReorder: () => {} }).includes(
      'data-testid="work-item-drag-handle"',
    ),
    "四格齐 ⇒ 每行给把手",
  );
  assert.ok(
    !renderBoard({ laneDimension: "assignee", onReorder: () => {} }).includes(
      'data-testid="work-item-drag-handle"',
    ),
    "按指派分组不给把手（验收 5）",
  );
  assert.ok(
    !renderBoard({ laneDimension: "none", onReorder: () => {} }).includes(
      'data-testid="work-item-drag-handle"',
    ),
    "不分组没有「列内」可言",
  );
  assert.ok(
    !renderBoard({
      laneDimension: "statusCategory",
      surface: withSort({ kind: "setSortKey", key: "title" }),
      onReorder: () => {},
    }).includes('data-testid="work-item-drag-handle"'),
    "非手动档不给把手（拖了看不出变化）",
  );
  assert.ok(
    !renderBoard({ laneDimension: "statusCategory" }).includes(
      'data-testid="work-item-drag-handle"',
    ),
    "页面没接写入口 ⇒ 不给把手",
  );
});

test("拖拽落库（验收 4）｜计划经 updateWorkItem 的 position 白名单写；宿主到看板的接线齐全", () => {
  const bridge = stripComments(readSource("squad/useWorkItemsViewsBridge.ts"));
  assert.ok(
    bridge.includes("executeWorkItemPositionPlan("),
    "拖拽执行走纯函数算好的计划（逐条串行、同值不写）",
  );
  assert.ok(
    /updateWorkItem\(target, \{[\s\S]{0,200}patch: \{ position: update\.position \}/.test(bridge),
    "落库经既有单条写入口 updateWorkItem 的 position（R6s 已通的白名单，不另开写路径）",
  );
  const page = stripComments(readSource("squad/WorkItemsPage.tsx"));
  assert.ok(
    page.includes("onReorderPosition={viewsBridge.movePosition}"),
    "宿主拿到写入口（页面 → 宿主）",
  );
  const surface = stripComments(readSource("squad/WorkItemsSurface.tsx"));
  assert.ok(
    surface.includes("workItemBoardReorderEnabled(") &&
      surface.includes("reorder: reorderCapability"),
    "宿主按唯一判据投影拖拽能力（行只据此挂不挂把手）",
  );
  /* 落点处理必须走提纯后的唯一实现（T-P2-V §8 缺口 1 / M10：`handleDragEnd` 整段短路后 ui 整包
     仍全绿）—— 这几条把"组件只做事件绑定与调用"钉住：自己算位置值 ⇒ 红；传一份没有 position 的
     泳道映射（拖了没有落点，且不报错）⇒ 红；**在调用之前短路 return / 不把计划交回写路径** ⇒ 红。
     落点语义本身在 workItemPosition.test.ts 逐格钉住。 */
  const board = stripComments(readSource("squad/WorkItemsBoard.tsx"));
  assert.ok(
    board.includes("workItemBoardDrop(") && !board.includes("workItemPositionPlan("),
    "看板把落点处理交给 workItemBoardDrop（不自己找泳道、不自己算计划）",
  );
  assert.ok(
    /lanes\.map\(\(boardLane\)[\s\S]{0,160}row\.item\.position/.test(board),
    "落点用的泳道映射必须带上落库的 position（映射成空/少了位置 = 每次拖拽都静默 none）",
  );
  /* 组件级的 M10 形态（整段短路 / 只算不交）逐格钉：把 `handleDragEnd` 的函数体切出来看 ——
     提前 `return`、或把 `onPlan` 换成空函数（计划算了却交不出去），都是**不报错**的坏法。 */
  const dragEnd = /const handleDragEnd =[\s\S]*?\n {2}\};/.exec(board)?.[0] ?? "";
  assert.ok(dragEnd.includes("workItemBoardDrop("), "handleDragEnd 的函数体必须真的调用落点处理");
  assert.ok(
    dragEnd.includes("onPlan: reorderCapability.onPlan"),
    "计划必须交回行环境给的写入口（换掉它 = 拖了但库里没动，且不报错）",
  );
  assert.ok(
    !dragEnd.includes("return"),
    "handleDragEnd 不得有短路 return（落点处理整段在 workItemBoardDrop 里，本层不做判断）",
  );
});

// ---------- ⑥ 权限镜像接线（T-P2-V §9-2：owner: null 死路已拆，编辑禁用/删除不渲染变可达） ----------

test("权限镜像｜归属由读面带回：接线层不再注入观察者身份，投影只消费 ownedByViewer", () => {
  /* 点亮前后的对照（T-P2-V §9-2 实测）：R6b 期间 `owner: null` ⇒ 每一行 ownership 都是
     "unknown" ⇒ `canManage = null` ⇒ **别人的共享视图也渲染可点的编辑/删除**（点下去才
     forbidden）——R6b 已实现的「编辑禁用 / 删除不渲染」两个分支生产接线不可达。
     现在：服务面列表逐行带回 `ownedByViewer`（repo 按注入身份算），UI 只消费它。 */
  const bridge = stripComments(readSource("squad/useWorkItemsViewsBridge.ts"));
  assert.ok(
    !bridge.includes("owner:"),
    "接线层不再注入「观察者身份」（UI 没有身份链：那一份只能是占位/自造）",
  );
  const hook = stripComments(readSource("squad/useWorkItemViews.ts"));
  assert.ok(
    hook.includes("workItemViewTabs({ views })") &&
      hook.includes("workItemViewManageRows({ views })"),
    "状态机的投影只吃记录本身（归属在记录上）",
  );
  const model = stripComments(readSource("squad/workItemViewsViewModel.ts"));
  assert.ok(
    model.includes("view.ownedByViewer"),
    "归属判据读读面带回的 `ownedByViewer`（变异：改回「不读这一位」⇒ 本条 + 纯函数用例红）",
  );
  assert.ok(
    !model.includes("owner: WorkItemViewOwner | null"),
    "投影不再有「观察者身份」入参（(kind, id) 比对只在服务面算一次）",
  );
});

// ---------- ⑦ 写路径单点（验收 2「本地调整不回写定义」的结构判据） ----------

/** 全 src 树里出现某个字面量的文件（相对 `src/`）。 */
function filesUsing(needle: string): string[] {
  const hits: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const absolute = resolve(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "components") continue;
        walk(absolute);
        continue;
      }
      if (!/\.(ts|tsx)$/.test(entry.name)) continue;
      if (stripComments(readFileSync(absolute, "utf8")).includes(needle)) {
        hits.push(absolute.slice(SRC_DIR.length + 1));
      }
    }
  };
  walk(SRC_DIR);
  return hits.sort();
}

test("写路径单点｜四个视图 RPC 的调用点只在页面接线一处；状态机只经注入的 io", () => {
  for (const rpc of [
    "listWorkItemViews(",
    "createWorkItemView(",
    "patchWorkItemView(",
    "deleteWorkItemView(",
  ]) {
    assert.deepEqual(
      filesUsing(rpc),
      ["squad/useWorkItemsViewsBridge.ts"],
      `${rpc} 的调用点只有接线层一处（引脚：页面、状态机与组件都不得直接碰服务）`,
    );
  }
  /* 状态机只经注入的 io（四条读写各恰一处调用）：`io` 是**页面注入**的，所以"忘了接线"是
     类型错误而不是静默失活（画册 `useWorkItemBulk` 的先例同款）。 */
  const hook = stripComments(readSource("squad/useWorkItemViews.ts"));
  for (const call of ["io.list(", "io.create(", "io.patch(", "io.remove("]) {
    assert.equal(hook.split(call).length - 1, 1, `${call} 恰一处（三条写路径 + 一次列表回读）`);
  }
  /* 反向：**本地意图**那一层（R1 的 Surface 折叠）与视图条组件都不得出现任何 RPC 名 ——
     变异：在意图折叠或控件里顺手写一次 patch ⇒ 本用例红。 */
  for (const file of [
    "squad/workItemSurfaceViewModel.ts",
    "squad/workItemViewsViewModel.ts",
    "squad/WorkItemViewsBar.tsx",
    "squad/WorkItemViewDialogs.tsx",
    "squad/WorkItemsPageActions.tsx",
  ]) {
    const source = stripComments(readSource(file));
    for (const rpc of ["WorkItemView(target", "updateWorkItem", "resolveSquadRuntimeService"]) {
      assert.ok(
        !source.includes(rpc),
        `${file} 不得出现 ${rpc}（本地调整不回写定义：写路径只有状态机那三条）`,
      );
    }
  }
});

test("写路径单点｜保存流带 expectedRevision；冲突分支重拉列表后再提示", () => {
  const hook = stripComments(readSource("squad/useWorkItemViews.ts"));
  assert.equal(
    (hook.match(/patchWorkItemView|io\.patch\(/g) ?? []).length,
    1,
    "patch 只调一次（三条写路径各一处，不散在多个动作里）",
  );
  assert.ok(hook.includes("expectedRevision: dialog.view.revision"), "必带乐观并发版本");
  assert.ok(
    hook.includes("WORK_ITEM_VIEW_REVISION_CONFLICT_CODE") && hook.includes("await reload()"),
    "409 等价物：重拉列表（不静默覆盖别人的改动）后再交给可见提示",
  );
  const bridge = stripComments(readSource("squad/useWorkItemsViewsBridge.ts"));
  assert.ok(
    bridge.includes("patchWorkItemView(target, input2)"),
    "接线层只做接线（把 target 与 service 绑上，不判任何视图语义）",
  );
});

test("视图消失｜退出默认标签 + 一次提示（missingToast 只在状态机里触发一次）", () => {
  const hook = stripComments(readSource("squad/useWorkItemViews.ts"));
  assert.ok(hook.includes("workItemViewListAfterLoad("), "收敛判据走纯函数（逐格可测）");
  assert.equal((hook.match(/onMissing\(\)/g) ?? []).length, 1, "缺失只报一次（列表回读的一处）");
  /* 提示的**出口**在接线层（页面注入的 notify 由它翻成 toast）：缺视图这一句用破例段的键 ——
     变异：把这句话静默掉（或换成别的键）⇒ 本用例红。 */
  const bridge = stripComments(readSource("squad/useWorkItemsViewsBridge.ts"));
  assert.ok(
    bridge.includes('"squad.workItems.views.missingToast"'),
    "提示文案用破例段里的 missingToast 键",
  );
});

// ---------- ⑧ 破例键：视图条这一面用到的键**全部**来自破例段（12 枚）+ 既有键 ----------

test("守卫｜视图面用到的文案键：破例 12 枚 + 既有键，且两语齐备（裸 key 是静默坏法）", () => {
  const exception = [
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
    "squad.workItems.views.shared",
    "squad.workItems.views.missingToast",
  ];
  for (const id of exception) {
    assert.ok(zhCN[id], `zh-CN 缺破例键 ${id}`);
    assert.ok(enUS[id], `en-US 缺破例键 ${id}`);
  }
  /* 全树扫描：这些文件里出现的 views.* 键必须**枚枚在破例段里**（变异：顺手加第 13 枚 ⇒ 红）。 */
  const scanned = [
    "squad/WorkItemViewsBar.tsx",
    "squad/WorkItemsViewsSection.tsx",
    "squad/useWorkItemsViewsBridge.ts",
    "squad/WorkItemViewDialogs.tsx",
    "squad/workItemViewsViewModel.ts",
    "squad/useWorkItemViews.ts",
    "squad/WorkItemsPage.tsx",
    "squad/WorkItemsPageActions.tsx",
  ];
  const seen = new Set<string>();
  for (const file of scanned) {
    for (const match of stripComments(readSource(file)).matchAll(
      /"(squad\.workItems\.views\.[A-Za-z0-9_]+)"/g,
    )) {
      seen.add(match[1]!);
      assert.ok(exception.includes(match[1]!), `${file} 用了破例段之外的 views 键 ${match[1]}`);
    }
  }
  for (const required of ["squad.workItems.views.label", "squad.workItems.views.missingToast"]) {
    assert.ok(seen.has(required), `扫描必须真的覆盖 \`${required}\`（否则本条空跑绿）`);
  }
  assert.equal(
    exception.filter((id) => seen.has(id)).length,
    12,
    "破例 12 枚**全部**被这一面用到（枚枚有落点：没人用的键不该占破例额）",
  );
});
