import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { BoardPaneView, type BoardPaneViewProps } from "../src/board/BoardPaneView.js";
import type { BoardPaneLoadState } from "../src/board/loadBoardDocument.js";
import { parseBoardJson } from "../src/board/boardViewModel.js";
import { ZCodeIntlProvider } from "../src/i18n/IntlProvider.js";
import {
  boardGuideSlotActivation,
  boardGuideSlotDrilldownTarget,
  BOARD_GUIDE_SLOT_KEYS,
  buildBoardGuideSummary,
} from "../src/board/boardGuideViewModel.js";
import {
  buildGuideLegacyBoard,
  buildGuideNoPlansBoard,
  buildGuideZeroBoard,
  GUIDE_BOARD,
  GUIDE_NOW,
} from "./boardGuideFixture.js";

/**
 * 指引面骨架（卡 #136 / C3-1）的结构断言。
 *
 * 期望值的独立真源：卡文验收（「打开板看到正在执行的计划与功能完成进度（计数+微条）；
 * 点计划内卡片弹详情；全零 attention 空槽有形态」）+ `board.schema.json` x-decisions 四段条
 * （成员/顺序/计数直取派生投影，UI 禁自算）+ 消费契约 §13.6（L0/L1 同源消费四段）。
 * 夹具 `boardGuideFixture.ts` 刻意让「派生投影计数 ≠ 按卡字段自算计数」——反例用例即以此为咬点。
 */

function render(state: BoardPaneLoadState, props: Partial<BoardPaneViewProps> = {}): string {
  return renderToStaticMarkup(
    createElement(ZCodeIntlProvider, {
      initialLocale: "zh-CN" as const,
      children: createElement(BoardPaneView, {
        state,
        onRefresh: () => {},
        viewMode: "guide",
        now: GUIDE_NOW,
        ...props,
      }),
    }),
  );
}

function readyStateOf(raw: Record<string, unknown>): BoardPaneLoadState {
  const outcome = parseBoardJson(JSON.stringify(raw));
  if (outcome.kind !== "ready") throw new Error(`夹具必须是 v2 且 features 非空：${outcome.kind}`);
  return { kind: "ready", board: outcome.board };
}

const readyState = () => readyStateOf(GUIDE_BOARD);

function slotMarkup(markup: string, slot: string): string {
  const match = new RegExp(
    `data-board-guide-slot="${slot}"[\\s\\S]*?(?=data-board-guide-slot="|data-board-guide-plans)`,
  ).exec(markup);
  assert.ok(match, `槽 ${slot} 应存在`);
  return match[0];
}

function slotValue(markup: string, slot: string): string | null {
  const match = new RegExp(
    `data-board-guide-slot="${slot}"[^>]*data-board-guide-slot-value="([^"]*)"`,
  ).exec(markup);
  return match ? (match[1] ?? null) : null;
}

/** 槽卡的开标签（属性同款断言用：交互态/样式类都在同一标签上）。 */
function slotTag(markup: string, slot: string): string {
  const match = new RegExp(`<div[^>]*data-board-guide-slot="${slot}"[^>]*>`).exec(markup);
  assert.ok(match, `槽 ${slot} 开标签应存在`);
  return match[0];
}

function planMarkup(markup: string, planId: string): string {
  const start = markup.indexOf(`data-board-guide-plan="${planId}"`);
  assert.ok(start >= 0, `计划 ${planId} 应渲染`);
  const next = markup.indexOf("data-board-guide-plan=", start + 1);
  const end = markup.indexOf("data-board-guide-plans-empty", start + 1);
  const candidates = [next, end, markup.length].filter((value) => value >= 0);
  return markup.slice(start, Math.min(...candidates));
}

/* ---------------- 四段派生映射（消费面：parseBoardJson） ---------------- */

