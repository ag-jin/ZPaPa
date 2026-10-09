import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { WorkItem } from "@zcode/shared";
import { SQUAD_DISPATCH_DISABLED_CODE, type SquadSnapshot } from "@zcode/services";
import { ZCodeIntlProvider } from "../src/i18n/IntlProvider.js";
import zhCN from "../src/i18n/locales/zh-CN.js";
import enUS from "../src/i18n/locales/en-US.js";
import { WorkItemQuickCreate } from "../src/squad/WorkItemQuickCreate.js";
import { WorkItemsSurface } from "../src/squad/WorkItemsSurface.js";
import { WORK_ITEM_USER_ASSIGNEE_ID } from "../src/squad/squadEntryViewModel.js";
import {
  applyWorkItemSurfaceIntent,
  workItemSurfaceDefaultState,
  type WorkItemSurfaceState,
} from "../src/squad/workItemSurfaceViewModel.js";
import {
  WORK_ITEM_PROJECT_SELECT_NONE,
  WORK_ITEM_PROJECT_SELECT_NEW,
} from "../src/squad/workItemProjectViewModel.js";
import {
  WORK_ITEM_QUICK_CREATE_NO_PARENT_VALUE,
  executeWorkItemQuickCreate,
  workItemQuickCreateDraftAfterParentChange,
  workItemQuickCreateDraftAfterSubmit,
  workItemQuickCreateParentDisplay,
  workItemQuickCreateParentId,
  workItemQuickCreateRequest,
  workItemQuickCreateSubmittable,
  type WorkItemQuickCreateDraft,
} from "../src/squad/workItemQuickCreateViewModel.js";

/* 「快速创建（视图顶部输入标题即建）」（阶段三 · T-P3-R1）的**默认值判据 + 呈现 + 结构守卫**。

   期望值的独立真源：任务卡 T-P3-R1 的验收 1-4 + `CreateWorkItemRequest` 的字段语义
   （`squadRuntimeService.ts`：缺省 = 未设置 / 不传这个键）+ 对话框 `WorkItemDialog`
   create 分支的既有默认（指派 = 本机用户、正文空白不传）。断言里的字面量**不按实现重算**。
   每条结构守卫都写明变异方式，交付报告里逐条实测。 */

const SRC_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "../src");

/** 全 src 树遍历（判据是「某个符号的出现文件集合」；注释去掉再扫）。返回 `true` 即停止。 */
function walkProjectFiles(
  dir: string,
  visit: (file: string, source: string) => boolean | void,
): void {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      walkProjectFiles(full, visit);
      continue;
    }
    if (!/\.tsx?$/.test(full) || full.endsWith(".d.ts")) continue;
    if (visit(full, stripComments(readFileSync(full, "utf8"))) === true) return;
  }
}
const readSource = (relativePath: string) => readFileSync(resolve(SRC_DIR, relativePath), "utf8");
/** 去掉注释再扫：注释里提到 `createWorkItem` / `.filter(` 是**说明**，不是代码本身。 */
const stripComments = (source: string) =>
  source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

/** 造一条工作项（只给父项候选关心的字段）。 */
function wi(id: string, title: string, parentId?: string): WorkItem {
  return {
    id,
    workspaceIdentity: "id",
    workspacePath: "/w/a",
    ...(parentId === undefined ? {} : { parentId }),
    title,
    body: "",
    status: "todo",
    assignee: { type: "user", id: "user" },
    labels: [],
    properties: {},
    position: 0,
  };
}

/** 取某个 testid 所在元素的**开标签**（`<... data-testid="x" ...>`）：用来断言 disabled 之类的属性。 */
function openTag(markup: string, testId: string): string {
  const marker = markup.indexOf(`data-testid="${testId}"`);
  assert.ok(marker >= 0, `markup 里必须有 ${testId}`);
  return markup.slice(markup.lastIndexOf("<", marker), markup.indexOf(">", marker) + 1);
}

/** 开标签上**真的**有 disabled 布尔属性（React SSR 输出 `disabled=""`）——
    不能只 `includes("disabled")`：输入框/按钮的 class 里就有 `disabled:pointer-events-none` 等前缀。 */
function hasDisabled(tag: string): boolean {
  return tag.includes('disabled=""');
}

/** 取本语词条（缺键 ⇒ 响亮失败）：`locale[key]` 在 `noUncheckedIndexedAccess` 下是 `string | undefined`，
    而 `includes("")` 恒真 —— 直接把 `undefined` 交给断言会让"缺键"变成假绿。 */
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

function renderQuickCreate(input: {
  workItems?: WorkItem[];
  createEnabled?: boolean;
  busy?: boolean;
  /** 项目清单（R-P2）：注入后项目下拉有清单可列（缺省 = 还没读到 ⇒ 只给「无项目」一档）。 */
  projects?: readonly { id: string; name: string; shortCode: string }[];
  /** 是否注入内联新建的写路径（缺省 = 不注入 ⇒ 下拉里没有「新建项目…」）。 */
  withCreateProject?: boolean;
}): string {
  const {
    workItems = [],
    createEnabled = true,
    busy = false,
    projects,
    withCreateProject = false,
  } = input;
  return renderToStaticMarkup(
    createElement(ZCodeIntlProvider, {
      initialLocale: "zh-CN" as const,
      children: createElement(WorkItemQuickCreate, {
        workItems,
        createEnabled,
        busy,
        onSubmit: async () => null,
        ...(projects === undefined ? {} : { projects }),
        ...(withCreateProject
          ? {
              onCreateProject: async () => ({
                kind: "failed" as const,
                feedback: { tone: "error" as const, messageId: "squad.common.operationFailed" },
              }),
            }
          : {}),
      }),
    }),
  );
}

