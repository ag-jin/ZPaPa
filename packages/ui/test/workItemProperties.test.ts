import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { WORK_ITEM_CREATOR_KINDS, WORK_ITEM_PRIORITY_KEYS, workItemSchema } from "@zcode/shared";
import type { WorkItemCollaborationRead } from "@zcode/services";
import { ZCodeIntlProvider } from "../src/i18n/IntlProvider.js";
import enUS from "../src/i18n/locales/en-US.js";
import zhCN from "../src/i18n/locales/zh-CN.js";
import { WorkItemDetailOverview } from "../src/squad/WorkItemDetailOverview.js";
import { WorkItemsBoard } from "../src/squad/WorkItemsBoard.js";
import {
  WORK_ITEM_CREATOR_KIND_MESSAGE_IDS,
  WORK_ITEM_PRIORITY_MESSAGE_IDS,
  WORK_ITEM_SURFACE_FIELD_ERROR_MESSAGE_IDS,
  parseWorkItemSurfaceFields,
  workItemCreatorKindMessageId,
  workItemCreatorText,
  workItemDateText,
  workItemIdentifierText,
  workItemPriorityMessageId,
} from "../src/squad/workItemPropertiesViewModel.js";

const SRC_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "../src");
const readSource = (relativePath: string) => readFileSync(resolve(SRC_DIR, relativePath), "utf8");

/* 工作项 Surface 字段（阶段一 · 轮 C）在 UI 面的用例：**呈现判据的纯函数**逐格 +
   结构守卫（单源/零日期换算/中性徽标）+ 两语文案成对。

   shared 的解析规则（优先级闭集 / 日历日期）不在这里重复：它们的逐格用例在
   `packages/shared/test/`。UI 侧只钉「这些值怎么被展示、怎么被送进表单」。 */

// ---------- ① identifier 展示文本（UI 单源纯函数；前缀不入库） ----------

test("identifier 展示文本：恰为 `#<序号>`；未设置 ⇒ null（调用方据此不渲染）", () => {
  assert.equal(workItemIdentifierText(12), "#12");
  assert.equal(workItemIdentifierText(1), "#1");
  assert.equal(workItemIdentifierText(999), "#999");
  assert.equal(workItemIdentifierText(undefined), null);
  assert.equal(workItemIdentifierText(null), null);
});

// ---------- ② 优先级（闭集四档 + 未设置） ----------

test("优先级文案：键集 == shared 闭集四档（穷尽），闭集外与未设置 ⇒ null（不渲染裸 key）", () => {
  assert.deepEqual(
    Object.keys(WORK_ITEM_PRIORITY_MESSAGE_IDS).sort(),
    [...WORK_ITEM_PRIORITY_KEYS].sort(),
    "映射的键集必须与 shared 的闭集逐项相同（加一枚键 ⇒ 这里必须跟着动）",
  );
  for (const key of WORK_ITEM_PRIORITY_KEYS) {
    const messageId = WORK_ITEM_PRIORITY_MESSAGE_IDS[key];
    assert.ok(
      messageId.startsWith("squad.workItems.priority."),
      `${key} 的文案 id 必须在优先级族内：${messageId}`,
    );
    assert.equal(workItemPriorityMessageId(key), messageId);
  }
  for (const unset of [undefined, null, "", "blocker", 1]) {
    assert.equal(
      workItemPriorityMessageId(unset),
      null,
      "未设置（NULL/undefined）与闭集外的值一律不渲染 —— 不猜、不显示陌生档位",
    );
  }
});

// ---------- ③ 日历日期的呈现（零换算） ----------

test("日期呈现：逐字原样（不换算、不改格式）；空/空白 ⇒ null（未设置）", () => {
  /* 时区**钉在 UTC 以西**：`YYYY-MM-DD` 一旦被当成时刻再按本地格式化，这一天会落到昨天 ——
     本机默认时区（UTC+8）差不出来，所以这条用例自带时区，换任何机器都咬得住换算
     （时区是进程级全局，用完立刻还原，避免影响同文件其它用例）。 */
  const defaultTimeZone = process.env.TZ;
  process.env.TZ = "America/Los_Angeles";
  try {
    assert.equal(workItemDateText("2026-10-08"), "2026-10-08");
    // 边界日：任何「按时刻解析再格式化」的实现都会在这里差一天（UTC 午夜 vs 本地时区），
    // 而呈现层的契约是**日历日期原样**——这些字面量就是独立真源。
    assert.equal(workItemDateText("2026-01-01"), "2026-01-01");
    assert.equal(workItemDateText("2026-12-31"), "2026-12-31");
    assert.equal(workItemDateText("2028-02-29"), "2028-02-29");
  } finally {
    if (defaultTimeZone === undefined) delete process.env.TZ;
    else process.env.TZ = defaultTimeZone;
  }
  assert.equal(workItemDateText(undefined), null);
  assert.equal(workItemDateText(null), null);
  assert.equal(workItemDateText("   "), null);
});

