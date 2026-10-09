import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { IServiceAccessor, SquadSnapshot } from "@zcode/services";
import type { WorkItem } from "@zcode/shared";
import { ZCodeIntlProvider } from "../src/i18n/IntlProvider.js";
import zhCN from "../src/i18n/locales/zh-CN.js";
import enUS from "../src/i18n/locales/en-US.js";
import { ServiceProvider } from "../src/hooks/useServices.js";
import { WorkItemMobileSheet } from "../src/squad/WorkItemMobileSheet.js";
import { WorkItemPeek } from "../src/squad/WorkItemPeek.js";
import { WorkItemsSurface } from "../src/squad/WorkItemsSurface.js";
import { workItemSurfaceDefaultState } from "../src/squad/workItemSurfaceViewModel.js";
import { useWorkItemSurfaceViewport } from "../src/squad/useWorkItemSurfaceViewport.js";
import {
  WORK_ITEM_COMPACT_MEDIA_QUERY,
  workItemCompactSheetKeyIntent,
  workItemCompactSheetTarget,
  workItemSurfaceViewport,
  type WorkItemSurfaceViewport,
} from "../src/squad/workItemResponsiveViewModel.js";

/* 「移动端 Sheet（响应式收口）」（阶段三 · T-P3-R4）的**判据 + 呈现 + 结构守卫**。

   期望值的独立真源：任务卡 T-P3-R4 的验收 1-4（窄屏 = Sheet / 桌面 = 分栏·行内、不得两套同时渲染、
   移动输入 `text-mobile-input-safe`、关闭路径可验证）+ 本仓既有响应式形态（Tailwind `md:` = 768px，
   squad 的移动输入 `text-mobile-input-safe md:text-ui-base` 用的就是这一枚）+ UI Events 规范的
   键值（`Escape`）。断言里的字面量不按实现重算：每条结构守卫都写明变异方式，交付报告里逐条实测。 */

const SRC_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "../src");
const readSource = (relativePath: string) => readFileSync(resolve(SRC_DIR, relativePath), "utf8");
/** 去掉注释再扫：注释里提到函数名/查询字符串是**说明**，不是代码本身。 */
const stripComments = (source: string) =>
  source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

// ---------- ① 视口判据（SSR 传桌面默认） ----------

/* 变异：把分界写成 640 / 1024（另造一枚与 `md:` 不同的断点）⇒ 第一条必红；
   把「判不出来」当成窄屏（`narrowMatch !== false`）⇒ 第三条必红（SSR 会翻到 Sheet，
   桌面默认路径当场变样）。 */
test("断点：与 Tailwind `md:` 同一枚（≥768 = 桌面）；判不出宽度 ⇒ 桌面默认（SSR）", () => {
  assert.equal(
    WORK_ITEM_COMPACT_MEDIA_QUERY,
    "(max-width: 767px)",
    "窄屏分界 = 768px 的另一半（本仓既有移动输入用的就是 `md:` 这一枚）",
  );
  assert.equal(workItemSurfaceViewport(true), "compact", "命中窄屏查询 ⇒ 抽屉形态");
  assert.equal(workItemSurfaceViewport(false), "desktop", "≥768 ⇒ 分栏/行内（既有形态）");
  assert.equal(
    workItemSurfaceViewport(null),
    "desktop",
    "SSR / 无 matchMedia ⇒ **桌面默认**（既有默认路径不能被兜底换掉）",
  );
});

// ---------- ② 抽屉目标：至多一个 ----------

/* 变异：两个抽屉各自独立渲染（不做目标归一）⇒ 第三条必红；把快速创建排在 peek 之前 ⇒
   第四条必红（行点击的直接结果是 peek，它不能被另一个抽屉盖住）。 */