// ---------- ① 默认值判据（纯函数：必填仅标题，其余默认） ----------

/* 变异：默认里顺手带上一个"聪明"的值（priority: "medium" / labels: [] / 正文占位）⇒ 下面的
   键集断言必红 —— 服务面把「不传这个键」读成未设置，替用户编一个默认值就是伪造事实。 */
test("默认值：请求只带标题（trim）+ 可选父项 + 默认指派给本机用户，其余键**不传**", () => {
  assert.deepEqual(
    workItemQuickCreateRequest({
      title: "  一条新工作项  ",
      parentValue: "wi-root",
      projectValue: WORK_ITEM_PROJECT_SELECT_NONE,
    }),
    {
      title: "一条新工作项",
      parentId: "wi-root",
      // R-P2：无项目 = 不传这个键（服务面把缺省读成无项目）。
      projectId: undefined,
      assignee: { type: "user", id: WORK_ITEM_USER_ASSIGNEE_ID },
    },
    "必填仅标题：正文 / 标签 / 优先级 / 起止日期 / 项目都不得被顺手填上（未设置就是未设置）",
  );
});

test("父项：哨兵值 ⇒ 不传 parentId（服务面把缺省读成无父项，不是空串 id）", () => {
  const request = workItemQuickCreateRequest({
    title: "顶层工作项",
    parentValue: WORK_ITEM_QUICK_CREATE_NO_PARENT_VALUE,
    projectValue: WORK_ITEM_PROJECT_SELECT_NONE,
  });
  assert.equal(request.parentId, undefined, "哨兵不得被当成一个 id 发出去");
  assert.equal(
    workItemQuickCreateParentId(WORK_ITEM_QUICK_CREATE_NO_PARENT_VALUE),
    undefined,
    "哨兵 → undefined 只有一处判据",
  );
  assert.equal(workItemQuickCreateParentId("wi-1"), "wi-1", "真实父项 id 原样透传");
});

/* 变异：提交判据里把「标题非空白」漏掉（或改成 `title.length > 0`，于是纯空格也能建）⇒ 必红。 */
test("可提交：标题非空白 + 写面可用 + 没有别的写动作在飞（三格逐格）", () => {
  const base = { createEnabled: true, busy: false };
  assert.equal(
    workItemQuickCreateSubmittable({ ...base, title: "   " }),
    false,
    "纯空白不算填了标题（与对话框的 canSubmit 同一口径）",
  );
  assert.equal(workItemQuickCreateSubmittable({ ...base, title: "" }), false);
  assert.equal(
    workItemQuickCreateSubmittable({ ...base, title: " x " }),
    true,
    "trim 后非空 ⇒ 可提交",
  );
  assert.equal(
    workItemQuickCreateSubmittable({ title: "x", createEnabled: false, busy: false }),
    false,
    "写面不可用（无目标 / 快照未就绪）⇒ 置灰",
  );
  assert.equal(
    workItemQuickCreateSubmittable({ title: "x", createEnabled: true, busy: true }),
    false,
    "有写动作在飞 ⇒ 不给第二次提交（一次写一条）",
  );
});

// ---------- ①b 父项选中的显示（触发器那行字） ----------

/* 变异：把「选中了 id 但快照里已没有它」也显示成「无（顶层）」⇒ 第三条必红 ——
   显示必须与"请求里会发生什么"一致（请求里仍然带那个 id）。 */
test("父项显示：哨兵 ⇒ 无 / 命中 ⇒ 快照标题 / 仅在快照缺席时回落 id（不假装没选）", () => {
  const items = [wi("wi-1", "批根标题"), wi("wi-2", "子项标题")];
  assert.deepEqual(
    workItemQuickCreateParentDisplay(items, WORK_ITEM_QUICK_CREATE_NO_PARENT_VALUE),
    { kind: "none" },
    "没选 ⇒ 显示「无（顶层）」",
  );
  assert.deepEqual(
    workItemQuickCreateParentDisplay(items, "wi-2"),
    { kind: "item", title: "子项标题" },
    "选中的父项在快照里 ⇒ 显示它的标题",
  );
  assert.deepEqual(
    workItemQuickCreateParentDisplay(items, "wi-gone"),
    { kind: "missing", id: "wi-gone" },
    "选中的父项已不在快照（被归档/删）⇒ 回落显示 id，**不得**显示成「无」",
  );
});

// ---------- ② 提交结论 → 表单草稿（验收 2：失败保留输入） ----------

/* 变异：失败分支顺手清空标题（或成功分支把父项也清掉）⇒ 下面两条必红。
   「成功清标题、保留父项」不是审美：清标题 = 可以接着敲下一条（连续创建）；保留父项 =
   在同一个批根下连建多条成员不用每次重选。 */
