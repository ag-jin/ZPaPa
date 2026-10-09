import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { SquadSnapshot } from "@zcode/services";
import { isTerminalWorkItemStatus, type WorkItem } from "@zcode/shared";
import { ZCodeIntlProvider } from "../src/i18n/IntlProvider.js";
import zhCN from "../src/i18n/locales/zh-CN.js";
import enUS from "../src/i18n/locales/en-US.js";
import {
  WorkItemChildAddFailureLine,
  WorkItemChildrenSection,
} from "../src/squad/WorkItemChildrenSection.js";
import {
  workItemChildAddDisabledReason,
  workItemChildCreateRequest,
  workItemChildDraftAfterSubmit,
  workItemChildren,
  workItemChildrenSummary,
  workItemChildrenView,
} from "../src/squad/workItemChildrenViewModel.js";
import { executeWorkItemQuickCreate } from "../src/squad/workItemQuickCreateViewModel.js";
import { WORK_ITEM_USER_ASSIGNEE_ID } from "../src/squad/squadEntryViewModel.js";

/* 「详情页子项区」（阶段三 · T-P3-R3）的**判据 + 呈现 + 结构守卫**。

   期望值的独立真源：任务卡 T-P3-R3 的验收 1-4（终态判定复用 `isTerminalWorkItemStatus` /
   上限与深度拒绝原样显示 / 空态与「名册读不到」分开 / 批根行时间线语义零变化）
   + 快照的既有次序口径（`workItemService.listByWorkspace` 的 `ORDER BY position ASC, created_at ASC,
   id ASC` —— 快照数组就是那份次序，UI 不再排一次）
   + P3-R1 快速创建的既有纯函数（`workItemQuickCreateRequest` / `executeWorkItemQuickCreate`：
   子项添加**复用**同一份请求构造与执行编排，不写第二份）。断言里的字面量**不按实现重算**，
   每条结构守卫都写明变异方式，交付报告里逐条实测。 */

/** 造一条工作项（只给子项区关心的字段；未给的字段按 schema 缺省形状补齐）。 */
function wi(over: Partial<WorkItem> & { id: string }): WorkItem {
  return {
    workspaceIdentity: "ws",
    workspacePath: "/w/a",
    title: `标题 ${over.id}`,
    body: "",
    status: "todo",
    assignee: { type: "user", id: "user" },
    labels: [],
    properties: {},
    position: 0,
    ...over,
  };
}

/** 快照（子项区从 `snapshot.workItems` 取清单、从名册取名；其余格按 runtime 契约补齐）。 */
function snapshotWith(workItems: WorkItem[]): SquadSnapshot {
  return {
    enabled: true,
    teamAgents: [
      {
        id: "ta-1",
        name: "队员",
        systemPrompt: "s",
        skills: [],
        memoryScope: "project",
        enabled: true,
      },
    ] as SquadSnapshot["teamAgents"],
    squads: [],
    workItems,
    runs: [],
    queuedRuns: [],
  };
}

// ---------- ① 子项投影（卡面：数据取自已加载名册，按 parentId 过滤，不新增读面） ----------

/* 变异：按标题/状态另排一次（第二份排序）⇒ 第一条的次序断言必红；把孙项也算进「子项」
   （自己爬 parentId 链 = 第二棵树遍历）⇒ 第三条必红；父项不存在时抛错/返回 undefined ⇒ 第二条必红。 */
test("子项投影：按 parentId 过滤出**直接**子项，次序原样（快照次序即 repo 的 position → created_at → id）", () => {
  const items = [
    wi({ id: "wi-root", title: "批根", position: 0 }),
    wi({ id: "wi-child-b", title: "B 子项", parentId: "wi-root", position: 0 }),
    wi({ id: "wi-other", title: "别的根", position: 5 }),
    wi({ id: "wi-child-a", title: "A 子项", parentId: "wi-root", position: 3 }),
    wi({ id: "wi-grand", title: "孙项", parentId: "wi-child-b", position: 4 }),
  ];
  assert.deepEqual(
    workItemChildren({ workItems: items, parentId: "wi-root" }).map((item) => item.id),
    ["wi-child-b", "wi-child-a"],
    "直接子项、**给定次序**（B 在前是快照的位置序；按标题重排会把 A 提到前面 —— 那是第二份排序）",
  );
  assert.deepEqual(
    workItemChildren({ workItems: items, parentId: "wi-child-a" }),
    [],
    "零子项 ⇒ 空数组（不是 undefined：调用方不必再判两次）",
  );
  assert.ok(
    !workItemChildren({ workItems: items, parentId: "wi-root" }).some(
      (item) => item.id === "wi-grand",
    ),
    "孙项不属于本区的「子项」（一层过滤；整棵树的遍历是看板 flattenWorkItemBoard 的事）",
  );
  /* 变异：在判据层再加一份排序（`.sort(` / `localeCompare(`）⇒ 本条必红 —— 扫描面是**判据模块**
     本身（快照次序就是 position 口径；再排一次 = 第二份排序，与看板同胞次序迟早漂移）。 */
  const viewModel = stripComments(readSource("squad/workItemChildrenViewModel.ts"));
  for (const forbidden of [".sort(", "localeCompare("]) {
    assert.ok(
      !viewModel.includes(forbidden),
      `子项判据不得出现 ${forbidden}（快照次序就是 position 口径）`,
    );
  }
});