test("四段派生映射：frontier/active/blocked/recent 按板序原值透出（消费不重排、不改判据）", () => {
  const outcome = parseBoardJson(JSON.stringify(GUIDE_BOARD));
  assert.equal(outcome.kind, "ready");
  if (outcome.kind !== "ready") return;
  const index = outcome.board.derivedIndex;
  assert.ok(index, "四段齐备的板必须映射出派生索引");
  assert.deepEqual(
    index.frontier.map((entry) => [entry.rank, entry.no]),
    [
      [1, 210],
      [2, 220],
      [3, 221],
    ],
    "frontier 顺序与 rank 直读板字段",
  );
  assert.deepEqual(
    index.active.map((entry) => [entry.no, entry.stage]),
    [
      [213, "执行中"],
      [215, "执行中"],
      [216, "审核中"],
    ],
    "active 顺序直读板字段（不按 status 重排）",
  );
  assert.equal(index.blocked.length, 3, "blocked 一行一项（一卡两项出两行）");
  assert.deepEqual(
    index.blocked.map((entry) => [entry.blockerKind, entry.targetId]),
    [
      ["external", null],
      ["dependency", 112],
      ["dependency", 113],
    ],
  );
  assert.deepEqual(
    index.recent.map((entry) => entry.no),
    [210, 211, 213, 215, 220],
  );
  assert.equal(index.recent[2]?.stoppedAt, 213, "recent 条目字段透出（stoppedAt/next 不丢）");
  assert.equal(index.recent[2]?.next, "续跑探针");
});

test("四段缺失（旧版编译器产物）→ 派生索引为 null（视图侧不得自算兜底）", () => {
  const outcome = parseBoardJson(JSON.stringify(buildGuideLegacyBoard()));
  assert.equal(outcome.kind, "ready");
  if (outcome.kind !== "ready") return;
  assert.equal(outcome.board.derivedIndex, null, "四段缺省 = 索引缺失，不是空段");
});

/* ---------------- 置顶五槽条 ---------------- */

test("五槽条：计数直取派生投影与板字段（需处理=attentionSummary 合计、阻塞=blocked 行数、运行/待收口=active 段位、最近活动=recent 条数）", () => {
  const markup = render(readyState());
  assert.ok(markup.includes('data-board-view="guide"'), "guide 视图根锚点");
  assert.ok(markup.includes("data-board-guide-slots"), "五槽条容器");
  assert.equal(slotValue(markup, "attention"), "4", "需处理 = 2+0+1+1");
  assert.equal(slotValue(markup, "blocked"), "3", "阻塞 = blocked[] 行数（一卡两项出两行）");
  assert.equal(slotValue(markup, "running"), "2", "运行 = active 段位=执行中");
  assert.equal(slotValue(markup, "review"), "1", "待收口 = active 段位=审核中");
  assert.equal(slotValue(markup, "recent"), "5", "最近活动 = recent[] 条数");
  for (const label of ["需处理", "阻塞", "运行", "待收口", "最近活动"]) {
    assert.ok(slotMarkup(markup, slotName(label)).includes(label), `槽标签逐字：${label}`);
  }
});

const slotName = (label: string): string =>
  ({ 需处理: "attention", 阻塞: "blocked", 运行: "running", 待收口: "review", 最近活动: "recent" })[
    label
  ] ?? label;

test("反例（禁自算）：槽计数与自算口径不一致时，渲染必须跟派生投影走", () => {
  const markup = render(readyState());
  // 节点 attention 码合计 2、挂 blockers 的卡 2 张、status=active 的卡 1 张——
  // 任何按卡字段自算的实现会得到 2/2/1，这里逐一断言与派生投影一致。
  assert.equal(slotValue(markup, "attention"), "4");
  assert.equal(slotValue(markup, "blocked"), "3");
  assert.equal(slotValue(markup, "running"), "2");
});

test("零 attention：五槽仍显示，空槽有明确形态（0 + 空槽文案）", () => {
  const markup = render(readyStateOf(buildGuideZeroBoard()));
  assert.ok(markup.includes("data-board-guide-slots"), "零 signal 也不隐藏五槽条");
  for (const slot of ["attention", "blocked", "running", "review", "recent"]) {
    assert.equal(slotValue(markup, slot), "0", `${slot} 槽显式 0`);
    assert.ok(
      new RegExp(`data-board-guide-slot="${slot}"[^>]*data-board-guide-zero="true"`).test(markup),
      `${slot} 空槽形态标记`,
    );
  }
  assert.ok(markup.includes("无待处理"), "空槽给出可读文案，不留空壳");
  assert.ok(markup.includes("无最近活动"));
});