test("提交结论：成功 ⇒ 清标题、保留父项（可连续建同批成员）", () => {
  const draft: WorkItemQuickCreateDraft = {
    title: "  一条  ",
    parentValue: "wi-root",
    projectValue: WORK_ITEM_PROJECT_SELECT_NONE,
  };
  assert.deepEqual(
    workItemQuickCreateDraftAfterSubmit({ draft, feedback: null, workItems: [] }),
    { title: "", parentValue: "wi-root", projectValue: WORK_ITEM_PROJECT_SELECT_NONE },
    "成功之后草稿只剩「空标题 + 原父项 + 项目继承值」—— 没有任何地方能塞进一条本地临时行",
  );
});

test("提交结论：失败 ⇒ 草稿**原样保留**（用户输入不丢，原因由 feedback 就地显示）", () => {
  const draft: WorkItemQuickCreateDraft = {
    title: "  一条  ",
    parentValue: "wi-root",
    projectValue: "proj-beta",
  };
  assert.deepEqual(
    workItemQuickCreateDraftAfterSubmit({
      draft,
      feedback: { tone: "error", messageId: "squad.common.operationFailed", detail: "深度超限" },
      workItems: [],
    }),
    draft,
    "失败不得吞掉输入、也不得改动草稿（否则用户要重打一遍）—— 手动选的项目也一并留着",
  );
});

// ---------- ①c 项目（R-P2）：请求取值 / 父项继承预填 / 不记忆上次选择 ----------

/* 语义真源：multica A2（三个预填来源里本仓 v1 只做「子项继承父项项目」）与 MUL-5862
   （**不记忆「上次用的项目」**：带过来就会把下一条静默挂进一个用户这次没选过的项目）。
   变异：成功后保留用户手动的项目选择 ⇒ 第三条必红；父项换成无项目的那个仍留着旧项目 ⇒ 第二条必红。 */
test("项目：哨兵 ⇒ 请求里不传 projectId（无项目）；选中项目 ⇒ 原样透传 id", () => {
  const free = workItemQuickCreateRequest({
    title: "x",
    parentValue: WORK_ITEM_QUICK_CREATE_NO_PARENT_VALUE,
    projectValue: WORK_ITEM_PROJECT_SELECT_NONE,
  });
  assert.equal(free.projectId, undefined, "无项目 = 不传这个键（服务面把缺省读成无项目）");
  assert.deepEqual(
    Object.keys(free).sort(),
    ["assignee", "parentId", "projectId", "title"],
    "键集固定（值可以是 undefined，但不得多出「编出来」的键）",
  );
  assert.equal(
    workItemQuickCreateRequest({
      title: "x",
      parentValue: WORK_ITEM_QUICK_CREATE_NO_PARENT_VALUE,
      projectValue: "proj-alpha",
    }).projectId,
    "proj-alpha",
    "选中项目 ⇒ id 原样透传（是否属于本 workspace 是服务面判据）",
  );
  assert.equal(
    workItemQuickCreateRequest({
      title: "x",
      parentValue: WORK_ITEM_QUICK_CREATE_NO_PARENT_VALUE,
      projectValue: WORK_ITEM_PROJECT_SELECT_NEW,
    }).projectId,
    undefined,
    "「新建项目…」是**动作**不是项目：没真的选中项目时不带 projectId",
  );
});

test("子项继承：父项有项目 ⇒ 预填父项的；父项无项目 / 未选 ⇒ 无项目", () => {
  const items = [{ id: "wi-root", projectId: "proj-alpha" }, { id: "wi-free" }];
  const base: WorkItemQuickCreateDraft = {
    title: "一条",
    parentValue: WORK_ITEM_QUICK_CREATE_NO_PARENT_VALUE,
    projectValue: WORK_ITEM_PROJECT_SELECT_NONE,
  };
  assert.equal(
    workItemQuickCreateDraftAfterParentChange({
      draft: base,
      parentValue: "wi-root",
      workItems: items,
    }).projectValue,
    "proj-alpha",
    "选了有项目的父项 ⇒ 预填父项的项目",
  );
  assert.equal(
    workItemQuickCreateDraftAfterParentChange({
      draft: base,
      parentValue: "wi-free",
      workItems: items,
    }).projectValue,
    WORK_ITEM_PROJECT_SELECT_NONE,
    "父项没有项目 ⇒ 无项目",
  );
  assert.equal(
    workItemQuickCreateDraftAfterParentChange({
      draft: base,
      parentValue: "wi-gone",
      workItems: items,
    }).projectValue,
    WORK_ITEM_PROJECT_SELECT_NONE,
    "父项不在候选里 ⇒ 无项目（不猜）",
  );
  // 换父项时**不保留**用户此前手动选的项目（MUL-5862）：新语境按新父项重新继承。
  assert.equal(
    workItemQuickCreateDraftAfterParentChange({
      draft: { ...base, projectValue: "proj-beta" },
      parentValue: "wi-free",
      workItems: items,
    }).projectValue,
    WORK_ITEM_PROJECT_SELECT_NONE,
    "手动挑的项目不跨父项沿用（否则会把下一条静默挂进一个没选过的项目）",
  );
});