// ---------- ② 摘要（验收 1：终态判定复用 isTerminalWorkItemStatus / category，**不比较键名**） ----------

/* 变异（承重）：把终态写成 `status === "done"`（比较**键名**）⇒ 第一条必红（`cancelled` 是
   closed 类终态，也是收尾）；把 started 类（in_review / blocked）当成终态 ⇒ 同样必红。 */
test("摘要：终态按 **category** 数（done 与 cancelled 都是终态；in_review / blocked 不是）", () => {
  assert.equal(isTerminalWorkItemStatus("cancelled"), true, "独立真源：cancelled 属 closed 类终态");
  assert.equal(isTerminalWorkItemStatus("in_review"), false, "独立真源：in_review 属 started 类");
  const children = [
    wi({ id: "c1", status: "todo" }),
    wi({ id: "c2", status: "in_review" }),
    wi({ id: "c3", status: "blocked" }),
    wi({ id: "c4", status: "done" }),
    wi({ id: "c5", status: "cancelled" }),
  ];
  assert.deepEqual(
    workItemChildrenSummary(children),
    { total: 5, terminal: 2 },
    "total 是全部子项；terminal 只数终态（键名口径会漏掉 cancelled、把 blocked 数进来）",
  );
  assert.deepEqual(workItemChildrenSummary([]), { total: 0, terminal: 0 }, "零子项 ⇒ 两格都是 0");
});

// ---------- ③ 四态（验收 3：空态与「名册读不到」是**两个**状态，不合并） ----------

/* 变异（承重）：名册读不到时返回 `ready + []`（拿空态顶替故障）⇒ 第二条必红；
   把 loading 也并进 unavailable（首帧就说「读不到」）⇒ 第一条必红。 */
test("四态：loading / unavailable（原因原样带出）/ ready（清单 + 摘要）；空态与读不到不同 kind", () => {
  const root = wi({ id: "wi-root" });
  const done = wi({ id: "wi-c1", parentId: "wi-root", status: "done" });
  assert.deepEqual(
    workItemChildrenView({ parentId: "wi-root", snapshot: null, rosterFailure: null }),
    { kind: "loading" },
    "名册还在读（没失败）⇒ loading：不能提前说「读不到」，也不能画成空",
  );
  assert.deepEqual(
    workItemChildrenView({
      parentId: "wi-root",
      snapshot: null,
      rosterFailure: "读取名册失败：boom",
    }),
    { kind: "unavailable", error: "读取名册失败：boom" },
    "读不到 ⇒ unavailable（原始原因原样带出，不吞成一句通用失败）",
  );
  assert.deepEqual(
    workItemChildrenView({
      parentId: "wi-root",
      snapshot: snapshotWith([root, done]),
      rosterFailure: null,
    }),
    { kind: "ready", children: [done], summary: { total: 1, terminal: 1 } },
    "名册就绪 ⇒ 清单 + 摘要（摘要的终态口径见 ②）",
  );
  assert.deepEqual(
    workItemChildrenView({
      parentId: "wi-root",
      snapshot: snapshotWith([root]),
      rosterFailure: null,
    }),
    { kind: "ready", children: [], summary: { total: 0, terminal: 0 } },
    "名册就绪但零子项 ⇒ ready 空清单（「还没有子项」是**事实**，不是读不到）",
  );
});

// ---------- ④ 添加子项的判据（复用 P3-R1 的请求构造与执行编排，不写第二份） ----------