test("旧板（缺四段）：不自行推算——槽值未知 + 指名重编译提示", () => {
  const markup = render(readyStateOf(buildGuideLegacyBoard()));
  assert.ok(markup.includes("data-board-guide-index-state"), "索引状态锚点");
  assert.ok(markup.includes("data-board-guide-recompile"), "指名重编译提示");
  for (const slot of ["attention", "blocked", "running", "review", "recent"]) {
    assert.equal(slotValue(markup, slot), "—", `${slot} 槽不得显示自算计数`);
  }
});

/* ---------------- 主体「正在执行的计划」区块 ---------------- */

test("计划区块：活跃计划置顶、计划按板序；已取消计划与 spec 特性不入区块", () => {
  const markup = render(readyState());
  assert.ok(markup.includes("data-board-guide-plans"), "计划区块容器");
  assert.ok(markup.includes("正在执行的计划"), "区块标题");
  const planA = markup.indexOf('data-board-guide-plan="plan:plan-guide-a"');
  const planB = markup.indexOf('data-board-guide-plan="plan:plan-guide-b"');
  const planD = markup.indexOf('data-board-guide-plan="plan:plan-guide-d"');
  assert.ok(planA >= 0 && planB >= 0 && planD >= 0, "三张在册计划都渲染");
  assert.ok(planA < planB && planB < planD, "活跃计划置顶：A(active) → B → D 保板序");
  assert.ok(!markup.includes("plan:plan-guide-c"), "已取消计划不入区块");
  assert.ok(!markup.includes("spec:guide-spec"), "spec 特性不入计划区块");
});

test("活跃计划置顶：板序靠后的 active 计划提到 pending 计划之前（status 判据，非段位自算）", () => {
  const mutated = structuredClone(GUIDE_BOARD);
  const features = mutated.features as Array<Record<string, unknown>>;
  const planD = features.find((feature) => feature.id === "plan:plan-guide-d");
  assert.ok(planD, "夹具里应有计划 D");
  planD.status = "active";
  const markup = render(readyStateOf(mutated));
  const planA = markup.indexOf('data-board-guide-plan="plan:plan-guide-a"');
  const planDIndex = markup.indexOf('data-board-guide-plan="plan:plan-guide-d"');
  const planB = markup.indexOf('data-board-guide-plan="plan:plan-guide-b"');
  assert.ok(planA < planDIndex && planDIndex < planB, "A、D（active，板序）→ B（pending）");
});

test("活跃计划辨识：头行带共享状态点（板字段 status=active），非活跃计划不带", () => {
  const markup = render(readyState());
  const planA = planMarkup(markup, "plan:plan-guide-a");
  const dotIndex = planA.indexOf('data-board-status="active"');
  assert.ok(dotIndex >= 0, "active 计划头行带共享状态点（BoardStatusDot 锚点）");
  const barIndex = planA.indexOf("data-board-guide-plan-bar");
  assert.ok(barIndex > 0 && dotIndex < barIndex, "状态点落在头行（进度微条之前）");
  const planB = planMarkup(markup, "plan:plan-guide-b");
  assert.ok(!planB.includes("data-board-status"), "非活跃计划头行不带状态点（不新造装饰）");
});

test("计划进度：计数 = 该计划卡 completed/total（板字段），配进度微条", () => {
  const markup = render(readyState());
  const planA = planMarkup(markup, "plan:plan-guide-a");
  assert.ok(planA.includes('data-board-guide-plan-progress="2/4"'), `计划 A 计数 2/4：${planA}`);
  assert.ok(planA.includes("data-board-guide-plan-bar"), "计划 A 有进度微条");
  assert.ok(/data-board-guide-plan-bar-value="2\/4"/.test(planA), "微条数值钉住同一计数");
  const planB = planMarkup(markup, "plan:plan-guide-b");
  assert.ok(planB.includes('data-board-guide-plan-progress="0/3"'), "计划 B 0/3");
  const planD = planMarkup(markup, "plan:plan-guide-d");
  assert.ok(planD.includes("data-board-guide-plan-progress"), "零卡计划也带进度锚点");
  assert.ok(planD.includes("未拆解"), "零卡计划显示未拆解，不留空白");
});

test("计划摘要行：段位 + 期次合成名 + 前沿/在途计数（四段投影计数）", () => {
  const markup = render(readyState());
  const planA = planMarkup(markup, "plan:plan-guide-a");
  assert.ok(planA.includes("data-board-guide-plan-summary"), "摘要行锚点");
  assert.ok(planA.includes("执行中"), "摘要行带段位文本");
  assert.ok(planA.includes("KANB1"), "期次合成名走 A4 单点（KANB+1）");
  const planB = planMarkup(markup, "plan:plan-guide-b");
  assert.ok(planB.includes("KANB2"), "计划 B 期次 2 合成名");
});