// ---------- ④ 表单输入归一化（判据单源在 shared） ----------

test("表单字段归一化：空 ⇒ null（未设置/清空）；合法值原样；坏值 ⇒ 指名到字段", () => {
  assert.deepEqual(
    parseWorkItemSurfaceFields({ priority: "", startDate: "", dueDate: "" }),
    { kind: "ok", patch: { priority: null, startDate: null, dueDate: null } },
    "三项全空 = 三项都不设置（不是「没提这个字段」）",
  );
  assert.deepEqual(
    parseWorkItemSurfaceFields({
      priority: "urgent",
      startDate: "2026-10-08",
      dueDate: "2026-10-15",
    }),
    {
      kind: "ok",
      patch: { priority: "urgent", startDate: "2026-10-08", dueDate: "2026-10-15" },
    },
  );
  assert.deepEqual(
    parseWorkItemSurfaceFields({ priority: "", startDate: " 2026-10-08 ", dueDate: "" }),
    { kind: "ok", patch: { priority: null, startDate: "2026-10-08", dueDate: null } },
    "输入两端的空白不构成拒绝理由（trim 只发生在表单取值这一侧）",
  );
  assert.deepEqual(
    parseWorkItemSurfaceFields({ priority: "blocker", startDate: "", dueDate: "" }),
    { kind: "invalid", field: "priority", value: "blocker" },
    "闭集外的优先级必须**指名**（响亮），不得静默折成未设置",
  );
  assert.deepEqual(
    parseWorkItemSurfaceFields({ priority: "", startDate: "2026-02-30", dueDate: "" }),
    { kind: "invalid", field: "startDate", value: "2026-02-30" },
    "不存在的日期（正则放行、日历不存在）同样响亮",
  );
  assert.deepEqual(
    parseWorkItemSurfaceFields({ priority: "", startDate: "", dueDate: "2026-13-01" }),
    { kind: "invalid", field: "dueDate", value: "2026-13-01" },
  );
});

// ---------- ⑤ 创建人（actor 词汇的闭集 + 显示名回落） ----------

test("创建人：种类文案键集 == actor 闭集（三类）；显示名缺省时回落 id；未设置 ⇒ null", () => {
  assert.deepEqual(
    Object.keys(WORK_ITEM_CREATOR_KIND_MESSAGE_IDS).sort(),
    [...WORK_ITEM_CREATOR_KINDS].sort(),
    "种类映射必须与 shared 的 actor 闭集逐项相同（human / agent / system）",
  );
  for (const kind of WORK_ITEM_CREATOR_KINDS) {
    assert.equal(workItemCreatorKindMessageId(kind), WORK_ITEM_CREATOR_KIND_MESSAGE_IDS[kind]);
    assert.ok(WORK_ITEM_CREATOR_KIND_MESSAGE_IDS[kind].startsWith("squad.workItems.creator."));
  }
  assert.equal(
    workItemCreatorText({ kind: "human", id: "u-1", displayName: "本地用户" }),
    "本地用户",
  );
  assert.equal(workItemCreatorText({ kind: "system", id: "migration-0018" }), "migration-0018");
  assert.equal(workItemCreatorText(undefined), null, "存量行没有这个事实 ⇒ 不渲染（不编「未知」）");
  assert.equal(workItemCreatorText(null), null);
});

// ---------- ⑥ 详情概览的真渲染（接缝 = 组件 props） ----------

const OVERVIEW_BASE: WorkItemCollaborationRead["workItem"] = {
  id: "wi-1",
  workspaceIdentity: "ws",
  workspacePath: "/w",
  title: "详情概览的新字段",
  body: "",
  status: "in_progress",
  assignee: { type: "user", id: "u" },
  labels: [],
  properties: {},
  position: 0,
};