/* 变异：子项区自己拼请求（顺手带上 priority/labels 之类的「聪明默认」）⇒ 第一条必红；
   成功后不清标题（没法连续加）或失败时顺手清空（用户要重打）⇒ 第二条必红。 */
test("添加请求：复用 P3-R1 的请求构造 —— 标题 trim + parentId = 本体 id + 默认指派本机用户", () => {
  assert.equal(WORK_ITEM_USER_ASSIGNEE_ID, "user", "独立真源：本机用户的稳定 id 就是这一枚常量");
  assert.deepEqual(
    workItemChildCreateRequest({ title: "  一条子项  ", parentId: "wi-root" }),
    {
      title: "一条子项",
      parentId: "wi-root",
      // R-P2：没有父项项目 ⇒ 无项目（不传这个键）。
      projectId: undefined,
      assignee: { type: "user", id: WORK_ITEM_USER_ASSIGNEE_ID },
    },
    "必填仅标题：其余键**不传**（服务面把缺省读成未设置，不替用户编默认）",
  );
  assert.equal(
    workItemChildCreateRequest({ title: "x", parentId: "wi-root", parentProjectId: "proj-alpha" })
      .projectId,
    "proj-alpha",
    "R-P2：子项**继承父项的项目**（与快速创建条同一条判据）",
  );
});

test("添加草稿：成功 ⇒ 清标题（可连续加）；失败 ⇒ 原样保留（与 P3-R1 同一实现）", () => {
  assert.equal(
    workItemChildDraftAfterSubmit({ title: "  半条  ", parentId: "wi-root", feedback: null }),
    "",
    "成功清标题（父项由本体固定，无需保留任何选择）",
  );
  assert.equal(
    workItemChildDraftAfterSubmit({
      title: "  半条  ",
      parentId: "wi-root",
      feedback: { tone: "error", messageId: "squad.common.operationFailed", detail: "上限 50" },
    }),
    "  半条  ",
    "失败保留**原文**（含未 trim 的空格）：用户重试不用重打",
  );
});

test("归档禁用：归档 ⇒ 原因键（服务面 validateParent 必拒）；未归档 ⇒ null（可写）", () => {
  assert.equal(
    workItemChildAddDisabledReason({ archived: true }),
    "squad.workItemDetail.children.disabled.archived",
    "父项已归档：服务面 `父工作项不存在或已归档` 必拒 —— 说得出原因就别让用户撞一次墙",
  );
  assert.equal(workItemChildAddDisabledReason({ archived: false }), null, "未归档 ⇒ 可写");
});

/* 验收 2：上限 / 深度拒绝原样显示（服务面原文），失败**不回读**（没发生写，不假装发生过）。
   执行编排与 P3-R1 是**同一份** `executeWorkItemQuickCreate`（子项区不写第二份写路径）。 */
test("执行（验收 2）：子项上限 / 深度拒绝 ⇒ 原始错误原样带出，且失败不回读", async () => {
  const calls: string[] = [];
  for (const serviceError of [
    "父工作项子项数量超过上限 50：wi-root",
    "工作项层级超过深度上限 5：wi-new",
  ]) {
    const result = await executeWorkItemQuickCreate({
      request: workItemChildCreateRequest({ title: "一条子项", parentId: "wi-root" }),
      create: async () => {
        throw new Error(serviceError);
      },
      reload: async () => {
        calls.push("reload");
      },
    });
    assert.deepEqual(result, {
      tone: "error",
      messageId: "squad.common.operationFailed",
      detail: serviceError,
    });
  }
  assert.deepEqual(calls, [], "失败不回读（回读这个动作本身在说「刚刚写成了」）");
});

// ---------- ⑤ 呈现（真 ZCodeIntlProvider，不 mock；空态 / 读不到 / 加载三态互斥） ----------

/** 取某个 testid 所在元素的**开标签**（用来断言 disabled 之类的属性而不是全文）。 */
function openTag(markup: string, testId: string): string {
  const marker = markup.indexOf(`data-testid="${testId}"`);
  assert.ok(marker >= 0, `markup 里必须有 ${testId}`);
  return markup.slice(markup.lastIndexOf("<", marker), markup.indexOf(">", marker) + 1);
}

/** 开标签上**真的**有 disabled 布尔属性（React SSR 输出 `disabled=""`）。 */
function hasDisabled(tag: string): boolean {
  return tag.includes('disabled=""');
}

