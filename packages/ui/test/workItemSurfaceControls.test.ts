import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { WorkItem } from "@zcode/shared";
import type { SquadSnapshot } from "@zcode/services";
import { ZCodeIntlProvider } from "../src/i18n/IntlProvider.js";
import { WorkItemsPageActions } from "../src/squad/WorkItemsPageActions.js";
import { WorkItemsSurface } from "../src/squad/WorkItemsSurface.js";
import {
  WORK_ITEM_SURFACE_SEARCH_DEBOUNCE_MS,
  resolveWorkItemSurfaceSearchKeyIntent,
  workItemSurfaceControlsDisabledReason,
  workItemSurfaceSearchDraftFollows,
  workItemSurfaceTwinControlLabel,
} from "../src/squad/workItemSurfaceControlsViewModel.js";
import {
  WORK_ITEM_COLUMN_MESSAGE_IDS,
  WORK_ITEM_PRIORITY_FILTER_MESSAGE_IDS,
  WORK_ITEM_SORT_DIRECTION_MESSAGE_IDS,
  WORK_ITEM_SORT_MESSAGE_IDS,
  WORK_ITEM_STATUS_FILTER_MESSAGE_IDS,
  WORK_ITEM_VIEW_MODE_MESSAGE_IDS,
  applyWorkItemSurfaceIntent,
  workItemSurfaceDefaultState,
  type WorkItemSurfaceIntent,
  type WorkItemSurfaceState,
} from "../src/squad/workItemSurfaceViewModel.js";
import type { WorkItemLaneDimension } from "../src/squad/workItemsViewModel.js";
import enUS from "../src/i18n/locales/en-US.js";
import zhCN from "../src/i18n/locales/zh-CN.js";

/* 工作项 Surface **控件带**（阶段二 · T-P2-R4）的呈现与接线守卫。

   本文件钉三件事（都按本域既有做法：判据在纯函数、呈现用真渲染、接线用源码守卫）：
   ① 控件**入口常驻**：取数不可用时置灰 + 给出原因，**不消失**（与刷新/新建同一条姿态）；
   ② 搜索输入**受控**（`value` 而非 `defaultValue`）+ 防抖口径**单源**（常量与折叠判据在
      `workItemSurfaceControlsViewModel`，组件里不得再写一份毫秒数或一份草稿比对）；
   ③ 控件**只回传意图**：组件里不得出现过滤/排序的业务判据（`.filter(` / `.sort(`），
      也不得自己 setState 一份 Surface 状态。

   期望值的独立真源：拆解卡 §阶段二 T-P2-R4 的四条验收 + R1 的闭集映射与文案键目录
   （`workItemSurfaceViewModel` / `workItemSurfaceKeys` 已冻结的键）+ 两语 locale 正文。 */

const SRC_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "../src");
const readSource = (relativePath: string) => readFileSync(resolve(SRC_DIR, relativePath), "utf8");
/** 去掉注释再扫：注释里提到坏写法是**说明**，不是坏写法本身（照 workItemInlineEditRow 的既有做法）。 */
const stripComments = (source: string) =>
  source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

/** 文案真源：zh-CN 正文（断言渲染出的**正文**，不是 key —— 裸 key 是这一面最典型的静默坏法）。 */
const t = (id: string): string => zhCN[id] ?? `MISSING:${id}`;

/** 真渲染控件带：`t` 由用例注入；外面套 `ZCodeIntlProvider`（刷新按钮里的 Spinner 需要它）。 */
function renderActions(over: {
  surface?: WorkItemSurfaceState;
  laneDimension?: WorkItemLaneDimension;
  targetAvailable?: boolean;
  loading?: boolean;
  createDisabled?: boolean;
  onSurfaceIntent?: (intent: WorkItemSurfaceIntent) => void;
}): string {
  const {
    surface = workItemSurfaceDefaultState(),
    laneDimension = "none",
    targetAvailable = true,
    loading = false,
    createDisabled = false,
    onSurfaceIntent = () => {},
  } = over;
  return renderToStaticMarkup(
    createElement(ZCodeIntlProvider, {
      initialLocale: "zh-CN" as const,
      children: createElement(WorkItemsPageActions, {
        targetAvailable,
        loading,
        createDisabled,
        laneDimension,
        onLaneDimensionChange: () => {},
        surface,
        onSurfaceIntent,
        t,
        onReload: () => {},
        onCreate: () => {},
      }),
    }),
  );
}