test("提交结论：成功 ⇒ 项目回落到**父项继承**（手动挑的那个不被记忆）", () => {
  const items = [{ id: "wi-root", projectId: "proj-alpha" }];
  const draft: WorkItemQuickCreateDraft = {
    title: "  一条  ",
    parentValue: "wi-root",
    projectValue: "proj-beta",
  };
  assert.deepEqual(
    workItemQuickCreateDraftAfterSubmit({ draft, feedback: null, workItems: items }),
    { title: "", parentValue: "wi-root", projectValue: "proj-alpha" },
    "连续创建时项目跟着仍留着的父项走（而不是记住上一次手动挑的那个）",
  );
  assert.deepEqual(
    workItemQuickCreateDraftAfterSubmit({ draft, feedback: null, workItems: [] }),
    { title: "", parentValue: "wi-root", projectValue: WORK_ITEM_PROJECT_SELECT_NONE },
    "没有父项候选（父项已归档）⇒ 无项目（不猜、不记忆）",
  );
});

// ---------- ②b 文案键（本轮新增恰 1 枚；其余复用既有键，两语成对） ----------

/* 变异：只改一语 / 新增第二枚键（越过"最小集 ≤4"的裁定）/ 复用一枚不存在的键 ⇒ 本用例红。
   复用不是"假设它存在"：复用键也在这里逐枚断言两语齐全（缺一枚 = 界面上出现裸 key）。 */
test("键：本轮新增恰 1 枚且两语成对；复用的既有键两语齐全（无裸 key）", () => {
  const added = ["squad.workItems.quickCreate.placeholder"];
  assert.equal(added.length, 1, "新增键规模（加键 ⇒ 这里必须显式改；任务卡上限 4 枚）");
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
  /* 命名空间集合锁（对齐 R3/R5u 的 deepEqual 形态）：`squad.workItems.quickCreate.*` 下此刻
     恰有两处声明 —— 本轮这枚 placeholder + R4 窄屏触发钮的 open。任何第三枚（越界加键：
     加了文案却没跟任何清单）⇒ 这里红；少一枚（界面上出现裸 key）同样红。 */
  for (const [name, locale] of [
    ["zh-CN", zhCN],
    ["en-US", enUS],
  ] as const) {
    assert.deepEqual(
      Object.keys(locale)
        .filter((key) => key.startsWith("squad.workItems.quickCreate."))
        .sort(),
      [...added, "squad.workItems.quickCreate.open"].sort(),
      `${name} 的 quickCreate.* 键集必须恰等于两处声明（placeholder 属本轮、open 属 R4；越界即红）`,
    );
  }
  for (const key of [
    "squad.common.title",
    "squad.common.parent",
    "squad.common.parent.none",
    "squad.common.submit",
    "squad.common.operationFailed",
    "squad.common.serviceUnavailable",
    "squad.common.dispatchDisabled",
  ]) {
    assert.ok(zhText(key) && enText(key), `复用键 ${key} 必须两语齐全`);
  }
});

// ---------- ③ 壳与可点性（渲染层：真实 ZCodeIntlProvider，不 mock） ----------

/* 变异：把可点性从 `workItemQuickCreateSubmittable` 挪走（例如只判 `!busy`，漏掉写面不可用）
   ⇒ 下面第二条必红。 */
test("壳：容器 + 标题输入（占位即用法）+ 父项下拉 + 创建钮（稳定锚点）", () => {
  const markup = renderQuickCreate({ workItems: [wi("wi-1", "批根标题"), wi("wi-2", "子项标题")] });
  assert.ok(markup.includes('data-testid="work-items-quick-create"'), "快速创建整块");
  const input = openTag(markup, "work-items-quick-create-title");
  assert.ok(
    input.includes(`placeholder="${zhText("squad.workItems.quickCreate.placeholder")}"`),
    "占位说明用法（输入标题 + 回车即建）",
  );
  assert.ok(
    input.includes(`aria-label="${zhText("squad.common.title")}"`),
    "输入框的无障碍名 = 标题（复用对话框同一枚键）",
  );
  assert.ok(
    markup.includes(`aria-label="${zhText("squad.common.parent")}"`),
    "父项下拉的无障碍名（复用同一枚键：父工作项（可选））",
  );
  assert.ok(
    markup.includes(zhText("squad.common.parent.none")),
    "默认父项 = 「无（顶层）」（触发器首屏就说得出当前挂着什么；不依赖打开过一次下拉）",
  );
  assert.ok(
    markup.includes(zhText("squad.common.submit")),
    "提交钮文案 = squad.common.submit（与对话框提交同词）",
  );
});

/* R-P2：项目下拉在条上（默认「无项目」；清单注入后才列得出项目）。变异：默认给一个项目 ⇒
   第一条必红（工作区级新建**没有默认项目**）。 */