test("前沿行入口：计划内卡行 = 四段投影成员（frontier 序 → active 序），带卡片锚点可点击", () => {
  const markup = render(readyState());
  const planA = planMarkup(markup, "plan:plan-guide-a");
  assert.ok(planA.includes('data-board-card="task:210"'), "计划 A 的前沿卡行（#210）");
  assert.ok(planA.includes('data-board-card="task:213"'), "计划 A 的在途卡行（#213）");
  assert.ok(planA.includes("置顶五槽条") && planA.includes("溢出探针"), "行内带标题");
  const planB = planMarkup(markup, "plan:plan-guide-b");
  assert.ok(planB.includes('data-board-card="task:220"'), "计划 B 前沿卡行");
});

test("卡片点击落点：计划内卡行带开弹窗 props（role=button + tabindex；真点击路由断言在浏览器脚本）", () => {
  const opened: string[] = [];
  const markup = render(readyState(), { onOpenCard: (id) => opened.push(id) });
  const cardRow = /data-board-card="task:210"[^>]*/.exec(markup);
  assert.ok(cardRow, "卡行锚点存在");
  assert.ok(cardRow[0].includes('role="button"'), "落点声明 button 角色");
  assert.ok(cardRow[0].includes('tabindex="0"'), "落点可键盘聚焦");
});

/* ---------------- 视图切换入口与词条 ---------------- */

test("视图切换：新增「指引」入口（guide 为可选项，四结构视图保留）", () => {
  const markup = render(readyState());
  const switcher = /data-board-view-switcher[\s\S]*?<\/div>/.exec(markup);
  assert.ok(switcher, "视图切换控件存在");
  assert.ok(switcher[0].includes('data-board-view-option="guide"'), "指引入口在位");
  for (const mode of ["tree", "kanban", "list", "table"]) {
    assert.ok(switcher[0].includes(`data-board-view-option="${mode}"`), `${mode} 视图入口保留`);
  }
});

test("英文界面：五槽与计划区块文案全走 en-US 词条（不漏中文）", () => {
  const markup = renderToStaticMarkup(
    createElement(ZCodeIntlProvider, {
      initialLocale: "en-US" as const,
      children: createElement(BoardPaneView, {
        state: readyState(),
        onRefresh: () => {},
        viewMode: "guide",
        now: GUIDE_NOW,
      }),
    }),
  );
  for (const label of ["Needs attention", "Blocked", "Running", "To close", "Recent activity"]) {
    assert.ok(markup.includes(label), `英文槽标签：${label}`);
  }
  assert.ok(markup.includes("Plans in progress"), "英文区块标题");
  assert.ok(!markup.includes("正在执行的计划"), "英文界面不得漏中文标题");
});

/* ---------------- 突变/空态咬点（计数跟随板字段，不跟标签） ---------------- */

test("突变：计划进度计数跟随板字段——卡 status 变 completed，计数与微条数值同步变", () => {
  const mutated = structuredClone(GUIDE_BOARD);
  const feature = (mutated.features as Array<Record<string, unknown>>)[0];
  const tasks = feature?.tasks as Array<Record<string, unknown>>;
  const target = tasks.find((task) => task.no === 210);
  assert.ok(target, "夹具里应有卡 #210");
  target.status = "completed";
  target.stage = "已完成";
  const markup = render(readyStateOf(mutated));
  const planA = planMarkup(markup, "plan:plan-guide-a");
  assert.ok(planA.includes('data-board-guide-plan-progress="3/4"'), `突变后计数 3/4：${planA}`);
  assert.ok(/data-board-guide-plan-bar-value="3\/4"/.test(planA), "微条数值同步突变");
});

test("突变：槽计数跟随派生投影——blocked 段少一行，阻塞槽随段变化（禁自算）", () => {
  const mutated = structuredClone(GUIDE_BOARD);
  (mutated.blocked as unknown[]).pop();
  const markup = render(readyStateOf(mutated));
  assert.equal(slotValue(markup, "blocked"), "2", "阻塞槽 = blocked[] 行数（突变后 2）");
});

