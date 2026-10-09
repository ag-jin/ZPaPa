import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type {
  AuthorRef,
  IServiceAccessor,
  WorkItemCollaborationRead,
  WorkItemReactionRecord,
} from "@zcode/services";
import type { WorkItem } from "@zcode/shared";
import { ZCodeIntlProvider } from "../src/i18n/IntlProvider.js";
import zhCN from "../src/i18n/locales/zh-CN.js";
import enUS from "../src/i18n/locales/en-US.js";
import { ServiceProvider } from "../src/hooks/useServices.js";
import { WorkItemPeekContent } from "../src/squad/WorkItemPeek.js";
import { WorkItemReactionChips } from "../src/squad/WorkItemReactionChips.js";
import {
  WorkItemReactionOptions,
  WorkItemReactionPicker,
  WorkItemReactions,
  WorkItemReactionsFailureLine,
} from "../src/squad/WorkItemReactions.js";
import {
  WORK_ITEM_REACTION_EMOJIS,
  workItemReactionGroups,
  workItemReactionLearnedViewer,
  workItemReactionOwnEmojisAfterWrite,
  workItemReactionViewerAfterWrite,
  workItemReactionsTarget,
  workItemReactionToggleOn,
} from "../src/squad/workItemReactionsViewModel.js";

/* 「工作项级 reactions · UI 半边」（阶段三 · T-P3-R5u）的**判据 + 呈现 + 结构守卫**。

   期望值的独立真源：任务卡 T-P3-R5（卡更新段）+ reports/2026-10-09-reactions-multica-evidence.md
   §1 Q3/Q4 与 §5 —— ①8 快捷表情集逐枚同序；②聚合三规则（按 emoji 分组 `{emoji,count,actors,
   reactedByMe}`、**reactedByMe 必须带 kind 判断**、**不折叠**、顺序=插入序）；③toggle 语义
   （同 emoji 再点 = 撤销）；④看板/list/table 不出现 reactions（multica 列表载荷刻意不带）。
   断言里的字面量**不按实现重算**；每条结构守卫都写明变异方式，交付报告里逐条实测。 */

/** 造一行回应（只给聚合关心的字段；其余按 repo 形状补齐）。 */
function reaction(
  id: string,
  emoji: string,
  author: AuthorRef,
  createdAt: number,
): WorkItemReactionRecord {
  return {
    id,
    workspaceKey: "ws",
    workItemId: "wi-1",
    author,
    emoji,
    createdAt,
  };
}

const ME: AuthorRef = { kind: "human", id: "local-user" };
/** **同 id 不同 kind** 的智能体：kind 判据唯一能咬住的形状（订阅线同款：
    `human:local-user` 与 `agent:local-user` 是两个人）。 */
const AGENT_SAME_ID: AuthorRef = { kind: "agent", id: "local-user" };
const OTHER_HUMAN: AuthorRef = { kind: "human", id: "hu-2" };

const SRC_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "../src");
const readSource = (relativePath: string) => readFileSync(resolve(SRC_DIR, relativePath), "utf8");
/** 去掉注释再扫：注释里提到写方法名 / 取数函数是**说明**，不是代码本身。 */
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

// ---------- ① 表情集（卡面：8 枚快捷表情，单一常量模块，逐枚同序） ----------

/* 独立真源：取证报告 §1 Q1 的常量原文（multica `quick-emoji-picker.tsx:12`，移动端逐字复制）。
   变异：换一枚 / 少一枚 / 改次序 ⇒ 本条必红。 */
test("表情集：恰 8 枚快捷表情，逐枚同序（单一常量模块）", () => {
  assert.deepEqual(
    [...WORK_ITEM_REACTION_EMOJIS],
    ["👍", "👌", "❤️", "✅", "🎉", "😕", "🚀", "👀"],
  );
  assert.equal(new Set(WORK_ITEM_REACTION_EMOJIS).size, 8, "八枚互不相同（重复 = 同一枚两格）");
});

// ---------- ② 聚合（卡面三规则：kind 判断 / 不折叠 / 插入序） ----------

/* 变异（承重 M1）：去掉 kind 判断（只比 id）⇒ 第二条必红（`agent:local-user` 的同 emoji
   被误标成「我」）；把 `reactedByMe` 写成「有任意一枚 human 行」⇒ 第四条必红。 */
test("聚合｜kind 判断：同 id 不同 kind 不是「我」；真源里只有 (kind,id) 两列都同才算", () => {
  const groups = workItemReactionGroups({
    rows: [
      reaction("r1", "👍", ME, 10),
      reaction("r2", "👍", OTHER_HUMAN, 20),
      reaction("r3", "👍", AGENT_SAME_ID, 30),
      reaction("r4", "✅", AGENT_SAME_ID, 40),
    ],
    viewerActor: ME,
  });
  assert.deepEqual(groups, [
    {
      emoji: "👍",
      count: 3,
      actors: [ME, OTHER_HUMAN, AGENT_SAME_ID],
      reactedByMe: true,
    },
    {
      emoji: "✅",
      count: 1,
      actors: [AGENT_SAME_ID],
      /* 只有智能体反应过 ✅：按 id 判会把这一格标成「我应该被点亮」（M1 变异形态）。 */
      reactedByMe: false,
    },
  ]);
});