test("项目：条上给项目下拉，默认「无项目」（清单未读到也只显示无项目）", () => {
  const plain = renderQuickCreate({});
  assert.ok(
    plain.includes('data-testid="work-items-quick-create-project"'),
    "条上有项目下拉（与父项同排）",
  );
  assert.ok(plain.includes(zhText("squad.workItems.project.none")), "默认显示「无项目」");
  const withList = renderQuickCreate({
    projects: [{ id: "proj-alpha", name: "阿尔法", shortCode: "ALP" }],
  });
  assert.ok(withList.includes("无项目"), "有清单时默认仍是「无项目」（不替用户挑一个项目）");
  assert.ok(
    withList.includes(`aria-label="${zhText("squad.workItems.project")}"`),
    "下拉的可及名称 = 项目（与过滤/表头同一句话）",
  );
  /* 内联新建入口在**下拉打开时**才进 DOM（Radix 的 presence）⇒ 选项层的判据在纯函数与
     `WorkItemProjectPicker` 的源码守卫里（缺写路径就不渲染那一项 —— 见 ⑦b 的接线守卫）。 */
  const picker = stripComments(readSource("squad/WorkItemProjectPicker.tsx"));
  assert.ok(
    picker.includes("onCreateProject === undefined ? null : ("),
    "没有写路径 ⇒ 连「新建项目…」选项都不渲染",
  );
});

test("可点性：空标题 / 写面不可用 / 有写动作在飞 ⇒ 提交钮置灰；输入框只在写面不可用时置灰", () => {
  const fresh = renderQuickCreate({});
  assert.ok(
    hasDisabled(openTag(fresh, "work-items-quick-create-submit")),
    "空标题 ⇒ 提交钮置灰（必填仅标题；按钮始终渲染，只置灰不消失）",
  );
  assert.ok(
    !hasDisabled(openTag(fresh, "work-items-quick-create-title")),
    "写面可用时输入框可编辑（标题为空禁用的是**提交**，不是输入）",
  );
  assert.ok(
    hasDisabled(
      openTag(renderQuickCreate({ createEnabled: false }), "work-items-quick-create-submit"),
    ),
    "写面不可用（无目标 / 快照未就绪）⇒ 置灰",
  );
  assert.ok(
    hasDisabled(openTag(renderQuickCreate({ busy: true }), "work-items-quick-create-submit")),
    "有写动作在飞 ⇒ 置灰（一次写一条）",
  );
  assert.ok(
    hasDisabled(
      openTag(renderQuickCreate({ createEnabled: false }), "work-items-quick-create-title"),
    ),
    "写面不可用时输入框也不可编辑（入口常驻、置灰，不消失）",
  );
});

/* 非空标题下「钮亮着」在 SSR 里渲染不出来（草稿初值恒为空）—— 所以绑定关系在源码层钉：
   钮的 disabled 必须来自 `workItemQuickCreateSubmittable` 的结论（不是第二份局部判据）。 */
test("可点性绑定：提交钮的 disabled 绑到唯一判据 canSubmit（变异：另写一份判据 ⇒ 红）", () => {
  const component = stripComments(readSource("squad/WorkItemQuickCreate.tsx"));
  assert.ok(component.includes("workItemQuickCreateSubmittable({"), "可点性走纯函数判据");
  assert.ok(component.includes("disabled={!canSubmit}"), "钮的 disabled 绑定到 canSubmit");
  assert.equal(
    (component.match(/canSubmit = /g) ?? []).length,
    1,
    "canSubmit 只在组件里定义一次（第二份 = 两套可点性语义）",
  );
});

// ---------- ④ 结构守卫：唯一写面 / 无本地临时行 / 失败不吞（变异逐条实测） ----------

test("守卫｜组件零服务访问：候选来自 props，写路径只有注入的 onSubmit（变异：组件里取服务 ⇒ 红）", () => {
  const component = stripComments(readSource("squad/WorkItemQuickCreate.tsx"));
  for (const forbidden of [
    "resolveSquadRuntimeService",
    "useServices",
    "createWorkItem",
    "updateWorkItem",
    "@zcode/services",
  ]) {
    assert.ok(
      !component.includes(forbidden),
      `快速创建条不得出现 ${forbidden}（第二处服务访问 = 第二份写路径/身份判据）`,
    );
  }
  assert.ok(component.includes("workItems.map("), "父项候选 = 宿主给的快照投影（不在组件里自取）");
});

/* 变异（本轮承重）：在组件里加一条本地临时行/乐观插入（`setItems([...])`、`useState<WorkItem[]>`、
   成功分支手工拼一条行）⇒ 下面每一条都能咬住。 */
test("守卫｜无本地临时行：草稿只有标题+父项，成功之后按纯函数清标题（变异：加本地行 ⇒ 红）", () => {
  const component = stripComments(readSource("squad/WorkItemQuickCreate.tsx"));
  assert.ok(
    !/useState<\s*WorkItem\s*(\[\])?\s*>/.test(component),
    "不得有工作项列表 state（本地行 = 冒充服务事实）",
  );
  for (const forbidden of ["setWorkItems", "setItems", "useOptimistic", "temporary"]) {
    assert.ok(
      !component.includes(forbidden),
      `快速创建条不得出现 ${forbidden}（本地行 = 冒充服务事实）`,
    );
  }
  assert.ok(
    component.includes("workItemQuickCreateDraftAfterSubmit("),
    "成功/失败的草稿演进走纯函数（成功清标题、失败原样保留）",
  );
});