/** 取本语词条（缺键 ⇒ 响亮失败）。 */
function zhText(key: string): string {
  const value = zhCN[key];
  assert.ok(value, `zh-CN 缺键 ${key}`);
  return value;
}

function enText(key: string): string {
  const value = enUS[key];
  assert.ok(value, `en-US 缺键 ${key}`);
  return value;
}

/** 把 `{name}` 占位替换成给定值：期望值来自本地化词条本身 + 调用方给的数字（不按实现重算）。 */
function fill(text: string, values: Record<string, string | number>): string {
  return text.replace(/\{(\w+)\}/g, (match, name: string) => String(values[name] ?? match));
}

function renderChildren(input: {
  /** 给了 ⇒ 名册就绪；不给 ⇒ 名册还没/读不到（由 `rosterFailure` 分）。 */
  workItems?: WorkItem[];
  rosterFailure?: string;
  archived?: boolean;
}): string {
  return renderToStaticMarkup(
    createElement(ZCodeIntlProvider, {
      initialLocale: "zh-CN" as const,
      children: createElement(WorkItemChildrenSection, {
        parentId: "wi-root",
        snapshot: input.workItems === undefined ? null : snapshotWith(input.workItems),
        rosterFailure: input.rosterFailure ?? null,
        archived: input.archived ?? false,
        onSubmit: async () => null,
      }),
    }),
  );
}

/* 变异：空态 / 读不到 / 加载三态合并（例如读不到时走空态分支）⇒ 下面互斥断言必红；
   状态/指派自己拼文案（不取既有单源）⇒ 状态文案断言必红。 */
test("呈现｜就绪：清单（标题 + 状态 + 指派）+ 摘要 + 添加入口（三态各自锚点互斥）", () => {
  const markup = renderChildren({
    workItems: [
      wi({ id: "wi-root" }),
      wi({ id: "wi-c1", title: "子项甲", parentId: "wi-root", status: "done" }),
      wi({
        id: "wi-c2",
        title: "子项乙",
        parentId: "wi-root",
        status: "blocked",
        assignee: { type: "agent", id: "ta-1" },
      }),
      wi({ id: "wi-other", title: "别的根" }),
    ],
  });
  assert.ok(markup.includes(`data-testid="work-item-children"`), "整块有锚点");
  assert.ok(markup.includes(zhText("squad.workItemDetail.children.title")), "区标题");
  assert.ok(
    markup.includes(
      fill(zhText("squad.workItemDetail.children.summary"), { terminal: 1, total: 2 }),
    ),
    "摘要只数这一条的直接子项（done=1 属终态；blocked 属 started 类，不算收尾）",
  );
  assert.equal(
    (markup.match(/data-testid="work-item-child"/g) ?? []).length,
    2,
    "清单恰两条（别的根不进本区）",
  );
  assert.ok(markup.includes("子项甲") && markup.includes("子项乙"), "标题直出");
  assert.ok(
    markup.includes(zhText("squad.workItems.status.done")) &&
      markup.includes(zhText("squad.workItems.status.blocked")),
    "状态走既有穷尽文案（不自己拼键名或中文）",
  );
  assert.ok(markup.includes(zhText("squad.common.assignee.user")), "指派给本机用户 ⇒ 「我」");
  assert.ok(markup.includes("队员"), "指派给智能体 ⇒ 名册里的名字（resolveAssigneeName 单源）");
  assert.ok(!markup.includes(zhText("squad.workItemDetail.children.empty")), "有子项就不画空态");
});