test("聚合｜插入序：不按热度重排、不按 emoji 码位重排（首见即序）", () => {
  const groups = workItemReactionGroups({
    rows: [
      reaction("r1", "🚀", ME, 10),
      reaction("r2", "👍", ME, 20),
      reaction("r3", "🚀", OTHER_HUMAN, 30),
    ],
    viewerActor: ME,
  });
  assert.deepEqual(
    groups.map((group) => group.emoji),
    ["🚀", "👍"],
    "首见顺序（🚀 先行）；按热度（两枚同量）或按码位会把 👍 排到前面 —— 都是第二份排序",
  );
  assert.deepEqual(groups[0]!.actors, [ME, OTHER_HUMAN], "组内主体按行序（created_at 升序）");
});

test("聚合｜不折叠：全量分组，无上限、无「+N」", () => {
  const rows = WORK_ITEM_REACTION_EMOJIS.map((emoji, index) =>
    reaction(`r${index}`, emoji, ME, 10 + index),
  );
  const groups = workItemReactionGroups({ rows, viewerActor: ME });
  assert.equal(groups.length, 8, "八枚全量平铺（折叠 = 数不全；multica 无上限、无展开更多）");
  assert.deepEqual(
    groups.map((group) => group.emoji),
    [...WORK_ITEM_REACTION_EMOJIS],
  );
});

/* 身份缺席（详情页概览：冻结页面不投 viewerActor —— 登记在交付报告）⇒ `null`，
 **不得**假装「不是我」（评论回应 `mine: boolean | null` 同款口径）。 */
test("聚合｜身份不可判定：reactedByMe 一律 null（不假装「不是我」）", () => {
  const groups = workItemReactionGroups({
    rows: [reaction("r1", "👍", ME, 10), reaction("r2", "🎉", OTHER_HUMAN, 20)],
    viewerActor: null,
  });
  assert.deepEqual(
    groups.map((group) => group.reactedByMe),
    [null, null],
  );
  assert.deepEqual(
    groups.map((group) => group.count),
    [1, 1],
    "计数与主体仍照常给出（身份缺席只影响「我」那一格）",
  );
});

test("聚合｜空输入 ⇒ 空数组（0 反应是合法事实，不是错误）", () => {
  assert.deepEqual(workItemReactionGroups({ rows: [], viewerActor: ME }), []);
});

// ---------- ③ toggle 意图 + 学到本机身份（写返回是唯一事实源） ----------

/* 变异：把我的行写成「有任意 human 行」⇒ 第二条必红；身份不可判定时返回「撤销」
   （凭空的乐观删除）⇒ 第四条必红。 */
test("toggle 意图：同 emoji 我已有 ⇒ 撤销；我没有 ⇒ 置上；身份不可判定 ⇒ 只能置上（幂等安全）", () => {
  const rows = [reaction("r1", "👍", ME, 10), reaction("r2", "✅", AGENT_SAME_ID, 20)];
  assert.equal(
    workItemReactionToggleOn({ rows, viewerActor: ME, emoji: "👍" }),
    false,
    "我按过的 emoji ⇒ on:false（卡的 toggle 语义：同 emoji 再点 = 撤销）",
  );
  assert.equal(workItemReactionToggleOn({ rows, viewerActor: ME, emoji: "👌" }), true);
  assert.equal(
    workItemReactionToggleOn({ rows, viewerActor: ME, emoji: "✅" }),
    true,
    "智能体同 emoji 不算我的（kind 判断）⇒ 仍是「置上」",
  );
  assert.equal(
    workItemReactionToggleOn({ rows, viewerActor: null, emoji: "👍" }),
    true,
    "身份不可判定 ⇒ 只能走幂等安全的「置上」；绝不猜「撤销」（那会删掉别人的行）",
  );
});

/* 学到身份：服务面契约「反应行的作者 = 组合根注入的本机操作者」⇒ 我这一次写**新增的那一行**
   的作者就是我。0 行新增（幂等命中）与 ≥2 行新增（有并发写者）都不学 —— 候选不唯一不猜。 */
test("学到本机身份：恰一行新增 ⇒ 它的作者；0 行或 ≥2 行新增 ⇒ 不学（不多猜）", () => {
  const before = [reaction("r1", "👍", OTHER_HUMAN, 10)];
  const after = [reaction("r1", "👍", OTHER_HUMAN, 10), reaction("r2", "✅", ME, 20)];
  assert.deepEqual(workItemReactionLearnedViewer(before, after), ME, "新增行的作者 = 本机操作者");
  assert.equal(
    workItemReactionLearnedViewer(after, after),
    null,
    "幂等命中（没有新行）⇒ 学不到，不编一个",
  );
  assert.equal(
    workItemReactionLearnedViewer(before, [
      ...before,
      reaction("r2", "✅", ME, 20),
      reaction("r3", "🎉", OTHER_HUMAN, 30),
    ]),
    null,
    "两行同时出现（并发写者）⇒ 分不清哪行是我，不猜",
  );
});