test("守卫｜失败就地显示（messageId + detail 都不吞），且成功才清输入", () => {
  const component = stripComments(readSource("squad/WorkItemQuickCreate.tsx"));
  assert.ok(
    component.includes('data-testid="work-items-quick-create-error"'),
    "失败原因有就地锚点（不是只发一条 toast）",
  );
  assert.ok(component.includes('role="alert"'), "就地原因必须是可被读屏播报的活区");
  assert.ok(
    component.includes("failure.messageId") && component.includes("failure.detail"),
    "文案键与原始细节都渲染（照 WorkItemsPageStatus 的既有形态，不吞错）",
  );
});

test("守卫｜键盘判据单源：Enter=Escape 与 IME 组合闸走行内编辑那枚纯函数（不写第二份链）", () => {
  const component = stripComments(readSource("squad/WorkItemQuickCreate.tsx"));
  assert.ok(
    component.includes("resolveWorkItemInlineTitleKeyIntent("),
    "标题输入的键位 → 意图走既有单源（组合期一律 ignore —— 中文输入法的 Enter 是候选确认）",
  );
  assert.ok(
    !component.includes("isImeComposingKeyEvent"),
    "组合判据不得在组件里再写一份（两处各写一份的漂移是静默的）",
  );
});

// ---------- ⑤ 宿主接线（WorkItemsSurface：视图顶部挂载 + 写入口缺省不渲染） ----------

/* 宿主渲染需要真快照（isSquadBatchRoot 读 runs）；run 只给判据关心的那一个字段。 */
function snapshotWith(workItems: WorkItem[]): SquadSnapshot {
  return {
    enabled: true,
    teamAgents: [],
    squads: [],
    workItems,
    runs: [],
    queuedRuns: [],
  };
}

function renderSurface(input: {
  workItems: WorkItem[];
  withWriter?: boolean;
  surface?: WorkItemSurfaceState;
  busyWorkItemId?: string | null;
}): string {
  const {
    workItems,
    withWriter = false,
    surface = workItemSurfaceDefaultState(),
    busyWorkItemId = null,
  } = input;
  return renderToStaticMarkup(
    createElement(ZCodeIntlProvider, {
      initialLocale: "zh-CN" as const,
      children: createElement(WorkItemsSurface, {
        workItems,
        snapshot: snapshotWith(workItems),
        discardableIds: new Set<string>(),
        busyWorkItemId,
        timelineExpandedWorkItemId: null,
        laneDimension: "none",
        surface,
        onSurfaceIntent: () => {},
        onEdit: () => {},
        onInlineEdit: async () => null,
        onReassign: () => {},
        onDiscard: () => {},
        onToggleTimeline: () => {},
        onOpenWorkItemDetail: () => {},
        workspacePath: "/w/a",
        ...(withWriter
          ? {
              onQuickCreate: async () => null,
            }
          : {}),
      }),
    }),
  );
}

/* 承重（默认路径零回归）：写入口**缺省** ⇒ 宿主逐字节与今天相同（三份字面量基线仍绿的
   可执行证据就是下面这条 —— 新增入口是**可选能力**，缺省时不进 DOM）。
   变异：无条件渲染快速创建条 ⇒ 第一条必红。 */
test("宿主：写入口缺省 ⇒ 快速创建整块不进 DOM（默认路径零回归）", () => {
  const markup = renderSurface({ workItems: [wi("wi-1", "标题一")] });
  assert.ok(!markup.includes("work-items-quick-create"), "没有写入口就不该有这条入口");
  assert.ok(!markup.includes(zhText("squad.workItems.quickCreate.placeholder")), "占位也不得出现");
});

/* 变异：把宿主给快速创建的候选换成过滤后的 `visibleItems`（搜索一出选不到别的父项）⇒
   第三条必红；把行渲染顺手改一处 ⇒ 第二条必红。 */
test("宿主：有写入口 ⇒ 条在视图顶部，行集与默认路径**逐行相同**（不碰既有行渲染）", () => {
  const items = [wi("wi-root", "批根标题"), wi("wi-child", "子项标题", "wi-root")];
  const withWriter = renderSurface({ workItems: items, withWriter: true });
  const without = renderSurface({ workItems: items });
  assert.ok(withWriter.includes('data-testid="work-items-quick-create"'), "写入口在 ⇒ 条渲染");
  const rows = (markup: string) => (markup.match(/data-work-item-id=/g) ?? []).length;
  assert.equal(rows(withWriter), rows(without), "行集不变（快速创建是新增入口，不碰行）");
  /* 搜索过滤生效时入口**仍在**（它是入口不是结果），且候选来自**原始**列表：源码层断言。 */
  const filtered = renderSurface({
    workItems: items,
    withWriter: true,
    surface: applyWorkItemSurfaceIntent(workItemSurfaceDefaultState(), {
      kind: "setSearch",
      search: "查不到的东西",
    }),
  });
  assert.ok(
    filtered.includes('data-testid="work-items-quick-create"'),
    "被筛空时入口仍在（不随结果消失）",
  );
  const host = stripComments(readSource("squad/WorkItemsSurface.tsx"));
  assert.ok(
    host.includes("workItems={workItems}"),
    "父项候选 = 快照原始列表（不是过滤后的 visibleItems）",
  );
});

test("宿主：快照就绪但零条 ⇒ 条仍在（可以在空列表里建第一条）", () => {
  const markup = renderSurface({ workItems: [], withWriter: true });
  assert.ok(markup.includes('data-testid="work-items-quick-create"'), "空态也给入口");
  assert.ok(markup.includes('data-testid="work-items-empty"'), "空态块本身保留");
});