test("呈现｜空态与「名册读不到」是两个状态：三态锚点与文案互斥（不合并）", () => {
  const empty = renderChildren({ workItems: [wi({ id: "wi-root" })] });
  assert.ok(
    empty.includes(`data-testid="work-item-children-empty"`) &&
      empty.includes(zhText("squad.workItemDetail.children.empty")),
    "名册就绪但零子项 ⇒ 空态",
  );
  assert.ok(
    !empty.includes(`data-testid="work-item-children-roster-unavailable"`) &&
      !empty.includes(`data-testid="work-item-children-list"`),
    "空态不得同时画「读不到」，也不留空清单壳",
  );

  const unavailable = renderChildren({ rosterFailure: "读取名册失败：boom" });
  assert.ok(
    unavailable.includes(`data-testid="work-item-children-roster-unavailable"`) &&
      unavailable.includes(zhText("squad.workItemDetail.children.rosterUnavailable")),
    "读不到 ⇒ 说明行（不是空态）",
  );
  assert.ok(unavailable.includes("读取名册失败：boom"), "原始原因原样显示（不吞错）");
  assert.ok(
    !unavailable.includes(`data-testid="work-item-children-empty"`) &&
      !unavailable.includes(zhText("squad.workItemDetail.children.empty")),
    "「读不到」不得画成「还没有子项」（把故障说成事实）",
  );

  const loading = renderChildren({});
  assert.ok(
    loading.includes(`data-testid="work-item-children-loading"`) &&
      loading.includes(zhText("squad.workItemDetail.loading")),
    "名册还在读 ⇒ 加载态（复用详情页既有加载文案）",
  );
  assert.ok(
    !loading.includes(`data-testid="work-item-children-empty"`) &&
      !loading.includes(`data-testid="work-item-children-roster-unavailable"`),
    "首帧既不宣布空、也不宣布读不到",
  );
});

test("呈现｜添加入口常驻：空标题 / 归档 / 名册未就绪 ⇒ 置灰（归档另有原因行）", () => {
  const fresh = renderChildren({ workItems: [wi({ id: "wi-root" })] });
  assert.ok(
    hasDisabled(openTag(fresh, "work-item-children-add-submit")),
    "空标题 ⇒ 提交置灰（必填仅标题；按钮始终渲染，只置灰不消失）",
  );
  assert.ok(
    !hasDisabled(openTag(fresh, "work-item-children-add-title")),
    "名册就绪且未归档 ⇒ 输入可编辑",
  );
  assert.ok(!fresh.includes(`data-testid="work-item-children-add-disabled"`), "可写时不画原因行");

  const archived = renderChildren({ workItems: [wi({ id: "wi-root" })], archived: true });
  assert.ok(hasDisabled(openTag(archived, "work-item-children-add-submit")), "归档 ⇒ 置灰");
  assert.ok(
    hasDisabled(openTag(archived, "work-item-children-add-title")),
    "归档 ⇒ 输入也不可编辑",
  );
  assert.ok(
    archived.includes(`data-testid="work-item-children-add-disabled"`) &&
      archived.includes(zhText("squad.workItemDetail.children.disabled.archived")),
    "归档原因就地可见（入口存在但禁用，不静默消失）",
  );

  const notReady = renderChildren({ rosterFailure: "boom" });
  assert.ok(
    hasDisabled(openTag(notReady, "work-item-children-add-submit")),
    "名册未就绪 ⇒ 置灰（写下去也看不见结果）",
  );
});

/* 提交失败是**交互后**的状态（SSR 到不了），故失败行单独导出、按真渲染钉住：
   锚点 + role=alert + 文案键与原始 detail 都渲染（与 P3-R1 的失败行同一形态，不吞错）。 */
test("呈现｜提交失败就地显示服务面原文（上限拒绝逐字带出，活区可播报）", () => {
  const markup = renderToStaticMarkup(
    createElement(ZCodeIntlProvider, {
      initialLocale: "zh-CN" as const,
      children: createElement(WorkItemChildAddFailureLine, {
        failure: {
          tone: "error",
          messageId: "squad.common.operationFailed",
          detail: "父工作项子项数量超过上限 50：wi-root",
        },
      }),
    }),
  );
  assert.ok(
    openTag(markup, "work-item-children-add-failure").includes('role="alert"'),
    "失败行是活区（读屏播报）",
  );
  assert.ok(
    markup.includes(zhText("squad.common.operationFailed")) &&
      markup.includes("父工作项子项数量超过上限 50：wi-root"),
    "文案键 + 服务面原文都渲染（深度 / 上限拒绝不预判、不改写）",
  );
});

test("守卫｜失败行挂载 + 草稿演进走纯函数（成功清标题、失败原样保留）", () => {
  const section = stripComments(readSource("squad/WorkItemChildrenSection.tsx"));
  assert.ok(
    section.includes("<WorkItemChildAddFailureLine") && section.includes("failure={failure}"),
    "失败行由会话内的失败态驱动（有失败才渲染）",
  );
  assert.ok(
    section.includes("workItemChildDraftAfterSubmit("),
    "成功/失败的草稿演进走纯函数（成功清标题、失败原样保留）",
  );
});