test("空态：无计划特性 → 计划区块给明确空态（spec-only 项目不落空白）", () => {
  const markup = render(readyStateOf(buildGuideNoPlansBoard()));
  assert.ok(markup.includes("正在执行的计划"), "区块标题仍在");
  assert.ok(markup.includes("data-board-guide-plans-empty"), "空态锚点");
  assert.ok(markup.includes("暂无执行中的计划"), "空态文案");
  assert.ok(!markup.includes("data-board-guide-plan="), "空态时不得渲染计划块");
});

test("行数上限：计划内卡行超过上限时裁剪量显式（完整队列归 #138，不静默丢）", () => {
  const mutated = structuredClone(GUIDE_BOARD);
  const feature = (mutated.features as Array<Record<string, unknown>>)[0];
  const tasks = feature?.tasks as Array<Record<string, unknown>>;
  // 追加第 5、6 张卡并让它们进前沿（上限 3 → 应有 3 行 + 「还有 N 项」）。
  tasks.push(
    { no: 230, label: "1.5", title: "追加卡一", status: "pending", stage: "待办" },
    { no: 231, label: "1.6", title: "追加卡二", status: "pending", stage: "待办" },
  );
  (mutated.frontier as Array<Record<string, unknown>>).push(
    {
      rank: 4,
      no: 230,
      title: "追加卡一",
      stage: "待办",
      nextAssignee: "implementer",
      resolvedDeps: [],
    },
    {
      rank: 5,
      no: 231,
      title: "追加卡二",
      stage: "待办",
      nextAssignee: "implementer",
      resolvedDeps: [],
    },
  );
  const markup = render(readyStateOf(mutated));
  const planA = planMarkup(markup, "plan:plan-guide-a");
  const rowIds = [...planA.matchAll(/data-board-card="([^"]+)"/g)].map((match) => match[1]);
  assert.deepEqual(rowIds, ["task:210", "task:230", "task:231"], "只展示前 3 行（frontier 序）");
  assert.ok(planA.includes("data-board-guide-plan-more"), "裁剪量显式锚点");
  assert.ok(planA.includes("还有 1 项"), "裁剪量文案（4 项入口 - 3 行展示，另加 1 张在途卡）");
});

/* ---------------- C3-4（#139）：计划级进度胶囊 + 期次/功能级摘要行胶囊 ---------------- */

test("计划进度胶囊（#139）：已完成/总卡旁给百分比可读文本（与微条同口径；E7 §4.2 条旁必有数字）", () => {
  const markup = render(readyState());
  const planA = planMarkup(markup, "plan:plan-guide-a");
  assert.ok(/data-board-guide-plan-percent="50"/.test(planA), `计划 A 2/4 → 50%：${planA}`);
  assert.ok(planA.includes("50%"), "百分比是可见文本，不只靠条长表达");
  const planB = planMarkup(markup, "plan:plan-guide-b");
  assert.ok(/data-board-guide-plan-percent="0"/.test(planB), "计划 B 0/3 → 0%（显式，不留空壳）");
  assert.ok(planB.includes("0%"));
  const planD = planMarkup(markup, "plan:plan-guide-d");
  assert.ok(
    !/data-board-guide-plan-percent/.test(planD),
    "未拆解（0/0）不给百分比——不制造未知（E7 §4.2 未拆解形态）",
  );
  assert.ok(planD.includes("未拆解"), "未拆解文案仍在");
});

test("微条轨道（F1-139 微回炉）：轨道背景类覆写为四主题已定义 token（bg-border 在场，惰性 bg-muted 不回退）", () => {
  const markup = render(readyState());
  const planA = planMarkup(markup, "plan:plan-guide-a");
  const anchor = planA.indexOf("data-board-guide-plan-bar");
  assert.ok(anchor >= 0, "微条锚点存在");
  const tag = planA.slice(planA.lastIndexOf("<", anchor), planA.indexOf(">", anchor) + 1);
  const classAttr = /class="([^"]*)"/.exec(tag);
  const classText = classAttr?.[1] ?? "";
  assert.ok(classText, `微条带 class：${tag}`);
  // F1-139：`--color-muted` 全仓四主题块/默认主题/基座均无定义（progress 基件 bg-muted 为惰性类）——
  // 回退成 bg-muted 会让四主题轨道透明、比例通道丢失；bg-border 四主题已定义（10% 墨轨道）。
  // SSR 面上类名是轨道 token 的唯一可观测通道，故按「已定义 token 类在场 + 惰性类被覆写」钉住。
  assert.ok(
    classText.includes("bg-border"),
    `轨道背景类应为四主题已定义 token（bg-border）：${classText}`,
  );
  assert.ok(
    !/(^|\s)bg-muted(\s|$)/.test(classText),
    `惰性类 bg-muted 必须被 tailwind-merge 覆写移除：${classText}`,
  );
});