/** 状态 + 一次意图折叠（复用 R1 的纯函数，不手写状态对象）。 */
function withIntent(intent: WorkItemSurfaceIntent): WorkItemSurfaceState {
  return applyWorkItemSurfaceIntent(workItemSurfaceDefaultState(), intent);
}

// ---------- ② 本地搜索：受控输入 + 防抖口径单源 ----------

test("搜索｜受控输入：渲染出的 value 就是状态里的搜索原文，文案复用 R1 键", () => {
  const markup = renderActions({
    surface: withIntent({ kind: "setSearch", search: "甲 乙" }),
  });
  assert.ok(markup.includes('data-testid="work-items-search"'), "搜索框常驻在控件带里");
  assert.ok(markup.includes('value="甲 乙"'), "受控：输入框的当前值来自状态（不是第二份本地真相）");
  assert.ok(
    markup.includes(`aria-label="${t("squad.workItems.search.label")}"`),
    "可及名称 = 搜索（键盘用户靠它知道这个框是干什么的）",
  );
  assert.ok(
    markup.includes(`placeholder="${t("squad.workItems.search.placeholder")}"`),
    "占位文案说明搜索范围（标题 / 标签 / 编号）",
  );
  const source = stripComments(readSource("squad/WorkItemsPageActions.tsx"));
  assert.ok(
    !source.includes("defaultValue"),
    "搜索框必须受控：defaultValue 就是第二份真相，外部清空（清除筛选 / 命名视图还原）看不见",
  );
  assert.ok(source.includes("onChange="), "受控输入必须接 onChange（不然输入框是死的）");
});

/** 取出文件里每个 `setTimeout(...)` 的**实参文本**（按括号配平切出来）。
    ⚠️ 不能用 `source.includes("常量名")` 代替：那份源码里还有 import 语句 —— 只 import 不用的
    变异会照样绿（本用例第一版实测踩过这个坑：把延迟改成字面量 200 仍绿）。 */
function timerArgsOf(source: string): string[] {
  const args: string[] = [];
  const marker = "setTimeout(";
  for (let at = source.indexOf(marker); at !== -1; at = source.indexOf(marker, at + 1)) {
    let depth = 1;
    let end = at + marker.length;
    while (end < source.length && depth > 0) {
      if (source[end] === "(") depth += 1;
      else if (source[end] === ")") depth -= 1;
      end += 1;
    }
    args.push(source.slice(at + marker.length, end - 1));
  }
  return args;
}

test("搜索｜防抖口径单源：毫秒数只在纯函数层定义，组件里不得再写一份", () => {
  assert.ok(
    Number.isFinite(WORK_ITEM_SURFACE_SEARCH_DEBOUNCE_MS) &&
      WORK_ITEM_SURFACE_SEARCH_DEBOUNCE_MS > 0 &&
      WORK_ITEM_SURFACE_SEARCH_DEBOUNCE_MS <= 1000,
    "防抖延迟必须是一个真实的、用于本地过滤的短延迟（0 = 没有防抖，过大 = 输入像卡住）",
  );
  const source = stripComments(readSource("squad/WorkItemsPageActions.tsx"));
  const timers = timerArgsOf(source);
  assert.equal(timers.length, 1, "控件带只有一个定时器（防抖提交那一处）");
  assert.ok(
    timers[0]!.includes("WORK_ITEM_SURFACE_SEARCH_DEBOUNCE_MS"),
    "那个定时器的延迟必须读纯函数层的常量（两处各写一个毫秒数 = 口径分叉）",
  );
  assert.ok(
    !/,\s*\d+\s*$/.test(timers[0]!),
    "组件里不得出现硬编码的防抖毫秒数（口径单源在 workItemSurfaceControlsViewModel）",
  );
});

test("搜索｜草稿对齐：外部改权威值 ⇒ 跟随；自己提交的回声 ⇒ 不覆盖正在输入的内容", () => {
  assert.equal(
    workItemSurfaceSearchDraftFollows({ authoritative: "", lastEmitted: "abc" }),
    true,
    "权威值被外部清空（清除筛选 / Esc / 命名视图还原）⇒ 草稿跟随",
  );
  assert.equal(
    workItemSurfaceSearchDraftFollows({ authoritative: "abc", lastEmitted: "abc" }),
    false,
    "自己提交的回声 ⇒ 保留草稿（否则用户接着敲的字会被上一帧的值覆盖掉）",
  );
  assert.equal(
    workItemSurfaceSearchDraftFollows({ authoritative: "新视图的查询", lastEmitted: "abc" }),
    true,
    "权威值换成别的内容（命名视图还原）⇒ 跟随",
  );
});