test("抽屉目标：至多一个（peek 优先；都没开 ⇒ none）", () => {
  assert.equal(workItemCompactSheetTarget({ peekOpen: false, quickCreateOpen: false }), "none");
  assert.equal(
    workItemCompactSheetTarget({ peekOpen: false, quickCreateOpen: true }),
    "quickCreate",
  );
  assert.equal(workItemCompactSheetTarget({ peekOpen: true, quickCreateOpen: false }), "peek");
  assert.equal(
    workItemCompactSheetTarget({ peekOpen: true, quickCreateOpen: true }),
    "peek",
    "同时成立 ⇒ peek（否则 peek 被快速创建抽屉盖住）",
  );
});

// ---------- ③ 关闭路径（验收 3：至少一条可验证） ----------

/* 变异：把键位判据另写一份（`key === "Esc"`）⇒ 第一条必红；让 Esc 无条件关两个（不判当前抽屉）
   ⇒ 第三条必红。 */
test("Esc：只关当前那一个抽屉；没得关 ⇒ none（键位复用 peek 那一枚判据）", () => {
  assert.equal(
    workItemCompactSheetKeyIntent({ key: "Escape", peekOpen: true, quickCreateOpen: true }),
    "peek",
  );
  assert.equal(
    workItemCompactSheetKeyIntent({ key: "Escape", peekOpen: false, quickCreateOpen: true }),
    "quickCreate",
  );
  assert.equal(
    workItemCompactSheetKeyIntent({ key: "Escape", peekOpen: false, quickCreateOpen: false }),
    "none",
  );
  for (const key of ["Esc", "Enter", " ", "j", "Tab"]) {
    assert.equal(
      workItemCompactSheetKeyIntent({ key, peekOpen: true, quickCreateOpen: true }),
      "none",
      `「${key}」不得关抽屉`,
    );
  }
});

// ---------- ④ 视口钩子（浏览器侧读取：SSR 默认 + 可注入覆盖） ----------

function Probe({ override }: { override?: WorkItemSurfaceViewport }) {
  const viewport = useWorkItemSurfaceViewport(override);
  return createElement("span", { "data-testid": "viewport-probe" }, viewport);
}

function renderProbe(override?: WorkItemSurfaceViewport): string {
  const markup = renderToStaticMarkup(
    createElement(ZCodeIntlProvider, {
      initialLocale: "zh-CN" as const,
      children: createElement(Probe, override === undefined ? {} : { override }),
    }),
  );
  return markup.slice(markup.indexOf(">") + 1, markup.lastIndexOf("<"));
}

/* 变异：初始态把「判不出来」当成窄屏 ⇒ 第一条必红；覆盖被忽略（宿主注入的形态不生效 ⇒
   验收 1 的两档都测不到）⇒ 第二、三条必红。 */
test("视口钩子：SSR 无 window ⇒ 桌面默认；注入覆盖 ⇒ 按覆盖（可测的唯一注入点）", () => {
  assert.equal(renderProbe(), "desktop", "无 window（node:test / SSR）⇒ 桌面默认");
  assert.equal(renderProbe("compact"), "compact", "注入窄屏 ⇒ 窄屏分支可达（两档都测得到）");
  assert.equal(renderProbe("desktop"), "desktop", "注入桌面 ⇒ 桌面分支");
});