/* 验收 ①：**toggle 之后的聚合正确**（UI 层的半边）—— 写返回是唯一事实源：行集整份换成服务面
   返回的那份（幂等同值 ⇒ 直接换不产生第二次事实），观察者身份 = 传入的 ?? 这次学到的。
   变异：本地自己拼一行（乐观插入 + 手改 count）⇒ 第三条必红（与服务面返回的行集不一致）；
   不学身份（用 null 收尾）⇒ 第二条必红（自己刚按下的那枚不亮）。 */
test("写之后：行集 = 服务返回；身份 = 传入的 ?? 学到的 —— 加/撤两侧聚合都随之正确", () => {
  const before = [reaction("r1", "👍", OTHER_HUMAN, 10)];
  const afterAdd = [...before, reaction("r2", "👌", ME, 20)];
  const viewerAfterAdd = workItemReactionViewerAfterWrite({
    previousRows: before,
    nextRows: afterAdd,
    viewerActor: null,
  });
  assert.deepEqual(viewerAfterAdd, ME, "身份缺席时从这次写学出（新增行 = 本机操作者）");
  assert.deepEqual(
    workItemReactionGroups({ rows: afterAdd, viewerActor: viewerAfterAdd }).map((group) => [
      group.emoji,
      group.count,
      group.reactedByMe,
    ]),
    [
      ["👍", 1, false],
      ["👌", 1, true],
    ],
    "置上之后：我按的那枚被点亮，别人的那枚不受影响（kind+id 判定）",
  );

  /* 撤销这一步：写返回里**没有新增行**（学不到新的），身份靠上一步学到的继续传递
     （hook 的链式状态）—— 撤销后剩下的仍是我的 👌，仍点亮。 */
  const afterRemove = [reaction("r2", "👌", ME, 20)];
  const viewerAfterRemove = workItemReactionViewerAfterWrite({
    previousRows: afterAdd,
    nextRows: afterRemove,
    viewerActor: viewerAfterAdd,
  });
  assert.deepEqual(viewerAfterRemove, ME, "身份一旦学得就跨这一步继续用（不重学、不回落）");
  assert.deepEqual(
    workItemReactionGroups({ rows: afterRemove, viewerActor: viewerAfterRemove }).map((group) => [
      group.emoji,
      group.reactedByMe,
    ]),
    [["👌", true]],
    "撤销只可能删掉**我自己的**那一行（服务面按键 = 本机身份）：剩下的仍是我的 👌",
  );
  assert.deepEqual(
    workItemReactionGroups({ rows: afterRemove, viewerActor: ME }).map((group) => group.count),
    [1],
    "行集整份来自服务面返回，不在本地做增减（本地增减 = 第二份事实）",
  );
  assert.deepEqual(
    workItemReactionGroups({ rows: before, viewerActor: ME }).map((group) => group.count),
    [1],
    "同人同 emoji 恰一条由服务面保证：UI 侧只照返回的行集计数（重复 add 返回同值 ⇒ 计数不变）",
  );
});

// ---------- ⑤ 呈现：chip（只读 / 可点两态；品牌色只标「我」） ----------