// ---------- ⑦ 守卫：零键增 / 判据不在组件里 / 两语成对 / Tab 结构 ----------

/** 本轮的**全部**文案键来源：R1 的六张闭集映射（视图名 / 排序键 / 方向 / 两个 facet / 列标题）
    —— 控件带能用的键必须**从这些映射或既有键里来**，一枚新键都不许有。 */
const FROZEN_MAP_KEY_VALUES: readonly string[] = [
  ...Object.values(WORK_ITEM_VIEW_MODE_MESSAGE_IDS),
  ...Object.values(WORK_ITEM_SORT_MESSAGE_IDS),
  ...Object.values(WORK_ITEM_SORT_DIRECTION_MESSAGE_IDS),
  ...Object.values(WORK_ITEM_STATUS_FILTER_MESSAGE_IDS),
  ...Object.values(WORK_ITEM_PRIORITY_FILTER_MESSAGE_IDS),
  ...Object.values(WORK_ITEM_COLUMN_MESSAGE_IDS),
];

/** 控件带按名消费的**既有**键（阶段二冻结清单里的标签/清除键 + 复用键 + 置灰原因键）。 */
const EXISTING_KEY_LITERALS: readonly string[] = [
  // 冻结清单（R1 落定）：控件标签与清除入口
  "squad.workItems.view.label",
  "squad.workItems.filter.label",
  "squad.workItems.filter.clear",
  "squad.workItems.search.label",
  "squad.workItems.search.placeholder",
  "squad.workItems.search.clear",
  "squad.workItems.sort.label",
  // 复用既有词汇：facet 的可及名称用字段名（与列标题同一套词）
  "squad.workItems.field.status",
  "squad.workItems.priority",
  // R1 之前就在这个文件里的键（刷新 / 新建 / 看板分组维度的标签与三档）——本轮**一字未动**，不是新键
  "squad.common.refresh",
  "squad.workItems.create",
  "squad.workItems.lane.dimension",
  "squad.workItems.lane.dimension.none",
  "squad.workItems.lane.dimension.statusCategory",
  "squad.workItems.lane.dimension.assignee",
  // 置灰原因：复用既有的三句（零键增 —— 这三枚键本来就表达"读不到数据"的三种局面）
  "squad.common.noWorkspace",
  "squad.workItems.loading",
  "squad.workItems.loadFailed",
];

const KEY_LITERAL = /"(squad\.[A-Za-z0-9_.]+)"/g;

test("守卫｜零键增：控件带两个文件里出现的文案键**全部**来自冻结清单或有既有键（一枚新键都不许有）", () => {
  const allowed = new Set([...FROZEN_MAP_KEY_VALUES, ...EXISTING_KEY_LITERALS]);
  const seen = new Set<string>();
  for (const file of [
    "squad/WorkItemsPageActions.tsx",
    "squad/workItemSurfaceControlsViewModel.ts",
  ]) {
    const source = stripComments(readSource(file));
    for (const match of source.matchAll(KEY_LITERAL)) {
      seen.add(match[1]!);
      assert.ok(
        allowed.has(match[1]!),
        `${file} 用了清单外的键 ${match[1]}（零键增：缺键要按阻塞上报，不得就地加）`,
      );
    }
  }
  // 反向检查：本轮真正在用的那几枚按名键必须被扫到（防止正则失效导致本用例空跑绿）。
  for (const required of [
    "squad.workItems.filter.label",
    "squad.workItems.search.clear",
    "squad.workItems.filter.clear",
    "squad.common.noWorkspace",
  ]) {
    assert.ok(seen.has(required), `零键增扫描必须真的覆盖到 ${required}（否则本条是空跑）`);
  }
});

test("守卫｜两语成对：控件带用到的每一枚键在 zh-CN / en-US 都有非空正文（裸 key 是静默坏法）", () => {
  const source = [
    readSource("squad/WorkItemsPageActions.tsx"),
    readSource("squad/workItemSurfaceControlsViewModel.ts"),
  ].join("\n");
  const used = new Set<string>([
    ...[...stripComments(source).matchAll(KEY_LITERAL)].map((match) => match[1]!),
    ...FROZEN_MAP_KEY_VALUES,
  ]);
  for (const id of used) {
    assert.ok((zhCN[id] ?? "").length > 0, `zh-CN 缺 ${id}`);
    assert.ok((enUS[id] ?? "").length > 0, `en-US 缺 ${id}`);
  }
});

/* 变异（承重）：把过滤 / 排序判据写进组件（或在控件带里自己 setState 一份 Surface 状态）
   ⇒ 下面两条必红。判据单源是阶段二的地基：三视图共用同一份投影，控件带只是它的投影面。 */