test("宿主：零服务访问（写路径只在注入的 onQuickCreate），可点性走 workItemCreateEnabled", () => {
  const host = stripComments(readSource("squad/WorkItemsSurface.tsx"));
  for (const forbidden of ["useServices", "resolveSquadRuntimeService", "createWorkItem("]) {
    assert.ok(!host.includes(forbidden), `宿主不得出现 ${forbidden}（唯一写路径在接线层）`);
  }
  assert.ok(host.includes("workItemCreateEnabled({"), "可点性沿用既有判据 workItemCreateEnabled");
  assert.ok(host.includes("busy={busyWorkItemId !== null}"), "有写动作在飞 ⇒ 条置灰（一次写一条）");
});

// ---------- ⑥ 执行编排（唯一写入口 → 成功才服务回读；失败不吞） ----------

/* 变异：先 reload 再 create / 失败也 reload / 失败吞掉原因 ⇒ 下面三条各自必红。
   这三条是验收 1（服务回读为准、无乐观插入）与验收 2（失败就地原因）在**编排层**的钉法：
   注入假实现，断言**调用次序与返回值**，不触碰真实服务。 */
const quickCreateRequest = () =>
  workItemQuickCreateRequest({
    title: "一条",
    parentValue: WORK_ITEM_QUICK_CREATE_NO_PARENT_VALUE,
    projectValue: WORK_ITEM_PROJECT_SELECT_NONE,
  });

test("执行：唯一写入口先写、成功才服务回读，返回 null（没有任何行从这条路径出来）", async () => {
  const calls: string[] = [];
  const result = await executeWorkItemQuickCreate({
    request: quickCreateRequest(),
    create: async (request) => {
      calls.push(
        `create:${request.title}:${request.parentId === undefined ? "root" : request.parentId}`,
      );
    },
    reload: async () => {
      calls.push("reload");
    },
  });
  assert.equal(
    result,
    null,
    "成功 ⇒ 结论是 null（不是「刚建的那条」：行只能来自回读后的快照投影）",
  );
  assert.deepEqual(
    calls,
    ["create:一条:root", "reload"],
    "写在前、回读在后（顺序反了就等于界面先自己说「它存在了」）",
  );
});

test("执行：失败 ⇒ 返回可显示原因（messageId + 原始 detail）且**不回读**（什么都没变）", async () => {
  const calls: string[] = [];
  const result = await executeWorkItemQuickCreate({
    request: quickCreateRequest(),
    create: async () => {
      throw new Error("子项已达上限 50");
    },
    reload: async () => {
      calls.push("reload");
    },
  });
  assert.deepEqual(
    result,
    {
      tone: "error",
      messageId: "squad.common.operationFailed",
      detail: "子项已达上限 50",
    },
    "服务面拒绝的原文照实带出（深度/子项上限类错误不预判、不改写）",
  );
  assert.deepEqual(calls, [], "失败不回读（不假装发生过写）");
});

test("执行：门禁关闭（稳定码）⇒ 走既有那一枚文案（不新造词、不吞成通用失败）", async () => {
  const result = await executeWorkItemQuickCreate({
    request: quickCreateRequest(),
    create: async () => {
      throw Object.assign(new Error("实验功能已关闭"), { code: SQUAD_DISPATCH_DISABLED_CODE });
    },
    reload: async () => {},
  });
  assert.equal(result?.messageId, "squad.common.dispatchDisabled");
  assert.equal(result?.tone, "warning", "门禁关闭是「功能未开」而不是一次异常");
});

// ---------- ⑦ 接线守卫（页面 → 宿主 → 条；接线层 → createWorkItem 单源） ----------

/* 变异（本轮承重 M1）：绕过 createWorkItem 直写（接线层改成 updateWorkItem / 页面自己取服务 /
   条自己发请求）⇒ 下面任一断言必红。 */