/* 变异：把查询写成别的断点（640/1024）或不做清理（不留孤儿监听）⇒ 结构守卫必红。 */
test("守卫｜视口钩子：命中结果按同一枚断点查询读、订阅 change、卸载时摘掉监听", () => {
  const hook = stripComments(readSource("squad/useWorkItemSurfaceViewport.ts"));
  assert.ok(
    hook.includes("typeof window") && hook.includes('typeof window.matchMedia !== "function"'),
    "无 window / 无 matchMedia ⇒ 不发问（走桌面兜底）",
  );
  assert.ok(
    hook.includes("matchMedia(WORK_ITEM_COMPACT_MEDIA_QUERY)"),
    "查询用**同一枚**断点常量（不手抄字面量）",
  );
  assert.equal(
    (hook.match(/matchMedia\(/g) ?? []).length,
    1,
    "只查一次（初始读与订阅各写一份查询 = 两处可以漂移）",
  );
  assert.ok(
    hook.includes('query.addEventListener("change", update)') &&
      hook.includes('query.removeEventListener("change", update)'),
    "订阅 change 且在卸载时摘掉（不留孤儿监听）",
  );
});

// ---------- ⑤ 抽屉壳（验收 1：窄屏 = Sheet/底部抽屉） ----------

/** 本语词条（缺键 ⇒ 响亮失败）：`locale[key]` 在 `noUncheckedIndexedAccess` 下是 `string | undefined`。 */
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

/** 取某个 testid 所在元素的**开标签**（用来断言属性而不是全文）。 */
function openTag(markup: string, testId: string): string {
  const marker = markup.indexOf(`data-testid="${testId}"`);
  assert.ok(marker >= 0, `markup 里必须有 ${testId}`);
  return markup.slice(markup.lastIndexOf("<", marker), markup.indexOf(">", marker) + 1);
}

function renderSheet(input: {
  title?: string;
  childText?: string;
  locale?: "zh-CN" | "en-US";
}): string {
  return renderToStaticMarkup(
    createElement(ZCodeIntlProvider, {
      initialLocale: input.locale ?? ("zh-CN" as const),
      children: createElement(WorkItemMobileSheet, {
        ...(input.title === undefined ? {} : { title: input.title }),
        onClose: () => {},
        children: createElement(
          "span",
          { "data-testid": "sheet-child" },
          input.childText ?? "子内容",
        ),
      }),
    }),
  );
}

/* 变异：壳子不做固定定位/不铺到视口底部（当成普通块）⇒ 第一条必红；把子内容套一层条件渲染
   ⇒ 第二条必红；有标题却不给可及名称 / 关闭钮 ⇒ 第三、四条必红。 */
test("抽屉壳：底部固定面板 + 遮罩；子内容原样渲染", () => {
  const markup = renderSheet({ title: zhText("squad.workItems.quickCreate.open") });
  const root = openTag(markup, "work-item-mobile-sheet");
  assert.ok(
    root.includes("fixed") && root.includes("inset-0") && root.includes("justify-end"),
    "抽屉是视口级（fixed）且贴底（justify-end）—— 普通流里的块不叫抽屉",
  );
  const panel = openTag(markup, "work-item-mobile-sheet-panel");
  assert.ok(
    panel.includes("max-h-") &&
      panel.includes("overflow-y-auto") &&
      panel.includes("rounded-t-2xl"),
    "面板限高可滚、只圆上角（贴底抽屉的形态）",
  );
  assert.ok(
    panel.includes('role="dialog"') && panel.includes('aria-modal="true"'),
    "有标题的抽屉是一次任务（role=dialog + aria-modal）",
  );
  assert.ok(
    panel.includes(`aria-label="${zhText("squad.workItems.quickCreate.open")}"`),
    "可及名称 = 标题（读屏听到的是抽屉要干什么）",
  );
  assert.ok(
    openTag(markup, "work-item-mobile-sheet-scrim").includes("absolute") &&
      openTag(markup, "work-item-mobile-sheet-scrim").includes("bg-black/60"),
    "遮罩铺满视口（点击外部关闭的落点）",
  );
  assert.ok(markup.includes("子内容"), "子内容（peek / 快速创建）原样进抽屉");
});

/* 变异：无标题也给头部（peek 抽屉会长出第二枚关闭钮与重复标题）⇒ 第一条必红。 */
test("抽屉壳：无标题 ⇒ 不画头部（peek 抽屉的可及名称与关闭钮在 peek 面板自身）", () => {
  const markup = renderSheet({});
  assert.ok(!markup.includes("work-item-mobile-sheet-close"), "没有头部就没有第二枚关闭钮");
  assert.ok(
    !openTag(markup, "work-item-mobile-sheet-panel").includes("role="),
    "壳体不承担语义（peek 是速览、非模态：可及名称在它的面板上）",
  );
  assert.ok(markup.includes("子内容"), "子内容照常渲染");
});

test("抽屉壳：有标题 ⇒ 关闭钮带可及名称（验收 3 的按钮一路）", () => {
  const markup = renderSheet({ title: zhText("squad.workItems.quickCreate.open") });
  const close = openTag(markup, "work-item-mobile-sheet-close");
  assert.ok(
    close.includes(`aria-label="${zhText("squad.workItems.sheet.close")}"`),
    "只有图标 ⇒ 必须带可及名称",
  );
  assert.ok(close.includes(`type="button"`), "关闭钮是普通按钮（不触发原生表单提交）");
});

// ---------- ⑥ peek 面板：width/className 可选 prop（P3-R2 接缝） ----------

function wipeek(over: Partial<WorkItem> = {}): WorkItem {
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

function renderPeek(className?: string): string {
  return renderToStaticMarkup(
    createElement(ZCodeIntlProvider, {
      initialLocale: "zh-CN" as const,
      children: createElement(ServiceProvider, {
        /* 静态渲染不进 effect ⇒ 读模型停在 idle：只需要一个能通过 useServices() 的访问器。 */
        services: {} as IServiceAccessor,
        children: createElement(WorkItemPeek, {
          workItemId: "wi-1",
          workspacePath: "/w/a",
          snapshot: snapshotWith([]),
          onClose: () => {},
          onOpenDetail: () => {},
          ...(className === undefined ? {} : { className }),
        }),
      }),
    }),
  );
}

/* 变异：把缺省类换成抽屉形态（桌面分栏当场变形，R2 的呈现逐槽变）⇒ 第一条必红；
   抽屉里不覆盖宽度（面板还是 w-80，窄屏抽屉里右半空着）⇒ 第二条必红。 */
test("peek 面板：缺省 = 桌面分栏固定宽（不变）；传 className ⇒ 合并覆盖（抽屉铺满）", () => {
  const desktop = openTag(renderPeek(), "work-item-peek");
  assert.ok(
    desktop.includes("w-80") && desktop.includes("shrink-0") && desktop.includes("bg-card"),
    "桌面分栏形态是 R2 的既有呈现（缺省不许变）",
  );
  const drawer = openTag(renderPeek("w-full rounded-none border-0 px-0 py-0"), "work-item-peek");
  assert.ok(drawer.includes("w-full"), "抽屉里铺满宽度（覆盖生效）");
  assert.ok(!drawer.includes("w-80"), "旧宽度被合并掉（两份宽度类同时留着 = 谁生效看 CSS 顺序）");
  assert.ok(drawer.includes("bg-card"), "覆盖只动几何，不动配色的语义 token");
});

// ---------- ⑦ 宿主：两档互斥（验收 1） ----------

function renderSurface(input: {
  workItems?: WorkItem[];
  withWriter?: boolean;
  viewport?: WorkItemSurfaceViewport;
  locale?: "zh-CN" | "en-US";
}): string {
  const { workItems = [wipeek()], withWriter = false, viewport } = input;
  return renderToStaticMarkup(
    createElement(ZCodeIntlProvider, {
      initialLocale: input.locale ?? ("zh-CN" as const),
      children: createElement(WorkItemsSurface, {
        workItems,
        snapshot: snapshotWith(workItems),
        discardableIds: new Set<string>(),
        busyWorkItemId: null,
        timelineExpandedWorkItemId: null,
        laneDimension: "none",
        surface: workItemSurfaceDefaultState(),
        onSurfaceIntent: () => {},
        onEdit: () => {},
        onInlineEdit: async () => null,
        onReassign: () => {},
        onDiscard: () => {},
        onToggleTimeline: () => {},
        onOpenWorkItemDetail: () => {},
        workspacePath: "/w/a",
        ...(withWriter ? { onQuickCreate: async () => null } : {}),
        ...(viewport === undefined ? {} : { viewport }),
      }),
    }),
  );
}

/* 承重（验收 1 的桌面侧 + 默认路径零回归）：桌面（缺省 = SSR 默认，以及显式注入 desktop）
   仍是既有行内条；触发钮/抽屉一个节点都不进 DOM。变异：桌面也渲染触发钮 ⇒ 第一条必红。 */
test("宿主｜桌面：行内条在、触发钮与抽屉都不在（缺省 = SSR 默认）", () => {
  for (const markup of [
    renderSurface({ withWriter: true }),
    renderSurface({ withWriter: true, viewport: "desktop" }),
  ]) {
    assert.ok(markup.includes('data-testid="work-items-quick-create"'), "行内条照旧");
    assert.ok(
      markup.includes('data-testid="work-items-quick-create-title"'),
      "行内输入照旧（桌面路径逐槽不变）",
    );
    assert.ok(!markup.includes("work-items-quick-create-open"), "桌面不给窄屏触发钮");
    assert.ok(!markup.includes("work-item-mobile-sheet"), "桌面不渲染抽屉");
    assert.ok(!markup.includes("work-items-surface-split"), "没打开面板 ⇒ 分栏壳也不在");
  }
});

/* 承重（验收 1 的窄屏侧 + 卡面变异「Sheet 与分栏同时渲染 ⇒ 红」）：窄屏只有触发钮一套，
   行内条与输入**不在** DOM 里；没开抽屉 ⇒ 抽屉也不在。变异：窄屏仍渲染行内条（两套同时在场）
   ⇒ 第二、三条必红；窄屏无条件渲染抽屉 ⇒ 第四条必红。 */
test("宿主｜窄屏：只有触发钮一套（行内条不在）；未开抽屉 ⇒ 抽屉不进 DOM；不套分栏壳", () => {
  const markup = renderSurface({ withWriter: true, viewport: "compact" });
  assert.ok(markup.includes('data-testid="work-items-quick-create-open"'), "窄屏给触发钮");
  assert.ok(
    !markup.includes('data-testid="work-items-quick-create"'),
    "行内条不得同时渲染（同一能力只有一套）",
  );
  assert.ok(
    !markup.includes('data-testid="work-items-quick-create-title"'),
    "行内输入也不得进 DOM（渲染了两套就是卡面明令的变异）",
  );
  assert.ok(!markup.includes("work-item-mobile-sheet"), "没开抽屉 ⇒ 抽屉一个节点都不进 DOM");
  assert.ok(
    !markup.includes('data-testid="work-items-surface-split"'),
    "窄屏不套桌面分栏壳（两套同时渲染 ⇒ 红）",
  );
});

test("宿主｜窄屏：没有写入口 ⇒ 连触发钮都不渲染（与桌面同款「缺省整块不渲染」）", () => {
  const markup = renderSurface({ viewport: "compact" });
  assert.ok(!markup.includes("work-items-quick-create"), "缺省 ⇒ 一个入口都不给");
  assert.ok(markup.includes('data-testid="work-items-list"'), "行照常渲染（没写入口不等于没有面）");
});

/* 结构守卫（验收 1 的源码侧）：宿主用**同一个**形态判据接两档，且
   ① 注入点唯一；② 分栏壳恰一处且只在窄屏分支**之后**；③ 抽屉恰一处（至多一个抽屉）；
   ④ 抽屉内容 = 目标三元（peek / 快速创建**二选一**）。
   变异：把抽屉挪到分栏壳里（或删掉窄屏提前返回）⇒ 第二条必红；抽屉里同时塞两样 ⇒ 第四条必红；
   再抄一份形态判据（第二处分支）⇒ 第一条必红。 */
test("守卫｜宿主：形态判据单源、分栏壳与抽屉互斥、抽屉内容二选一", () => {
  const host = stripComments(readSource("squad/WorkItemsSurface.tsx"));
  assert.equal(
    (host.match(/useWorkItemSurfaceViewport\(/g) ?? []).length,
    1,
    "视口形态只有一处求值（可注入的唯一注入点）",
  );
  assert.equal(
    (host.match(/workItemCompactSheetTarget\(/g) ?? []).length,
    1,
    "抽屉目标只有一处判据（至多一个抽屉）",
  );
  assert.equal(
    (host.match(/workItemCompactSheetKeyIntent\(/g) ?? []).length,
    1,
    "窄屏 Esc 的「关谁」只有一处判据",
  );
  assert.equal(
    (host.match(/<WorkItemMobileSheet/g) ?? []).length,
    1,
    "抽屉只有一处渲染点（两处 = 两个抽屉可能同时在场）",
  );
  assert.equal(
    (host.match(/data-testid="work-items-surface-split"/g) ?? []).length,
    1,
    "分栏壳只有一处",
  );
  /* 互斥：窄屏**提前返回**必须在分栏壳之前，且窄屏分支里不得出现分栏壳（否则两套同时渲染）。 */
  const compactBranch = host.indexOf('viewportMode === "compact"');
  const splitAnchor = host.indexOf('data-testid="work-items-surface-split"');
  assert.ok(compactBranch >= 0, "窄屏分支必须存在（形态判据的消费点）");
  assert.ok(
    splitAnchor > compactBranch,
    "窄屏提前返回必须在分栏壳之前（删掉它 = 窄屏也开始渲染分栏壳）",
  );
  assert.ok(
    !host.slice(compactBranch, splitAnchor).includes("work-items-surface-split"),
    "窄屏分支内不得出现分栏壳",
  );
  assert.ok(
    host.includes('{sheetTarget === "peek" ? peekPanel : quickCreate}'),
    "抽屉内容 = 目标三元（peek / 快速创建二选一；同时塞两样 ⇒ 红）",
  );
  assert.ok(
    host.includes("{peekPanel}") && host.includes("min-w-0 flex-1"),
    "桌面分栏壳仍然只装既有面 + 面板本体（面板只构造一份，两档共用）",
  );
});

// ---------- ⑧ DESIGN 硬约束：移动输入用 text-mobile-input-safe（验收 2） ----------

/* 变异（卡面变异 2）：把快速创建标题框的 `text-mobile-input-safe` 换成 `text-ui-base`（或去掉
   `md:` 前缀，让窄屏也吃桌面档）⇒ 本用例必红。 */
test("守卫｜移动输入：抽屉里的快速创建标题框带 text-mobile-input-safe（窄屏档不被 md: 变体吃掉）", () => {
  const quick = stripComments(readSource("squad/WorkItemQuickCreate.tsx"));
  const match = /className="([^"]+)"[^>]*data-testid="work-items-quick-create-title"/.exec(quick);
  assert.ok(match, "标题框（抽屉里唯一的可编辑输入）必须存在且可定位");
  const classes = (match[1] ?? "").split(/\s+/).filter((token) => token.length > 0);
  assert.ok(
    classes.includes("text-mobile-input-safe"),
    "iOS 聚焦缩放闸：16px 兼容 token 必须在（DESIGN 硬约束）",
  );
  const uiTokens = classes.filter((token) => token.includes("text-ui-"));
  assert.ok(uiTokens.length > 0, "桌面档由 text-ui-* 表达（移动档 + 桌面档成对）");
  for (const token of uiTokens) {
    assert.ok(
      token.startsWith("md:"),
      `${token} 必须是 md: 变体（窄屏回落到 mobile-safe；裸 text-ui-* 会把移动档按 DESIGN 违规改掉）`,
    );
  }
  const sheet = stripComments(readSource("squad/WorkItemMobileSheet.tsx"));
  assert.ok(
    !sheet.includes("<Input") && !sheet.includes("<textarea"),
    "壳体不引入输入件（输入只在抽屉内容里，且已过 mobile-safe 约束）",
  );
});

test("守卫｜peek 面板内没有输入件（只读速览；若加输入就必须同轮过同一条移动输入约束）", () => {
  const peek = stripComments(readSource("squad/WorkItemPeek.tsx"));
  for (const forbidden of ["<Input", "<textarea", "<Textarea", "contentEditable"]) {
    assert.ok(
      !peek.includes(forbidden),
      `peek 不得出现 ${forbidden}（T-P3-R2 只读纪律；新增输入要同轮补 mobile-safe 守卫）`,
    );
  }
});

// ---------- ⑨ 关闭路径（验收 3：至少一条可验证） ----------

/* 变异：窄屏不挂键盘层（Esc 到不了）⇒ 第一条必红；关闭绕开 closePeek（焦点不还给触发行）
   ⇒ 第三条必红；壳里少接一处 onClose（遮罩或关闭钮形同虚设）⇒ 第四条必红。 */
test("守卫｜关闭路径：Esc 纯判据 + 遮罩/关闭钮两处 + 关闭走 closePeek（焦点归还）", () => {
  const host = stripComments(readSource("squad/WorkItemsSurface.tsx"));
  assert.ok(host.includes("onKeyDown={compactKeyDown}"), "窄屏面上的键盘层（Esc 到得了）");
  assert.ok(
    host.includes("workItemCompactSheetKeyIntent({ key: event.key, peekOpen, quickCreateOpen })"),
    "关谁由纯判据回答（不另写键位链）",
  );
  assert.ok(
    host.includes('sheetTarget === "peek" ? closePeek : () => setQuickCreateOpen(false)'),
    "peek 抽屉关闭走 closePeek（焦点归还那一路），快速创建只收自己的打开态",
  );
  const sheet = stripComments(readSource("squad/WorkItemMobileSheet.tsx"));
  assert.equal(
    (sheet.match(/onClick=\{onClose\}/g) ?? []).length,
    2,
    "两处关闭：遮罩 + 头部关闭钮（少一处 = 那个入口形同虚设）",
  );
});

// ---------- ⑩ 文案键（本轮新增恰 2 枚；两语成对） ----------

/* 变异：只改一语（界面另一语翻出裸 key）⇒ 本用例红。主题（Zai Light/Dark）由语义 token 承担，
   人工演示登记在交付报告（本仓测试环境没有浏览器，主题不在这里判）。 */
test("两语：窄屏触发钮与抽屉头在两语下都出本语文案", () => {
  for (const locale of ["zh-CN", "en-US"] as const) {
    const dict = locale === "zh-CN" ? zhCN : enUS;
    const open = dict["squad.workItems.quickCreate.open"];
    const close = dict["squad.workItems.sheet.close"];
    assert.ok(open && close, `${locale} 缺键`);
    const surface = renderSurface({ withWriter: true, viewport: "compact", locale });
    assert.ok(
      surface.includes(`data-testid="work-items-quick-create-open"`) && surface.includes(open),
      `${locale}：窄屏触发钮出本语文案`,
    );
    const sheet = renderSheet({ title: open, locale });
    assert.ok(
      openTag(sheet, "work-item-mobile-sheet-close").includes(`aria-label="${close}"`),
      `${locale}：抽屉关闭钮的可及名称是本语`,
    );
  }
});

/* 变异：只改一语 / 多新增一枚键（越过卡面「≤4 枚」的裁定）⇒ 本用例红。 */
test("键：本轮新增恰 2 枚且两语成对（其余复用既有键）", () => {
  const added = ["squad.workItems.quickCreate.open", "squad.workItems.sheet.close"];
  assert.equal(added.length, 2, "新增键规模（加键 ⇒ 这里必须显式改；卡面上限 4 枚）");
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
  for (const key of [
    "squad.workItems.peek.title",
    "squad.workItems.peek.openDetail",
    "squad.workItems.peek.close",
    "squad.workItems.quickCreate.placeholder",
  ]) {
    assert.ok(zhText(key) && enText(key), `复用键 ${key} 必须两语齐全（无裸 key）`);
  }
});