/** 取某个 testid 所在元素的**开标签**（用来断言属性而不是全文）。 */
function openTag(markup: string, testId: string): string {
  const marker = markup.indexOf(`data-testid="${testId}"`);
  assert.ok(marker >= 0, `markup 里必须有 ${testId}`);
  return markup.slice(markup.lastIndexOf("<", marker), markup.indexOf(">", marker) + 1);
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

const CHIP_GROUPS = [
  { emoji: "👍", count: 3, actors: [ME, OTHER_HUMAN, AGENT_SAME_ID], reactedByMe: true },
  { emoji: "🎉", count: 1, actors: [AGENT_SAME_ID], reactedByMe: false },
  { emoji: "👀", count: 2, actors: [OTHER_HUMAN, AGENT_SAME_ID], reactedByMe: null },
];

function renderChips(input: { onToggle?: (emoji: string) => void; pendingEmoji?: string | null }) {
  return renderToStaticMarkup(
    createElement(ZCodeIntlProvider, {
      initialLocale: "zh-CN" as const,
      children: createElement(WorkItemReactionChips, {
        groups: CHIP_GROUPS,
        ...(input.onToggle === undefined ? {} : { onToggle: input.onToggle }),
        ...(input.pendingEmoji === undefined ? {} : { pendingEmoji: input.pendingEmoji }),
      }),
    }),
  );
}

/* 变异：chip 画成 `emoji × count` 之外的形态（丢掉 count / 折叠成「+N」）⇒ 第一条必红；
   品牌色按「任意 human 行」或按 id 判（M1 的呈现侧）⇒ 第三条必红；身份不可判定时也上品牌色
   ⇒ 第四条必红。 */
test("chip｜emoji + count 全量平铺、插入序；品牌色只标**可判定的**「我」", () => {
  const markup = renderChips({});
  assert.ok(markup.includes(`data-testid="work-item-reaction-chips"`), "整组有锚点");
  assert.equal(
    (markup.match(/data-testid="work-item-reaction-chip-/g) ?? []).length,
    3,
    "三组各一枚 chip（全量、不折叠）",
  );
  const order = ["👍", "🎉", "👀"].map((emoji) =>
    markup.indexOf(`data-testid="work-item-reaction-chip-${emoji}"`),
  );
  assert.ok(order[0]! < order[1]! && order[1]! < order[2]!, "次序 = 传入的分组次序（插入序）");
  assert.ok(
    markup.includes(fill(zhText("squad.workItemDetail.reactions.chip"), { emoji: "👍", count: 3 })),
    "chip 的可及名称带上 emoji 与计数（emoji + count 是 chip 的全部内容）",
  );
  assert.ok(markup.includes("3") && markup.includes(">👍<"), "chip 里看得见 emoji 与计数");

  assert.ok(
    openTag(markup, "work-item-reaction-chip-👍").includes("text-brand"),
    "我按过的 ⇒ 品牌色（multica 的「我已反应」态）",
  );
  assert.ok(
    !openTag(markup, "work-item-reaction-chip-🎉").includes("text-brand"),
    "别人（智能体）按的 ⇒ 不上品牌色（kind 判断的呈现侧）",
  );
  assert.ok(
    !openTag(markup, "work-item-reaction-chip-👀").includes("text-brand"),
    "身份不可判定 ⇒ 不标「我」（不假装「不是我」也不假装「是我」）",
  );
});

/* 只读态（peek）：**结构上**没有 toggle —— 不是靠禁用，而是根本不渲染按钮。 */
test("chip｜只读态（peek）：整组零按钮（写不出去），计数仍在", () => {
  const markup = renderChips({});
  assert.ok(!markup.includes("<button"), "只读态不得出现按钮（peek 零写纪律的结构面）");
  assert.ok(!markup.includes("aria-pressed"), "不可点的 chip 不给 aria-pressed（那不是它的语义）");
  assert.ok(markup.includes("3"), "只读 ≠ 省略信息（emoji + count 照常）");
});

test("chip｜可点态：按钮 + aria-pressed 只在可判定时给出；在途（pending）禁用", () => {
  const markup = renderChips({ onToggle: () => {} });
  assert.ok(
    openTag(markup, "work-item-reaction-chip-👍").includes('<button type="button"'),
    "可点态是按钮（键盘可达）",
  );
  assert.ok(
    openTag(markup, "work-item-reaction-chip-👍").includes('aria-pressed="true"'),
    "我按过的 ⇒ aria-pressed=true",
  );
  assert.ok(
    openTag(markup, "work-item-reaction-chip-🎉").includes('aria-pressed="false"'),
    "我没有的 ⇒ aria-pressed=false（可点 = 加上）",
  );
  assert.ok(
    !openTag(markup, "work-item-reaction-chip-👀").includes("aria-pressed"),
    "身份不可判定 ⇒ 不渲染 aria-pressed（评论回应同款：不假装「不是我」）",
  );

  const pending = renderChips({ onToggle: () => {}, pendingEmoji: "👍" });
  assert.ok(
    openTag(pending, "work-item-reaction-chip-👍").includes('disabled=""'),
    "在途的那一枚禁用（一次一个写在途，避免重复提交）",
  );
  assert.ok(
    !openTag(pending, "work-item-reaction-chip-🎉").includes('disabled=""'),
    "其余 chip 照常可点（不整组冻结）",
  );
});

// ---------- ⑥ 呈现：选择器（8 枚全在场 / 已选可再点 = 撤销 / 在途禁那一枚） ----------

/* 变异：只画「还没选过的」几枚（已选的从菜单里消失）⇒ 第一条必红 —— 卡面明写「点 picker=
   添加（已选过的=撤销）」，已选项必须**在场**才撤销得了；把已选项禁用（抄评论回应的只增语义）
   ⇒ 第二条必红。 */
test("选择器｜8 枚全在场：已选过的也画（再点 = 撤销），aria-selected 如实标注", () => {
  const markup = renderToStaticMarkup(
    createElement(ZCodeIntlProvider, {
      initialLocale: "zh-CN" as const,
      children: createElement(WorkItemReactionOptions, {
        reactedEmojis: new Set(["👍", "🚀"]),
        pendingEmoji: null,
        onToggle: () => {},
      }),
    }),
  );
  assert.ok(markup.includes('role="listbox"'), "选择器是 listbox（键盘语义）");
  assert.equal(
    (markup.match(/data-testid="work-item-reactions-option-/g) ?? []).length,
    8,
    "8 枚快捷表情全在场（已选过的也在 —— 再点它就是撤销）",
  );
  for (const emoji of WORK_ITEM_REACTION_EMOJIS) {
    assert.ok(
      markup.includes(`data-testid="work-item-reactions-option-${emoji}"`),
      `缺 ${emoji} 这一枚（卡面：8 枚逐枚同序）`,
    );
  }
  assert.ok(
    openTag(markup, "work-item-reactions-option-👍").includes('aria-selected="true"'),
    "我按过的 ⇒ aria-selected=true",
  );
  assert.ok(
    !openTag(markup, "work-item-reactions-option-👍").includes("disabled"),
    "已选过的那一枚**不禁用**（再点 = 撤销；禁用就没有撤销入口了）",
  );
  assert.ok(
    openTag(markup, "work-item-reactions-option-🎉").includes('aria-selected="false"'),
    "没按过的 ⇒ aria-selected=false",
  );

  const pending = renderToStaticMarkup(
    createElement(ZCodeIntlProvider, {
      initialLocale: "zh-CN" as const,
      children: createElement(WorkItemReactionOptions, {
        reactedEmojis: new Set<string>(),
        pendingEmoji: "🎉",
        onToggle: () => {},
      }),
    }),
  );
  assert.ok(
    openTag(pending, "work-item-reactions-option-🎉").includes('disabled=""'),
    "在途的那一枚禁用（一次一个写在途）",
  );
  assert.ok(!openTag(pending, "work-item-reactions-option-👍").includes("disabled"));
});

/* 入口常驻：0 反应时也画（multica 详情页 showPicker=true）—— 空态只是没有 chip，不是没有入口。 */
test("选择器｜入口按钮：可及名称 + listbox 语义；首帧（SSR）只画按钮、不预展开", () => {
  const markup = renderToStaticMarkup(
    createElement(ZCodeIntlProvider, {
      initialLocale: "zh-CN" as const,
      children: createElement(WorkItemReactionPicker, {
        reactedEmojis: new Set<string>(),
        pendingEmoji: null,
        onToggle: () => {},
      }),
    }),
  );
  const tag = openTag(markup, "work-item-reactions-add");
  assert.ok(
    tag.includes(`aria-label="${zhText("squad.workItemDetail.reactions.add")}"`),
    "可及名称（icon-only 按钮必须能读出来）",
  );
  assert.ok(
    tag.includes('aria-expanded="false"') && tag.includes('aria-haspopup="listbox"'),
    "展开语义",
  );
  assert.ok(!markup.includes('role="listbox"'), "首帧不预展开（点开才画）");
});

// ---------- ⑦ 容器与失败行（首帧不预判；失败不吞错） ----------

/** 详情页概览/peek 的容器渲染要一个能通过 `useServices()` 的访问器；静态渲染不进 effect
    ⇒ 读面停在「还没读到」，正是要钉住的首帧形态。 */
function renderContainer(input: { archived?: boolean; viewerActor?: AuthorRef | null } = {}) {
  return renderToStaticMarkup(
    createElement(ZCodeIntlProvider, {
      initialLocale: "zh-CN" as const,
      children: createElement(ServiceProvider, {
        services: {} as IServiceAccessor,
        children: createElement(WorkItemReactions, {
          workItem: {
            id: "wi-1",
            workspacePath: "/w/a",
            workspaceIdentity: "ws-1",
            ...(input.archived === true ? { archivedAt: 1759968000000 } : {}),
          },
          viewerActor: input.viewerActor ?? null,
        }),
      }),
    }),
  );
}

/* 为什么首帧必须**整块不渲染**（而不是画骨架 / 预判空态）：①「还没读到」与「0 反应」是两件事，
   预判空态等于把故障说成事实；②概览区有一份**逐字节搬件基线**（`workItemDetailPage.test.ts`：
   四态渲染输出全等），挂上去的东西若在首帧画任何字节，基线就会因一个新增区域而假红。 */
test("容器｜首帧（未读到）整块不渲染：不预判空态、不画骨架、不抢概览的形状", () => {
  assert.equal(renderContainer(), "", "未读到 ⇒ 零字节（读到之后再决定画 chip 还是只画入口）");
  assert.equal(
    renderContainer({ archived: true }),
    "",
    "归档行：服务面把归档视同不存在（读也抛、写也抛）⇒ 本块不出现（页面头部已有「已归档」）",
  );
  assert.equal(
    renderContainer({ viewerActor: ME }),
    "",
    "身份在场也不改变首帧（身份只影响读到之后的「我」那一格）",
  );
});

/* 失败**不吞**：读到失败时给一行可及的原因（服务面原文 + 重试），与详情页其余区同款
   （「读不到」不是「还没有人反应」）。 */
test("失败行｜role=alert + 服务面原文 + 重试（复用既有重试文案）", () => {
  const markup = renderToStaticMarkup(
    createElement(ZCodeIntlProvider, {
      initialLocale: "zh-CN" as const,
      children: createElement(WorkItemReactionsFailureLine, {
        error: "工作项不存在或已归档：wi-1",
        onRetry: () => {},
      }),
    }),
  );
  assert.ok(
    openTag(markup, "work-item-reactions-failure").includes('role="alert"'),
    "失败行是活区（读屏播报）",
  );
  assert.ok(
    markup.includes(zhText("squad.common.operationFailed")) &&
      markup.includes("工作项不存在或已归档：wi-1"),
    "文案键 + 服务面原文都渲染（不吞错、不改写）",
  );
  assert.ok(markup.includes(zhText("squad.workItemDetail.retry")), "就地重试入口");
});

// ---------- ⑧ 挂载：详情页概览尾部固定一行 + peek 只读挂载 ----------

/* 排它裁定：`WorkItemDetailPage.tsx`（399/400）与 `WorkItemsPage.tsx`（400/400）本轮**零改动**
   —— 挂载点因此落在概览模块（概览尾部）与 peek 模块（标签块之后）。 */
test("挂载｜概览尾部固定一行（页面零改动）；概览恰一处", () => {
  const page = stripComments(readSource("squad/WorkItemDetailPage.tsx"));
  const overview = stripComments(readSource("squad/WorkItemDetailOverview.tsx"));
  assert.equal(
    (page.match(/<WorkItemReactions\b/g) ?? []).length,
    0,
    "冻结页面（399/400）不得出现本轮的挂载点（排它红线：零改动）",
  );
  assert.equal(
    (overview.match(/<WorkItemReactions\b/g) ?? []).length,
    1,
    "概览模块恰挂载一处（第二处 = 两个回应行）",
  );
  const body = overview.indexOf('data-testid="work-item-detail-body-toggle"');
  const mount = overview.indexOf("<WorkItemReactions");
  assert.ok(
    body >= 0 && mount > body,
    "落在正文块之后 = 概览尾部固定一行（multica 的「描述块正下方」同位语义）",
  );
  assert.ok(
    overview.includes("viewerActor={null}"),
    "身份交白卷（概览拿不到读面的 viewerActor：页面冻结、只投 workItem —— 取法与接缝登记在交付报告）",
  );
});

/* 变异（承重 M2）：peek 里挂可写入口（或 import 可写 hook）⇒ 下面每条都能咬住。 */
test("挂载｜peek 只读：读 hook + 只读 chip，零 toggle、零写方法", () => {
  const peek = stripComments(readSource("squad/WorkItemPeek.tsx"));
  assert.ok(peek.includes("useWorkItemReactionRows({"), "回应经**读** hook 取（只读路径）");
  assert.ok(peek.includes("<WorkItemReactionChips"), "只读 chip 组（组件本身就是无按钮形态）");
  assert.ok(!peek.includes("onToggle"), "不得传 toggle 回调（传了就丢掉只读形态）");
  for (const forbidden of [
    "setWorkItemReaction",
    "useWorkItemReactions(",
    "WorkItemReactionPicker",
    "WorkItemReactions ",
    "<WorkItemReactions",
  ]) {
    assert.ok(!peek.includes(forbidden), `peek 不得出现 ${forbidden}（面板零写入口）`);
  }
});

/* 全树唯一写路径：写方法只在可写 hook 里被调用一次（任何新面自己调服务 = 第二份写路径）。 */
test("守卫｜全树唯一写路径：setWorkItemReaction( 恰一处，且落在可写 hook", () => {
  const hits = walkSourceFiles(SRC_DIR)
    .filter((file) => stripComments(readFileSync(file, "utf8")).includes("setWorkItemReaction("))
    .map((file) => file.slice(SRC_DIR.length + 1))
    .sort();
  assert.deepEqual(hits, ["squad/useWorkItemReactions.ts"], "写调用只在可写 hook（全树恰一处）");
  const hook = stripComments(readSource("squad/useWorkItemReactions.ts"));
  assert.equal(
    hook.split("setWorkItemReaction(").length - 1,
    1,
    "hook 里写调用恰一处（第二个调用点 = 第二份写路径）",
  );
  assert.ok(
    hook.includes("resolveSquadRuntimeService(services).setWorkItemReaction(target, {"),
    "写经服务面唯一入口（不直写 repo、不拼第二条请求）",
  );
});

/* 验收 ⑤（卡面：看板/list/table **不出现** reactions —— multica 的列表载荷刻意不带该字段）。
   全树守卫：本轮新增的符号只允许出现在「回应四件 + 两个挂载点」这七个文件里。 */
test("守卫｜列表面零反应：看板/list/table/行/单元格/宿主不出现任何回应符号", () => {
  const consumers = (needle: string) =>
    walkSourceFiles(SRC_DIR)
      .filter((file) => stripComments(readFileSync(file, "utf8")).includes(needle))
      .map((file) => file.slice(SRC_DIR.length + 1))
      .sort();
  assert.deepEqual(
    consumers("WorkItemReaction"),
    [
      "squad/WorkItemDetailOverview.tsx",
      "squad/WorkItemPeek.tsx",
      "squad/WorkItemReactionChips.tsx",
      "squad/WorkItemReactions.tsx",
      "squad/useWorkItemReactionRows.ts",
      "squad/useWorkItemReactions.ts",
      "squad/workItemReactionsViewModel.ts",
    ],
    "「回应」符号的消费点白名单（多一个 = 有人绕开这四件自己实现；少一个 = 挂载点丢了）",
  );
  assert.deepEqual(
    consumers("useWorkItemReactionRows("),
    ["squad/WorkItemPeek.tsx", "squad/useWorkItemReactionRows.ts", "squad/useWorkItemReactions.ts"],
    "读 hook 的消费点：定义模块 + peek（只读面）+ 可写 hook（写面复用同一份读）",
  );
  assert.deepEqual(
    consumers("useWorkItemReactions("),
    ["squad/WorkItemReactions.tsx", "squad/useWorkItemReactions.ts"],
    "可写 hook 的消费点：定义模块 + 详情页那一行（第二处消费 = 第二个写入口）",
  );
  assert.deepEqual(
    consumers("WORK_ITEM_REACTION_EMOJIS"),
    ["squad/WorkItemReactions.tsx", "squad/workItemReactionsViewModel.ts"],
    "表情常量单一模块（定义处 + 选择器；第二份清单 = 两边迟早不一样）",
  );
  for (const file of [
    "squad/WorkItemsBoard.tsx",
    "squad/WorkItemListView.tsx",
    "squad/WorkItemTableView.tsx",
    "squad/WorkItemRows.tsx",
    "squad/WorkItemTableCell.tsx",
    "squad/WorkItemsSurface.tsx",
    "squad/WorkItemsPage.tsx",
  ]) {
    const source = stripComments(readSource(file));
    for (const needle of ["WorkItemReaction", "workItemReaction", "WORK_ITEM_REACTION_EMOJIS"]) {
      assert.ok(!source.includes(needle), `${file} 不得出现 ${needle}（列表面刻意不带回应）`);
    }
  }
});

/* peek 的挂载点：标签块之后、只读；0 反应 / 未读到 ⇒ 整块不渲染（轻量速览不摆空壳）。 */

/** peek 内容的夹具：只给这一条断言会读到的格（协作读模型的全部字段由宿主保证，这里不重造）。 */
function peekRead(): WorkItemCollaborationRead {
  const workItem: WorkItem = {
    id: "wi-1",
    workspaceIdentity: "ws-1",
    workspacePath: "/w/a",
    title: "批根标题",
    body: "",
    status: "todo",
    assignee: { type: "user", id: "user" },
    labels: [],
    properties: {},
    position: 0,
  };
  return {
    workItem,
    viewerActor: ME,
    comments: [],
    activities: [],
    decisions: [],
    reactions: [],
    receipts: [],
    subscribers: [],
    deliverables: [],
    pullRequests: [],
    pullRequestProvider: { available: false, reason: null },
    mergeMode: "local",
  } as unknown as WorkItemCollaborationRead;
}

function renderPeek(input: {
  reactionRows?: WorkItemReactionRecord[] | null;
  reactionsFailure?: string | null;
}): string {
  return renderToStaticMarkup(
    createElement(ZCodeIntlProvider, {
      initialLocale: "zh-CN" as const,
      children: createElement(WorkItemPeekContent, {
        read: peekRead(),
        snapshot: {
          enabled: true,
          teamAgents: [],
          squads: [],
          workItems: [],
          runs: [],
          queuedRuns: [],
        },
        ...(input.reactionRows === undefined ? {} : { reactionRows: input.reactionRows }),
        ...(input.reactionsFailure === undefined
          ? {}
          : { reactionsFailure: input.reactionsFailure }),
      }),
    }),
  );
}

test("peek 呈现｜回应只读挂载：0 反应与未读到都不渲染；有反应画 chip；读失败给一行原因", () => {
  const empty = renderPeek({ reactionRows: [], reactionsFailure: null });
  assert.ok(!empty.includes("work-item-reaction-chips"), "0 反应 ⇒ 整块不渲染（速览不摆空壳）");
  assert.ok(!empty.includes("work-item-peek-reactions-failure"), "没失败就不画失败行");

  const withRows = renderPeek({
    reactionRows: [reaction("r1", "👍", ME, 10), reaction("r2", "👍", OTHER_HUMAN, 20)],
    reactionsFailure: null,
  });
  assert.ok(
    withRows.includes('data-testid="work-item-reaction-chips"') &&
      withRows.includes(
        fill(zhText("squad.workItemDetail.reactions.chip"), { emoji: "👍", count: 2 }),
      ),
    "有反应 ⇒ chip（emoji + count，聚合走同一份纯函数）",
  );
  assert.ok(!withRows.includes("<button"), "peek 里零按钮（面板零写入口的结构面）");
  const labels = withRows.indexOf('data-testid="work-item-peek-labels"');
  const chips = withRows.indexOf('data-testid="work-item-reaction-chips"');
  assert.ok(labels >= 0 && chips > labels, "挂在标签块**之后**（卡面口径）");

  const failed = renderPeek({ reactionRows: null, reactionsFailure: "工作项不存在或已归档：wi-1" });
  assert.ok(
    failed.includes('data-testid="work-item-peek-reactions-failure"') &&
      failed.includes(zhText("squad.workItemDetail.reactions.readFailed")) &&
      failed.includes("工作项不存在或已归档：wi-1"),
    "读失败 ⇒ 一行原因（键 + 服务面原文：不把「读不到」说成「没有人反应」）",
  );

  const notRead = renderPeek({});
  assert.ok(
    !notRead.includes("work-item-reaction-chips") &&
      !notRead.includes("work-item-peek-reactions-failure"),
    "缺省（还没读到）⇒ 整块不渲染（不预判 0 反应）",
  );
});

// ---------- ⑨ 文案键（本轮新增恰 3 枚；两语成对、占位符一致） ----------

/* 卡面上限 5 枚（「reactions 区标题 / 添加入口 aria / 无反应态不渲染则免」）：实际 3 枚 ——
   没有区标题（chip 行自带语义，multica 的 ReactionBar 也没有标题），0 反应不画空态文案
   （只画入口），失败行复用既有键。变异：只改一语 / 多新增一枚键 / 用了裸键 ⇒ 本用例红。 */
test("键：本轮新增恰 3 枚（卡面上限 5）且两语成对；复用的既有键两语齐全（无裸 key）", () => {
  const added = [
    "squad.workItemDetail.reactions.add",
    "squad.workItemDetail.reactions.chip",
    "squad.workItemDetail.reactions.readFailed",
  ];
  assert.equal(added.length, 3, "新增键规模（加键 ⇒ 这里必须显式改；卡面上限 5）");
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
        .filter((key) => key.startsWith("squad.workItemDetail.reactions."))
        .sort(),
      [...added].sort(),
      `${name} 的 reactions.* 键集必须与清单逐枚一致（多 = 越界加键，少 = 用了裸 key）`,
    );
  }
  for (const key of [
    "squad.common.operationFailed",
    "squad.workItemDetail.retry",
    "squad.workItemDetail.overview.labels",
    "squad.workItemDetail.overview.labelsEmpty",
  ]) {
    assert.ok(zhText(key) && enText(key), `复用键 ${key} 必须两语齐全`);
  }
});

/* 本机集（`ownEmojis`）：**身份不可判定**时的第二条判据，两次推理都**可靠**（不是猜）：
   ①「置上」返回**多了一行** ⇒ 那行的作者就是我（服务面作者 = 组合根注入身份）；
   ②「置上」**没有多行** ⇒ 命中了五元组唯一键 ⇒ 这一枚本来就是我按过的（`INSERT OR IGNORE`
   的意义就是「我这一枚已经在库里」）—— 两种结论都指向「这枚是我的」，故一次点击即可判准。
   变异：把「置上」当成「必然新增」（没有新行就不进本机集）⇒ 第二条必红（自己按过的历史回应
   永远撤不掉，且第一次点击后也不亮）；把本机集当成「一定不是我」的补集（不在集里给
   `false`）⇒ 第三条必红（身份缺席时那叫**不可判定**，不是「不是我」）。 */
test("本机集：身份不可判定时一次写就判准（幂等命中 ⇒ 这一枚本来就是我的）", () => {
  const rows = [reaction("r1", "👍", ME, 10), reaction("r2", "🎉", AGENT_SAME_ID, 20)];
  assert.equal(
    workItemReactionToggleOn({
      rows,
      viewerActor: null,
      ownEmojis: new Set<string>(),
      emoji: "👍",
    }),
    true,
    "还没有任何本机知识 ⇒ 只能「置上」（幂等安全：命中也无副作用）",
  );
  const afterAdd = workItemReactionOwnEmojisAfterWrite({
    previousEmojis: new Set<string>(),
    emoji: "👍",
    on: true,
  });
  assert.deepEqual([...afterAdd].sort(), ["👍"], "无论新增还是幂等命中，这枚都归我");
  assert.equal(
    workItemReactionToggleOn({ rows, viewerActor: null, ownEmojis: afterAdd, emoji: "👍" }),
    false,
    "第二次点击 = 撤销（再也不会卡在「点了没反应」）",
  );
  const afterRemove = workItemReactionOwnEmojisAfterWrite({
    previousEmojis: afterAdd,
    emoji: "👍",
    on: false,
  });
  assert.deepEqual([...afterRemove], [], "撤销之后本机集里不再有这一枚");

  assert.deepEqual(
    workItemReactionGroups({ rows, viewerActor: null, ownEmojis: afterAdd }).map((group) => [
      group.emoji,
      group.reactedByMe,
    ]),
    [
      ["👍", true],
      ["🎉", null],
    ],
    "本机集里的 ⇒ true；其余仍是**不可判定**（null，不假装「不是我」）",
  );
  assert.deepEqual(
    workItemReactionGroups({ rows, viewerActor: null }).map((group) => group.reactedByMe),
    [null, null],
    "不给本机集（peek / 静态调用）⇒ 身份缺席就是 null（同一条判据的两个出口）",
  );
});

// ---------- ④ 目标（行自身的来源坐标 = 唯一可用的 workspace 口径） ----------

/* 详情页概览拿不到页面的 `target`（页面冻结、只投 workItem）⇒ 目标按**行自身的来源**
   反推（`workspacePath` + `workspaceIdentity`）—— 与收件箱 `inboxItemUnsubscribeTarget`
   同一手法（跨面目标一律按行反推，不猜、不取首个）。 */
test("目标：按行自身的来源反推 workspace 目标（path + identity，C14 口径）", () => {
  assert.deepEqual(workItemReactionsTarget({ workspacePath: "/w/a", workspaceIdentity: "ws-1" }), {
    path: "/w/a",
    identity: "ws-1",
  });
  assert.equal(
    workItemReactionsTarget({ workspacePath: "   ", workspaceIdentity: "ws-1" }),
    null,
    "空路径 ⇒ 没有可写的目标（不猜一个默认 workspace）",
  );
});