test("守卫｜判据不在组件里：控件带不得出现 .filter( / .sort( / localeCompare(，也不得自持 Surface 状态", () => {
  const source = stripComments(readSource("squad/WorkItemsPageActions.tsx"));
  for (const forbidden of [
    ".filter(",
    ".sort(",
    "localeCompare(",
    "setSurface(",
    "useState<WorkItemSurfaceState>",
  ]) {
    assert.ok(
      !source.includes(forbidden),
      `控件带不得出现 ${forbidden}（投影与状态的判据在 workItemSurfaceViewModel / 页面一处）`,
    );
  }
  assert.ok(
    source.includes("onSurfaceIntent("),
    "控件只回传意图：所有控件都必须经 onSurfaceIntent 走页面的唯一折叠点",
  );
});

test("键盘可达｜控件带结构：无可见文本的控件各带可及名称、没有任何 tabIndex（Tab 顺序不被代码改动）", () => {
  const markup = renderActions({});
  /* 无可见文本的控件靠 aria-label 命名（下拉显示的是当前值、输入框靠占位符 —— 都不足以当名字）。
     「清除筛选」有可见正文，它的名字就是那句正文（在本文件另一个用例里钉住）。 */
  for (const [testId, labelId] of [
    ["work-items-status-filter", "squad.workItems.field.status"],
    ["work-items-priority-filter", "squad.workItems.priority"],
    ["work-items-search", "squad.workItems.search.label"],
    ["work-items-sort-key", "squad.workItems.sort.label"],
  ] as const) {
    assert.ok(
      tagWithTestId(markup, testId).includes(`aria-label="${t(labelId)}"`),
      `${testId} 必须有可及名称（Tab 到了要知道这是什么控件）`,
    );
  }
  assert.ok(
    /aria-label="[^"]+"/.test(tagWithTestId(markup, "work-items-sort-direction")),
    "方向下拉的可及名称是「排序 + 当前方向」的组合（组合规则另有专门用例）",
  );
  const source = stripComments(readSource("squad/WorkItemsPageActions.tsx"));
  assert.ok(
    !source.includes("tabIndex"),
    "不得把任何控件移出 Tab 顺序（Tab 可达是结构性的，不靠事件补）",
  );
  assert.ok(
    !source.includes('role="button"'),
    "不得用 div 冒充按钮（那会同时丢掉键盘语义与读屏语义）",
  );
  for (const primitive of ["<Input", "<SelectTrigger", "<Button"]) {
    assert.ok(source.includes(primitive), `控件带必须消费既有 UI 原语 ${primitive}（原生可聚焦）`);
  }
});

// ---------- ⑥ 两态文案分开：「无匹配」≠「还没有工作项」 ----------

/** 一条最小工作项（只给宿主渲染用到的字段）。 */
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

/** 控件带 + 宿主同屏渲染（页面里就是这两块：动作行在上、内容在下）—— 一次断言即可看出
    "带里还留着查询"与"内容给的是哪一句话"是否自洽。 */
function renderBandAndSurface(surface: WorkItemSurfaceState, workItems: WorkItem[]): string {
  const snapshot = {
    enabled: true,
    teamAgents: [],
    squads: [],
    workItems,
    runs: [],
    queuedRuns: [],
  } as unknown as SquadSnapshot;
  return renderToStaticMarkup(
    createElement(ZCodeIntlProvider, {
      initialLocale: "zh-CN" as const,
      children: createElement(
        "div",
        null,
        createElement(WorkItemsPageActions, {
          targetAvailable: true,
          loading: false,
          createDisabled: false,
          laneDimension: "none",
          onLaneDimensionChange: () => {},
          surface,
          onSurfaceIntent: () => {},
          t,
          onReload: () => {},
          onCreate: () => {},
        }),
        createElement(WorkItemsSurface, {
          workItems,
          snapshot,
          discardableIds: new Set<string>(),
          busyWorkItemId: null,
          timelineExpandedWorkItemId: null,
          laneDimension: "none",
          surface,
          onEdit: () => {},
          onInlineEdit: async () => null,
          onReassign: () => {},
          onDiscard: () => {},
          onToggleTimeline: () => {},
          onOpenWorkItemDetail: () => {},
          workspacePath: "/w/a",
        }),
      ),
    }),
  );
}

/* 变异：把两态合并成一个分支（或让「无匹配」复用 `empty` 那两枚键）⇒ 本用例必红。
   期望值来自两语 locale 的**正文**（不是 key）：这一面最典型的静默坏法是渲染出裸 key
   —— 界面上一句 `squad.workItems.filteredEmpty`，而分支看上去是对的。 */