test("期次/功能级摘要行胶囊（#139）：计划卡数胶囊与 A4 组头 [N 张卡] 同源同值（countBoardFeatureTasks 单点）", () => {
  const guide = render(readyState());
  const planA = planMarkup(guide, "plan:plan-guide-a");
  assert.ok(
    /data-board-guide-plan-card-count="4"/.test(planA),
    `计划 A 规模胶囊 = 夹具全部成员卡 4 张：${planA}`,
  );
  assert.ok(planA.includes("4 张卡"), "规模文案走 A4 组头同一词条（{count} 张卡）");
  // 「与组头计数一致」对账：同一板同一单点，指引面胶囊与结构视图组头必须同值（4 张卡）。
  const kanban = render(readyState(), { viewMode: "kanban" });
  assert.ok(kanban.includes('data-board-feature-card-count="4"'), "看板组头 [N 张卡] 锚点");
  assert.ok(kanban.includes("4 张卡"), "组头计数同文案（两处同一词条）");
  // 反例（禁自算）：计划 A 的四段成员只有 2 张（frontier #210 + active #213）——
  // 规模胶囊必须是全部成员卡（4）；按四段成员数自算会得 2，必咬。
  const planB = planMarkup(guide, "plan:plan-guide-b");
  assert.ok(/data-board-guide-plan-card-count="3"/.test(planB), "计划 B 3 张卡（含在途/受阻卡）");
});

test("突变：卡数胶囊跟随板字段（含嵌套子卡）——与组头同步变，不跟标签/四段成员", () => {
  const mutated = structuredClone(GUIDE_BOARD);
  const feature = (mutated.features as Array<Record<string, unknown>>)[0];
  const tasks = feature?.tasks as Array<Record<string, unknown>>;
  const target = tasks.find((task) => task.no === 210);
  assert.ok(target, "夹具里应有卡 #210");
  target.tasks = [{ label: "1.1.1", title: "嵌套子卡", status: "pending", stage: "待办" }];
  const guide = render(readyStateOf(mutated));
  const planA = planMarkup(guide, "plan:plan-guide-a");
  assert.ok(
    /data-board-guide-plan-card-count="5"/.test(planA),
    `嵌套子卡计入总卡数（4+1）：${planA}`,
  );
  const kanban = render(readyStateOf(mutated), { viewMode: "kanban" });
  assert.ok(kanban.includes('data-board-feature-card-count="5"'), "组头计数同变（同一单点）");
});

test("rollup 缺口徽章（#139）：计数 = 计划成员卡 attention 码条数之和（A4 单点 boardLayerGapCount；零缺口不渲染）", () => {
  const base = render(readyState());
  const basePlanA = planMarkup(base, "plan:plan-guide-a");
  assert.ok(
    !basePlanA.includes("data-board-guide-plan-gap-count"),
    "全无缺口 → 不落徽章（日常零噪声，与 A4 层头同判据）",
  );
  const mutated = structuredClone(GUIDE_BOARD);
  const feature = (mutated.features as Array<Record<string, unknown>>)[0];
  assert.ok(feature, "夹具里应有计划 A");
  const tasks = feature.tasks as Array<Record<string, unknown>>;
  const card211 = tasks.find((task) => task.no === 211);
  const card210 = tasks.find((task) => task.no === 210);
  assert.ok(card211 && card210, "夹具里应有卡 #211/#210");
  card211.attention = ["interrupted-resume"];
  // 嵌套子卡也计入 rollup（成员 = 计划全部卡，含子卡）。
  card210.tasks = [
    {
      label: "1.1.1",
      title: "子卡",
      status: "pending",
      stage: "待办",
      attention: ["unmerged-worktree", "interrupted-resume"],
    },
  ];
  const markup = render(readyStateOf(mutated));
  const planA = planMarkup(markup, "plan:plan-guide-a");
  assert.ok(/data-board-guide-plan-gap-count="3"/.test(planA), `缺口 = 1+2 = 3：${planA}`);
  assert.ok(planA.includes("缺口 3"), "缺口文案走 A4 层头同一词条（缺口 {count}）");
  const planB = planMarkup(markup, "plan:plan-guide-b");
  assert.ok(!planB.includes("data-board-guide-plan-gap-count"), "计划 B 无缺口，不串台");
});