test("守卫｜唯一写路径：接线层的快速创建动作用 createWorkItem 单源 + 服务回读（不经第二处写）", () => {
  const bridge = stripComments(readSource("squad/useWorkItemsViewsBridge.ts"));
  assert.equal(
    (bridge.match(/createWorkItem\(/g) ?? []).length,
    1,
    "接线层里 createWorkItem 恰一处（第二处 = 第二份写路径）",
  );
  assert.ok(
    bridge.includes("resolveSquadRuntimeService(services).createWorkItem(target,"),
    "写走服务面唯一创建入口（不是 repo / 不是第二份请求）",
  );
  assert.ok(
    bridge.includes("executeWorkItemQuickCreate({") && bridge.includes("reload,"),
    "执行编排走纯函数 + 注入服务回读（判据可逐格测）",
  );
  const action = bridge.slice(
    bridge.indexOf("const createWorkItem = useCallback("),
    bridge.indexOf("const createWorkItem = useCallback(") + 900,
  );
  for (const forbidden of ["updateWorkItem(", "repo", "insert", "setSurface"]) {
    assert.ok(
      !action.includes(forbidden),
      `快速创建动作里不得出现 ${forbidden}（第二写面/本地改列表）`,
    );
  }
});

test("守卫｜页面接线：把接线层动作交给宿主（页面自己不拼快速创建请求）", () => {
  const page = stripComments(readSource("squad/WorkItemsPage.tsx"));
  assert.ok(
    page.includes("onQuickCreate={viewsBridge.createWorkItem}"),
    "页面只透传接线层动作（写路径与回读都在接线层）",
  );
  /* 页面里的 `service.createWorkItem(` 是**手动创建对话框**那条既有路径（另一个入口、同一单源），
     不是本轮接线 —— 所以这里判的是"快速创建那一条"没被页面自己拼出来。 */
  for (const forbidden of ["WorkItemQuickCreate", "workItemQuickCreate", "quickCreate"]) {
    assert.ok(
      !page.includes(forbidden),
      `页面不得出现 ${forbidden}（挂载点与请求构造都在宿主与条的模块里）`,
    );
  }
});

/* ---------- ⑦b 项目接线守卫（R-P2）：一份取数 / 一份写路径 / 页面三处 prop ----------

   变异（一一对应）：让某个视图自己取项目清单（→「唯一调用点」必红）；页面自己拼项目请求
   （→ 页面不得出现项目符号的负扫必红）；漏传某一处 prop（→ 计数必红）。 */
test("守卫｜项目清单与新建项目：全树唯一调用点都在 `useWorkItemProjects`（消费面只投影）", () => {
  const SRC_DIR_TREE = resolve(dirname(fileURLToPath(import.meta.url)), "../src");
  walkProjectFiles(SRC_DIR_TREE, (file, source) => {
    const relative = file.slice(SRC_DIR_TREE.length + 1);
    const inHook = relative === "squad/useWorkItemProjects.ts";
    for (const needle of ["listProjects(", "createProject("]) {
      if (source.includes(needle)) {
        assert.ok(
          inHook,
          `${relative} 出现 ${needle} —— 项目取数/写路径只能在 useWorkItemProjects`,
        );
      }
    }
    return false;
  });
  const hook = stripComments(readSource("squad/useWorkItemProjects.ts"));
  assert.equal(
    (hook.match(/listProjects\(/g) ?? []).length,
    2,
    "读面两处（挂载读一次 + 新建后回读一次），且都在这一个 hook 里",
  );
  assert.equal((hook.match(/createProject\(/g) ?? []).length, 1, "写路径恰一处");
  assert.ok(
    hook.includes("resolveSquadRuntimeService(services).createProject(target,"),
    "写走服务面唯一入口（不直写 repo / 不拼第二条请求）",
  );
});

test("守卫｜页面接线：项目 handle 投给三处（动作行 / 宿主 / 对话框），页面自己不拼项目请求", () => {
  const page = stripComments(readSource("squad/WorkItemsPage.tsx"));
  assert.equal(
    (page.match(/workItemProjects=\{viewsBridge\.workItemProjects\}/g) ?? []).length,
    3,
    "三处 prop（动作行的项目过滤 / 宿主下的看板·chip·快速创建条 / 新建对话框）",
  );
  assert.ok(
    page.includes("projectId: input.projectId"),
    "创建请求必须带上表单选中的项目（漏了 = 界面上选了、库里没有）",
  );
  for (const forbidden of ["listProjects", "createProject", "WorkItemProjectPicker"]) {
    assert.ok(
      !page.includes(forbidden),
      `页面不得出现 ${forbidden}（取数与拾取器都在各自模块，页面只透传 handle）`,
    );
  }
  const bridge = stripComments(readSource("squad/useWorkItemsViewsBridge.ts"));
  assert.ok(
    bridge.includes("useWorkItemProjects({ services, target })"),
    "接线层持有**一份**项目状态（三处消费同一个 handle）",
  );
});

test("守卫｜宿主→条：条目接收项目清单与内联新建写路径（宿主自己不取服务）", () => {
  const host = stripComments(readSource("squad/WorkItemsSurface.tsx"));
  assert.ok(
    host.includes("projects={workItemProjects?.projects ?? null}"),
    "宿主把清单投影给快速创建条",
  );
  assert.ok(
    host.includes("onCreateProject: workItemProjects.createProject"),
    "内联新建的写路径同样来自注入的 handle",
  );
  for (const forbidden of ["useServices", "resolveSquadRuntimeService", "createProject("]) {
    assert.ok(!host.includes(forbidden), `宿主不得出现 ${forbidden}（唯一写路径在接线层）`);
  }
});

test("守卫｜宿主→条：宿主把可点性结论与忙碌态投给条，条不自己取服务", () => {
  const host = stripComments(readSource("squad/WorkItemsSurface.tsx"));
  assert.ok(host.includes("<WorkItemQuickCreate"), "宿主挂载快速创建条（唯一挂载点）");
  assert.ok(
    host.includes("createEnabled={quickCreateEnabled}") &&
      host.includes("busy={busyWorkItemId !== null}"),
    "可点性与忙碌态由宿主投影（条只消费）",
  );
  assert.ok(
    host.includes("workItemCreateEnabled({") &&
      host.includes("squadWorkspaceTarget(workspacePath, workspaceIdentity)"),
    "可点性经既有判据 + 与页面同一枚 target 纯函数求值",
  );
});