function renderOverviewDetail(
  workItem: WorkItemCollaborationRead["workItem"],
  bodyExpanded = false,
): string {
  return renderToStaticMarkup(
    createElement(ZCodeIntlProvider, {
      initialLocale: "zh-CN" as const,
      children: createElement(WorkItemDetailOverview, {
        workItem,
        assigneeLabel: "用户·本地",
        bodyExpanded,
        onToggleBody: () => {},
      }),
    }),
  );
}

test("概览真渲染｜四族字段各有稳定 testid 与文本（优先级 / 起止 / 创建人 / identifier）", () => {
  const markup = renderOverviewDetail({
    ...OVERVIEW_BASE,
    priority: "high",
    startDate: "2026-10-08",
    dueDate: "2026-12-31",
    creator: { kind: "human", id: "u-1", displayName: "本地用户" },
    identifierSeq: 12,
  });
  for (const testId of [
    "work-item-detail-priority",
    "work-item-detail-start-date",
    "work-item-detail-due-date",
    "work-item-detail-creator",
    "work-item-detail-identifier",
  ]) {
    assert.ok(markup.includes(`data-testid="${testId}"`), `概览缺 ${testId}`);
  }
  assert.ok(markup.includes("#12"), "identifier 以 `#序号` 形态呈现（前缀由 UI 单源函数拼）");
  assert.ok(markup.includes("高"), "优先级显示该档文案（闭集四档之一）");
  assert.ok(markup.includes("2026-10-08") && markup.includes("2026-12-31"), "起止日期原样呈现");
  assert.ok(markup.includes("本地用户"), "创建人显示 displayName");
});

test("概览真渲染｜未设置的字段**整块不渲染**（不留空行、不写「未知/系统」）", () => {
  const markup = renderOverviewDetail(OVERVIEW_BASE);
  for (const testId of [
    "work-item-detail-priority",
    "work-item-detail-start-date",
    "work-item-detail-due-date",
    "work-item-detail-creator",
    "work-item-detail-identifier",
  ]) {
    assert.ok(
      !markup.includes(`data-testid="${testId}"`),
      `${testId} 在未设置时必须整块不渲染（空行是噪音）`,
    );
  }
  assert.ok(
    !markup.includes('data-testid="work-item-detail-attributes"'),
    "三项全空时连属性带容器都不渲染（一个空容器就是一个空行）",
  );
  for (const never of ["未知", "系统", "未设置"]) {
    assert.ok(!markup.includes(never), `未设置不得编出「${never}」这类占位说法`);
  }
});

test("概览真渲染｜创建人无显示名时回落 id（不显示空行）；日期不被换算", () => {
  const markup = renderOverviewDetail({
    ...OVERVIEW_BASE,
    creator: { kind: "system", id: "migration-0018" },
    startDate: "2026-01-01",
  });
  assert.ok(markup.includes("migration-0018"), "displayName 缺省 ⇒ 回落 id");
  assert.ok(markup.includes("2026-01-01"), "边界日原样（任何换算都会在这一天现形）");
});

// ---------- ⑦ 看板行的视觉密度与字段（真渲染 + 结构守卫） ----------

function renderBoard(workItems: WorkItemCollaborationRead["workItem"][]): string {
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
      children: createElement(WorkItemsBoard, {
        workItems,
        snapshot,
        discardableIds: new Set<string>(),
        busyWorkItemId: null,
        timelineExpandedWorkItemId: null,
        laneDimension: "none",
        onEdit: () => {},
        onReassign: () => {},
        onDiscard: () => {},
        onToggleTimeline: () => {},
        onOpenWorkItemDetail: () => {},
        workspacePath: "/w",
      }),
    }),
  );
}

test("看板行真渲染｜identifier 与优先级**有值才画**（未设置不留空位）", () => {
  /* 取值用正则**只读锚点里的文本**：档位文案「中」是「进行中」的子串，裸 includes 会把
     状态文案误当徽标（这种断言一旦写松，改坏徽标也不会红）。 */
  const badgeText = (markup: string) =>
    /data-testid="work-item-priority"[^>]*>([^<]*)</.exec(markup)?.[1] ?? null;
  const rich = renderBoard([{ ...OVERVIEW_BASE, priority: "urgent", identifierSeq: 7 }]);
  assert.ok(rich.includes("#7"), "行上给 identifier 文本（同一个单源纯函数）");
  assert.equal(badgeText(rich), "紧急", "行上给优先级档位文案");
  const plain = renderBoard([OVERVIEW_BASE]);
  assert.ok(!plain.includes("#7"), "没有序号就不画（不显示一个空编号）");
  assert.equal(badgeText(plain), null, "未设置优先级就不画徽标（连空壳都不留）");
});