/* ---------------- C3-2（#137）：槽下钻路由 + 槽激活判据 ---------------- */

test("五槽可点（#137）：槽卡是看板既有交互形态（role=button + tabindex，hover/focus 复用既有 token），初始无空态指引", () => {
  const markup = render(readyState(), { onDrillToSlot: () => {} });
  for (const key of BOARD_GUIDE_SLOT_KEYS) {
    const tag = slotTag(markup, key);
    assert.ok(
      tag.includes('role="button"'),
      `${key} 槽声明 button 角色（:focus-visible 规则同款覆盖）`,
    );
    assert.ok(tag.includes('tabindex="0"'), `${key} 槽可键盘聚焦`);
    assert.ok(tag.includes("cursor-pointer"), `${key} 槽有可点光标`);
    assert.ok(
      tag.includes("hover:bg-surface-hover"),
      `${key} 槽 hover 复用看板既有交互 token（不新造配色/大面积色块）：${tag}`,
    );
  }
  assert.ok(
    !markup.includes("data-board-guide-slot-empty"),
    "初始不渲染空态指引（点零槽才出——不占版面）",
  );
});

test("槽不可点边界（#137）：缺下钻派发（只读渲染）时槽不落 button 角色；旧板（缺四段）槽不落死跳转", () => {
  const readOnly = render(readyState());
  for (const key of BOARD_GUIDE_SLOT_KEYS) {
    assert.ok(
      !slotTag(readOnly, key).includes('role="button"'),
      `${key} 槽缺宿主派发时应为只读（与卡行「缺 onOpenCard 不可点」同款）`,
    );
  }
  // 旧板：槽值未知（null，§13.6 缺四段）——重编译提示已点名，槽不上可点态（不拿未知当集合）。
  const legacy = render(readyStateOf(buildGuideLegacyBoard()), { onDrillToSlot: () => {} });
  for (const key of BOARD_GUIDE_SLOT_KEYS) {
    assert.ok(
      !slotTag(legacy, key).includes('role="button"'),
      `${key} 槽在缺四段板上不上可点态（不猜落点）`,
    );
  }
});

test("槽下钻路由（#137）：五槽落到既有视图/过滤——派发目标唯一、互不相同（禁第二路由）", () => {
  // 期望值 = 派发落点口径（需处理→看板列 / 阻塞→受阻清单形态 / 运行·待收口→对应列表态 /
  // 最近活动→最近视图），独立于实现逐槽抄写；controls 是既有 BoardListControls 的显式取值。
  const expected: Record<
    string,
    { viewMode: string; controls?: { stage: string | null; sort: string } }
  > = {
    attention: { viewMode: "kanban" },
    blocked: { viewMode: "table", controls: { stage: null, sort: "recent" } },
    running: { viewMode: "list", controls: { stage: "执行中", sort: "recent" } },
    review: { viewMode: "list", controls: { stage: "审核中", sort: "recent" } },
    recent: { viewMode: "list", controls: { stage: null, sort: "recent" } },
  };
  for (const key of BOARD_GUIDE_SLOT_KEYS) {
    const target = boardGuideSlotDrilldownTarget(key);
    const want = expected[key];
    assert.ok(want, `槽 ${key} 必须给落点（闭集穷尽）`);
    assert.equal(target.mode, want.viewMode, `槽 ${key} 的落点视图`);
    if (want.controls) {
      assert.ok(
        target.controls,
        `槽 ${key} 应给列表/表格目标的显式控制（确定性落点，不吃上一次筛子）`,
      );
      assert.equal(target.controls.stage, want.controls.stage, `槽 ${key} 的段位筛`);
      assert.equal(target.controls.sort, want.controls.sort, `槽 ${key} 的排序视角`);
      assert.equal(target.controls.status, null, "下钻不给状态筛（只看槽对应集合）");
      assert.equal(target.controls.attention, null, "下钻不给缺口码筛（只看槽对应集合）");
      assert.equal(target.controls.kind, null, "下钻不给类型筛（只看槽对应集合）");
    }
  }
  // 每槽落点互不相同：浏览器断言要能逐槽分辨「跳到了哪个对应视图/过滤」。
  const seen = new Set(
    BOARD_GUIDE_SLOT_KEYS.map((key) => JSON.stringify(boardGuideSlotDrilldownTarget(key))),
  );
  assert.equal(seen.size, BOARD_GUIDE_SLOT_KEYS.length, "五槽落点必须两两不同（否则点击不可分辨）");
  // 拷贝语义：落点表是共享常量，调用方改写返回值不得污染下一处消费（宿主会把 controls 交给 setState）。
  const first = boardGuideSlotDrilldownTarget("running");
  if (first.controls) first.controls.stage = "已完成";
  assert.equal(
    boardGuideSlotDrilldownTarget("running").controls?.stage,
    "执行中",
    "落点对象为拷贝（共享表不被调用方改写）",
  );
});