test("两态｜有数据但被筛掉：给「无匹配」的那两句正文，且控件带仍留着查询与清除入口", () => {
  const surface = withIntent({ kind: "setSearch", search: "查不到的东西" });
  const markup = renderBandAndSurface(surface, [wi({ id: "wi-1", title: "甲" })]);
  assert.ok(
    markup.includes('data-testid="work-items-filtered-empty"'),
    "有数据但被筛掉 ⇒ 「无匹配」态",
  );
  assert.ok(markup.includes(t("squad.workItems.filteredEmpty")), "正文 = filteredEmpty");
  assert.ok(markup.includes(t("squad.workItems.filteredEmptyHint")), "提示 = filteredEmptyHint");
  for (const wrong of ["squad.workItems.empty", "squad.workItems.emptyHint"]) {
    assert.ok(
      !markup.includes(t(wrong)),
      `「无匹配」不得借「${wrong}」的句子说（两态是两件事：一个是被筛掉了，一个是本来就没有）`,
    );
  }
  assert.ok(
    !markup.includes('data-testid="work-items-empty"'),
    "两态不得同时出现（合并分支 = 这句话会对没有数据的用户说错）",
  );
  assert.ok(
    markup.includes('value="查不到的东西"'),
    "被筛掉的这一屏里，控件带仍留着用户输入的查询",
  );
  assert.ok(
    !hasDisabledAttr(tagWithTestId(markup, "work-items-filter-clear")),
    "「清除筛选」在这一屏必须是可点的（这就是「无匹配」提示语让人做的那件事）",
  );
});

test("两态｜一条都没有：给「还没有工作项」的那两句正文，且不出现「无匹配」的句子", () => {
  const markup = renderBandAndSurface(workItemSurfaceDefaultState(), []);
  assert.ok(markup.includes('data-testid="work-items-empty"'), "零数据 ⇒ 既有空态（锚点不变）");
  assert.ok(markup.includes(t("squad.workItems.empty")), "正文 = empty");
  assert.ok(markup.includes(t("squad.workItems.emptyHint")), "提示 = emptyHint");
  assert.ok(
    !markup.includes(t("squad.workItems.filteredEmpty")),
    "一条都没有时不得说「没有匹配」—— 用户会去找那个不存在的筛选条件",
  );
  assert.ok(!markup.includes('data-testid="work-items-filtered-empty"'), "两条分支互斥");
});

// ---------- ⑤ 入口常驻 + 取数不可用 = 置灰 + 原因 ----------

/** 控件带上的 Surface **入口**（取数不可用时也必须仍然渲染 —— 只置灰，不消失）。
    搜索框内的「清除」X 是输入框自己的随附件（有文本才出现），不在"入口常驻"这一条里，
    它单独一个用例（见下）。 */
const SURFACE_CONTROL_TEST_IDS = [
  "work-items-status-filter",
  "work-items-priority-filter",
  "work-items-search",
  "work-items-sort-key",
  "work-items-sort-direction",
  "work-items-filter-clear",
] as const;

/** 取出带某个 testid 的那个**标签本身**（SSR markup 是扁平字符串；锚点到下一个 `>` 即元素末尾）。 */
function tagWithTestId(markup: string, testId: string): string {
  const index = markup.indexOf(`data-testid="${testId}"`);
  assert.ok(index >= 0, `markup 里找不到 ${testId}`);
  return markup.slice(markup.lastIndexOf("<", index), markup.indexOf(">", index));
}

/* ⚠️ `disabled` 属性必须按**属性**判：Tailwind 的 class 里就有 `disabled:cursor-not-allowed`
   这种变体 token（`includes("disabled")` 会把它误判成置灰 —— 那样"置灰"用例是恒真的）。 */