/* 密度 token（差距报告 §5）：行不再是「卡片」（`rounded-lg border` 包裹感 + 行间 gap），
   而是**细分隔线 + hover surface** 的高密度列表行；行高不小于 44px（可点目标的下限）。
   变异：把 ROW_CLASSNAME 改回卡片形态（或去掉 min-h-11）⇒ 本守卫必红。 */
test("守卫｜看板行视觉密度：细分隔线 + hover surface + 44px 行高（不是卡片包裹）", () => {
  const board = readSource("squad/WorkItemsBoard.tsx");
  const match = /const ROW_CLASSNAME\s*=\s*([\s\S]*?);/.exec(board);
  assert.ok(match, "行样式常量必须存在且可被文本断言");
  const classname = match[1]!;
  assert.ok(classname.includes("border-b border-border"), "行之间用细分隔线（替换卡片的四边框）");
  assert.ok(classname.includes("hover:bg-hover"), "行有 hover surface（可点性可见）");
  assert.ok(classname.includes("transition-colors"), "hover 过渡（与仓内列表同款）");
  assert.ok(classname.includes("min-h-11"), "行高不小于 44px（可点目标下限）");
  for (const cardLike of ["rounded-lg border border-border", "shadow"]) {
    assert.ok(!classname.includes(cardLike), `行不得退回卡片形态（${cardLike}）`);
  }
  const list = /const LIST_CLASSNAME\s*=\s*([\s\S]*?);/.exec(board);
  assert.ok(list, "列表容器样式常量必须存在");
  assert.ok(
    !/\bgap-\d/.test(list[1]!),
    "列表不留行间沟（分隔线相邻成列；留沟会让 hover surface 断成一块块卡片）",
  );
});

test("守卫｜优先级徽标只有一处定义（看板行与详情概览共用同一个组件）", () => {
  const board = readSource("squad/WorkItemsBoard.tsx");
  const overview = readSource("squad/WorkItemDetailOverview.tsx");
  assert.ok(
    board.includes("export function WorkItemPriorityBadge("),
    "徽标的唯一定义在看板（行词汇的拥有者）",
  );
  assert.equal(
    (board.match(/const WORK_ITEM_PRIORITY_BADGE_CLASSNAME/g) ?? []).length,
    1,
    "徽标样式常量只有一处定义",
  );
  assert.ok(
    overview.includes("<WorkItemPriorityBadge"),
    "详情概览必须复用徽标组件（不得自带第二份外观）",
  );
  assert.ok(
    !overview.includes("border-border px-1.5 py-0.5 text-ui-xs text-foreground-subtle"),
    "详情概览不得再抄一份徽标样式（两份外观迟早长得不一样）",
  );
});