test("槽激活判据（#137）：计数 >0 才下钻；0 = 空态指引；缺四段（null）= 不跳（重编译提示已点名）", () => {
  // 期望值 = 卡文验收「零 attention 槽点击有明确空态指引（不落死跳转）」+ §13.6 缺四段不猜口径。
  assert.equal(boardGuideSlotActivation({ key: "attention", count: 4 }), "drill");
  assert.equal(boardGuideSlotActivation({ key: "blocked", count: 0 }), "empty");
  assert.equal(boardGuideSlotActivation({ key: "recent", count: 0 }), "empty");
  assert.equal(boardGuideSlotActivation({ key: "running", count: 1 }), "drill");
  assert.equal(boardGuideSlotActivation({ key: "review", count: null }), "none");
  assert.equal(boardGuideSlotActivation({ key: "attention", count: null }), "none");
});

test("反例（槽计数与板一致必咬）：派生段为零、节点自带 attention 码/blockers 时，激活仍按派生走", () => {
  // 夹具节点仍带 attention 码与 blockers，但 buildGuideZeroBoard 把四段与 attentionSummary 清零——
  // 任何「按节点字段自算」的实现会把需处理算成 2/阻塞算成 2 并下钻；判据必须跟板字段（派生）。
  const outcome = parseBoardJson(JSON.stringify(buildGuideZeroBoard()));
  assert.equal(outcome.kind, "ready");
  if (outcome.kind !== "ready") return;
  const summary = buildBoardGuideSummary(outcome.board);
  for (const slot of summary.slots) {
    assert.equal(slot.count, 0, `${slot.key} 槽计数必须跟派生（0）`);
    assert.equal(
      boardGuideSlotActivation(slot),
      "empty",
      `${slot.key} 自算口径会得非零 → 必咬（应走空态指引，不下钻）`,
    );
  }
});

test("反例（缺口口径必咬）：不数计划自身 attention 码、也不漏嵌套子卡——只有成员卡全量求和得真值", () => {
  const mutated = structuredClone(GUIDE_BOARD);
  const feature = (mutated.features as Array<Record<string, unknown>>)[0];
  assert.ok(feature, "夹具里应有计划 A");
  // 计划自身缺口码（feature.attention）是「自身信号」不是 rollup——若被计数会得 1。
  feature.attention = ["interviewed-not-arranged"];
  const tasks = feature.tasks as Array<Record<string, unknown>>;
  const card213 = tasks.find((task) => task.no === 213);
  const card210 = tasks.find((task) => task.no === 210);
  assert.ok(card213 && card210, "夹具里应有卡 #213/#210");
  card213.attention = ["unmerged-worktree"];
  card210.tasks = [
    {
      label: "1.1.1",
      title: "子卡",
      status: "pending",
      stage: "待办",
      attention: ["interrupted-resume", "arranged-not-expanded"],
    },
  ];
  const markup = render(readyStateOf(mutated));
  const planA = planMarkup(markup, "plan:plan-guide-a");
  // 真值 = 成员卡全量求和：顶层 #213 的 1 条 + 嵌套子卡 2 条 = 3
  // （自算自身码会得 1；只数顶层会得 1；两者都被此断言咬住）。
  assert.ok(/data-board-guide-plan-gap-count="3"/.test(planA), `缺口真值 = 3：${planA}`);
});