// ---------- ⑥ 接线与结构守卫（页面是串行点：挂载一次 + 唯一写路径 + 时间线不动） ----------

const SRC_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "../src");
const readSource = (relativePath: string) => readFileSync(resolve(SRC_DIR, relativePath), "utf8");
/** 去掉注释再扫：注释里提到行模块 / 树遍历 / 写方法名是**说明**，不是代码本身。 */
const stripComments = (source: string) =>
  source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

function walkSourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walkSourceFiles(full, out);
    else if (/\.tsx?$/.test(full) && !full.endsWith(".d.ts")) out.push(full);
  }
  return out;
}

test("接线｜页面挂载子项区恰一次（概览之后），名册**两格**（快照 + 失败原因）分开投给区", () => {
  const page = stripComments(readSource("squad/WorkItemDetailPage.tsx"));
  assert.equal(
    (page.match(/<WorkItemChildrenSection/g) ?? []).length,
    1,
    "子项区恰挂载一次（第二处 = 两个子项区，改一个漏一个）",
  );
  const overview = page.indexOf("<WorkItemDetailOverview");
  const children = page.indexOf("<WorkItemChildrenSection");
  const collaboration = page.indexOf('data-testid="work-item-collaboration"');
  assert.ok(
    overview >= 0 && children > overview && children < collaboration,
    "子项区落在概览之后、协作区之前（挂载点稳定，既有两区顺序不动）",
  );
  for (const prop of [
    "parentId={workItem.id}",
    "snapshot={roster}",
    "rosterFailure={rosterFailure}",
    "archived={",
    "onSubmit={createChildWorkItem}",
  ]) {
    assert.ok(page.includes(prop), `页面必须以 ${prop} 接线子项区`);
  }
  assert.equal(
    page.split(".getSnapshot(").length - 1,
    1,
    "名册读取仍只有页面那一处（子项区不新增读面：清单从这一份名册过滤）",
  );
});

/* 承重（卡面变异 2）：把子项区做成第二棵批次树（flattenWorkItemBoard / 看板行模块 /
   SquadTimelineSection 搬进详情页）⇒ 下面每一条都能咬住。 */
test("守卫｜单源：树的唯一遍历与批根判据的消费点名单不变；子项区与它们零接触", () => {
  for (const file of [
    "squad/WorkItemDetailPage.tsx",
    "squad/WorkItemChildrenSection.tsx",
    "squad/useWorkItemChildren.ts",
  ]) {
    const source = stripComments(readSource(file));
    for (const forbidden of [
      "flattenWorkItemBoard",
      "WorkItemRowList",
      "SquadTimelineSection",
      "isSquadBatchRoot",
      "work-item-timeline-toggle",
      "<WorkItemRow",
    ]) {
      assert.ok(
        !source.includes(forbidden),
        `${file} 不得出现 ${forbidden}（第二棵树 = 单源破裂）`,
      );
    }
  }
  const consumers = (needle: string) =>
    walkSourceFiles(SRC_DIR)
      .filter((file) => stripComments(readFileSync(file, "utf8")).includes(needle))
      .map((file) => file.slice(SRC_DIR.length + 1))
      .sort();
  assert.deepEqual(
    consumers("flattenWorkItemBoard("),
    [
      "squad/WorkItemListView.tsx",
      "squad/WorkItemTableView.tsx",
      "squad/WorkItemsBoard.tsx",
      "squad/workItemsViewModel.ts",
    ],
    "整片森林的唯一遍历仍只被三视图 + 它的定义模块消费（新消费点 = 第二棵树）",
  );
  assert.deepEqual(
    consumers("isSquadBatchRoot("),
    ["squad/WorkItemRows.tsx", "squad/squadEntryViewModel.ts"],
    "「什么是批根」的消费点仍是行模块 + 放弃整批判据（不新增第三处）",
  );
});