test("守卫｜行渲染仍单点（data-work-item-id 与 rowElementsRef 注册各恰一处）", () => {
  const board = readSource("squad/WorkItemsBoard.tsx");
  assert.equal(
    (board.match(/data-work-item-id=\{item\.id\}/g) ?? []).length,
    1,
    "密度改造不得复制第二份行 JSX（行渲染单点守卫）",
  );
  assert.equal((board.match(/rowElementsRef\.current\.set\(/g) ?? []).length, 1);
});

// ---------- ⑧ 编辑面（表单 → 页面 → 服务面）见 `workItemSurfaceEdit.test.ts` ----------

// ---------- ⑨ 两条硬守卫：日期零换算 / identifier 前缀不入库 ----------

/** 去掉注释再扫：注释里提到 `new Date(` 是说明，不是换算（真正要禁的是代码里的换算）。 */
const stripComments = (source: string) =>
  source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

test("守卫｜日期零转换：轮 C 的呈现与编辑面不得出现时刻换算（含 new Date(）", () => {
  for (const file of [
    "squad/WorkItemDetailOverview.tsx",
    "squad/WorkItemsBoard.tsx",
    "squad/workItemPropertiesViewModel.ts",
    "squad/WorkItemsPage.tsx",
    "squad/WorkItemsPageDialogs.tsx",
    "squad/SquadCreateDialogs.tsx",
  ]) {
    const source = stripComments(readSource(file));
    for (const forbidden of ["new Date(", "Date.parse(", "toISOString(", "toLocaleDateString("]) {
      assert.ok(
        !source.includes(forbidden),
        `${file} 不得出现 ${forbidden}：YYYY-MM-DD 一经时刻换算就会按 UTC/本地时区差一天，且静默`,
      );
    }
  }
});

test("守卫｜identifier 前缀不入库：展示文本单源拼接，领域形状只收整数序号", () => {
  const vm = stripComments(readSource("squad/workItemPropertiesViewModel.ts"));
  assert.equal(
    (vm.match(/WORK_ITEM_IDENTIFIER_PREFIX/g) ?? []).length,
    2,
    "前缀常量只有「定义 + 拼接」两处（多一处 = 有人自己拼）",
  );
  assert.ok(vm.includes('export const WORK_ITEM_IDENTIFIER_PREFIX = "#";'), "前缀是 UI 常量短码");
  for (const file of ["squad/WorkItemDetailOverview.tsx", "squad/WorkItemsBoard.tsx"]) {
    const source = stripComments(readSource(file));
    assert.ok(source.includes("workItemIdentifierText("), `${file} 必须走单源函数`);
    assert.ok(
      !/\$\{WORK_ITEM_IDENTIFIER_PREFIX\}|["'`]#\$\{/.test(source),
      `${file} 不得自己拼前缀（前缀是单源函数的事）`,
    );
  }
  // 领域形状：`identifierSeq` 是**整数序号**（前缀入库会在这里就解析失败）。
  const base = {
    id: "wi-1",
    workspaceIdentity: "ws",
    workspacePath: "/w",
    title: "t",
    body: "",
    status: "todo",
    assignee: { type: "user", id: "u" },
  };
  assert.equal(workItemSchema.safeParse({ ...base, identifierSeq: 12 }).success, true);
  assert.equal(
    workItemSchema.safeParse({ ...base, identifierSeq: "#12" }).success,
    false,
    "前缀不得进领域模型（DB 只存整数；展示文本是 UI 的事）",
  );
});

// ---------- ⑩ 两语文案成对（R10 口径） ----------

/** 轮 C 新增的全部文案键（由闭集与映射**推导**，不是手抄：漏一个键这条用例就红）。 */
const WORK_ITEM_SURFACE_MESSAGE_IDS: string[] = [
  "squad.workItems.priority",
  ...WORK_ITEM_PRIORITY_KEYS.map((key) => `squad.workItems.priority.${key}`),
  "squad.workItems.priority.unset",
  "squad.workItems.startDate",
  "squad.workItems.dueDate",
  "squad.workItems.datePlaceholder",
  "squad.workItems.creator",
  ...WORK_ITEM_CREATOR_KINDS.map((kind) => `squad.workItems.creator.${kind}`),
  ...Object.values(WORK_ITEM_SURFACE_FIELD_ERROR_MESSAGE_IDS),
];

test("守卫｜新字段文案两语成对（每键两语齐 + 占位符成对 + 键数 == 闭集大小）", () => {
  assert.equal(
    new Set(WORK_ITEM_SURFACE_MESSAGE_IDS).size,
    WORK_ITEM_SURFACE_MESSAGE_IDS.length,
    "键目录里不得有重复（重复 = 有人合并了两族词汇）",
  );
  const placeholders = (value: string) =>
    [...value.matchAll(/\{(\w+)\}/g)]
      .map((match) => match[1])
      .sort()
      .join(",");
  for (const key of WORK_ITEM_SURFACE_MESSAGE_IDS) {
    const zh = zhCN[key];
    const en = enUS[key];
    assert.ok(zh, `zh-CN 缺键 ${key}`);
    assert.ok(en, `en-US 缺键 ${key}`);
    assert.equal(placeholders(zh), placeholders(en), `${key} 的占位符两语不成对`);
  }
  // 档位键数 == 闭集大小（两族映射各一条）。
  assert.equal(Object.keys(WORK_ITEM_PRIORITY_MESSAGE_IDS).length, WORK_ITEM_PRIORITY_KEYS.length);
  assert.equal(
    Object.keys(WORK_ITEM_CREATOR_KIND_MESSAGE_IDS).length,
    WORK_ITEM_CREATOR_KINDS.length,
  );
  // 预检文案的映射键集 == 三个字段（少一个键 ⇒ 那个字段坏掉时没有话可说）。
  assert.deepEqual(Object.keys(WORK_ITEM_SURFACE_FIELD_ERROR_MESSAGE_IDS).sort(), [
    "dueDate",
    "priority",
    "startDate",
  ]);
});