const hasDisabledAttr = (tag: string): boolean => /[\s"']disabled(?:=""|="true"|[\s/>])/.test(tag);

test("取数不可用（无工作区）｜控件**不消失**、一律置灰，且各带同一句原因", () => {
  const markup = renderActions({ targetAvailable: false, createDisabled: true });
  for (const testId of SURFACE_CONTROL_TEST_IDS) {
    const tag = tagWithTestId(markup, testId);
    assert.ok(hasDisabledAttr(tag), `${testId} 取数不可用时必须置灰（而不是消失）`);
    assert.ok(
      tag.includes(`title="${t("squad.common.noWorkspace")}"`),
      `${testId} 置灰必须给出原因（没有工作区），否则用户只看到一个点不动的控件`,
    );
  }
  // 既有入口同样在（本组件不改变刷新 / 新建的姿态）。
  assert.ok(markup.includes('data-testid="work-items-refresh"'));
  assert.ok(markup.includes('data-testid="work-items-create"'));
});

test("取数不可用（快照没读到）｜原因区分「正在读取」与「读取失败」，读取中不谎报失败", () => {
  const reading = renderActions({ createDisabled: true, loading: true });
  for (const testId of SURFACE_CONTROL_TEST_IDS) {
    assert.ok(
      tagWithTestId(reading, testId).includes(`title="${t("squad.workItems.loading")}"`),
      `${testId} 在读取中必须说「正在读取」（不是失败）`,
    );
  }
  const failed = renderActions({ createDisabled: true, loading: false });
  for (const testId of SURFACE_CONTROL_TEST_IDS) {
    assert.ok(
      tagWithTestId(failed, testId).includes(`title="${t("squad.workItems.loadFailed")}"`),
      `${testId} 读取失败必须说失败`,
    );
  }
});

test("取数不可用｜视图切换与分组**不**跟着置灰（它们不依赖数据，口径与置灰范围要显式）", () => {
  const markup = renderActions({ targetAvailable: false, createDisabled: true, loading: false });
  for (const testId of ["work-items-view-mode", "work-items-lane-dimension"]) {
    assert.ok(
      !hasDisabledAttr(tagWithTestId(markup, testId)),
      `${testId} 是纯视图设置（不需要读到数据），置灰范围只覆盖「需要数据的控件」`,
    );
  }
});

test("取数不可用｜搜索框里的「清除」X：随文本出现，但取数不可用时同样置灰 + 原因", () => {
  const withText = { kind: "setSearch", search: "abc" } as const;
  const available = renderActions({ surface: withIntent(withText) });
  const clearTag = tagWithTestId(available, "work-items-search-clear");
  assert.ok(!hasDisabledAttr(clearTag), "有文本且数据可用 ⇒ 可点（清空是纯会话内动作）");
  assert.ok(
    clearTag.includes(`aria-label="${t("squad.workItems.search.clear")}"`),
    "可及名称复用冻结键 search.clear",
  );
  assert.ok(
    !renderActions({}).includes('data-testid="work-items-search-clear"'),
    "没有文本时不出现（空框里挂一个点不动的 X 只是噪音 —— 照 SettingsSearchInput 的既有姿态）",
  );
  const unavailableTag = tagWithTestId(
    renderActions({ surface: withIntent(withText), createDisabled: true }),
    "work-items-search-clear",
  );
  assert.ok(
    hasDisabledAttr(unavailableTag) &&
      unavailableTag.includes(`title="${t("squad.workItems.loadFailed")}"`),
    "取数不可用时 X 同样置灰 + 原因（不留一个点了没反应的入口）",
  );
});

test("控制带｜置灰原因判据：纯函数逐格（无工作区 > 未就绪：读取中 / 失败），可用时为 null", () => {
  assert.equal(
    workItemSurfaceControlsDisabledReason({
      targetAvailable: false,
      dataUnavailable: true,
      loading: false,
    }),
    "squad.common.noWorkspace",
    "无工作区优先于一切（连「读取中」都不说：没有目标就无从读取）",
  );
  assert.equal(
    workItemSurfaceControlsDisabledReason({
      targetAvailable: true,
      dataUnavailable: true,
      loading: true,
    }),
    "squad.workItems.loading",
    "读取中 ⇒ 说读取中",
  );
  assert.equal(
    workItemSurfaceControlsDisabledReason({
      targetAvailable: true,
      dataUnavailable: true,
      loading: false,
    }),
    "squad.workItems.loadFailed",
    "不在读取且数据不可用 ⇒ 上一次读取失败",
  );
  assert.equal(
    workItemSurfaceControlsDisabledReason({
      targetAvailable: true,
      dataUnavailable: false,
      loading: true,
    }),
    null,
    "刷新在飞但快照还在 ⇒ 控件照常可用（不能用后台刷新把输入框锁住）",
  );
});

test("控制带｜「清除筛选」：无查询时置灰、有查询时可点并只回传 clearQuery 意图", () => {
  const idleMarkup = renderActions({});
  const idle = tagWithTestId(idleMarkup, "work-items-filter-clear");
  assert.ok(hasDisabledAttr(idle), "没有生效查询时「清除筛选」置灰（点了也没东西可清）");
  assert.ok(
    idleMarkup.includes(`>${t("squad.workItems.filter.clear")}</button>`),
    "入口文案复用冻结键的正文（不是裸 key）",
  );

  const active = tagWithTestId(
    renderActions({ surface: withIntent({ kind: "setSearch", search: "abc" }) }),
    "work-items-filter-clear",
  );
  assert.ok(!hasDisabledAttr(active), "有生效查询时可点");
  const facetOnly = tagWithTestId(
    renderActions({ surface: withIntent({ kind: "setStatusFilter", value: "done" }) }),
    "work-items-filter-clear",
  );
  assert.ok(
    !hasDisabledAttr(facetOnly),
    "只有 facet 生效（搜索为空）时同样可点 —— 可点性问 workItemSurfaceHasActiveQuery 一处",
  );

  const source = stripComments(readSource("squad/WorkItemsPageActions.tsx"));
  assert.ok(
    source.includes("workItemSurfaceHasActiveQuery("),
    "可点性必须问 R1 的纯判据（不在这里再判一遍「有没有查询」）",
  );
  assert.ok(
    source.includes('kind: "clearQuery"'),
    "「清除筛选」只回传 clearQuery 意图（清哪些字段在 applyWorkItemSurfaceIntent 一处）",
  );
});

// ---------- ④ 键盘可达：Tab / Enter / Esc ----------

/* 键盘语义的判据在纯函数里（照 `resolveWorkItemInlineTitleKeyIntent` 的先例）——
   ui 包没有渲染测试设施，写在事件回调里就等于不可测，而这些判据的坏法全是静默的：
   Tab 被 preventDefault 吞掉（焦点再也出不去这个输入框）、组合期的 Enter 被当成提交
   （中文输入法按 Enter 选字 = 每次选字都提交一次查询）。 */
test("键盘｜按键 → 意图：非组合期 Enter = 立刻提交、Esc = 清空、**Tab 必须放行**、组合期一律不吃", () => {
  const intentOf = (
    key: string,
    over: { compositionActive?: boolean; isComposing?: boolean } = {},
  ) =>
    resolveWorkItemSurfaceSearchKeyIntent({
      key,
      compositionActive: over.compositionActive ?? false,
      isComposing: over.isComposing ?? false,
    });
  assert.equal(intentOf("Enter"), "commit", "Enter = 立刻提交（不等防抖窗口）");
  assert.equal(intentOf("Escape"), "clear", "Esc = 清空搜索（唯一的键盘清空路径）");
  assert.equal(
    intentOf("Tab"),
    "ignore",
    "Tab 必须放行：吃了 Tab 就等于把键盘用户困在搜索框里（焦点出不去）",
  );
  for (const key of ["a", "ArrowDown", "ArrowUp", "Shift", " "]) {
    assert.equal(intentOf(key), "ignore", `${key} 不该被搜索框吃掉`);
  }
  for (const key of ["Enter", "Escape"]) {
    assert.equal(
      intentOf(key, { compositionActive: true }),
      "ignore",
      `输入法组合期的 ${key} 是候选确认/取消，不是「提交/清空搜索」`,
    );
    assert.equal(
      intentOf(key, { isComposing: true }),
      "ignore",
      `nativeEvent 报组合期的 ${key} 同样不吃（组合态两个来源都认）`,
    );
  }
});

test("键盘｜接线：输入框的键盘判据只有那一份纯函数，组件里不得出现键名字面量", () => {
  const source = stripComments(readSource("squad/WorkItemsPageActions.tsx"));
  assert.ok(
    source.includes("resolveWorkItemSurfaceSearchKeyIntent("),
    "输入框必须调那枚纯函数（按键语义单源）",
  );
  for (const keyLiteral of ['"Enter"', "'Enter'", '"Escape"', "'Escape'", '"Tab"', "'Tab'"]) {
    assert.ok(
      !source.includes(keyLiteral),
      `组件里不得出现键名字面量 ${keyLiteral}（键位判据在 workItemSurfaceControlsViewModel 一处）`,
    );
  }
  assert.ok(
    source.includes("onCompositionStart") && source.includes("onCompositionEnd"),
    "组合态必须接线（只读 nativeEvent.isComposing 在部分浏览器上会漏掉组合结束那一帧）",
  );
});

// ---------- ③ 排序：键 + 方向 ----------

/* 两个同族下拉的**可及名称必须能区分**：都用「排序」的话，读屏与键盘用户听到两个同名控件，
   选错了也不知道错在哪。而「排序方向」这一枚键**不在**冻结清单里（零键增）⇒ 用已有的两枚键
   拼出名称（族 + 当前值，空格分隔 —— 本仓 en 文案不用全角冒号，分隔符因此必须是语言中立的）。 */
test("控件带｜同族双控件的可及名称：族 + 当前值，中英都读得通，且不与族名同形", () => {
  assert.equal(
    workItemSurfaceTwinControlLabel("排序", "升序"),
    "排序 升序",
    "中文：族 + 空格 + 当前值（分隔符不得用全角冒号 —— en 文案里没有它）",
  );
  assert.equal(
    workItemSurfaceTwinControlLabel("Sort", "Ascending"),
    "Sort Ascending",
    "英文：同样的组合规则读得通（这是选空格分隔的理由）",
  );
  assert.notEqual(
    workItemSurfaceTwinControlLabel("排序", "升序"),
    "排序",
    "组合名必须与族名不同形，否则两个下拉在可及名称上仍然同名",
  );
});

test("控件带｜排序两个下拉常驻：取值表引用 R1 闭集，方向的可及名称随当前值走", () => {
  const markup = renderActions({});
  assert.ok(markup.includes('data-testid="work-items-sort-key"'), "排序键下拉常驻");
  assert.ok(markup.includes('data-testid="work-items-sort-direction"'), "排序方向下拉常驻");
  assert.ok(
    markup.includes(`aria-label="${t("squad.workItems.sort.label")}"`),
    "排序键下拉的可及名称 = 排序",
  );
  assert.ok(
    markup.includes(
      `aria-label="${workItemSurfaceTwinControlLabel(t("squad.workItems.sort.label"), t("squad.workItems.sort.asc"))}"`,
    ),
    "方向下拉的可及名称 = 排序 + 当前方向（默认升序）—— 与键下拉不同名",
  );
  const source = stripComments(readSource("squad/WorkItemsPageActions.tsx"));
  for (const needle of [
    "WORK_ITEM_SORT_KEYS.map(",
    "WORK_ITEM_SORT_MESSAGE_IDS[key]",
    "WORK_ITEM_SORT_DIRECTIONS.map(",
    "WORK_ITEM_SORT_DIRECTION_MESSAGE_IDS[direction]",
    'kind: "setSortKey"',
    'kind: "setSortDirection"',
  ]) {
    assert.ok(source.includes(needle), `排序控件必须经 ${needle} 接线（闭集与文案都来自 R1 单源）`);
  }
  assert.ok(
    !source.includes('sort.key === "manual"') && !source.includes("compareWorkItem"),
    "组件里不得出现排序判据（比较只在 workItemSurfaceViewModel 一处）",
  );
});

// ---------- ① 过滤 facet（状态 / 优先级） ----------

test("控件带｜过滤 facet 常驻：两个下拉各有稳定锚点与可及名称，且同属「筛选」一组", () => {
  const markup = renderActions({});
  for (const [testId, labelId] of [
    ["work-items-status-filter", "squad.workItems.field.status"],
    ["work-items-priority-filter", "squad.workItems.priority"],
  ] as const) {
    assert.ok(
      markup.includes(`data-testid="${testId}"`),
      `${testId} 必须常驻在动作行（不是藏起来的设置项）`,
    );
    assert.ok(
      markup.includes(`aria-label="${t(labelId)}"`),
      `${testId} 的可及名称必须是「${labelId}」的正文（键盘/读屏靠它分辨两个同族下拉）`,
    );
  }
  assert.ok(
    markup.includes(`role="group"`) &&
      markup.includes(`aria-label="${t("squad.workItems.filter.label")}"`),
    "两个 facet 归属同一个命名组（组名 = 筛选）",
  );
});

test("控件带｜过滤 facet 只回传意图：取值表引用 R1 闭集，组件里不自己判过滤", () => {
  const source = stripComments(readSource("squad/WorkItemsPageActions.tsx"));
  /* 断言**调用点**而不是裸标识符：只 import 不用的变异不能照样绿（照防抖那一处踩过的坑）。 */
  for (const needle of [
    "WORK_ITEM_STATUS_FILTER_VALUES.map(",
    "WORK_ITEM_STATUS_FILTER_MESSAGE_IDS[value]",
    "WORK_ITEM_PRIORITY_FILTER_VALUES.map(",
    "WORK_ITEM_PRIORITY_FILTER_MESSAGE_IDS[value]",
    'kind: "setStatusFilter"',
    'kind: "setPriorityFilter"',
  ]) {
    assert.ok(
      source.includes(needle),
      `控件带必须经 ${needle} 接线（取值表与文案都来自 R1 的单源）`,
    );
  }
});