/* 验收 4：批根行时间线语义零变化 —— 时间线仍只挂在看板行上（展开钮在批根判据内）。 */
test("守卫｜时间线不动：SquadTimelineSection 与批根判据仍各恰一处（都在看板行模块）", () => {
  const rows = stripComments(readSource("squad/WorkItemRows.tsx"));
  assert.equal(
    (rows.match(/<SquadTimelineSection/g) ?? []).length,
    1,
    "时间线在看板行模块恰挂一处（详情页不做第二个挂载点）",
  );
  assert.equal(
    (rows.match(/isSquadBatchRoot\(\{/g) ?? []).length,
    1,
    "展开钮的批根判据仍只经服务面唯一实现",
  );
  const gate = rows.indexOf("isSquadBatchRoot({");
  const toggle = rows.indexOf('data-testid="work-item-timeline-toggle"');
  assert.ok(gate >= 0 && toggle > gate, "展开钮仍在批根判据内（结构未变）");
});

test("守卫｜唯一写路径：子项创建经 createWorkItem 单源 + P3-R1 执行编排；子项区零服务访问", () => {
  const hook = stripComments(readSource("squad/useWorkItemChildren.ts"));
  assert.equal(
    (hook.match(/createWorkItem\(/g) ?? []).length,
    1,
    "hook 里 createWorkItem 恰一处（第二处 = 第二份写路径）",
  );
  assert.ok(
    hook.includes("resolveSquadRuntimeService(services).createWorkItem(target,"),
    "写走服务面唯一创建入口（不直写 repo / 不拼第二条请求）",
  );
  assert.ok(
    hook.includes("executeWorkItemQuickCreate({") && hook.includes("reload: reloadRoster"),
    "执行编排复用 P3-R1 纯函数 + 服务回读（成功才回读、失败不回读由它保证）",
  );
  const section = stripComments(readSource("squad/WorkItemChildrenSection.tsx"));
  assert.ok(
    section.includes("workItemChildCreateRequest(") && !section.includes("assignee:"),
    "请求构造走 P3-R1 单源（组件里不出现 `assignee:` 字面量 = 不自己拼第二份请求）",
  );
  for (const forbidden of [
    "useServices",
    "resolveSquadRuntimeService",
    "createWorkItem",
    "updateWorkItem",
    "setRoster",
    "useOptimistic",
  ]) {
    assert.ok(
      !section.includes(forbidden),
      `子项区不得出现 ${forbidden}（组件只画 + 回传意图；写路径与回读在接线层）`,
    );
  }
  for (const line of section.split("\n")) {
    if (!line.includes('"@zcode/services"')) continue;
    assert.ok(
      line.trimStart().startsWith("import type "),
      `子项区只允许类型导入 @zcode/services：${line.trim()}`,
    );
  }
});

// ---------- ⑦ 文案键（本轮新增恰 5 枚；其余复用既有键，两语成对） ----------

/* 变异：只改一语 / 多新增一枚键（越过卡面「最小集 ≤6」的裁定）/ 复用一枚不存在的键 ⇒ 本用例红。 */
test("键：本轮新增恰 5 枚（卡面上限 6）且两语成对；复用的既有键两语齐全（无裸 key）", () => {
  const added = [
    "squad.workItemDetail.children.title",
    "squad.workItemDetail.children.empty",
    "squad.workItemDetail.children.rosterUnavailable",
    "squad.workItemDetail.children.summary",
    "squad.workItemDetail.children.disabled.archived",
  ];
  assert.equal(added.length, 5, "新增键规模（卡面：最小集 ≤6 枚；加键 ⇒ 这里必须显式改）");
  for (const key of added) {
    const zh = zhText(key);
    const en = enText(key);
    assert.ok(zh.length > 0 && en.length > 0, `${key} 两语都不得为空`);
    assert.equal(
      (zh.match(/\{(\w+)\}/g) ?? []).sort().join(","),
      (en.match(/\{(\w+)\}/g) ?? []).sort().join(","),
      `${key} 的占位符两语必须一致`,
    );
  }
  for (const [name, locale] of [
    ["zh-CN", zhCN],
    ["en-US", enUS],
  ] as const) {
    assert.deepEqual(
      Object.keys(locale)
        .filter((key) => key.startsWith("squad.workItemDetail.children."))
        .sort(),
      [...added].sort(),
      `${name} 的 children.* 键集必须与清单逐枚一致（多 = 越界加键，少 = 用了裸 key）`,
    );
  }
  for (const key of [
    "squad.workItemDetail.loading",
    "squad.common.title",
    "squad.common.submit",
    "squad.common.assignee.user",
    "squad.workItems.quickCreate.placeholder",
    "squad.workItems.status.todo",
    "squad.workItems.status.in_review",
    "squad.workItems.status.blocked",
    "squad.workItems.status.done",
    "squad.workItems.status.cancelled",
  ]) {
    assert.ok(zhText(key) && enText(key), `复用键 ${key} 必须两语齐全`);
  }
});
